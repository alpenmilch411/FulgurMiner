import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyShare, shareOutcome } from './poolClient.js';

test('classifyShare: only result==="accepted" counts; block:true => block-strike', () => {
  assert.equal(classifyShare({ result: 'accepted' }), 'accepted');
  assert.equal(classifyShare({ result: 'accepted', block: true }), 'block-strike');
  assert.equal(classifyShare({ result: 'accepted', block: false }), 'accepted');
  assert.equal(classifyShare({ result: 'stale' }), 'rejected');
  assert.equal(classifyShare({ result: 'duplicate' }), 'rejected');
  assert.equal(classifyShare({ result: 'invalid' }), 'rejected');
  assert.equal(classifyShare({}), 'rejected');
  assert.equal(classifyShare(null), 'rejected');
  assert.equal(classifyShare(undefined), 'rejected');
  // a stray prefix that the OLD regex would have wrongly accepted:
  assert.equal(classifyShare({ result: 'accepted-but-not' as string }), 'rejected');
});

test('shareOutcome: transient => retry (never rejected); verdict otherwise', () => {
  assert.equal(shareOutcome(429, { result: 'rate-limited' }), 'retry');
  assert.equal(shareOutcome(503, { result: 'draining' }), 'retry');
  assert.equal(shareOutcome(503, {}), 'retry'); // {"error":"syncing"} body has no result
  assert.equal(shareOutcome(200, { result: 'accepted' }), 'accepted');
  assert.equal(shareOutcome(200, { result: 'accepted', block: true }), 'block-strike');
  assert.equal(shareOutcome(200, { result: 'stale' }), 'rejected');
  assert.equal(shareOutcome(400, { result: 'invalid' }), 'rejected');
  // money-critical invariant: a transient status is NEVER reported as rejected
  for (const s of [429, 503]) assert.notEqual(shareOutcome(s, { result: 'invalid' }), 'rejected');
});

test('shareOutcome: 408/425/5xx are AMBIGUOUS => retry, never a false reject', () => {
  // A 5xx/408/425 means the share may or may not have landed — retry, never
  // record it as a rejected/dropped share (lost PPLNS credit + polluted stats).
  assert.equal(shareOutcome(408, {}), 'retry');
  assert.equal(shareOutcome(425, {}), 'retry');
  for (const s of [500, 502, 504]) {
    assert.equal(shareOutcome(s, { result: 'invalid' }), 'retry');
    assert.notEqual(shareOutcome(s, { result: 'invalid' }), 'rejected');
  }
  // Definitive fatals are NOT retried — they map to a real verdict.
  assert.equal(shareOutcome(400, { result: 'invalid' }), 'rejected');
  assert.equal(shareOutcome(426, {}), 'rejected');
});
