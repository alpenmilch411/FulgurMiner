// Unit tests for envLocal (node:test - vitest is src/chain only).
//
// Two invariants, both regression-pinned, both learned from a real user's file:
//   1. persist() SPLICES the raw .env.local text - comments, blank lines, key
//      order and unknown keys all survive a write. It used to regenerate the file
//      from a parsed Record, which deleted every comment and every blank line.
//   2. A pools.json write NEVER deletes what it could not parse - a malformed
//      entry, an unknown per-entry key and the top-level "_comment" all survive an
//      add/remove round-trip.
//
// Every test works in its own temp dir, so the developer's real .env.local and
// pools.json are never touched.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import {
  persist,
  readEnvFile,
  readPoolsFile,
  writePoolsFile,
  isValidPoolUrl,
  POOLS_FILE_ISSUE,
} from './envLocal.js';

/** A fresh temp dir per call, with the paths of the two files envLocal manages. */
function tmpFiles(): { env: string; pools: string } {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'fulgur-envlocal-'));
  return { env: path.join(dir, '.env.local'), pools: path.join(dir, 'pools.json') };
}

/** The kind of .env.local that .env.example tells people to hand-write. */
const HAND_WRITTEN_ENV = [
  '# FulgurMiner - my settings',
  '# do NOT delete this file',
  '',
  `MINER_PUBKEY=${'aa'.repeat(32)}`,
  '',
  '# commented out on purpose:',
  '# MINER_WORKERS=4',
  'MINER_THROTTLE=0.77',
  'SOMETHING_ELSE=keep me',
  '',
].join('\n');

