import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MODE_OPTIONS,
  currentMode,
  modeLabel,
  nextMode,
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
