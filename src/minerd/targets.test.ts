// src/minerd/targets.test.ts
//
// The ONE target model + the ONE writer of MINER_POOL.
//
// TEMP CWD, AND WHY THE IMPORT IS DYNAMIC: envLocal resolves ENV_FILE and POOLS_FILE
// from process.cwd() at MODULE LOAD time, and this module writes both. So we chdir
// into a temp dir BEFORE importing targets.js - a static import would bind the
// developer's real .env.local / pools.json and this suite would overwrite them.
// `node --test` runs each test FILE in its own child process, so the chdir cannot
// leak into another suite.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';

const TMP = mkdtempSync(path.join(os.tmpdir(), 'fulgur-targets-'));
process.chdir(TMP);

const ENV_LOCAL = path.join(TMP, '.env.local');
const POOLS = path.join(TMP, 'pools.json');

const T = await import('./targets.js');
const P = await import('./pools.js');

const FULGUR_URL = P.BUILTIN_POOLS[0]!.url;
const BRC_URL = P.BUILTIN_POOLS[1]!.url;

/** Write pools.json - an object is JSON-stringified, a string is written verbatim (for broken files). */
function writePools(json: unknown): void {
  writeFileSync(POOLS, typeof json === 'string' ? json : JSON.stringify(json, null, 2) + '\n');
}

beforeEach(() => {
  for (const f of [ENV_LOCAL, `${ENV_LOCAL}.bak`, POOLS, `${POOLS}.bak`]) if (existsSync(f)) rmSync(f);
  delete process.env.MINER_POOL;
});

/** Assert a validateNewPool rejection and hand back its fields. */
function rejected(r: ReturnType<typeof T.validateNewPool>): { field: 'name' | 'url'; reason: string } {
  assert.equal(r.ok, false, `expected a rejection, got ${JSON.stringify(r)}`);
  if (r.ok) throw new Error('unreachable');
  return { field: r.field, reason: r.reason };
}

/** The reason a removeCustomPool call refused (asserts that it DID refuse). */
function refused(r: ReturnType<typeof T.removeCustomPool>): string {
  assert.equal(r.ok, false, 'expected a refusal');
  return r.ok ? '' : r.reason;
}

// -- the row list -------------------------------------------------------------

test('row 0 is ALWAYS Solo, then FulgurPool, then brcpool - and FulgurPool persists as an absence', () => {
  const m = T.buildTargetModel({});
  assert.deepEqual(m.targets[0], {
    key: 'solo',
    label: 'Solo',
    value: 'solo',
    description: 'mine on your own, no pool',
    kind: 'solo',
    removable: false,
  });
  assert.equal(m.targets[1]!.key, 'fulgurpool');
  assert.equal(m.targets[1]!.value, undefined, 'FulgurPool is the default pool: an absent key, never its own URL');
  assert.equal(m.targets[2]!.key, 'brcpool');
  assert.equal(m.targets[2]!.value, BRC_URL);
  for (const t of m.targets) assert.equal(t.removable, false);
});

// -- activeIndex: never -1, and unset resolves to FulgurPool ------------------

test('unset/blank MINER_POOL resolves to the FulgurPool row - there is no "not chosen" state', () => {
  assert.equal(T.buildTargetModel({}).activeIndex, 1);
  assert.equal(T.buildTargetModel({ MINER_POOL: '' }).activeIndex, 1);
  assert.equal(T.buildTargetModel({ MINER_POOL: '   ' }).activeIndex, 1);
  assert.equal(T.buildTargetModel({}).targets.length, 3);
});

test('MINER_POOL=solo, and the legacy off/none spellings, resolve to the Solo row', () => {
  assert.equal(T.buildTargetModel({ MINER_POOL: 'solo' }).activeIndex, 0);
  assert.equal(T.buildTargetModel({ MINER_POOL: 'OFF' }).activeIndex, 0);
  assert.equal(T.buildTargetModel({ MINER_POOL: ' None ' }).activeIndex, 0);
});

