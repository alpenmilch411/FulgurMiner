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

test('partition: narrow slot (width < workers) still splits across workers, no empty ranges', () => {
  // 5-wide slot, 8 workers: every worker that gets work must get a non-empty range,
  // ranges disjoint + contiguous + cover exactly [100,105).
  const ranges = partitionNonceSpace(8, 100, 105);
  const nonEmpty = ranges.filter((r) => r.end > r.start);
  assert.equal(nonEmpty.length, 5, 'exactly 5 workers get a 1-wide range');
  assert.equal(ranges[0]!.start, 100);
  assert.equal(ranges[ranges.length - 1]!.end, 105);
  for (let i = 1; i < ranges.length; i++) assert.equal(ranges[i]!.start, ranges[i - 1]!.end); // contiguous
  const total = ranges.reduce((s, r) => s + (r.end - r.start), 0);
  assert.equal(total, 5, 'ranges cover exactly the slot width, no gaps or overlaps');
});

test('partition: even split unchanged for the common case', () => {
  const ranges = partitionNonceSpace(4, 0, 400);
  assert.deepEqual(ranges, [
    { start: 0, end: 100 }, { start: 100, end: 200 },
    { start: 200, end: 300 }, { start: 300, end: 400 },
  ]);
});

test('partition: width 0 yields all-empty ranges, still n of them, no crash', () => {
  const ranges = partitionNonceSpace(3, 50, 50);
  assert.equal(ranges.length, 3);
  assert.ok(ranges.every((r) => r.start === 50 && r.end === 50));
});
