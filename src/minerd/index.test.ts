// src/minerd/index.test.ts
//
// FIX 1(a): applyMineEnvOverrides() existed only as two unwired helpers
// (envLocal.ts's loadEnvLocalKeys/dropBlankPoolEnv) — `npm run mine` called
// loadConfig() directly and never read .env.local at all, so a MINER_POOL (or
// wallet) saved via the menu/settings was silently ignored by the headless
// path, which then mined FulgurPool instead. This pins the wiring itself:
// main() must call the override BEFORE loadConfig(), and dryrun() (the
// consensus gate) must never call it at all.
//
// TEMP CWD, AND WHY THE IMPORT IS DYNAMIC: applyMineEnvOverrides() reads
// .env.local via envLocal.ts's ENV_FILE, resolved from process.cwd() at
// MODULE LOAD time — same trap start.test.ts/menu.test.ts document. chdir
// BEFORE importing index.js. `node --test` runs each test FILE in its own
// child process, so this cannot leak into another suite.
//
// IMPORTING index.js DOES NOT RUN main(): index.ts only calls it when this
// file is the direct CLI entry point (process.argv[1] === this file), which
// is false under `node --test` — same guard hardfork.test.ts already relies
// on to import validateTemplate from here without launching anything.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync, writeFileSync, existsSync, rmSync, readFileSync } from 'node:fs';

const TMP = mkdtempSync(path.join(os.tmpdir(), 'fulgur-index-'));
process.chdir(TMP);

const ENV_LOCAL = path.join(TMP, '.env.local');

const I = await import('./index.js');

const saved = {
  MINER_POOL: process.env.MINER_POOL,
  MINER_PUBKEY: process.env.MINER_PUBKEY,
  MINER_WORKERS: process.env.MINER_WORKERS,
};

beforeEach(() => {
  if (existsSync(ENV_LOCAL)) rmSync(ENV_LOCAL);
  delete process.env.MINER_POOL;
  delete process.env.MINER_PUBKEY;
  delete process.env.MINER_WORKERS;
});

test.after(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k as keyof typeof saved];
    else process.env[k as keyof typeof saved] = v;
  }
});

const ADDR = 'aa'.repeat(32);

test('applyMineEnvOverrides: a stored MINER_POOL=solo from .env.local is honoured by the headless `mine` path', () => {
  writeFileSync(ENV_LOCAL, `MINER_POOL=solo\nMINER_PUBKEY=${ADDR}\n`);

  I.applyMineEnvOverrides();

  assert.equal(process.env.MINER_POOL, 'solo');
  assert.equal(process.env.MINER_PUBKEY, ADDR);
});

test('applyMineEnvOverrides: a REAL (non-blank) env MINER_POOL still wins over .env.local', () => {
  writeFileSync(ENV_LOCAL, 'MINER_POOL=solo\n');
  process.env.MINER_POOL = 'https://custom.example';

  I.applyMineEnvOverrides();

  assert.equal(process.env.MINER_POOL, 'https://custom.example');
});

test('applyMineEnvOverrides: a blank real-env MINER_POOL= no longer shadows a stored solo choice', () => {
  writeFileSync(ENV_LOCAL, 'MINER_POOL=solo\n');
  process.env.MINER_POOL = ''; // e.g. an exported empty var, or `MINER_POOL= npm run mine`

  I.applyMineEnvOverrides();

  assert.equal(process.env.MINER_POOL, 'solo');
});

test('applyMineEnvOverrides: MINER_WORKERS in .env.local is still IGNORED — the allowlist holds (D9)', () => {
  writeFileSync(ENV_LOCAL, `MINER_POOL=solo\nMINER_WORKERS=8\n`);

  I.applyMineEnvOverrides();

  assert.equal(process.env.MINER_POOL, 'solo');
  assert.equal(process.env.MINER_WORKERS, undefined, 'MINER_WORKERS must stay env-var-only on the headless path');
});

// -- wiring: main() must call it before loadConfig(); dryrun() must never ----

test('index.ts: main() (the headless `mine` path) applies the override BEFORE loadConfig()', () => {
  const src = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
  const mainStart = src.indexOf('async function main(');
  assert.ok(mainStart >= 0, 'expected an async function main(');
  const mainBody = src.slice(mainStart);
  const overrideAt = mainBody.indexOf('applyMineEnvOverrides()');
  const loadConfigAt = mainBody.indexOf('loadConfig()');
  assert.ok(overrideAt >= 0, 'main() must call applyMineEnvOverrides()');
  assert.ok(loadConfigAt >= 0, 'main() must call loadConfig()');
  assert.ok(overrideAt < loadConfigAt, 'applyMineEnvOverrides() must run BEFORE loadConfig()');
});

test('index.ts: dryrun() (the consensus gate) never reads .env.local — no override call anywhere in its body', () => {
  const src = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
  const dryrunStart = src.indexOf('async function dryrun(');
  const mainStart = src.indexOf('async function main(');
  assert.ok(dryrunStart >= 0 && mainStart > dryrunStart, 'expected dryrun() defined before main()');
  const dryrunBody = src.slice(dryrunStart, mainStart);
  assert.doesNotMatch(
    dryrunBody,
    /applyMineEnvOverrides|loadEnvLocalKeys|dropBlankPoolEnv/,
    'dryrun() must stay pristine — it writes no snapshot and must read no config file',
  );
});
