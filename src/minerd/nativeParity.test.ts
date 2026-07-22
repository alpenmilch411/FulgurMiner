import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync, readFileSync, rmSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { nativePowIsCurrent } from './nativeParity.js';
import { sandglassHash } from '../crypto/sandglass.js';
import { SANDGLASS_FORK_HEIGHT } from '../chain/genesis.js';

const HEADER_LEN = 148;
const FORK = SANDGLASS_FORK_HEIGHT;

function toHex(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.length; i++) s += b[i]!.toString(16).padStart(2, '0');
  return s;
}
function headerAtHeight(height: number): Uint8Array {
  const h = new Uint8Array(HEADER_LEN);
  h[0] = (height >>> 24) & 0xff;
  h[1] = (height >>> 16) & 0xff;
  h[2] = (height >>> 8) & 0xff;
  h[3] = height & 0xff;
  return h;
}
/** The digest a CORRECT native binary must SOLVE for nonce 0 at the fork height. */
const GOOD_DIGEST = toHex(sandglassHash(headerAtHeight(FORK)));

const TMP = mkdtempSync(path.join(os.tmpdir(), 'fulgur-nativeparity-'));

/**
 * Write a fake `brc-pow`-shaped node executable. It records "<subcommand> <height>"
 * (parsed from argv) to `<bin>.log` so a test can prove WHAT the probe requested,
 * then behaves per `mode`. `mode` is JS evaluated inside the fake with `sub` (the
 * subcommand) and `height` in scope, and must call print(line)/fail() to respond.
 */
function fakeBin(name: string, body: string): string {
  const p = path.join(TMP, name);
  const src = `#!/usr/bin/env node
const fs = require('node:fs');
const sub = process.argv[2];
const headerHex = process.argv[3] || '';
const height = parseInt(headerHex.slice(0, 8), 16) >>> 0;
fs.writeFileSync(${JSON.stringify(p)} + '.log', sub + ' ' + height);
const GOOD = ${JSON.stringify(GOOD_DIGEST)};
const print = (l) => process.stdout.write(l + '\\n');
const fail = () => process.exit(1);
${body}
`;
  writeFileSync(p, src, { mode: 0o755 });
  chmodSync(p, 0o755);
  return p;
}

test('nativePowIsCurrent: accepts a binary that SOLVES nonce 0 with the correct digest then EXHAUSTS', () => {
  const bin = fakeBin('good', `print('HASHRATE 42'); print('SOLVED 0 ' + GOOD); print('EXHAUSTED');`);
  assert.equal(nativePowIsCurrent(bin), true);
  // Pin the safety-critical probe parameters: it must have exercised `grind` at
  // EXACTLY the fork height (not `hash`, not height 40,000).
  const log = readFileSync(bin + '.log', 'utf8');
  assert.equal(log, `grind ${FORK}`);
});

test('nativePowIsCurrent: REJECTS a stale binary that grinds the old algo (wrong digest)', () => {
  const bin = fakeBin('stale', `print('SOLVED 0 ' + '0'.repeat(64)); print('EXHAUSTED');`);
  assert.equal(nativePowIsCurrent(bin), false);
});

test('nativePowIsCurrent: REJECTS a binary built with the superseded 34,800 fork height', () => {
  // Correct Sandglass only at height >= 34,800; still the old algo (wrong digest) in
  // [33,550, 34,800) — the live range. A probe at height 40,000 would wave it
  // through; probing at the fork height must reject it.
  const bin = fakeBin('fork34800', `
    if (height >= 34800) print('SOLVED 0 ' + GOOD);
    else print('SOLVED 0 ' + '0'.repeat(64));
    print('EXHAUSTED');
  `);
  assert.equal(nativePowIsCurrent(bin), false);
});

test('nativePowIsCurrent: REJECTS a binary whose `grind` is stale even if `hash` is correct', () => {
  // Proves the check exercises the real work path (`grind`), not `hash`.
  const bin = fakeBin('hashonly', `
    if (sub === 'hash') print(GOOD);            // hash branch correct…
    else print('SOLVED 0 ' + '0'.repeat(64));   // …but grind is stale
    print('EXHAUSTED');
  `);
  assert.equal(nativePowIsCurrent(bin), false);
});

test('nativePowIsCurrent: REJECTS a binary that hashes nonce 0 but MISLABELS it SOLVED 1', () => {
  // Correct digest, wrong nonce label → shifted/invalid nonces in real mining.
  const bin = fakeBin('mislabel', `print('SOLVED 1 ' + GOOD); print('EXHAUSTED');`);
  assert.equal(nativePowIsCurrent(bin), false);
});

test('nativePowIsCurrent: REJECTS a binary that ignores continuous=1 (no EXHAUSTED)', () => {
  // Solves correctly but exits after the first hit instead of running the range to
  // completion → in pool mode it would respawn-churn after every share.
  const bin = fakeBin('nocontinuous', `print('SOLVED 0 ' + GOOD);`);
  assert.equal(nativePowIsCurrent(bin), false);
});

test('nativePowIsCurrent: rejects a binary that emits more than one SOLVED line', () => {
  const bin = fakeBin('multisolved', `print('SOLVED 0 ' + GOOD); print('SOLVED 1 ' + GOOD); print('EXHAUSTED');`);
  assert.equal(nativePowIsCurrent(bin), false);
});

test('nativePowIsCurrent: rejects a binary that emits no SOLVED line', () => {
  const bin = fakeBin('nosolved', `print('HASHRATE 100'); print('EXHAUSTED');`);
  assert.equal(nativePowIsCurrent(bin), false);
});

test('nativePowIsCurrent: rejects a binary that exits non-zero', () => {
  const bin = fakeBin('crash', `print('SOLVED 0 ' + GOOD); print('EXHAUSTED'); fail();`);
  assert.equal(nativePowIsCurrent(bin), false);
});

test('nativePowIsCurrent: rejects a missing binary', () => {
  assert.equal(nativePowIsCurrent(path.join(TMP, 'does-not-exist')), false);
});

test('nativePowIsCurrent: accepts trailing whitespace around the digest', () => {
  const bin = fakeBin('trailing', `process.stdout.write('SOLVED 0 ' + GOOD + '  \\n'); print('EXHAUSTED');`);
  assert.equal(nativePowIsCurrent(bin), true);
});

test.after(() => {
  if (existsSync(TMP)) rmSync(TMP, { recursive: true, force: true });
});
