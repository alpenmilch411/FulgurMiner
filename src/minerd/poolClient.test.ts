import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isValidSlot, isValidJob, jobRestartKey, shouldRegrind, resolveJobPollMs,
  resolveJobWaitS, buildJobUrl, nextJobPollDelayMs, abortableDelay,
  runJobPollLoop, type RefreshResult,
} from './poolClient.js';

test('resolveJobWaitS: default, clamp, junk', () => {
  assert.equal(resolveJobWaitS({}), 25);
  assert.equal(resolveJobWaitS({ JOB_WAIT_S: '' }), 25);
  assert.equal(resolveJobWaitS({ JOB_WAIT_S: '10' }), 10);
  assert.equal(resolveJobWaitS({ JOB_WAIT_S: '40' }), 30);   // clamp high
  assert.equal(resolveJobWaitS({ JOB_WAIT_S: '-3' }), 0);    // clamp low
  assert.equal(resolveJobWaitS({ JOB_WAIT_S: 'abc' }), 25);  // junk -> default
  assert.equal(resolveJobWaitS({ JOB_WAIT_S: '0' }), 0);     // explicit disable
  assert.equal(resolveJobWaitS({ JOB_WAIT_S: '25.9' }), 25); // floor
});

test('buildJobUrl: long-poll only when wait>0 AND have present', () => {
  const u = 'https://p';
  assert.equal(buildJobUrl(u, 'w1'), 'https://p/job?workerId=w1');
  assert.equal(buildJobUrl(u, 'w1', { waitS: 25, have: 'j1' }), 'https://p/job?workerId=w1&wait=25&have=j1');
  assert.equal(buildJobUrl(u, 'w1', { waitS: 0, have: 'j1' }), 'https://p/job?workerId=w1');   // wait disabled
  assert.equal(buildJobUrl(u, 'w1', { waitS: 25, have: null }), 'https://p/job?workerId=w1');  // no job held
  assert.equal(buildJobUrl(u, 'w/1', { waitS: 25, have: 'a/b' }), 'https://p/job?workerId=w%2F1&wait=25&have=a%2Fb');
});

test('nextJobPollDelayMs: backward-compat + honored detection', () => {
  const base = { usedWaitS: 25, jobPollMs: 1000, haveJobId: 'j1' };
  // no job held -> immediate (enter long-poll next)
  assert.equal(nextJobPollDelayMs({ ...base, hadJob: false, responseJobId: 'j1', elapsedMs: 5 }), 0);
  // long-poll disabled -> fast-poll cadence
  assert.equal(nextJobPollDelayMs({ ...base, hadJob: true, usedWaitS: 0, responseJobId: 'j1', elapsedMs: 5 }), 1000);
  // job changed -> immediate
  assert.equal(nextJobPollDelayMs({ ...base, hadJob: true, responseJobId: 'j2', elapsedMs: 5 }), 0);
  // same job, held to ~expiry (>= 0.8*25s=20s) -> honored -> immediate
  assert.equal(nextJobPollDelayMs({ ...base, hadJob: true, responseJobId: 'j1', elapsedMs: 24_000 }), 0);
  // same job, returned early (legacy ignored wait / over-cap) -> fast-poll fallback
  assert.equal(nextJobPollDelayMs({ ...base, hadJob: true, responseJobId: 'j1', elapsedMs: 100 }), 1000);
  // boundary just under threshold -> fallback
  assert.equal(nextJobPollDelayMs({ ...base, hadJob: true, responseJobId: 'j1', elapsedMs: 19_999 }), 1000);
});

test('nextJobPollDelayMs: clamps a bad jobPollMs to the default (no 0ms spin)', () => {
  const base = { hadJob: true, usedWaitS: 0, responseJobId: 'j1', haveJobId: 'j1', elapsedMs: 5 };
  assert.equal(nextJobPollDelayMs({ ...base, jobPollMs: 0 }), 1000);
  assert.equal(nextJobPollDelayMs({ ...base, jobPollMs: Number.NaN }), 1000);
  assert.equal(nextJobPollDelayMs({ ...base, jobPollMs: -5 }), 1000);
});

test('nextJobPollDelayMs: exact honored boundary (elapsed == 0.8*wait) -> 0', () => {
  assert.equal(nextJobPollDelayMs({ hadJob: true, usedWaitS: 25, responseJobId: 'j1', haveJobId: 'j1', elapsedMs: 20_000, jobPollMs: 1000 }), 0);
});

test('abortableDelay: resolves after ms', async () => {
  const start = Date.now();
  await abortableDelay(20);
  assert.ok(Date.now() - start >= 15);
});

test('abortableDelay: rejects immediately when pre-aborted', async () => {
  const ac = new AbortController();
  ac.abort(new Error('pre'));
  await assert.rejects(() => abortableDelay(10_000, ac.signal), { message: 'pre' });
});