test('a built-in URL (any spelling) lights up its row, and a legacy FulgurPool origin is FulgurPool', () => {
  assert.equal(T.buildTargetModel({ MINER_POOL: `${FULGUR_URL}/` }).activeIndex, 1);
  assert.equal(T.buildTargetModel({ MINER_POOL: FULGUR_URL.toUpperCase() }).activeIndex, 1);
  assert.equal(T.buildTargetModel({ MINER_POOL: BRC_URL }).activeIndex, 2);

  // The legacy origin (FULGURPOOL_ALIASES) IS FulgurPool - it must not render as an
  // unrecognised third-party pool with the jackpot panel switched off.
  const alias = T.buildTargetModel({ MINER_POOL: P.FULGURPOOL_ALIASES[0]! });
  assert.equal(alias.activeIndex, 1);
  assert.equal(alias.targets.length, 3, 'and it adds no unknown row');
});

test('an unrecognised pool URL gets its OWN row - it is NEVER relabelled FulgurPool', () => {
  // menu.ts:155 does `this.targetIndex = i >= 0 ? i : 0`, so TODAY this URL renders
  // as "FulgurPool" while the miner mines at unknown.example - and one Enter in the
  // picker then persists undefined and ERASES it.
  const m = T.buildTargetModel({ MINER_POOL: 'https://unknown.example/api' });
  const active = m.targets[m.activeIndex]!;
  assert.equal(active.kind, 'unknown');
  assert.equal(active.key, 'unknown');
  assert.equal(active.value, 'https://unknown.example/api');
  assert.equal(active.label, 'https://unknown.example/api');
  assert.equal(active.removable, false);
  assert.notEqual(m.activeIndex, 1);
  assert.equal(m.targets[1]!.key, 'fulgurpool', 'FulgurPool is still exactly where it was');
  assert.equal(m.targets.length, 4);
});

test('garbage MINER_POOL (not even a URL) also gets an unknown row - never -1, never silently FulgurPool', () => {
  for (const raw of ['solo1', 'ftp://x.org', '\x07evil']) {
    const m = T.buildTargetModel({ MINER_POOL: raw });
    assert.ok(m.activeIndex >= 0, `activeIndex must never be -1 (raw=${JSON.stringify(raw)})`);
    const active = m.targets[m.activeIndex]!;
    assert.equal(active.kind, 'unknown');
    assert.equal(active.removable, false);
    // eslint-disable-next-line no-control-regex
    assert.doesNotMatch(active.label, /[\x00-\x1f\x7f]/, 'a control character must never reach the label');
  }
});

// -- pools.json: custom rows, dedupe, and the issues both UIs render ----------

test('pools.json entries become removable custom rows, after the built-ins', () => {
  writePools({ pools: [{ name: 'MyPool', url: 'pool.foo.org' }] }); // scheme-less: it must LOAD
  const m = T.buildTargetModel({ MINER_POOL: 'https://pool.foo.org' });
  assert.equal(m.targets.length, 4);
  const custom = m.targets[3]!;
  assert.equal(custom.kind, 'custom');
  assert.equal(custom.key, 'custom:https://pool.foo.org');
  assert.equal(custom.label, 'MyPool');
  assert.equal(custom.value, 'https://pool.foo.org');
  assert.equal(custom.removable, true);
  assert.equal(m.activeIndex, 3);
  for (const t of m.targets.slice(0, 3)) assert.equal(t.removable, false);
});

test('a broken pools.json surfaces as issues - not a console.warn the alt-screen would wipe', () => {
  writePools('{ not json');
  const m = T.buildTargetModel({});
  assert.ok(m.issues.length >= 1, 'the parse failure is reported to the UI');
  for (const i of m.issues) {
    assert.equal(typeof i.entry, 'string');
    assert.ok(i.reason.length > 0);
  }
  assert.equal(m.targets.length, 3, 'and the built-ins still render');
});

