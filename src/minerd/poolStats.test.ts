import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mapBalance, mapJackpot } from './poolStats.js';

test('mapBalance: valid -> pool-balance; invalid -> null', () => {
  assert.deepEqual(mapBalance({ address: 'a', earnedBrc: 1.5, pendingBrc: 0.5, paidBrc: 1, currency: 'BRC' }),
    { kind: 'pool-balance', earnedBrc: 1.5, pendingBrc: 0.5, paidBrc: 1 });
  assert.equal(mapBalance({ error: 'nope' }), null);
  assert.equal(mapBalance(null), null);
});

test('mapJackpot: valid -> JackpotInfo; invalid -> null', () => {
  assert.deepEqual(mapJackpot({ finderBonusPct: 0.03, yourBlockStrikes: 2, lastWinner: 'x', lastStrikeHeight: 99 }),
    { finderBonusPct: 0.03, yourBlockStrikes: 2, lastWinner: 'x', lastStrikeHeight: 99 });
  assert.equal(mapJackpot({}), null);
  assert.equal(mapJackpot(null), null);
});
