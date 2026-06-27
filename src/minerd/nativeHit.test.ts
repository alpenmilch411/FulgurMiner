import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isValidNativeHit } from './nativeGrindPool.js';

// a stale/replaced native binary could emit an out-of-slot nonce or a malformed
// hash; forwarding it would post an INVALID pool share. isValidNativeHit gates it.

const HASH = 'a'.repeat(64);

test('isValidNativeHit: accepts an in-range integer nonce + 64-hex hash', () => {
  assert.equal(isValidNativeHit(5, HASH, 0, 10), true);
  assert.equal(isValidNativeHit(0, HASH, 0, 10), true); // inclusive start
  assert.equal(isValidNativeHit(9, HASH, 0, 10), true);
});

test('isValidNativeHit: rejects out-of-slot / malformed hits', () => {
  assert.equal(isValidNativeHit(10, HASH, 0, 10), false);            // == end (exclusive)
  assert.equal(isValidNativeHit(-1, HASH, 0, 10), false);            // below start
  assert.equal(isValidNativeHit(11, HASH, 0, 10), false);           // above range
  assert.equal(isValidNativeHit(1.5, HASH, 0, 10), false);          // non-integer
  assert.equal(isValidNativeHit(Number.NaN, HASH, 0, 10), false);
  assert.equal(isValidNativeHit(5, 'a'.repeat(63), 0, 10), false);  // short hash
  assert.equal(isValidNativeHit(5, 'a'.repeat(65), 0, 10), false);  // long hash
  assert.equal(isValidNativeHit(5, 'g'.repeat(64), 0, 10), false);  // non-hex
  assert.equal(isValidNativeHit(5, undefined, 0, 10), false);
  assert.equal(isValidNativeHit(5, 12345, 0, 10), false);
});
