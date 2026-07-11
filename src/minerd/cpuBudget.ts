// src/minerd/cpuBudget.ts
//
// How much CPU we are ACTUALLY allowed to use — which is not what os.cpus() says.
//
// os.cpus() reports the HOST's processors. Inside a container with a CPU limit
// (`docker --cpus=2`, a k8s `limits.cpu`) it still reports every core on the host,
// so auto-sizing workers from it massively over-spawns: a miner on a shared
// 128-core box spun up 127 workers against a 2-CPU allowance.
//
// os.availableParallelism() is the obvious answer and it is NOT enough on our
// supported floor: it only learns about the CFS quota in libuv >= 1.49 (Node 22.12+),
// while we support Node >= 20.6, whose bundled libuv (1.46) knows nothing about it.
// On Node 20 it respects CPU *affinity* (cpuset, taskset) and silently ignores the
// quota — i.e. exactly the container case we are trying to fix. So we read the
// cgroup quota ourselves; availableParallelism still covers the affinity half.
//
// A QUOTA is treated as "constrained" but AFFINITY is not, and that distinction is
// load-bearing: see autoWorkers().
import os from 'node:os';
import { readFileSync } from 'node:fs';

/** cgroup v2 (`/sys/fs/cgroup/cpu.max`). */
const CGROUP_V2_MAX = '/sys/fs/cgroup/cpu.max';
/** cgroup v1 (`/sys/fs/cgroup/cpu/…`). */
const CGROUP_V1_QUOTA = '/sys/fs/cgroup/cpu/cpu.cfs_quota_us';
const CGROUP_V1_PERIOD = '/sys/fs/cgroup/cpu/cpu.cfs_period_us';
/** Cumulative CPU consumed by everything in our cgroup. */
const CGROUP_V2_STAT = '/sys/fs/cgroup/cpu.stat';           // usage_usec (µs)
const CGROUP_V1_ACCT = '/sys/fs/cgroup/cpuacct/cpuacct.usage'; // ns
const CGROUP_V1_ACCT_COMBINED = '/sys/fs/cgroup/cpu,cpuacct/cpuacct.usage'; // ns (co-mounted)

/** Reads a file as text, or returns null if it isn't there / isn't readable. */
export type ReadText = (path: string) => string | null;

const defaultRead: ReadText = (path) => {
  try {
    return readFileSync(path, 'utf-8');
  } catch {
    return null; // not Linux, not containerised, or no permission — all "no quota"
  }
};

/**
 * cgroup v2 `cpu.max` is `"<quota> <period>"` in microseconds, or `"max <period>"`
 * when unlimited. Returns the quota in CORES (fractional — `--cpus=1.5` → 1.5), or
 * null when unlimited/unparseable.
 */
export function parseCpuMaxV2(text: string): number | null {
  const [quota, period] = text.trim().split(/\s+/);
  if (!quota || quota === 'max') return null;
  const q = Number(quota);
  const p = Number(period);
  if (!Number.isFinite(q) || !Number.isFinite(p) || q <= 0 || p <= 0) return null;
  return q / p;
}

/**
 * cgroup v1 keeps the quota and period in separate files; an unlimited quota is `-1`.
 * Returns cores (fractional) or null.
 */
export function parseCpuQuotaV1(quotaText: string, periodText: string): number | null {
  const q = Number(quotaText.trim());
  const p = Number(periodText.trim());
  if (!Number.isFinite(q) || !Number.isFinite(p) || q <= 0 || p <= 0) return null;
  return q / p;
}

/**
 * The CPU quota this process is held to, in cores, or null if unlimited/unknown.
 *
 * Caveat worth knowing: this reads the WELL-KNOWN cgroup paths, which is what a
 * container with its own cgroup namespace (the normal docker/k8s case) exposes. A
 * process running with `cgroupns=host` sees the host's root cgroup here and reads
 * "no quota" — we then fall back to affinity/host cores, i.e. today's behavior. That
 * is a miss, not a wrong answer.
 */
export function cgroupCpuQuota(read: ReadText = defaultRead): number | null {
  const v2 = read(CGROUP_V2_MAX);
  if (v2 !== null) return parseCpuMaxV2(v2);

  const q = read(CGROUP_V1_QUOTA);
  const p = read(CGROUP_V1_PERIOD);
  if (q !== null && p !== null) return parseCpuQuotaV1(q, p);

  return null;
}

