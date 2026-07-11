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
import { existsSync, readFileSync } from 'node:fs';

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
 * Only call this when we are provably INSIDE A CONTAINER (see inContainer). On a
 * plain VM the path resolves to the cgroup-v2 ROOT, whose `usage_usec` uniquely
 * includes stolen time — reading it there would invent a phantom competitor out of
 * our own steal.
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

/** Docker writes /.dockerenv; podman writes /run/.containerenv. */
const DOCKER_MARKER = '/.dockerenv';
const PODMAN_MARKER = '/run/.containerenv';

/**
 * Are we inside a container? This is a DIFFERENT question from "are we CPU-limited",
 * and both matter:
 *   - it decides whether the HOST's /proc/stat and os.cpus() describe our world (in a
 *     container they do not — they describe the whole machine we're a guest on);
 *   - it distinguishes a cpuset-limited CONTAINER (the allowance IS our machine — take
 *     all of it) from a `taskset`-ed process on a DESKTOP (still a desktop — leave a
 *     core free for the human).
 */
export function inContainer(exists: (p: string) => boolean = existsSync): boolean {
  return exists(DOCKER_MARKER) || exists(PODMAN_MARKER);
}

export interface CpuBudget {
  /** What os.cpus() reports: this machine, or the HOST if we're in a container. */
  hostCores: number;
  /** What we may actually run on: cpuset ∩ quota. Always ≥ 1 core, fractional. */
  allowanceCores: number;
  /** Whole workers we can usefully run within the allowance. Always ≥ 1. */
  usableCores: number;
  /** The cgroup quota in cores (fractional), or null when there is none. */
  quota: number | null;
  /** Cores our CPU affinity (cpuset/taskset) permits. */
  affinityCores: number;
  /** Inside a container image (docker/podman/k8s/RunPod). */
  container: boolean;
  /** A limit smaller than the host is being enforced on us BY a container. */
  constrained: boolean;
}

export interface CpuBudgetDeps {
  hostCores?: number;
  /** Affinity-aware core count (cpuset/taskset). */
  parallelism?: number;
  read?: ReadText;
  exists?: (path: string) => boolean;
}

/**
 * What CPU we are actually allowed to use — whichever way the platform chose to limit
 * us. There is no single mechanism, and keying off only one of them is how the first
 * cut of this missed the very platform our own fleet runs on:
 *
 *   docker --cpus=N, k8s limits.cpu, Fargate, systemd CPUQuota → a CFS QUOTA
 *   RunPod, k8s static CPU manager, LXC pinning, taskset       → a CPUSET (affinity)
 *   a plain VPS (Hetzner/DO/Vultr)                             → NEITHER (steal instead)
 *
 * So the allowance is the tighter of the two: min(quota, cpuset). RunPod, for example,
 * publishes NO quota at all (`cpu.max` = "max") and instead pins the container to 2 of
 * the host's 256 CPUs — a quota-only reading sees "unlimited" and a 256-core host.
 */
export function cpuBudget(deps: CpuBudgetDeps = {}): CpuBudget {
  const read = deps.read ?? defaultRead;
  const hostCores = Math.max(1, deps.hostCores ?? os.cpus().length);
  // availableParallelism() honors cpuset/affinity on every Node we support (it landed
  // in 18.14; our floor is 20.6). It just can't see the quota — hence cgroupCpuQuota.
  const affinityCores = Math.max(1, deps.parallelism ?? os.availableParallelism());
  const quota = cgroupCpuQuota(read);
  const container = inContainer(deps.exists ?? existsSync);

  const allowanceCores = Math.min(quota ?? Number.POSITIVE_INFINITY, affinityCores);

  // Round, don't floor: an allowance of 1.9 cores that floors to 1 worker strands
  // nearly half of what was paid for. Duty-cycling and the scheduler absorb the
  // fractional overshoot; stranded capacity is never recovered.
  const usableCores = Math.max(1, Math.min(affinityCores, Math.round(allowanceCores)));

  // "Constrained" = a container is holding us BELOW the host. A non-binding quota
  // (16 CPUs on an 8-core host) constrains nothing and must not flip this on, or a
  // desktop would lose its free core. A taskset on a bare-metal desktop is not a
  // container and must not either — that box still has a human in front of it.
  const constrained = container && allowanceCores < hostCores;

  return { hostCores, allowanceCores, usableCores, quota, affinityCores, container, constrained };
}

/**
 * Workers to run when MINER_WORKERS is unset.
 *
 * On a real machine we leave one core free so the box stays responsive — the
 * long-standing default, unchanged.
 *
 * Inside a CPU-limited container we take the whole allowance. A 2-CPU container that
 * "leaves one free" runs a single worker and mines at half speed, and there is no
 * desktop in there to keep responsive: the limit IS the reservation.
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
