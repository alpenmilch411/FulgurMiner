import { test } from 'node:test';
import assert from 'node:assert/strict';
import { partitionNonceSpace, NONCE_SPACE } from './partition.js';

test('partitionNonceSpace default: full [0,2^32) disjoint contiguous cover (unchanged)', () => {
  const r = partitionNonceSpace(4);
  assert.equal(r.length, 4);
  assert.equal(r[0]!.start, 0);
  assert.equal(r[3]!.end, NONCE_SPACE);
  for (let i = 0; i < r.length - 1; i++) assert.equal(r[i]!.end, r[i + 1]!.start); // contiguous
  const step = Math.floor(NONCE_SPACE / 4);
  assert.deepEqual(r[0], { start: 0, end: step });
});

test('partitionNonceSpace honors a served slot [start,end)', () => {
  const r = partitionNonceSpace(2, 100, 200);
  assert.deepEqual(r, [{ start: 100, end: 150 }, { start: 150, end: 200 }]);
});

test('partitionNonceSpace: slot slices stay within range, last ends exactly at end', () => {
  const r = partitionNonceSpace(3, 8388608, 12582912); // a real pool slot
  assert.equal(r[0]!.start, 8388608);
  assert.equal(r[2]!.end, 12582912);
  for (let i = 0; i < r.length - 1; i++) assert.equal(r[i]!.end, r[i + 1]!.start);
});

test('partitionNonceSpace: more workers than nonces -> no crash, last covers end', () => {
  const r = partitionNonceSpace(5, 0, 2);
  assert.equal(r.length, 5);
  assert.equal(r[4]!.end, 2);
  for (const x of r) assert.ok(x.end >= x.start); // never inverted
});
