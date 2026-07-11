import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseCpuMaxV2,
  parseCpuQuotaV1,
  cgroupCpuQuota,
  cpuBudget,
  autoWorkers,
  resolveWorkers,
  type ReadText,
} from './cpuBudget.js';

/** A fake filesystem: only the listed paths exist. */
const fs = (files: Record<string, string>): ReadText => (p) => files[p] ?? null;

const V2 = '/sys/fs/cgroup/cpu.max';
const V1Q = '/sys/fs/cgroup/cpu/cpu.cfs_quota_us';
const V1P = '/sys/fs/cgroup/cpu/cpu.cfs_period_us';

// --- parsers (no container needed) -----------------------------------------

test('parseCpuMaxV2: quota/period → cores; "max" → unlimited', () => {
  assert.equal(parseCpuMaxV2('200000 100000'), 2);      // --cpus=2
  assert.equal(parseCpuMaxV2('150000 100000'), 1.5);    // --cpus=1.5 (fractional kept)
  assert.equal(parseCpuMaxV2('50000 100000'), 0.5);     // --cpus=0.5
  assert.equal(parseCpuMaxV2('max 100000'), null);      // unlimited
  assert.equal(parseCpuMaxV2('  200000   100000  \n'), 2);
});

test('parseCpuMaxV2: junk is unlimited, never a crash or a zero', () => {
  assert.equal(parseCpuMaxV2(''), null);
  assert.equal(parseCpuMaxV2('garbage'), null);
  assert.equal(parseCpuMaxV2('0 100000'), null);
  assert.equal(parseCpuMaxV2('200000 0'), null);
  assert.equal(parseCpuMaxV2('-1 100000'), null);
});

test('parseCpuQuotaV1: -1 is unlimited', () => {
  assert.equal(parseCpuQuotaV1('200000', '100000'), 2);
  assert.equal(parseCpuQuotaV1('-1', '100000'), null);
  assert.equal(parseCpuQuotaV1('junk', '100000'), null);
});

test('cgroupCpuQuota: prefers v2, falls back to v1, else unlimited', () => {
  assert.equal(cgroupCpuQuota(fs({ [V2]: '200000 100000' })), 2);
  assert.equal(cgroupCpuQuota(fs({ [V1Q]: '400000', [V1P]: '100000' })), 4);
  assert.equal(cgroupCpuQuota(fs({})), null); // bare metal / macOS / Windows
});

// --- the budget ------------------------------------------------------------

test('bare metal: no quota → not constrained, usable = affinity', () => {
  const b = cpuBudget({ hostCores: 8, parallelism: 8, read: fs({}) });
  assert.equal(b.constrained, false);
  assert.equal(b.usableCores, 8);
  assert.equal(b.quota, null);
});

test('container: quota beats the host core count (the 127-workers bug)', () => {
  // A 2-CPU allowance on a 128-core shared host. os.cpus() says 128; we must not.
  const b = cpuBudget({ hostCores: 128, parallelism: 128, read: fs({ [V2]: '200000 100000' }) });
  assert.equal(b.hostCores, 128);
  assert.equal(b.usableCores, 2);
  assert.equal(b.constrained, true);
  assert.equal(autoWorkers(b), 2); // NOT 127, and NOT 1 (no "-1" under a quota)
});

test('fractional quota floors, never to zero', () => {
  const b = cpuBudget({ hostCores: 64, parallelism: 64, read: fs({ [V2]: '50000 100000' }) }); // --cpus=0.5
  assert.equal(b.usableCores, 1);
  assert.equal(autoWorkers(b), 1);
});

test('affinity is respected even without a quota (cpuset/taskset)', () => {
  const b = cpuBudget({ hostCores: 16, parallelism: 4, read: fs({}) });
  assert.equal(b.usableCores, 4);
  assert.equal(b.constrained, false);
});

// --- the two regressions the design must not have --------------------------

test('REGRESSION: an explicit MINER_WORKERS is never re-clamped by the quota', () => {
  // Our own 2-vCPU pods pin MINER_WORKERS=2. If a host reports a 1-CPU-ish quota,
  // re-clamping the explicit value to the floored quota would silently halve them.
  const b = cpuBudget({ hostCores: 128, parallelism: 128, read: fs({ [V2]: '100000 100000' }) });
  assert.equal(b.usableCores, 1);
  assert.equal(resolveWorkers('2', b), 2, 'operator asked for 2 — they get 2');
  assert.equal(autoWorkers(b), 1, '…but the AUTO default still respects the quota');
});

test('REGRESSION: taskset on a desktop keeps its free core (affinity ≠ constrained)', () => {
  // `taskset -c 0-3` on a 16-core desktop is still a desktop someone is using —
  // it must NOT get the container treatment of taking every allowed core.
  const b = cpuBudget({ hostCores: 16, parallelism: 4, read: fs({}) });
  assert.equal(autoWorkers(b), 3, 'leaves one free — 4 would be the container rule');
});

test('bare-metal auto default is unchanged for existing users', () => {
  for (const cores of [1, 2, 4, 8, 10, 16]) {
    const b = cpuBudget({ hostCores: cores, parallelism: cores, read: fs({}) });
    assert.equal(autoWorkers(b), Math.max(1, cores - 1), `${cores} cores → cores-1`);
  }
});

test('resolveWorkers: unset/blank/junk → auto; explicit → floored, bounded by host', () => {
  const b = cpuBudget({ hostCores: 8, parallelism: 8, read: fs({}) });
  assert.equal(resolveWorkers(undefined, b), 7);
  assert.equal(resolveWorkers('', b), 7);
  assert.equal(resolveWorkers('   ', b), 7);
  assert.equal(resolveWorkers('not-a-number', b), 7);
  assert.equal(resolveWorkers('3', b), 3);
  assert.equal(resolveWorkers('3.9', b), 3);
  assert.equal(resolveWorkers('0', b), 1);
  assert.equal(resolveWorkers('-5', b), 1);
  assert.equal(resolveWorkers('999', b), 8, 'bounded by host cores');
});
