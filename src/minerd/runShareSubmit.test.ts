import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runShareSubmit, type ShareSubmitDeps } from './poolClient.js';

// retry-until-terminal-or-roll + caps + captured {workerId,epoch} core,
// tested as a pure function with injected fakes — no network, no timers.

interface Calls {
  posts: { workerId: string; jobId: string; nonce: number }[];
  shares: { ok: boolean; label: string }[];
  events: { kind: string; msg: string }[];
  accepted: boolean[];
  backoffs: { attempt: number; retryAfterMs?: number }[];
  sleeps: number[];
}

function makeDeps(over: Partial<ShareSubmitDeps> = {}): { deps: ShareSubmitDeps; calls: Calls; setNow: (v: number) => void } {
  const calls: Calls = { posts: [], shares: [], events: [], accepted: [], backoffs: [], sleeps: [] };
  let t = 0;
  const deps: ShareSubmitDeps = {
    post: async (s) => { calls.posts.push(s); return { status: 200, result: 'accepted' }; },
    sleep: async (ms) => { calls.sleeps.push(ms); },
    backoff: (attempt, opts) => { calls.backoffs.push({ attempt, retryAfterMs: opts?.retryAfterMs }); return 10; },
    now: () => t,
    isStopped: () => false,
    getActiveJobId: () => 'job1',
    getEpoch: () => 0,
    reporter: { share: (ok, label) => calls.shares.push({ ok, label }), event: (kind, msg) => calls.events.push({ kind, msg }) },
    onAccepted: (block) => calls.accepted.push(block),
    deadlineMs: 120_000,
    ...over,
  };
  return { deps, calls, setNow: (v) => { t = v; } };
}

test('terminal accepted -> true, onAccepted once, reporter.share(true), POST carries the captured workerId', async () => {
  const { deps, calls } = makeDeps();
  const r = await runShareSubmit(deps, 'capW', 'job1', 0, 42);
  assert.equal(r, true);
  assert.deepEqual(calls.accepted, [false]);
  assert.deepEqual(calls.shares, [{ ok: true, label: 'accepted' }]);
  assert.deepEqual(calls.posts[0], { workerId: 'capW', jobId: 'job1', nonce: 42 });
});

test('block-strike accepted -> onAccepted(true)', async () => {
  const { deps, calls } = makeDeps({ post: async () => ({ status: 200, result: 'accepted', block: true }) });
  const r = await runShareSubmit(deps, 'w', 'job1', 0, 1);
  assert.equal(r, true);
  assert.deepEqual(calls.accepted, [true]);
});

test('terminal rejected -> true, reporter.share(false), onAccepted NOT called', async () => {
  const { deps, calls } = makeDeps({ post: async () => ({ status: 200, result: 'invalid' }) });
  const r = await runShareSubmit(deps, 'w', 'job1', 0, 1);
  assert.equal(r, true);
  assert.deepEqual(calls.shares, [{ ok: false, label: 'invalid' }]);
  assert.equal(calls.accepted.length, 0);
});

test('429 then 200 -> retries, backs off once, returns accepted', async () => {
  let n = 0;
  const { deps, calls } = makeDeps();
  deps.post = async (s) => { calls.posts.push(s); return n++ === 0 ? { status: 429 } : { status: 200, result: 'accepted' }; };
  const r = await runShareSubmit(deps, 'w', 'job1', 0, 1);
  assert.equal(r, true);
  assert.equal(calls.posts.length, 2);
  assert.equal(calls.sleeps.length, 1);
});

test('500 then 200 -> retried (not a false reject)', async () => {
  let n = 0;
  const { deps, calls } = makeDeps();
  deps.post = async (s) => { calls.posts.push(s); return n++ === 0 ? { status: 500, result: 'invalid' } : { status: 200, result: 'accepted' }; };
  const r = await runShareSubmit(deps, 'w', 'job1', 0, 1);
  assert.equal(r, true);
  assert.equal(calls.posts.length, 2);
  assert.equal(calls.shares.filter((s) => !s.ok).length, 0);
});

