// src/minerd/settings.test.ts
//
// The plain readline settings menu (`npm run settings`) — parity with the
// arrow-key menu (menu.ts) on the "where to mine" picker and the throttle
// editor, both of which now route through the SAME shared targets.ts /
// selectors.ts functions instead of a second, hand-duplicated copy.
//
// TEMP CWD, AND WHY THE IMPORT IS DYNAMIC: settings.ts pulls in targets.ts,
// which pulls in envLocal.ts, which resolves ENV_FILE/POOLS_FILE from
// process.cwd() at MODULE LOAD time. So we chdir into a temp dir BEFORE
// importing settings.js — a static import would bind the developer's real
// .env.local / pools.json (same trap targets.test.ts and menu.test.ts document).
// `node --test` runs each test FILE in its own child process, so the chdir
// cannot leak into another suite.
//
// DRIVING "THE SETTINGS PATH": runSettings() is hardwired to real
// process.stdin for input in production, so it takes an optional
// `customInput` Readable (settings.ts's own doc comment explains it exists
// for exactly this file). Console output goes through the real console/
// process.stdout either way, so it is captured by temporarily swapping
// process.stdout.write — the same technique menu.test.ts's withMutedStdout
// uses, just capturing instead of muting.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';

const TMP = mkdtempSync(path.join(os.tmpdir(), 'fulgur-settings-'));
process.chdir(TMP);

const ENV_LOCAL = path.join(TMP, '.env.local');
const POOLS = path.join(TMP, 'pools.json');

const S = await import('./settings.js');
const T = await import('./targets.js');

beforeEach(() => {
  for (const f of [ENV_LOCAL, `${ENV_LOCAL}.bak`, POOLS, `${POOLS}.bak`]) if (existsSync(f)) rmSync(f);
  delete process.env.MINER_POOL;
  delete process.env.MINER_THROTTLE;
  delete process.env.MINER_SMART;
});

/** Write pools.json — an object is JSON-stringified, a string is written verbatim (for broken files). */
function writePools(json: unknown): void {
  writeFileSync(POOLS, typeof json === 'string' ? json : JSON.stringify(json, null, 2) + '\n');
}

/**
 * A Readable that feeds one scripted answer per line, in the exact order
 * runSettings will `question()` for them.
 *
 * ONE LINE PER CHUNK, PACED WITH setImmediate — NOT ONE BIG PUSH: readline
 * parses every complete line out of a single incoming chunk SYNCHRONOUSLY,
 * emitting a 'line' event for each. `rl.question()` only attaches a
 * ONE-SHOT 'line' listener for the answer it is currently awaiting, so if
 * every scripted line arrived in one chunk, only the FIRST 'line' event
 * would have a listener — the rest would fire into the void before the
 * awaited code ever got a chance to call question() again, and the next
 * question() would then wait forever for input that already came and went.
 * Pacing each push with a setImmediate (a macrotask) guarantees it lands
 * only after every pending microtask — including the chain of awaits that
 * gets the caller back to its next question() call — has drained.
 *
 * Also deliberately NEVER ended (no push(null)): readline auto-closes its
 * Interface the moment the input stream sees 'end', which would race a
 * still-pending question() and throw ERR_USE_AFTER_CLOSE. Each script below
 * ends on an explicit 'q' (or blank Enter), which is what actually resolves
 * runSettings() and closes the interface via its own `finally { rl.close() }`.
 */
function scriptedInput(lines: string[]): Readable {
  const rs = new Readable({ read() { /* fed asynchronously below */ } });
  void (async () => {
    for (const line of lines) {
      rs.push(`${line}\n`);
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  })();
  return rs;
}

/**
 * Run runSettings() end to end against a scripted answer list, and return
 * everything it printed (console.log + the readline prompts themselves).
 *
 * TEE, NEVER SWALLOW: `node --test` runs this file as its own child process
 * and reports results back to the parent by writing serialized test-protocol
 * data over this SAME process.stdout — menu.test.ts's withMutedStdout can get
 * away with discarding writes because it only wraps a single synchronous
 * handleKey() call (no event-loop turn for the test runner's own writes to
 * land in between). runSettings() is async with many awaited question()
 * calls, so there are plenty of such turns; a version of this helper that
 * discarded writes instead of forwarding them corrupted that protocol and
 * hung the whole run waiting for a completion message that never arrived.
 * Forwarding every write unmodified keeps the parent's stream byte-identical
 * to an unintercepted run — we just also keep our own copy.
 */
async function runScript(answers: string[]): Promise<string> {
  const chunks: string[] = [];
  const realWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
    chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
    return (realWrite as (...a: unknown[]) => boolean)(chunk, ...rest);
  }) as typeof process.stdout.write;
  try {
    await S.runSettings(scriptedInput(answers));
  } finally {
    process.stdout.write = realWrite;
  }
  return chunks.join('');
}