test('a hand-edited pools.json cannot inject control characters into a label or an issue', () => {
  writePools({ pools: [{ name: 'Ev\x07il', url: 'https://a.example' }, { name: 'No\x1bURL' }] });
  const m = T.buildTargetModel({});
  // eslint-disable-next-line no-control-regex
  const CTRL = /[\x00-\x1f\x7f]/;
  for (const t of m.targets) assert.ok(!CTRL.test(t.label), `control char in label: ${JSON.stringify(t.label)}`);
  for (const i of m.issues) {
    assert.ok(!CTRL.test(i.entry), `control char in issue.entry: ${JSON.stringify(i.entry)}`);
    assert.ok(!CTRL.test(i.reason), `control char in issue.reason: ${JSON.stringify(i.reason)}`);
  }
});

test('a pools.json entry that points at a built-in gets no duplicate row - it is reported', () => {
  // Two rows with the same value would make activeIndex ambiguous, and ambiguity here
  // is how hashrate ends up somewhere the user did not pick.
  writePools({
    pools: [
      { name: 'My FulgurPool', url: FULGUR_URL },
      { name: 'Dup', url: 'https://x.example' },
      { name: 'Dup2', url: 'x.example' },
    ],
  });
  const m = T.buildTargetModel({});
  assert.deepEqual(m.targets.map((t) => t.label), ['Solo', 'FulgurPool', 'brcpool', 'Dup']);
  assert.deepEqual(m.issues.map((i) => i.entry), ['My FulgurPool', 'Dup2']);
  for (const i of m.issues) assert.ok(i.reason.length > 0);
});

// -- persistTarget: the one writer ---------------------------------------------

test('persistTarget writes an ABSENT MINER_POOL for FulgurPool - never its own URL - and it round-trips', () => {
  writeFileSync(ENV_LOCAL, `MINER_POOL=solo\nMINER_PUBKEY=${'aa'.repeat(32)}\n`);
  process.env.MINER_POOL = 'solo';
  const m = T.buildTargetModel(process.env);

  T.persistTarget(m.targets[1]!); // FulgurPool
  const body = readFileSync(ENV_LOCAL, 'utf8');
  assert.ok(!/^MINER_POOL=/m.test(body), `expected no MINER_POOL line, got:\n${body}`);
  assert.match(body, /MINER_PUBKEY=/, 'other lines survive the splice');
  assert.equal(process.env.MINER_POOL, undefined);
  assert.equal(T.buildTargetModel(process.env).activeIndex, 1);
});

test('persistTarget writes solo and a real URL for brcpool/custom - and each round-trips', () => {
  writePools({ pools: [{ name: 'MyPool', url: 'https://pool.foo.org' }] });
  const m = T.buildTargetModel({});

  T.persistTarget(m.targets[0]!); // Solo
  assert.equal(process.env.MINER_POOL, 'solo');
  assert.ok(readFileSync(ENV_LOCAL, 'utf8').split('\n').includes('MINER_POOL=solo'));
  assert.equal(T.buildTargetModel(process.env).activeIndex, 0);

  T.persistTarget(m.targets[2]!); // brcpool
  assert.equal(process.env.MINER_POOL, BRC_URL);
  assert.equal(T.buildTargetModel(process.env).activeIndex, 2);

  T.persistTarget(m.targets[3]!); // custom MyPool
  assert.equal(process.env.MINER_POOL, 'https://pool.foo.org');
  assert.equal(T.buildTargetModel(process.env).activeIndex, 3);
});

// -- validateNewPool: one validator, one set of caps ---------------------------

