import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { spawnSync, type ChildProcess } from 'node:child_process';
import type { Worker } from 'node:worker_threads';
import { FAST_FAIL_MS, GrindPool, MAX_FAST_FAILS } from './grindPool.js';
import { NATIVE_BIN, NativeGrindPool } from './nativeGrindPool.js';

const HEADER = new Uint8Array(148);
const EASY_TARGET = 'f'.repeat(64);

function workersOf(pool: GrindPool): Worker[] {
  return (pool as unknown as { workers: Worker[] }).workers;
}

function childrenOf(pool: NativeGrindPool): ChildProcess[] {
  return (pool as unknown as { children: Array<{ proc: ChildProcess }> }).children.map((child) => child.proc);
}

async function waitFor<T>(label: string, read: () => T | undefined, timeoutMs = 30_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timed out waiting for ${label}`);
}

function waitForExit(proc: ChildProcess, timeoutMs = 10_000): Promise<void> {
  if (proc.exitCode !== null || proc.signalCode !== null) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      proc.off('exit', onExit);
      reject(new Error('timed out waiting for native child exit'));
    }, timeoutMs);
    const onExit = (): void => {
      clearTimeout(timeout);
      resolve();
    };
    proc.once('exit', onExit);
  });
}

function nativeContinuousAvailable(): boolean {
  if (!existsSync(NATIVE_BIN)) return false;
  const r = spawnSync(NATIVE_BIN, ['grind'], { encoding: 'utf8' });
  return `${r.stdout}${r.stderr}`.includes('[continuous]');
}

const HAS_NATIVE_CONTINUOUS = nativeContinuousAvailable();

test('GrindPool.respawn replaces workers and the pool can hash afterward', { timeout: 45_000 }, async () => {
  const pool = new GrindPool(2, 1);
  const errors: Error[] = [];
  let lastHps = 0;

  try {
    pool.respawn();
    const workers = workersOf(pool);
    assert.equal(workers.length, 2);
    assert.ok(workers.every((w) => w.threadId > 0));

    pool.start(
      HEADER,
      EASY_TARGET,
      () => {},
      (hps) => { if (hps > 0) lastHps = hps; },
      () => {},
      (err) => { errors.push(err); },
      0,
      1000,
      true,
    );

    const hps = await waitFor('hashrate after respawn', () => lastHps > 0 ? lastHps : undefined);
    assert.ok(hps > 0);
    assert.deepEqual(errors, []);
  } finally {
    pool.terminate();
  }
});

test('GrindPool.setThrottle updates live workers without respawning', { timeout: 45_000 }, () => {
  const pool = new GrindPool(2, 1);
  const errors: Error[] = [];

  try {
    pool.start(
      HEADER,
      '0'.repeat(64),
      () => {},
      () => {},
      () => {},
      (err) => { errors.push(err); },
      0,
      0x1_0000_0000,
      true,
    );

    const workers = [...workersOf(pool)];
    const messages: unknown[][] = workers.map(() => []);
    const originals = workers.map((worker) => worker.postMessage.bind(worker));
    const hasThrottleMessage = (workerMessages: unknown[], throttle: number): boolean => {
      return workerMessages.some((msg) => {
        return typeof msg === 'object'
          && msg !== null
          && (msg as { type?: unknown }).type === 'setThrottle'
          && (msg as { throttle?: unknown }).throttle === throttle;
      });
    };
    workers.forEach((worker, index) => {
      (worker as unknown as { postMessage: (...args: unknown[]) => unknown }).postMessage = (...args: unknown[]) => {
        messages[index].push(args[0]);
        return (originals[index] as unknown as (...postArgs: unknown[]) => unknown)(...args);
      };
    });

    pool.setThrottle(0.42);
    assert.deepEqual(workersOf(pool), workers);
    assert.ok(messages.every((workerMessages) => hasThrottleMessage(workerMessages, 0.42)));

    pool.setThrottle(5);
    assert.ok(messages.every((workerMessages) => hasThrottleMessage(workerMessages, 1)));

    pool.setThrottle(-1);
    assert.ok(messages.every((workerMessages) => hasThrottleMessage(workerMessages, 0.05)));
    assert.deepEqual(errors, []);
  } finally {
    pool.terminate();
  }
});

test('GrindPool respawns unexpectedly exited workers and resumes hashing', { timeout: 60_000 }, async () => {
  const pool = new GrindPool(2, 1);
  const errors: Error[] = [];
  const ticks: Array<{ at: number; hps: number }> = [];
  let respawnWarnings = 0;
  let exitedAt = 0;

  try {
    pool.start(
      HEADER,
      EASY_TARGET,
      () => {},
      (hps) => { if (hps > 0) ticks.push({ at: Date.now(), hps }); },
      () => {},
      (err) => {
        errors.push(err);
        if (err.message.includes('respawning')) respawnWarnings++;
      },
      0,
      2000,
      true,
    );

    await waitFor('initial hashrate', () => ticks.length > 0 ? ticks.at(-1)!.hps : undefined);

    const exitingWorkers = [...workersOf(pool)];
    await Promise.all(exitingWorkers.map((w) => w.terminate()));
    exitedAt = Date.now();

    await waitFor('worker exit respawn warnings', () => respawnWarnings >= 2 ? true : undefined);
    const replacementWorkers = await waitFor('replacement workers', () => {
      const current = workersOf(pool);
      return current.length === 2
        && current.every((w) => w.threadId > 0)
        && current.some((w) => !exitingWorkers.includes(w))
        ? current
        : undefined;
    });
    assert.equal(replacementWorkers.length, 2);
    assert.ok(replacementWorkers.every((w) => w.threadId > 0));

    const resumedHps = await waitFor(
      'hashrate after unexpected worker exits',
      () => ticks.find((tick) => tick.at - exitedAt >= 1000)?.hps,
    );
    assert.ok(resumedHps > 0);
    assert.equal(errors.length, 2);
  } finally {
    pool.terminate();
  }
});

test('GrindPool leaves a rapidly failing worker down after the fast-failure limit', { timeout: 45_000 }, async () => {
  const pool = new GrindPool(1, 1);
  const errors: Error[] = [];
  const seenWorkers = new Set<Worker>();
  let finalWorker: Worker | null = null;

  try {
    pool.start(
      HEADER,
      '0'.repeat(64),
      () => {},
      () => {},
      () => {},
      (err) => { errors.push(err); },
      0,
      0x1_0000_0000,
      true,
    );

    for (let i = 0; i < MAX_FAST_FAILS; i++) {
      const worker = await waitFor(`live worker before rapid exit ${i + 1}`, () => {
        const current = workersOf(pool)[0];
        return current && current.threadId > 0 && !seenWorkers.has(current) ? current : undefined;
      }, 10_000);
      seenWorkers.add(worker);
      finalWorker = worker;
      await worker.terminate();
    }

    const leftDown = await waitFor('rapid-failure circuit breaker', () => {
      return errors.find((err) => err.message.includes(`failed ${MAX_FAST_FAILS}x rapidly`) && err.message.includes('leaving it down'));
    }, 10_000);
    assert.ok(leftDown);

    await new Promise((resolve) => setTimeout(resolve, FAST_FAIL_MS + 300));
    assert.equal(workersOf(pool)[0], finalWorker);
    assert.ok((workersOf(pool)[0]?.threadId ?? -1) <= 0);
    assert.ok(errors.filter((err) => err.message.includes('respawning')).length <= MAX_FAST_FAILS - 1);
  } finally {
    pool.terminate();
  }
});

test('NativeGrindPool continuous mode forwards multiple solved nonces', { timeout: 60_000, skip: !HAS_NATIVE_CONTINUOUS }, async () => {
  const pool = new NativeGrindPool(1, 1);
  const solved: number[] = [];
  let exhausted = false;

  try {
    pool.start(
      HEADER,
      EASY_TARGET,
      (nonce) => { solved.push(nonce); },
      () => {},
      () => { exhausted = true; },
      (err) => { throw err; },
      0,
      3,
      true,
    );

    await waitFor('multiple native continuous solves', () => solved.length > 1 ? true : undefined);
    await waitFor('native continuous exhaustion', () => exhausted ? true : undefined);
    assert.deepEqual(solved, [0, 1, 2]);
  } finally {
    pool.terminate();
  }
});

test('NativeGrindPool.setThrottle writes live throttle to child stdin without respawning', { timeout: 60_000, skip: !HAS_NATIVE_CONTINUOUS }, async () => {
  const pool = new NativeGrindPool(2, 1);

  try {
    pool.start(
      HEADER,
      '0'.repeat(64),
      () => {},
      () => {},
      () => {},
      (err) => { throw err; },
      0,
      0x1_0000_0000,
      true,
    );

    const children = await waitFor('native children before live throttle', () => {
      const current = childrenOf(pool);
      return current.length === 2 ? current : undefined;
    });
    const writes: string[][] = children.map(() => []);
    const originals = children.map((child) => child.stdin!.write.bind(child.stdin!));
    children.forEach((child, index) => {
      (child.stdin as unknown as { write: (...args: unknown[]) => boolean }).write = (...args: unknown[]) => {
        writes[index].push(String(args[0]));
        return (originals[index] as unknown as (...writeArgs: unknown[]) => boolean)(...args);
      };
    });

    pool.setThrottle(0.3);

    assert.deepEqual(childrenOf(pool), children);
    assert.equal(childrenOf(pool).length, 2);
    assert.ok(writes.every((childWrites) => childWrites.some((line) => /^THROTTLE 0\.3\b/.test(line))));
  } finally {
    pool.terminate();
  }
});

test('NativeGrindPool.respawn kills children and the pool can start again', { timeout: 60_000, skip: !HAS_NATIVE_CONTINUOUS }, async () => {
  const pool = new NativeGrindPool(2, 1);
  const solved: number[] = [];

  try {
    pool.start(
      HEADER,
      '0'.repeat(64),
      (nonce) => { solved.push(nonce); },
      () => {},
      () => {},
      (err) => { throw err; },
      0,
      0x1_0000_0000,
      true,
    );
    const firstChildren = await waitFor('native children before respawn', () => {
      const children = childrenOf(pool);
      return children.length === 2 ? children : undefined;
    });
    const exited = firstChildren.map((child) => waitForExit(child));

    pool.respawn();
    assert.equal(childrenOf(pool).length, 0);
    await Promise.all(exited);

    pool.start(
      HEADER,
      EASY_TARGET,
      (nonce) => { solved.push(nonce); },
      () => {},
      () => {},
      (err) => { throw err; },
      0,
      1,
      true,
    );

    await waitFor('native solve after respawn', () => solved.includes(0) ? true : undefined);
  } finally {
    pool.terminate();
  }
});

test('NativeGrindPool respawns an unexpectedly killed child during continuous grind', { timeout: 60_000, skip: !HAS_NATIVE_CONTINUOUS }, async () => {
  const pool = new NativeGrindPool(2, 1);
  const errors: Error[] = [];
  const ticks: Array<{ at: number; hps: number }> = [];

  try {
    pool.start(
      HEADER,
      '0'.repeat(64),
      () => {},
      (hps) => { if (hps > 0) ticks.push({ at: Date.now(), hps }); },
      () => {},
      (err) => { errors.push(err); },
      0,
      0x1_0000_0000,
      true,
    );

    const initialChildren = await waitFor('native children before unexpected kill', () => {
      const children = childrenOf(pool);
      return children.length === 2 ? children : undefined;
    });
    await waitFor('initial native hashrate', () => ticks.length > 0 ? ticks.at(-1)!.hps : undefined);

    const killed = initialChildren[0];
    const killedPid = killed.pid;
    const exited = waitForExit(killed);
    killed.kill('SIGKILL');
    const killedAt = Date.now();
    await exited;

    await waitFor('native child respawn warning', () => {
      return errors.some((err) => err.message.includes('native grind child 0 exited') && err.message.includes('respawning'))
        ? true
        : undefined;
    });
    const replacementChildren = await waitFor('native replacement child', () => {
      const current = childrenOf(pool);
      return current.length === 2 && current.some((child) => child.pid !== killedPid)
        ? current
        : undefined;
    });

    assert.equal(replacementChildren.length, 2);
    assert.ok(replacementChildren.every((child) => child.exitCode === null && child.signalCode === null));
    assert.ok(errors.every((err) => !err.message.includes('leaving it down')));
    const resumedHps = await waitFor('native hashrate after unexpected child kill', () => {
      return ticks.find((tick) => tick.at - killedAt >= 1000)?.hps;
    });
    assert.ok(resumedHps > 0);
  } finally {
    pool.terminate();
  }
});

test('NativeGrindPool exhaustion quorum treats permanently down children as complete', { skip: !HAS_NATIVE_CONTINUOUS }, () => {
  const pool = new NativeGrindPool(2, 1);
  let exhausted = 0;
  const internals = pool as unknown as {
    activeGrind: unknown;
    expectedChildCount: number;
    exhaustedThisGen: number;
    permanentlyDownThisGen: number;
    solvedThisGen: boolean;
    onExhausted: () => void;
    maybeExhausted: () => void;
  };

  try {
    internals.activeGrind = {};
    internals.expectedChildCount = 2;
    internals.exhaustedThisGen = 1;
    internals.permanentlyDownThisGen = 1;
    internals.solvedThisGen = false;
    internals.onExhausted = () => { exhausted++; };

    internals.maybeExhausted();

    assert.equal(exhausted, 1);
    assert.equal(internals.activeGrind, null);
  } finally {
    pool.terminate();
  }
});

// Regression: at throttle 1 (Max) the POST-fork PoW (Sandglass) is synchronous, so a
// worker's `await powHash` only drains microtasks and — without a periodic macrotask
// yield — never services queued control messages. A `stop()`+`start()` (the watchdog's
// "re-apply", and any job change) would then be ignored and the worker stays on the old
// generation forever. This asserts the worker LEAVES gen1 and picks up gen2 at throttle 1.
test('GrindPool at throttle 1 picks up a new generation on a synchronous (post-fork) grind', { timeout: 30_000 }, async () => {
  // height 0x0000830e = 33550 (>= fork) → powHash takes the synchronous Sandglass path.
  const POST_FORK = new Uint8Array(148);
  POST_FORK[2] = 0x83;
  POST_FORK[3] = 0x0e;
  const noop = (): void => {};
  const pool = new GrindPool(1, 1); // 1 worker, throttle 1 (Max)
  try {
    // gen1: impossible target (0) — grinds a huge range forever, never solves.
    pool.start(POST_FORK, '0'.repeat(64), noop, noop, noop, noop, 0, 2 ** 31, true);
    await new Promise((r) => setTimeout(r, 400)); // let the worker enter gen1's tight loop
    // gen2: easy target (max) — nonce 0 always solves, IF the worker leaves gen1.
    let solvedGen2 = false;
    pool.stop();
    pool.start(POST_FORK, 'f'.repeat(64), () => { solvedGen2 = true; }, noop, noop, noop, 0, 8, false);
    await waitFor('gen2 solve at throttle 1', () => (solvedGen2 ? true : undefined), 15_000);
    assert.equal(solvedGen2, true);
  } finally {
    pool.terminate();
  }
});

test('terminate() advances the generation so a late worker message is stale', () => {
  // stop()/respawn() bump gen; terminate() must too, or a "solved" message already
  // queued when terminate() runs still matches gen and fires onSolved after shutdown.
  const pool = new GrindPool(1, 0.5);
  const genBefore = (pool as unknown as { gen: number }).gen;
  pool.terminate();
  const genAfter = (pool as unknown as { gen: number }).gen;
  assert.ok(genAfter > genBefore, 'terminate() must increment gen (like stop/respawn)');
});
