import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { smartStartDuty, CONSIDERATE_START } from './smartController.js';

// The pool path is the DEFAULT path (an unset MINER_POOL follows FulgurPool), but
// runPoolClient is network-bound and has no unit coverage — which is exactly how it
// kept seeding the grind from the leftover MINER_THROTTLE after the solo path was
// fixed: Smart Max started at the stale manual value (e.g. 0.75) and crawled up at
// 5%/25s instead of going straight to full tilt.
//
// There is no way to assert the live behavior here without a pool, so we guard the
// invariant at the source: whatever poolClient hands to the grind pool and to the
// SmartController must be the MODE-derived start duty, never the raw throttle.

const SRC = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), 'poolClient.ts'),
  'utf-8',
);

test('smartStartDuty: the mode picks the start, not MINER_THROTTLE', () => {
  // Max goes straight to full tilt no matter what the manual throttle was left at.
  assert.equal(smartStartDuty('max', 0.25), 1);
  assert.equal(smartStartDuty('max', 1), 1);
  // Considerate starts eased; the demand loop yields further from there.
  assert.equal(smartStartDuty('considerate', 0.25), CONSIDERATE_START);
  // Manual is the one mode that still honors the user's throttle verbatim.
  assert.equal(smartStartDuty('off', 0.25), 0.25);
  assert.equal(smartStartDuty('off', 1), 1);
});

test('poolClient seeds the grind pool from the mode-derived duty, not the raw throttle', () => {
  assert.match(SRC, /import \{[^}]*smartStartDuty[^}]*\} from '\.\/smartController\.js'/);
  assert.match(SRC, /const startDuty = smartStartDuty\(smart, throttle\)/);

  assert.match(SRC, /new NativeGrindPool\(workers, startDuty\)/);
  assert.match(SRC, /new GrindPool\(workers, startDuty\)/);

  // Regression: these are what shipped broken.
  assert.doesNotMatch(SRC, /new NativeGrindPool\(workers, throttle\)/);
  assert.doesNotMatch(SRC, /new GrindPool\(workers, throttle\)/);
});

test('poolClient seeds the SmartController from the mode-derived duty', () => {
  assert.match(SRC, /\{ start: startDuty \}/);
  assert.doesNotMatch(SRC, /\{ start: throttle \}/);
});

test('poolClient reports the duty it actually starts at', () => {
  // start.ts builds the status object from cfg.throttle BEFORE the smart mode is
  // applied, so the pool path must correct it or the startup line shows the stale
  // manual value while the grind runs at something else.
  assert.match(SRC, /status\.throttle = startDuty;/);
});