test('validateNewPool refuses a built-in NAME and a built-in URL (including the legacy alias)', () => {
  const { targets } = T.buildTargetModel({});

  // A pools.json entry may legally be NAMED "FulgurPool" today, which is why identity
  // is never taken from a label - and why the Add form must not let a user create
  // the confusion in the first place.
  assert.equal(rejected(T.validateNewPool('FulgurPool', 'https://evil.example', targets)).field, 'name');
  assert.equal(rejected(T.validateNewPool('  brcpool ', 'https://evil.example', targets)).field, 'name');
  assert.equal(rejected(T.validateNewPool('solo', 'https://a.example', targets)).field, 'name');
  assert.equal(rejected(T.validateNewPool('', 'https://a.example', targets)).field, 'name');
  // Non-ASCII would be counted as 1 column per UTF-16 unit by menu.ts's vlen(),
  // tearing the two-pane frame. Deliberately non-ASCII test input, not authored copy.
  assert.equal(rejected(T.validateNewPool('矿池', 'https://a.example', targets)).field, 'name');

  assert.equal(rejected(T.validateNewPool('Mine', `${FULGUR_URL}/`, targets)).field, 'url');
  assert.equal(rejected(T.validateNewPool('Mine', BRC_URL.toUpperCase(), targets)).field, 'url');
  assert.equal(rejected(T.validateNewPool('Mine', P.FULGURPOOL_ALIASES[0]!, targets)).field, 'url');
  assert.equal(rejected(T.validateNewPool('Mine', 'not a url', targets)).field, 'url');
});

test('the caps live HERE, so both UIs enforce the same ones', () => {
  const { targets } = T.buildTargetModel({});
  assert.equal(T.NAME_MAX, 40);
  assert.equal(T.URL_MAX, 256);

  const okName = 'x'.repeat(T.NAME_MAX);
  assert.equal(T.validateNewPool(okName, 'https://a.example', targets).ok, true);
  const longName = rejected(T.validateNewPool('x'.repeat(T.NAME_MAX + 1), 'https://a.example', targets));
  assert.equal(longName.field, 'name');
  assert.match(longName.reason, /40/);

  // An over-long paste is REJECTED, never silently truncated into a URL that is
  // still URL-shaped and would be persisted as the mining endpoint.
  const longUrl = `https://a.example/${'p'.repeat(T.URL_MAX)}`;
  const rej = rejected(T.validateNewPool('Mine', longUrl, targets));
  assert.equal(rej.field, 'url');
  assert.match(rej.reason, /256/);
});

test('validateNewPool refuses duplicates case-insensitively, and normalises a scheme-less URL', () => {
  writePools({ pools: [{ name: 'MyPool', url: 'https://pool.foo.org' }] });
  const { targets } = T.buildTargetModel({});
  assert.equal(rejected(T.validateNewPool('mypool', 'https://other.example', targets)).field, 'name');
  assert.equal(rejected(T.validateNewPool('Another', 'pool.foo.org/', targets)).field, 'url');

  const ok = T.validateNewPool('  My Second Pool  ', 'pool.bar.org', targets);
  assert.equal(ok.ok, true);
  if (!ok.ok) return;
  assert.deepEqual(ok.entry, { name: 'My Second Pool', url: 'https://pool.bar.org' });
});

// -- addCustomPool: a write must never delete what it could not parse ---------

test('addCustomPool appends to pools.json WITHOUT destroying what it could not parse', () => {
  writePools({
    _comment: 'hand-written - keep me',
    pools: [{ name: 'Broken' }, { name: 'MyPool', url: 'https://pool.foo.org' }],
  });

  const m = T.addCustomPool('Second', 'pool.bar.org');
  assert.deepEqual(m.targets.map((t) => t.label), ['Solo', 'FulgurPool', 'brcpool', 'MyPool', 'Second']);
  assert.equal(m.activeIndex, 1, 'saving a bookmark must never move your hashrate - MINER_POOL is still unset');

  const raw = JSON.parse(readFileSync(POOLS, 'utf8')) as { _comment: string; pools: unknown[] };
  assert.equal(raw._comment, 'hand-written - keep me', 'the top-level key survives');
  assert.deepEqual(raw.pools[0], { name: 'Broken' }, 'the entry we could not use is still on disk');
  assert.deepEqual(raw.pools[2], { name: 'Second', url: 'https://pool.bar.org' });
  assert.ok(existsSync(`${POOLS}.bak`), 'a .bak is kept');
});