/** cgroup v2 `cpu.stat` is `key value` lines; we want `usage_usec`. Microseconds. */
export function parseCgroupCpuStatV2(text: string): number | null {
  for (const line of text.split('\n')) {
    const [key, value] = line.trim().split(/\s+/);
    if (key === 'usage_usec') {
      const n = Number(value);
      return Number.isFinite(n) && n >= 0 ? n : null;
    }
  }
  return null;
}

/** cgroup v1 `cpuacct.usage` is a single nanosecond counter. Returned as MICROseconds. */
export function parseCpuacctUsageV1(text: string): number | null {
  const n = Number(text.trim());
  return Number.isFinite(n) && n >= 0 ? n / 1000 : null;
}

/**
 * Cumulative CPU used by EVERYTHING in our cgroup (us + any co-tenant process in
 * the same cgroup), in microseconds. Null when unreadable.
 *
 * Only ever call this when a quota exists. The cgroup-v2 ROOT `cpu.stat` uniquely
 * includes stolen time in `usage_usec`, so reading it on a plain VM would invent a
 * phantom competitor out of our own steal. A quota implies we are NOT the root.
 */
export function cgroupCpuUsageUsec(read: ReadText = defaultRead): number | null {
  const v2 = read(CGROUP_V2_STAT);
  if (v2 !== null) {
    const usec = parseCgroupCpuStatV2(v2);
    if (usec !== null) return usec;
  }
  for (const path of [CGROUP_V1_ACCT, CGROUP_V1_ACCT_COMBINED]) {
    const v1 = read(path);
    if (v1 !== null) {
      const usec = parseCpuacctUsageV1(v1);
      if (usec !== null) return usec;
    }
  }
  return null;
}

export interface CpuBudget {
  /** What os.cpus() reports: this machine, or the HOST if we're in a container. */
  hostCores: number;
  /** What we may actually run on: affinity ∩ quota. Always ≥ 1. */
  usableCores: number;
  /** The cgroup quota in cores (fractional), or null when unlimited. */
  quota: number | null;
  /** True ONLY when a CPU QUOTA limits us — never for mere affinity. */
  constrained: boolean;
}

export interface CpuBudgetDeps {
  hostCores?: number;
  /** Affinity-aware core count (cpuset/taskset). */
  parallelism?: number;
  read?: ReadText;
}

export function cpuBudget(deps: CpuBudgetDeps = {}): CpuBudget {
  const hostCores = Math.max(1, deps.hostCores ?? os.cpus().length);
  // availableParallelism() honors cpuset/affinity on every Node we support (it
  // landed in 18.14; our floor is 20.6). It just can't see the quota — hence below.
  const parallelism = Math.max(1, deps.parallelism ?? os.availableParallelism());
  const quota = cgroupCpuQuota(deps.read ?? defaultRead);

  // Floor the quota: 1.5 CPUs of allowance cannot usefully run 2 grinding workers,
  // and over-spawning is the bug we're fixing. Never below 1.
  const quotaCores = quota === null ? null : Math.max(1, Math.floor(quota));
  const usableCores = quotaCores === null
    ? parallelism
    : Math.max(1, Math.min(parallelism, quotaCores));

  return { hostCores, usableCores, quota, constrained: quota !== null };
}

/**
 * Workers to run when MINER_WORKERS is unset.
 *
 * On a real machine we leave one core free so the box stays responsive — that is the
 * long-standing default and it does not change.
 *
 * Under a CPU QUOTA we take the whole allowance instead. A 2-vCPU container that
 * "leaves one free" runs a single worker and mines at half speed, and there is no
 * desktop to keep responsive in there — the quota IS the reservation. (Affinity is
 * deliberately not treated this way: `taskset`-ing the miner onto 4 cores of a
 * 16-core desktop is still a desktop, and it keeps its free core.)
 */
export function autoWorkers(b: CpuBudget): number {
  return b.constrained ? b.usableCores : Math.max(1, b.usableCores - 1);
}

/**
 * Resolve the worker count from the raw MINER_WORKERS value.
 *
 * An explicitly-set MINER_WORKERS is honored as written and bounded only by the HOST
 * core count — never by the detected budget. Deliberate: an operator who asks for 2
 * workers must get 2. (Our own pods pin MINER_WORKERS=2 on 2-vCPU hosts; re-clamping
 * an explicit value to a floored quota would have silently halved them.) The auto
 * default is the thing being fixed here.
 */
export function resolveWorkers(raw: string | undefined, b: CpuBudget): number {
  const v = (raw ?? '').trim();
  if (v === '') return autoWorkers(b);
  const n = Number(v);
  if (!Number.isFinite(n)) return autoWorkers(b);
  return Math.min(b.hostCores, Math.max(1, Math.floor(n)));
}