test('abortableDelay: rejects mid-wait on abort', async () => {
  const ac = new AbortController();
  const p = abortableDelay(10_000, ac.signal);
  ac.abort(new Error('mid'));
  await assert.rejects(() => p, { message: 'mid' });
});

// A loop harness: a programmable refresh + a recording sleep + a fake clock.
function harness(opts: {
  results: Array<{ kind?: 'job' | 'reregister' | 'stopped' | 'retry'; jobId?: string; elapsedMs?: number; hang?: boolean }>;
  waitS?: number; jobPollMs?: number;
  teardownSignal?: AbortSignal;
}) {
  const sleeps: number[] = [];
  const refreshArgs: Array<{ have: string | null; waitS: number }> = [];
  let active: string | null = null;
  let stopped = false;
  let i = 0;
  let clock = 0;
  let currentCycle: AbortController | null = null;
  let forcePlain = false;
  const deps = {
    isStopped: () => stopped,
    getHave: () => active,
    takeForcePlain: () => { const f = forcePlain; forcePlain = false; return f; },
    waitS: opts.waitS ?? 25,
    jobPollMs: opts.jobPollMs ?? 1000,
    now: () => clock,
    setCurrentCycle: (ac: AbortController | null) => { currentCycle = ac; },
    teardownSignal: opts.teardownSignal,
    refresh: async (a: { have: string | null; waitS: number; signal: AbortSignal }) => {
      refreshArgs.push({ have: a.have, waitS: a.waitS });
      const r = opts.results[i++];
      if (!r) { stopped = true; return { kind: 'retry' } as RefreshResult; }
      if (r.hang) {
        await new Promise((_res, rej) => {
          if (a.signal.aborted) return rej(a.signal.reason);
          a.signal.addEventListener('abort', () => rej(a.signal.reason), { once: true });
        });
      }
      clock += r.elapsedMs ?? 1; // advance the fake clock by the request's elapsed
      if (r.kind === 'job') active = r.jobId!; // simulate refresh setting activeJobId
      if (i >= opts.results.length) stopped = true; // end after the scripted results
      return r as RefreshResult;
    },
    onPollError: () => {},
    sleep: async (ms: number, signal?: AbortSignal) => { sleeps.push(ms); if (signal?.aborted) throw signal.reason; },
  };
  return { deps, sleeps, refreshArgs, wake: () => { forcePlain = true; currentCycle?.abort(new DOMException('wake', 'WakeError')); }, stop: () => { stopped = true; } };
}

test('loop: legacy pool (instant same-job) falls back to JOB_POLL_MS — no hot loop', async () => {
  const h = harness({ results: [
    { kind: 'job', jobId: 'j1', elapsedMs: 5 },   // 1st: have=null -> plain
    { kind: 'job', jobId: 'j1', elapsedMs: 5 },   // 2nd: have=j1, returns fast same job
    { kind: 'job', jobId: 'j1', elapsedMs: 5 },   // 3rd: same
  ] });
  await runJobPollLoop(h.deps);
  // 1st poll was plain (have null) -> delay 0; 2nd & 3rd same-job-fast -> jobPollMs
  assert.deepEqual(h.sleeps, [1000, 1000]);
  assert.equal(h.refreshArgs[0]!.waitS, 0);   // plain first
  assert.equal(h.refreshArgs[1]!.waitS, 25);  // long-poll after holding j1
});

test('loop: honored expiry (same job held ~wait) re-polls immediately', async () => {
  const h = harness({ results: [
    { kind: 'job', jobId: 'j1', elapsedMs: 1 },        // plain -> hold j1
    { kind: 'job', jobId: 'j1', elapsedMs: 24_000 },   // held ~24s, same job -> honored
  ] });
  await runJobPollLoop(h.deps);
  assert.deepEqual(h.sleeps, []); // both immediate
});

test('loop: job change re-polls immediately', async () => {
  const h = harness({ results: [
    { kind: 'job', jobId: 'j1', elapsedMs: 1 },
    { kind: 'job', jobId: 'j2', elapsedMs: 3_000 }, // changed before expiry
  ] });
  await runJobPollLoop(h.deps);
  assert.deepEqual(h.sleeps, []);
});

test('loop: retry kind sleeps the fast-poll cadence', async () => {
  const h = harness({ results: [{ kind: 'retry', elapsedMs: 5 }] });
  await runJobPollLoop(h.deps);
  assert.deepEqual(h.sleeps, [1000]);
});

test('loop: reregister kind re-polls immediately', async () => {
  const h = harness({ results: [{ kind: 'reregister', elapsedMs: 5 }] });
  await runJobPollLoop(h.deps);
  assert.deepEqual(h.sleeps, []);
});

