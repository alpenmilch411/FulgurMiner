import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MODE_OPTIONS,
  currentMode,
  modeLabel,
  nextMode,
  parseThrottle,
  throttleLabel,
} from './selectors.js';

test('mode options expose the expected labels', () => {
  assert.deepEqual(
    MODE_OPTIONS.map((option) => [option.value, option.label]),
    [
      ['off', 'Manual'],
      ['max', 'Smart: Max'],
      ['considerate', 'Smart: Considerate'],
    ],
  );
});

test('currentMode mirrors MINER_SMART parsing', () => {
  assert.equal(currentMode('max'), 'max');
  assert.equal(currentMode('CONSIDERATE'), 'considerate');
  assert.equal(currentMode(undefined), 'off');
  assert.equal(currentMode('garbage'), 'off');
});

test('nextMode cycles forward and backward with wrapping', () => {
  assert.equal(nextMode('off', 1), 'max');
  assert.equal(nextMode('max', 1), 'considerate');
  assert.equal(nextMode('considerate', 1), 'off');

  assert.equal(nextMode('off', -1), 'considerate');
  assert.equal(nextMode('considerate', -1), 'max');
  assert.equal(nextMode('max', -1), 'off');
});

test('modeLabel defaults to Manual', () => {
  assert.equal(modeLabel(undefined), 'Manual');
});

// -- parseThrottle: the ONE shared validator for the Custom... editor (and, in a
//    later task, settings.ts's own custom prompt) -----------------------------

test('parseThrottle accepts the full 0.05-1 inclusive range, and trims whitespace', () => {
  assert.deepEqual(parseThrottle('0.05'), { ok: true, value: 0.05 });
  assert.deepEqual(parseThrottle('1'), { ok: true, value: 1 });
  assert.deepEqual(parseThrottle('1.00'), { ok: true, value: 1 });
  assert.deepEqual(parseThrottle('0.77'), { ok: true, value: 0.77 });
  assert.deepEqual(parseThrottle('  0.5  '), { ok: true, value: 0.5 });
});

test('parseThrottle rejects out-of-range and non-numeric input with a reason — NEVER a silent clamp', () => {
  for (const bad of ['2', '0', '0.04', '1.01', 'abc', '', '   ']) {
    const r = parseThrottle(bad);
    assert.equal(r.ok, false, `expected ${JSON.stringify(bad)} to be rejected`);
    if (!r.ok) assert.ok(r.reason.length > 0, `expected a reason for ${JSON.stringify(bad)}`);
  }
});

// -- throttleLabel: stop lying about a hand-set value being a preset ----------

test('throttleLabel names an exact preset match; a non-preset value reads "custom", not the nearest preset', () => {
  assert.equal(throttleLabel('0.25'), '0.25  Quiet');
  assert.equal(throttleLabel('0.75'), '0.75  Default');
  assert.equal(throttleLabel('1.00'), '1.00  Max');
  assert.equal(throttleLabel(undefined), '0.75  Default');
  // 0.77 is nearest to 0.75 (Default) under the OLD snap-to-nearest behavior —
  // it must NOT render as "Default" now that the UI can no longer silently
  // relabel a value it does not actually own.
  assert.equal(throttleLabel('0.77'), '0.77  custom');
  // 0.90 is nearest to 1.00 (Max) under the old behavior — same requirement.
  assert.equal(throttleLabel('0.90'), '0.90  custom');
});
