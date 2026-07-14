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
import { persist, readEnvFile } from './envLocal.js';

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