test('addCustomPool writes NOTHING on an invalid entry or an unreadable file', () => {
  writePools({ pools: [{ name: 'MyPool', url: 'https://pool.foo.org' }] });
  const before = readFileSync(POOLS, 'utf8');
  T.addCustomPool('MyPool', 'https://other.example'); // duplicate name
  assert.equal(readFileSync(POOLS, 'utf8'), before);

  writePools('{ not json');
  const brokenBefore = readFileSync(POOLS, 'utf8');
  const m = T.addCustomPool('Fresh', 'https://fresh.example');
  assert.equal(readFileSync(POOLS, 'utf8'), brokenBefore, 'a file we cannot parse is never overwritten');
  assert.ok(m.issues.length >= 1, 'and the reason is on screen');
});

// -- removeCustomPool: refuse the active pool, and delete the entry you NAMED --

test('removeCustomPool refuses the pool you are mining on, and every non-removable row', () => {
  writePools({ pools: [{ name: 'MyPool', url: 'https://pool.foo.org' }] });
  process.env.MINER_POOL = 'https://pool.foo.org/'; // the same pool, spelled with a trailing slash
  const m = T.buildTargetModel(process.env);
  const before = readFileSync(POOLS, 'utf8');

  assert.equal(refused(T.removeCustomPool(m.targets[3]!)), T.REMOVE_ACTIVE_REFUSAL);
  assert.match(T.REMOVE_ACTIVE_REFUSAL, /switch to another destination first/);

  for (const t of m.targets.slice(0, 3)) {
    assert.equal(refused(T.removeCustomPool(t)), T.REMOVE_BUILTIN_REFUSAL, `${t.label} must not be removable`);
  }
  assert.equal(readFileSync(POOLS, 'utf8'), before, 'a refusal never touches the file');
});

test('removeCustomPool refuses the unknown row too - it is not removable', () => {
  const m = T.buildTargetModel({ MINER_POOL: 'https://unknown.example' });
  const unknown = m.targets[m.activeIndex]!;
  assert.equal(unknown.kind, 'unknown');
  assert.equal(refused(T.removeCustomPool(unknown)), T.REMOVE_BUILTIN_REFUSAL);
});

test('removeCustomPool deletes the entry it NAMED, even if pools.json moved under us', () => {
  writePools({
    pools: [
      { name: 'Alpha', url: 'https://alpha.example' },
      { name: 'Beta', url: 'https://beta.example' },
    ],
  });
  process.env.MINER_POOL = 'solo';
  const beta = T.buildTargetModel(process.env).targets[4]!;
  assert.equal(beta.label, 'Beta');

  // The user edits pools.json in another window (or runs `npm run settings`): Beta is
  // now raw index 0. A splice by the index captured when the picker opened would
  // delete ALPHA while the confirm said "Remove Beta?".
  writePools({
    pools: [
      { name: 'Beta', url: 'https://beta.example' },
      { name: 'Alpha', url: 'https://alpha.example' },
    ],
  });

  const r = T.removeCustomPool(beta);
  assert.equal(r.ok, true);
  const raw = JSON.parse(readFileSync(POOLS, 'utf8')) as { pools: unknown[] };
  assert.deepEqual(raw.pools, [{ name: 'Alpha', url: 'https://alpha.example' }]);
  if (r.ok) assert.deepEqual(r.model.targets.map((t) => t.label), ['Solo', 'FulgurPool', 'brcpool', 'Alpha']);
});

test('removeCustomPool refuses when the entry it named is gone, or the file is unreadable', () => {
  writePools({ pools: [{ name: 'Alpha', url: 'https://alpha.example' }] });
  const alpha = T.buildTargetModel({ MINER_POOL: 'solo' }).targets[3]!;

  writePools({ pools: [] });
  assert.equal(refused(T.removeCustomPool(alpha)), T.POOLS_FILE_CHANGED);

  writePools('{ not json');
  const before = readFileSync(POOLS, 'utf8');
  assert.equal(refused(T.removeCustomPool(alpha)), T.POOLS_FILE_BROKEN);
  assert.equal(readFileSync(POOLS, 'utf8'), before);
});
