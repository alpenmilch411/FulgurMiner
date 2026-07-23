import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classify, backoffDelay, parseRetryAfterMs, withPoolRetry, PoolError, poolFetch } from './poolHttp.js';

test('classify: 200 ok; 429/503 transient; others fatal', () => {
  assert.equal(classify(200), 'ok');
  assert.equal(classify(429), 'transient');
  assert.equal(classify(503), 'transient');
  assert.equal(classify(400), 'fatal');
  assert.equal(classify(404), 'fatal');
  assert.equal(classify(426), 'fatal');
});

test('backoffDelay: exponential 1s,2s,4s capped 30s, ±20% jitter (rnd injectable)', () => {
  const mid = () => 0.5; // jitter 0
  assert.equal(backoffDelay(0, { rnd: mid }), 1000);
  assert.equal(backoffDelay(1, { rnd: mid }), 2000);
  assert.equal(backoffDelay(2, { rnd: mid }), 4000);
  assert.ok(backoffDelay(20, { rnd: mid }) <= 30000);
  assert.equal(backoffDelay(0, { retryAfterMs: 5000, rnd: mid }), 5000); // Retry-After wins
  const lo = backoffDelay(3, { rnd: () => 0 });   // -20%
  const hi = backoffDelay(3, { rnd: () => 1 });   // +20%
  assert.ok(lo < 8000 && hi > 8000);
});

test('parseRetryAfterMs: numeric seconds -> ms; missing -> undefined', () => {
  assert.equal(parseRetryAfterMs(new Headers({ 'retry-after': '2' })), 2000);
  assert.equal(parseRetryAfterMs(new Headers()), undefined);
});

test('withPoolRetry: retries transient then returns ok', async () => {
  const seq = [{ status: 503, body: { error: 'syncing' }, headers: new Headers() },
               { status: 503, body: { error: 'draining' }, headers: new Headers() },
               { status: 200, body: { ok: true }, headers: new Headers() }];
  let i = 0;
  const waits: number[] = [];
  const r = await withPoolRetry(async () => seq[i++], { sleep: async (ms) => { waits.push(ms); }, onWait: () => {} });
  assert.deepEqual(r, { status: 200, body: { ok: true } });
  assert.equal(waits.length, 2);
});

test('withPoolRetry: throws PoolError on fatal', async () => {
  await assert.rejects(
    () => withPoolRetry(async () => ({ status: 400, body: { error: 'bad payoutAddress' }, headers: new Headers() }), { sleep: async () => {} }),
    (e: unknown) => e instanceof PoolError && e.status === 400);
});

test('withPoolRetry: retries on thrown network error, then returns ok', async () => {
  const outcomes: Array<() => { status: number; body: any; headers: Headers }> = [
    () => { throw new TypeError('fetch failed'); },          // network blip
    () => { throw new TypeError('ECONNRESET'); },            // another blip
    () => ({ status: 200, body: { ok: true }, headers: new Headers() }),
  ];
  let i = 0;
  const waits: number[] = [];
  const r = await withPoolRetry(async () => outcomes[i++](), { sleep: async (ms) => { waits.push(ms); } });
  assert.deepEqual(r, { status: 200, body: { ok: true } });
  assert.equal(waits.length, 2);
});

test('withPoolRetry: re-throws AbortError thrown by attempt (does not swallow)', async () => {
  await assert.rejects(
    () => withPoolRetry(async () => { const e = new Error('aborted'); e.name = 'AbortError'; throw e; }, { sleep: async () => {} }),
    (e: unknown) => (e as Error).name === 'AbortError');
});

test('withPoolRetry: aborts cleanly', async () => {
  const ac = new AbortController(); ac.abort();
  await assert.rejects(
    () => withPoolRetry(async () => ({ status: 503, body: {}, headers: new Headers() }), { signal: ac.signal, sleep: async () => {} }),
    (e: unknown) => (e as Error).name === 'AbortError');
});

const okFetch = async (): Promise<Response> =>
  ({ status: 200, ok: true, headers: new Headers(), text: async () => JSON.stringify({ jobId: 'j' }) }) as unknown as Response;

// A fetch that never resolves on its own but rejects when its signal aborts.
const hangFetch: typeof fetch = (_url, init) =>
  new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject((init!.signal as AbortSignal).reason), { once: true });
  });

test('poolFetch passes the body through with a custom timeout', async () => {
  const r = await poolFetch('http://x/job', {}, 5_000, okFetch);
  assert.equal(r.status, 200);
  assert.equal(r.body.jobId, 'j');
});

test('poolFetch honors a short custom timeout (fires TimeoutError, fast)', async () => {
  const sentinel = new Promise((_r, rej) => setTimeout(() => rej(new Error('SENTINEL: timeout not honored (>500ms)')), 500));
  const call = poolFetch('http://x/job', {}, 20, hangFetch);
  await assert.rejects(() => Promise.race([call, sentinel]), (e) => (e as Error).name === 'TimeoutError');
});

test('classify: all 5xx are transient (a cold origin 502/500/504 must not kill the miner)', () => {
  assert.equal(classify(500), 'transient');
  assert.equal(classify(502), 'transient');
  assert.equal(classify(503), 'transient');
  assert.equal(classify(504), 'transient');
  assert.equal(classify(429), 'transient');
  assert.equal(classify(200), 'ok');
  // 4xx that the caller handles explicitly stay fatal so those handlers still run.
  assert.equal(classify(400), 'fatal');
  assert.equal(classify(404), 'fatal');
  assert.equal(classify(410), 'fatal');
  assert.equal(classify(426), 'fatal');
});

test('backoffDelay: a huge Retry-After is clamped, not slept verbatim', () => {
  // 24h header must not park the miner for a day; cap at the same 30s ceiling
  // the exponential backoff already uses.
  assert.equal(backoffDelay(0, { retryAfterMs: 86_400_000 }), 30_000);
  // a reasonable value passes through
  assert.equal(backoffDelay(0, { retryAfterMs: 5_000 }), 5_000);
  // the cap boundary
  assert.equal(backoffDelay(0, { retryAfterMs: 30_000 }), 30_000);
});