test('Retry-After is forwarded to backoff', async () => {
  let n = 0;
  const { deps, calls } = makeDeps();
  deps.post = async (s) => { calls.posts.push(s); return n++ === 0 ? { status: 429, retryAfterMs: 5000 } : { status: 200, result: 'accepted' }; };
  await runShareSubmit(deps, 'w', 'job1', 0, 1);
  assert.equal(calls.backoffs[0].retryAfterMs, 5000);
});

test('hostile huge backoff delay is clamped (<=30s)', async () => {
  let n = 0;
  const { deps, calls } = makeDeps({ backoff: () => 999_999 });
  deps.post = async (s) => { calls.posts.push(s); return n++ === 0 ? { status: 429 } : { status: 200, result: 'accepted' }; };
  await runShareSubmit(deps, 'w', 'job1', 0, 1);
  assert.ok(calls.sleeps[0]! <= 30_000, `expected clamped sleep, got ${calls.sleeps[0]}`);
});

test('job-roll DROP: activeJobId flips after the first attempt -> false, no share emitted', async () => {
  let job = 'job1';
  const { deps, calls } = makeDeps({ getActiveJobId: () => job });
  deps.post = async (s) => { calls.posts.push(s); job = 'job2'; return { status: 429 }; };
  const r = await runShareSubmit(deps, 'w', 'job1', 0, 1);
  assert.equal(r, false);
  assert.equal(calls.posts.length, 1);
  assert.equal(calls.shares.length, 0);
  assert.equal(calls.accepted.length, 0);
});

test('epoch-roll DROP (Frankenstein): epoch changes mid-retry -> false, POST never used a rolled identity', async () => {
  let ep = 0;
  const { deps, calls } = makeDeps({ getEpoch: () => ep });
  deps.post = async (s) => { calls.posts.push(s); ep = 1; return { status: 429 }; };
  const r = await runShareSubmit(deps, 'capW', 'job1', 0, 1);
  assert.equal(r, false);
  assert.equal(calls.posts.length, 1);
  assert.equal(calls.posts[0]!.workerId, 'capW'); // captured, never the post-reregister worker
  assert.equal(calls.shares.length, 0);
});

test('deadline DROP: wall-clock passes the deadline during an outage -> false + warn, no reject emitted', async () => {
  const { deps, calls, setNow } = makeDeps({ deadlineMs: 1000 });
  deps.post = async (s) => { calls.posts.push(s); setNow(5000); return { status: 503 }; };
  const r = await runShareSubmit(deps, 'w', 'job1', 0, 1);
  assert.equal(r, false);
  assert.ok(calls.events.some((e) => e.kind === 'warn' && /no nonce burned/i.test(e.msg)));
  assert.equal(calls.shares.length, 0);
});

test('abort thrown by post -> false, silent (no emit)', async () => {
  const { deps, calls } = makeDeps({ post: async () => { throw new DOMException('aborted', 'AbortError'); } });
  const r = await runShareSubmit(deps, 'w', 'job1', 0, 1);
  assert.equal(r, false);
  assert.equal(calls.shares.length, 0);
  assert.equal(calls.events.length, 0);
});

test('TimeoutError thrown by post is RETRYABLE (not a teardown drop)', async () => {
  let n = 0;
  const { deps, calls } = makeDeps();
  deps.post = async (s) => { calls.posts.push(s); if (n++ === 0) throw new DOMException('timed out', 'TimeoutError'); return { status: 200, result: 'accepted' }; };
  const r = await runShareSubmit(deps, 'w', 'job1', 0, 1);
  assert.equal(r, true);
  assert.equal(calls.posts.length, 2);
});

test('stopped -> false immediately, no post', async () => {
  const { deps, calls } = makeDeps({ isStopped: () => true });
  const r = await runShareSubmit(deps, 'w', 'job1', 0, 1);
  assert.equal(r, false);
  assert.equal(calls.posts.length, 0);
});
