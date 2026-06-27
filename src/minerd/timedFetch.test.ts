import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchJsonWithTimeout } from './timedFetch.js';

// Hardening:
//  - No listener accumulation on the long-lived caller signal (the old AbortSignal.any
//    leaked ~50MB/day -> OOM).
//  - The timeout/abort scope bounds the ENTIRE request INCLUDING the body read. A
//    header-only timeout left res.json() unbounded -> a stalled body
//    wedged a /share submit forever (lost share + pinned slot).
//  - TimeoutError(timeout) / AbortError(caller teardown) name distinction preserved;
//    body-stream errors propagate as non-AbortError (retryable transient).

// A fake Response exposing only what fetchJsonWithTimeout reads.
const fakeRes = (status: number, ok: boolean, text: () => Promise<string>): any => ({ status, ok, headers: new Headers(), text });

// doFetch whose BODY read hangs until the (internal) signal aborts — mimics a server
// that sends headers then stalls the body.
const headersThenBodyStall: typeof fetch = (async (_url: any, init: any) => {
  const sig: AbortSignal = init.signal;
  return fakeRes(200, true, () => new Promise<string>((_res, rej) => {
    if (sig.aborted) return rej(sig.reason);
    sig.addEventListener('abort', () => rej(sig.reason), { once: true });
  }));
}) as any;

test('timedFetch: no listener accumulation on the caller signal over many calls', async () => {
  const caller = new AbortController().signal;
  let added = 0;
  let removed = 0;
  const origAdd = caller.addEventListener.bind(caller);
  const origRemove = caller.removeEventListener.bind(caller);
  (caller as any).addEventListener = (type: string, ...rest: any[]) => { if (type === 'abort') added++; return (origAdd as any)(type, ...rest); };
  (caller as any).removeEventListener = (type: string, ...rest: any[]) => { if (type === 'abort') removed++; return (origRemove as any)(type, ...rest); };
  const okFetch: typeof fetch = (async () => fakeRes(200, true, async () => '{}')) as any;
  for (let i = 0; i < 200; i++) await fetchJsonWithTimeout('http://x', { signal: caller }, 1000, okFetch);
  assert.equal(added, removed, `leaked ${added - removed} caller listeners over 200 calls`);
  assert.ok(added > 0, 'sanity: a caller listener was attached');
});

test('timedFetch: a stalled response BODY times out (body read is inside the bounded scope)', async () => {
  await assert.rejects(
    fetchJsonWithTimeout('u', {}, 5, headersThenBodyStall),
    (e: any) => e?.name === 'TimeoutError',
  );
});

test('timedFetch: caller abort during a stalled body → AbortError (caller wins over timeout)', async () => {
  const ac = new AbortController();
  const p = fetchJsonWithTimeout('u', { signal: ac.signal }, 10_000, headersThenBodyStall);
  ac.abort();
  await assert.rejects(p, (e: any) => e?.name === 'AbortError');
});

test('timedFetch: pre-aborted caller → AbortError, underlying fetch never called', async () => {
  const ac = new AbortController();
  ac.abort();
  let called = false;
  const spyFetch: typeof fetch = (async () => { called = true; return fakeRes(200, true, async () => '{}'); }) as any;
  await assert.rejects(
    fetchJsonWithTimeout('u', { signal: ac.signal }, 1000, spyFetch),
    (e: any) => e?.name === 'AbortError',
  );
  assert.equal(called, false);
});

test('timedFetch: success returns parsed body + status + ok', async () => {
  const okFetch: typeof fetch = (async () => fakeRes(200, true, async () => JSON.stringify({ ok: 1 }))) as any;
  const r = await fetchJsonWithTimeout('u', {}, 1000, okFetch);
  assert.equal(r.status, 200);
  assert.equal(r.ok, true);
  assert.deepEqual(r.body, { ok: 1 });
  assert.equal(r.parseError, false);
});

test('timedFetch: a complete but non-JSON body → parseError=true, body=null, no throw', async () => {
  const htmlFetch: typeof fetch = (async () => fakeRes(200, true, async () => '<html>not json</html>')) as any;
  const r = await fetchJsonWithTimeout('u', {}, 1000, htmlFetch);
  assert.equal(r.parseError, true);
  assert.equal(r.body, null);
});

test('timedFetch: an empty body → body=null, parseError=false (e.g. 204/empty 200)', async () => {
  const emptyFetch: typeof fetch = (async () => fakeRes(200, true, async () => '')) as any;
  const r = await fetchJsonWithTimeout('u', {}, 1000, emptyFetch);
  assert.equal(r.body, null);
  assert.equal(r.parseError, false);
});

test('timedFetch: a body-stream error propagates as a non-AbortError (retryable transient)', async () => {
  const resetMidBody: typeof fetch = (async () => fakeRes(200, true, async () => { throw new TypeError('terminated'); })) as any;
  await assert.rejects(
    fetchJsonWithTimeout('u', {}, 1000, resetMidBody),
    (e: any) => e?.name === 'TypeError',
  );
});

test('timedFetch: non-2xx status is returned (not thrown) with its parsed body', async () => {
  const errFetch: typeof fetch = (async () => fakeRes(503, false, async () => JSON.stringify({ error: 'syncing' }))) as any;
  const r = await fetchJsonWithTimeout('u', {}, 1000, errFetch);
  assert.equal(r.status, 503);
  assert.equal(r.ok, false);
  assert.deepEqual(r.body, { error: 'syncing' });
});