// -- parity: both UIs route through the SAME shared functions ----------------

test('parity: settings.ts and menu.ts both call the shared targets.ts/selectors.ts writers, and neither duplicates a write', () => {
  const settingsSrc = readFileSync(new URL('./settings.ts', import.meta.url), 'utf8');
  const menuSrc = readFileSync(new URL('./menu.ts', import.meta.url), 'utf8');
  for (const [name, src] of [['settings.ts', settingsSrc], ['menu.ts', menuSrc]] as const) {
    assert.match(src, /persistTarget\(/, `${name}: expected a persistTarget( call`);
    assert.match(src, /addCustomPool\(/, `${name}: expected an addCustomPool( call`);
    assert.match(src, /removeCustomPool\(/, `${name}: expected a removeCustomPool( call`);
    assert.match(src, /parseThrottle\(/, `${name}: expected a parseThrottle( call`);
    // The one MINER_POOL writer is persistTarget — a UI that also calls
    // persist({ MINER_POOL... directly has grown a second, driftable writer.
    assert.doesNotMatch(
      src,
      /persist\(\s*\{\s*MINER_POOL/,
      `${name}: must not persist MINER_POOL directly — persistTarget is the only writer`,
    );
  }
});

// -- unset MINER_POOL still resolves to FulgurPool ---------------------------

test('unset MINER_POOL still resolves to FulgurPool — printed on entry, semantics unchanged', async () => {
  const out = await runScript(['q']);
  assert.match(out, /Where to mine\s+\(current FulgurPool\)/);
});

// -- add a pool ----------------------------------------------------------------

test('add a pool through the settings path — validated + written via targets.ts, confirmed before "saved" is claimed', async () => {
  const out = await runScript(['2', 'a', 'MyPool', 'https://a.example', '', 'q']);
  assert.match(out, /Added MyPool\./);
  const raw = JSON.parse(readFileSync(POOLS, 'utf8')) as { pools: { name: string; url: string }[] };
  assert.deepEqual(raw.pools, [{ name: 'MyPool', url: 'https://a.example' }]);
});

test('adding a pool with a bad URL is refused with validateNewPool\'s reason, and writes nothing', async () => {
  const out = await runScript(['2', 'a', 'MyPool', 'not a url', '', '', 'q']);
  assert.match(out, /contains spaces/);
  assert.ok(!existsSync(POOLS), 'a rejected entry must never create pools.json');
});

// -- remove a pool ---------------------------------------------------------------

test('remove a pool through the settings path — custom only, behind an explicit y/N confirm', async () => {
  writePools({ pools: [{ name: 'MyPool', url: 'https://a.example' }] });
  // targets: [Solo, FulgurPool*, brcpool, MyPool] — MyPool is row 4.
  const out = await runScript(['2', 'r', '4', 'y', '', 'q']);
  assert.match(out, /Removed MyPool\./);
  const raw = JSON.parse(readFileSync(POOLS, 'utf8')) as { pools: unknown[] };
  assert.deepEqual(raw.pools, []);
});

test('declining the y/N confirm removes nothing', async () => {
  writePools({ pools: [{ name: 'MyPool', url: 'https://a.example' }] });
  const out = await runScript(['2', 'r', '4', 'n', '', 'q']);
  assert.match(out, /Cancelled\./);
  const raw = JSON.parse(readFileSync(POOLS, 'utf8')) as { pools: unknown[] };
  assert.equal(raw.pools.length, 1);
});

test('removing the active pool is refused with REMOVE_ACTIVE_REFUSAL — not a retyped copy of it', async () => {
  writePools({ pools: [{ name: 'MyPool', url: 'https://a.example' }] });
  process.env.MINER_POOL = 'https://a.example';
  const out = await runScript(['2', 'r', '4', 'y', '', 'q']);
  assert.ok(out.includes(T.REMOVE_ACTIVE_REFUSAL), `expected the active-pool refusal in output, got:\n${out}`);
  const raw = JSON.parse(readFileSync(POOLS, 'utf8')) as { pools: unknown[] };
  assert.equal(raw.pools.length, 1, 'the active pool must survive the refused removal');
});

test('a built-in cannot be removed — REMOVE_BUILTIN_REFUSAL, not a retyped copy of it', async () => {
  const out = await runScript(['2', 'r', '2', 'y', '', 'q']); // row 2 = FulgurPool
  assert.ok(out.includes(T.REMOVE_BUILTIN_REFUSAL), `expected the built-in refusal in output, got:\n${out}`);
});

// -- pools.json problems are surfaced as text ---------------------------------

test('pools.json issues are printed as entry + reason text', async () => {
  writePools('{ not json');
  const out = await runScript(['2', '', 'q']);
  assert.match(out, /pools\.json:\s*\d+\s*problem/);
  assert.ok(out.includes('is not valid JSON'), `expected the issue reason in output, got:\n${out}`);
});

// -- throttle: presets + Custom..., via the ONE shared validator -------------

test('a custom throttle of 0.77 persists exactly "0.77" (typed value, never rounded)', async () => {
  const out = await runScript(['5', 'c', '0.77', 'q']);
  assert.match(out, /Throttle set to 0\.77\./);
  const body = readFileSync(ENV_LOCAL, 'utf8');
  assert.match(body, /^MINER_THROTTLE=0\.77$/m);
});

test('an out-of-range custom throttle errors (parseThrottle\'s reason) and persists nothing', async () => {
  const out = await runScript(['5', 'c', '2', '', 'q']);
  assert.match(out, /Enter a number from 0\.05 to 1/);
  assert.ok(!existsSync(ENV_LOCAL) || !/^MINER_THROTTLE=/m.test(readFileSync(ENV_LOCAL, 'utf8')));
});

test('a non-numeric custom throttle is refused the same way — no silent clamp', async () => {
  const out = await runScript(['5', 'c', 'fast', '', 'q']);
  assert.match(out, /Enter a number from 0\.05 to 1/);
  assert.ok(!existsSync(ENV_LOCAL) || !/^MINER_THROTTLE=/m.test(readFileSync(ENV_LOCAL, 'utf8')));
});

test('a preset throttle selection persists that preset\'s value', async () => {
  const out = await runScript(['5', '3', 'q']); // [3] = Balanced (0.50)
  assert.match(out, /Throttle set to 0\.50 \(Balanced\)\./);
  const body = readFileSync(ENV_LOCAL, 'utf8');
  assert.match(body, /^MINER_THROTTLE=0\.5$/m);
});

test('Smart mode shows the shared About-pane copy and the Throttle row is not editable', async () => {
  process.env.MINER_SMART = 'considerate';
  const out = await runScript(['5', 'q']);
  assert.ok(out.includes('the auto-tuner sets the rate'), `expected SMART_THROTTLE_EXPLAIN text, got:\n${out}`);
  assert.ok(!existsSync(ENV_LOCAL) || !/^MINER_THROTTLE=/m.test(readFileSync(ENV_LOCAL, 'utf8')));
});

test('full-blast caution (imported verbatim from menuCopy.ts) shows its actionable last line at Manual + 100%', async () => {
  const out = await runScript(['5', '5', 'q']); // [5] = Max (1.00)
  assert.ok(out.includes('Full blast'), `expected the caution heading, got:\n${out}`);
  // The bug this task closes: a prior re-derivation of this copy silently
  // dropped the actionable last line (the Considerate recommendation).
  assert.ok(out.includes('Considerate'), `expected the caution's actionable last line, got:\n${out}`);
});