test('persist() rewrites the matching line IN PLACE - comments, blank lines, order and unknown keys are byte-identical afterwards', () => {
  const { env } = tmpFiles();
  writeFileSync(env, HAND_WRITTEN_ENV);

  persist({ MINER_THROTTLE: '0.9' }, env);

  const after = readFileSync(env, 'utf8');
  assert.equal(after, HAND_WRITTEN_ENV.replace('MINER_THROTTLE=0.77', 'MINER_THROTTLE=0.9'));
  // Spelled out, because this is the bug:
  assert.match(after, /# do NOT delete this file/);
  assert.match(after, /# MINER_WORKERS=4/);
  assert.match(after, /\n\n/);
  assert.match(after, /SOMETHING_ELSE=keep me/);
  assert.equal(readEnvFile(env).MINER_THROTTLE, '0.9');
});

test('persist() appends a key the file does not have, at the end, and touches nothing else', () => {
  const { env } = tmpFiles();
  writeFileSync(env, HAND_WRITTEN_ENV);

  persist({ MINER_POOL: 'https://pool.fulgurpool.xyz' }, env);

  assert.equal(readFileSync(env, 'utf8'), `${HAND_WRITTEN_ENV}MINER_POOL=https://pool.fulgurpool.xyz\n`);
});

test('persist(undefined) deletes ONLY its own line', () => {
  const { env } = tmpFiles();
  writeFileSync(env, HAND_WRITTEN_ENV);

  persist({ MINER_THROTTLE: undefined }, env);

  const after = readFileSync(env, 'utf8');
  assert.equal(after, HAND_WRITTEN_ENV.replace('MINER_THROTTLE=0.77\n', ''));
  assert.equal(readEnvFile(env).MINER_THROTTLE, undefined);
  assert.match(after, /# MINER_WORKERS=4/);                  // the COMMENTED-OUT key is untouched
  assert.equal(readEnvFile(env).SOMETHING_ELSE, 'keep me');
});

test('persist() creates the file 0600 when there is none, with a trailing newline', () => {
  const { env } = tmpFiles();
  assert.equal(existsSync(env), false);

  persist({ MINER_POOL: 'solo' }, env);

  assert.equal(readFileSync(env, 'utf8'), 'MINER_POOL=solo\n');
  assert.equal(statSync(env).mode & 0o777, 0o600);
});

test('persist() collapses duplicate lines for the key it writes (readEnvFile is last-wins - a stale duplicate would shadow the new value)', () => {
  const { env } = tmpFiles();
  writeFileSync(env, 'MINER_POOL=https://old.example\n# note\nMINER_POOL=https://older.example\n');

  persist({ MINER_POOL: 'solo' }, env);

  const after = readFileSync(env, 'utf8');
  assert.equal(after, 'MINER_POOL=solo\n# note\n');
  assert.equal(readEnvFile(env).MINER_POOL, 'solo');
  assert.equal(after.match(/MINER_POOL=/g)?.length, 1);
});

test('persist() does not treat an Object.prototype name as an update key', () => {
  const { env } = tmpFiles();
  writeFileSync(env, 'constructor=keep me\nMINER_PUBKEY=ab\n');

  persist({ MINER_POOL: 'solo' }, env);   // `'constructor' in updates` is TRUE via the prototype chain

  assert.match(readFileSync(env, 'utf8'), /^constructor=keep me$/m);
});

// -- pools.json: the read side -----------------------------------------------

/** A hand-written pools.json: a scheme-less url, an entry we cannot use, unknown keys. */
const HAND_WRITTEN_POOLS = JSON.stringify(
  {
    _comment: 'hand-written - keep me',
    pools: [
      { name: 'Alpha', url: 'pool.alpha.example', _note: 'my LAN box' },
      { name: 'Broken' },
      { name: 'Beta', url: 'https://pool.beta.example/', page: 'beta.example' },
    ],
  },
  null,
  2,
) + '\n';

/** Run fn with console.{log,warn,error} captured; returns everything it printed. */
function captureConsole(fn: () => void): string[] {
  const printed: string[] = [];
  const orig = { log: console.log, warn: console.warn, error: console.error };
  const grab = (...a: unknown[]): void => { printed.push(a.map(String).join(' ')); };
  console.log = grab; console.warn = grab; console.error = grab;
  try { fn(); } finally { console.log = orig.log; console.warn = orig.warn; console.error = orig.error; }
  return printed;
}

test('readPoolsFile: a scheme-less url AND page are accepted and canonicalised; a bad entry becomes an issue, not a silent drop; nothing is printed', () => {
  const { pools } = tmpFiles();
  writeFileSync(pools, HAND_WRITTEN_POOLS);

  let file!: ReturnType<typeof readPoolsFile>;
  const printed = captureConsole(() => { file = readPoolsFile(pools); });

  assert.deepEqual(printed, []);                          // the two console.warns are GONE
  assert.equal(file.rawList.length, 3);                   // the raw array is carried through untouched
  assert.deepEqual(file.extraKeys, { _comment: 'hand-written - keep me' });
  assert.deepEqual(file.pools, [
    { entry: { name: 'Alpha', url: 'https://pool.alpha.example' }, rawIndex: 0 },   // item 5: scheme-less now LOADS
    { entry: { name: 'Beta', url: 'https://pool.beta.example', page: 'https://beta.example' }, rawIndex: 2 },
  ]);
  assert.equal(file.issues.length, 1);
  assert.equal(file.issues[0]!.entry, 'Broken');
  assert.match(file.issues[0]!.reason, /url/);
});

test('readPoolsFile: a missing file is empty and silent; unparseable JSON and a wrong shape are FILE-level issues (the wrong shape is completely silent today)', () => {
  const { pools } = tmpFiles();
  assert.deepEqual(readPoolsFile(pools), { pools: [], issues: [], rawList: [], extraKeys: {} });

  writeFileSync(pools, '{ not json');
  let broken!: ReturnType<typeof readPoolsFile>;
  const printed = captureConsole(() => { broken = readPoolsFile(pools); });
  assert.deepEqual(printed, []);
  assert.deepEqual(broken.pools, []);
  assert.deepEqual(broken.rawList, []);
  assert.equal(broken.issues[0]!.entry, POOLS_FILE_ISSUE);

  writeFileSync(pools, '{"pools": {}}');
  const wrongShape = readPoolsFile(pools);
  assert.deepEqual(wrongShape.pools, []);
  assert.equal(wrongShape.issues[0]!.entry, POOLS_FILE_ISSUE);
});

test('readPoolsFile: a bad `page` keeps the pool and drops only the link', () => {
  const { pools } = tmpFiles();
  writeFileSync(pools, JSON.stringify([{ name: 'Alpha', url: 'https://pool.alpha.example', page: 'ftp://nope' }]));

  const file = readPoolsFile(pools);

  assert.deepEqual(file.pools, [{ entry: { name: 'Alpha', url: 'https://pool.alpha.example' }, rawIndex: 0 }]);
  assert.equal(file.issues.length, 1);
  assert.match(file.issues[0]!.reason, /page/);
});

test('readPoolsFile: a bare array is read too, and an entry with no name is positioned, not anonymous', () => {
  const { pools } = tmpFiles();
  writeFileSync(pools, JSON.stringify([{ name: 'Alpha', url: 'https://pool.alpha.example' }, { nope: 1 }]));

  const file = readPoolsFile(pools);

  assert.deepEqual(file.extraKeys, {});                    // a bare array has no wrapper keys
  assert.equal(file.rawList.length, 2);
  assert.equal(file.pools.length, 1);
  assert.equal(file.issues[0]!.entry, 'entry 2');
  assert.match(file.issues[0]!.reason, /name/);
});

test('isValidPoolUrl now accepts a scheme-less host, and still rejects control chars and a wrong scheme', () => {
  assert.equal(isValidPoolUrl('pool.foo.org'), true);
  assert.equal(isValidPoolUrl('https://pool.foo.org'), true);
  assert.equal(isValidPoolUrl('\x07evil'), false);
  assert.equal(isValidPoolUrl('ftp://x.org'), false);
  assert.equal(isValidPoolUrl(''), false);
});

test('envLocal never prints - the two console.warn calls do not come back', () => {
  const src = readFileSync(new URL('./envLocal.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /console\./);          // not even in a comment: the next person greps for this
});

// -- pools.json: the write side (this is where the data loss was) -------------

test('writePoolsFile: an added pool appends to rawList, and the malformed entry, the unknown per-entry key and the top-level "_comment" all survive', () => {
  const { pools } = tmpFiles();
  writeFileSync(pools, HAND_WRITTEN_POOLS);

  // Exactly what targets.addCustomPool will do: read, push onto rawList, write.
  const file = readPoolsFile(pools);
  file.rawList.push({ name: 'Gamma', url: 'https://pool.gamma.example' });
  writePoolsFile(file, pools);

  const raw = JSON.parse(readFileSync(pools, 'utf8')) as { _comment: string; pools: Record<string, unknown>[] };
  assert.equal(raw._comment, 'hand-written - keep me');                                   // the wrapper's keys survive
  assert.equal(raw.pools.length, 4);
  assert.deepEqual(raw.pools[1], { name: 'Broken' });                                     // THE PIN: it used to be deleted forever
  assert.deepEqual(raw.pools[0], { name: 'Alpha', url: 'pool.alpha.example', _note: 'my LAN box' });  // unknown key AND the user's spelling
  assert.deepEqual(raw.pools[3], { name: 'Gamma', url: 'https://pool.gamma.example' });
  assert.deepEqual(readPoolsFile(pools).pools.map((p) => p.entry.name), ['Alpha', 'Beta', 'Gamma']);
  assert.equal(readPoolsFile(pools).issues.length, 1);                                    // Broken is still reported, not lost
  assert.equal(statSync(pools).mode & 0o777, 0o600);
});

test('writePoolsFile: a removal splices ONLY that rawIndex, and keeps a .bak of what was there before', () => {
  const { pools } = tmpFiles();
  writeFileSync(pools, HAND_WRITTEN_POOLS);

  // Exactly what targets.removeCustomPool will do: read, splice by rawIndex, write.
  const file = readPoolsFile(pools);
  const beta = file.pools.find((p) => p.entry.name === 'Beta')!;
  assert.equal(beta.rawIndex, 2);                        // rawIndex is the RAW slot (2), not the parsed one (1)
  file.rawList.splice(beta.rawIndex, 1);
  writePoolsFile(file, pools);

  const raw = JSON.parse(readFileSync(pools, 'utf8')) as { _comment: string; pools: Record<string, unknown>[] };
  assert.equal(raw._comment, 'hand-written - keep me');
  assert.deepEqual(raw.pools.map((p) => p.name), ['Alpha', 'Broken']);   // Beta, and only Beta, is gone
  assert.equal(readFileSync(`${pools}.bak`, 'utf8'), HAND_WRITTEN_POOLS);
});

test('writePoolsFile: a bare-array file is written back in the { pools: [...] } shape, losing nothing', () => {
  const { pools } = tmpFiles();
  writeFileSync(pools, JSON.stringify([{ name: 'Alpha', url: 'https://pool.alpha.example' }, { nope: 1 }]));

  const file = readPoolsFile(pools);
  file.rawList.push({ name: 'Gamma', url: 'https://pool.gamma.example' });
  writePoolsFile(file, pools);

  const raw = JSON.parse(readFileSync(pools, 'utf8')) as { pools: Record<string, unknown>[] };
  assert.equal(raw.pools.length, 3);
  assert.deepEqual(raw.pools[1], { nope: 1 });           // still there, untouched
});