test('loop: stopped kind exits', async () => {
  const h = harness({ results: [{ kind: 'stopped' }] });
  await runJobPollLoop(h.deps); // resolves (does not hang)
  assert.ok(true);
});

test('loop: sustained fast changed-jobs throttle to JOB_POLL_MS (no 0ms spin)', async () => {
  const results = Array.from({ length: 6 }, (_, k) => ({ kind: 'job' as const, jobId: 'j' + k, elapsedMs: 5 }));
  const h = harness({ results });
  await runJobPollLoop(h.deps);
  assert.ok(h.sleeps.length >= 1, 'expected throttling sleeps, got none (spin)');
  assert.ok(h.sleeps.every((s) => s === 1000), `every throttled sleep must be JOB_POLL_MS, got ${h.sleeps}`);
});

test('loop: sustained reregister (404) throttles to JOB_POLL_MS (no 0ms spin)', async () => {
  const results = Array.from({ length: 6 }, () => ({ kind: 'reregister' as const, elapsedMs: 5 }));
  const h = harness({ results });
  await runJobPollLoop(h.deps);
  assert.ok(h.sleeps.length >= 1, 'expected throttling sleeps, got none (spin)');
  assert.ok(h.sleeps.every((s) => s === 1000), `every throttled sleep must be JOB_POLL_MS, got ${h.sleeps}`);
});

test('loop: a long-poll that held to ~expiry still re-polls immediately (not throttled)', async () => {
  const results = [
    { kind: 'job' as const, jobId: 'j1', elapsedMs: 1 },        // plain -> hold j1
    { kind: 'job' as const, jobId: 'j1', elapsedMs: 24_000 },   // held ~24s, same job -> honored
    { kind: 'job' as const, jobId: 'j1', elapsedMs: 24_000 },   // held again -> still immediate
  ];
  const h = harness({ results });
  await runJobPollLoop(h.deps);
  assert.deepEqual(h.sleeps, []); // all immediate; the guard's elapsed<jobPollMs is false
});

test('loop: a watchdog wake interrupts the long-poll and forces an immediate PLAIN re-poll (no exit)', async () => {
  const h = harness({ results: [
    { kind: 'job' as const, jobId: 'j1', elapsedMs: 5 }, // plain -> hold j1
    { hang: true },                                        // long-poll (have=j1) that we will wake
    { kind: 'job' as const, jobId: 'j2', elapsedMs: 5 }, // the post-wake plain re-poll
  ] });
  const p = runJobPollLoop(h.deps);
  await new Promise((r) => setTimeout(r, 20)); // let it reach the hanging long-poll
  h.wake();
  await p;
  // iter2 long-polled (waitS 25); iter3 was forced plain by the wake
  assert.equal(h.refreshArgs[1]!.waitS, 25);
  assert.equal(h.refreshArgs[2]!.waitS, 0);
});

test('loop: honored long-poll re-polls immediately even when JOB_POLL_MS > wait (MED regression)', async () => {
  // JOB_POLL_MS larger than the long-poll hold must NOT throttle a genuine honored expiry.
  const h = harness({ jobPollMs: 60_000, results: [
    { kind: 'job', jobId: 'j1', elapsedMs: 1 },        // plain -> hold j1
    { kind: 'job', jobId: 'j1', elapsedMs: 25_000 },   // held ~25s, same job -> honored
    { kind: 'job', jobId: 'j1', elapsedMs: 25_000 },   // held again -> still immediate
  ] });
  await runJobPollLoop(h.deps);
  assert.deepEqual(h.sleeps, []); // immediate; not misclassified as a fast spin
});

test('loop: clamps a bad jobPollMs so a spin cannot occur (LOW regression)', async () => {
  // jobPollMs=0 must not let the throttle set delay 0 -> the loop must floor to DEFAULT.
  const h = harness({ jobPollMs: 0, results: Array.from({ length: 6 }, (_, k) => ({ kind: 'job', jobId: 'j' + k, elapsedMs: 5 })) });
  await runJobPollLoop(h.deps);
  assert.ok(h.sleeps.length >= 1, 'expected throttling sleeps, got none (spin)');
  assert.ok(h.sleeps.every((s) => s === 1000), `throttled sleeps must be DEFAULT 1000, got ${h.sleeps}`);
});

test('loop: a teardown signal abort exits the loop', async () => {
  const ac = new AbortController();
  const h = harness({ results: [
    { kind: 'job' as const, jobId: 'j1', elapsedMs: 5 },
    { hang: true },
  ], teardownSignal: ac.signal });
  const p = runJobPollLoop(h.deps);
  await new Promise((r) => setTimeout(r, 20));
  ac.abort(new DOMException('teardown', 'AbortError'));
  await p; // resolves (loop exits) — would hang/throw if teardown were mishandled
  assert.ok(true);
});
