import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getJsonWithRetry, isHelperAccept, decodeBlockHex, MAX_BLOCK_HEX, isValidTipBody } from './http.js';

// The 30s request timeout wired into the solo sync path means a
// slow/cold-start /blocks now throws TimeoutError; ChainSync.bootstrap has no retry,
// so a headless run crashed to the menu. getJsonWithRetry adds a bounded retry that
// recovers a transient TimeoutError / network error / 5xx, fails fast on a 4xx, and
// propagates a caller teardown (AbortError) immediately.

const noSleep = async (): Promise<void> => {};
const resp = (status: number, body = '{}'): Response => new Response(body, { status });

test('getJsonWithRetry: 503 twice then 200 → retries and returns the parsed body', async () => {
  let n = 0;
  const sleeps: number[] = [];
  const doFetch: typeof fetch = (async () => (n++ < 2 ? resp(503) : resp(200, JSON.stringify({ ok: 1 })))) as any;
  const r = await getJsonWithRetry('u', { attempts: 4, doFetch, sleep: async (ms) => { sleeps.push(ms); } });
  assert.deepEqual(r, { ok: 1 });
  assert.equal(n, 3);
  assert.equal(sleeps.length, 2, 'backed off once per 503');
});

test('getJsonWithRetry: persistent 503 → throws after exactly `attempts` tries', async () => {
  let n = 0;
  const doFetch: typeof fetch = (async () => { n++; return resp(503); }) as any;
  await assert.rejects(getJsonWithRetry('u', { attempts: 3, doFetch, sleep: noSleep }), /HTTP 503/);
  assert.equal(n, 3);
});

test('getJsonWithRetry: a 404 is fatal → no retry', async () => {
  let n = 0;
  const doFetch: typeof fetch = (async () => { n++; return resp(404); }) as any;
  await assert.rejects(getJsonWithRetry('u', { attempts: 4, doFetch, sleep: noSleep }), /HTTP 404/);
  assert.equal(n, 1, 'a definitive client error is not retried');
});

test('getJsonWithRetry: TimeoutError thrown by fetch → retried', async () => {
  let n = 0;
  const doFetch: typeof fetch = (async () => {
    if (n++ === 0) throw new DOMException('timed out', 'TimeoutError');
    return resp(200, JSON.stringify({ ok: 1 }));
  }) as any;
  const r = await getJsonWithRetry('u', { attempts: 4, doFetch, sleep: noSleep });
  assert.deepEqual(r, { ok: 1 });
  assert.equal(n, 2);
});

test('getJsonWithRetry: a transient network error → retried', async () => {
  let n = 0;
  const doFetch: typeof fetch = (async () => {
    if (n++ === 0) throw new TypeError('fetch failed');
    return resp(200, JSON.stringify({ ok: 1 }));
  }) as any;
  const r = await getJsonWithRetry('u', { attempts: 4, doFetch, sleep: noSleep });
  assert.deepEqual(r, { ok: 1 });
  assert.equal(n, 2);
});

test('getJsonWithRetry: AbortError (caller teardown) → propagates immediately, no retry', async () => {
  let n = 0;
  const doFetch: typeof fetch = (async () => { n++; throw new DOMException('aborted', 'AbortError'); }) as any;
  await assert.rejects(
    getJsonWithRetry('u', { attempts: 4, doFetch, sleep: noSleep }),
    (e: any) => e?.name === 'AbortError',
  );
  assert.equal(n, 1, 'teardown is not retried');
});

// the helper success token is `added` — the old /ok|200|accept/ matcher missed
// it, so solo block submits read as accepted=false and solo earnings showed 0.
test('isHelperAccept: accepts ONLY an explicit added/accepted/ok token; a bare 2xx is NOT enough', () => {
  for (const ok of ['added', 'accepted', 'ok', 'ADDED', ' Ok ']) {
    assert.equal(isHelperAccept(ok), true, `expected accept for ${JSON.stringify(ok)}`);
  }
  // http_2xx (an unparseable 2xx body) must NOT be an adoption permit — a proxy can
  // return 200 with an HTML/`invalid` page.
  for (const bad of ['http_200', 'http_201', 'invalid', 'duplicate', 'rejected', 'stale', 'http_400', 'http_500', 'error:boom', '', 'pending']) {
    assert.equal(isHelperAccept(bad), false, `expected reject for ${JSON.stringify(bad)}`);
  }
});

// a hostile helper could ship a giant `/blocks` hex; cap it BEFORE allocate+decode.
test('decodeBlockHex rejects an oversized block hex before decoding (DoS guard)', () => {
  const huge = 'a'.repeat(MAX_BLOCK_HEX + 2);
  assert.throws(() => decodeBlockHex(huge, 3), /oversized/);
});

test('decodeBlockHex rejects a non-string block entry', () => {
  assert.throws(() => decodeBlockHex(12345 as unknown, 0), /non-string/);
  assert.throws(() => decodeBlockHex(undefined as unknown), /non-string/);
});

test('isValidTipBody: rejects missing/short/non-numeric fields', () => {
  assert.equal(isValidTipBody({ height: 35550, tipHash: 'a'.repeat(64) }), true);
  assert.equal(isValidTipBody({ tipHash: 'a'.repeat(64) }), false);        // missing height -> NaN
  assert.equal(isValidTipBody({ height: 1, tipHash: 'xyz' }), false);       // bad hash
  assert.equal(isValidTipBody({ height: -1, tipHash: 'a'.repeat(64) }), false);
  assert.equal(isValidTipBody({ height: 'abc', tipHash: 'a'.repeat(64) }), false);
  assert.equal(isValidTipBody(null), false);
});
