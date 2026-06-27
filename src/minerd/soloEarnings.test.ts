import { test } from 'node:test';
import assert from 'node:assert/strict';
import { soloEarnedBrc } from './reporter.js';

test('soloEarnedBrc: sums halving-accurate block reward in BRC', () => {
  assert.equal(soloEarnedBrc([]), 0);
  // first reward is 50 BRC; two early blocks => 100 BRC (before any halving)
  assert.equal(soloEarnedBrc([1, 2]), 100);
});
