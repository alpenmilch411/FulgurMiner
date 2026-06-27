import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from './config.js';

test('MINER_SMART parses off|max|considerate, defaults off', () => {
  assert.equal(loadConfig({ MINER_PUBKEY: 'aa'.repeat(32) }).smart, 'off');
  assert.equal(loadConfig({ MINER_PUBKEY: 'aa'.repeat(32), MINER_SMART: 'max' }).smart, 'max');
  assert.equal(loadConfig({ MINER_PUBKEY: 'aa'.repeat(32), MINER_SMART: 'CONSIDERATE' }).smart, 'considerate');
  assert.equal(loadConfig({ MINER_PUBKEY: 'aa'.repeat(32), MINER_SMART: 'garbage' }).smart, 'off');
});
