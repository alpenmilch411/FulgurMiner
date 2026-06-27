import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createShareDispatcher, type ShareDispatcherDeps } from './poolClient.js';

// The old PENDING_CAP hard-dropped any solved nonce found over the cap.
// Continuous-grind never re-scans a slot, so a dropped nonce is a PERMANENTLY lost
// payable share. The dispatcher replaces the drop with a bounded queue+drain: shares
// over the in-flight cap wait in a FIFO queue and launch as in-flight slots free, so
// a burst + slow /share loses nothing (only a true outage that fills BOTH the cap and
// the queue drops — and the pool can't credit those anyway).

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

interface Submit { nonce: number; jobId: string; capWorkerId: string; capEpoch: number; resolve: (b: boolean) => void; }

function harness(over: Partial<ShareDispatcherDeps> = {}): {
  d: ReturnType<typeof createShareDispatcher>;
  submits: Submit[];
  warns: string[];
  setEpoch: (v: number) => void;
} {
  const submits: Submit[] = [];
  const warns: string[] = [];
  let epoch = 0;
  const deps: ShareDispatcherDeps = {
    pendingCap: 4,
    queueCap: 8,
    getEpoch: () => epoch,
    submit: (nonce, jobId, capWorkerId, capEpoch) =>
      new Promise<boolean>((resolve) => { submits.push({ nonce, jobId, capWorkerId, capEpoch, resolve }); }),
    onWarn: (m) => warns.push(m),
    ...over,
  };
  return { d: createShareDispatcher(deps), submits, warns, setEpoch: (v) => { epoch = v; } };
}

test('under cap: offers launch immediately', () => {
  const { d, submits } = harness();
  d.offer(1, 'job1', 'w', 0);
  d.offer(2, 'job1', 'w', 0);
  assert.equal(submits.length, 2);
  assert.deepEqual(submits.map((s) => s.nonce), [1, 2]);
});

test('CORE INVARIANT: cap+queue nonces with a slow submit ALL launch exactly once (no payable share lost)', async () => {
  const { d, submits } = harness({ pendingCap: 4, queueCap: 8 });
  const N = 12; // pendingCap + queueCap
  for (let i = 0; i < N; i++) d.offer(i, 'job1', 'w', 0);
  assert.equal(submits.length, 4, 'only the cap launches up front; the rest queue');
  // Resolve in-flight one at a time; each freed slot must drain one queued share.
  let i = 0;
  while (i < submits.length) {
    submits[i].resolve(true);
    i++;
    await flush();
  }
  assert.equal(submits.length, N, 'every queued share eventually launched');
  const nonces = submits.map((s) => s.nonce).sort((a, b) => a - b);
  assert.deepEqual(nonces, Array.from({ length: N }, (_, k) => k), 'each nonce submitted exactly once, none lost');
});

test('dedup: the same nonce offered twice → one submit; a terminally-submitted nonce never re-launches', async () => {
  const { d, submits } = harness();
  d.offer(5, 'job1', 'w', 0);
  d.offer(5, 'job1', 'w', 0);
  assert.equal(submits.length, 1);
  submits[0].resolve(true); // terminal verdict reached
  await flush();
  d.offer(5, 'job1', 'w', 0);
  assert.equal(submits.length, 1, 'a nonce with a terminal verdict is never resubmitted');
});

test('queue full → drops the OLDEST queued share with a warn (bounded backlog)', async () => {
  const { d, submits, warns } = harness({ pendingCap: 1, queueCap: 2 });
  d.offer(0, 'job1', 'w', 0); // launches (in-flight)
  d.offer(1, 'job1', 'w', 0); // queue: [1]
  d.offer(2, 'job1', 'w', 0); // queue: [1,2]
  d.offer(3, 'job1', 'w', 0); // queue full → drop oldest (1), queue: [2,3]
  assert.ok(warns.some((m) => /backlog full/i.test(m)), 'warns on backlog overflow');
  // Drain everything.
  let i = 0;
  while (i < submits.length) { submits[i].resolve(true); i++; await flush(); }
  const launched = submits.map((s) => s.nonce).sort((a, b) => a - b);
  assert.deepEqual(launched, [0, 2, 3], 'nonce 1 (oldest over-capacity) was dropped; the rest survived');
});

test('a stale-epoch queued share is skipped on drain (never submit under a rolled identity)', async () => {
  const { d, submits, setEpoch } = harness({ pendingCap: 1, queueCap: 4 });
  d.offer(0, 'job1', 'w', 0); // in-flight
  d.offer(1, 'job1', 'w', 0); // queued at epoch 0
  setEpoch(1);                 // a reregister bumped the epoch
  submits[0].resolve(true);
  await flush();
  assert.equal(submits.length, 1, 'the queued epoch-0 share is dropped, not submitted under epoch 1');
});

test('job roll resets dedup/queue; a late old-job completion does not corrupt the new job', async () => {
  const { d, submits } = harness({ pendingCap: 1, queueCap: 4 });
  d.offer(0, 'job1', 'w', 0); // in-flight for job1
  d.offer(1, 'job2', 'w', 0); // new job → reset, launch 1 for job2
  assert.equal(submits.length, 2);
  assert.equal(submits[1].jobId, 'job2');
  // The late job1 completion must not throw or mislabel job2 state.
  submits[0].resolve(true);
  await flush();
  // job2's nonce 1 can still complete normally.
  submits[1].resolve(true);
  await flush();
  d.offer(1, 'job2', 'w', 0); // already terminal for job2 → no resubmit
  assert.equal(submits.length, 2);
});

test('clear() wipes state so reregister starts a fresh identity', () => {
  const { d, submits } = harness({ pendingCap: 1, queueCap: 4 });
  d.offer(0, 'job1', 'w', 0); // in-flight
  d.offer(1, 'job1', 'w', 0); // queued
  d.clear();
  d.offer(0, 'job1', 'w2', 1); // same nonce/job but post-reregister → fresh launch
  assert.equal(submits.length, 2, 'after clear, a previously in-flight nonce can launch again under the new identity');
  assert.equal(submits[1].capWorkerId, 'w2');
});
