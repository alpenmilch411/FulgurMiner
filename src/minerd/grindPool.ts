// src/minerd/grindPool.ts
import { Worker } from 'node:worker_threads';
import { bytesToHex } from '../util/binary.js';
import { partitionNonceSpace } from './partition.js';

const WORKER_URL = new URL('./powWorker.bootstrap.mjs', import.meta.url);
// Empty execArgv so the worker can't inherit the parent's `--import tsx` (which
// doesn't reliably activate tsx's .js->.ts resolver inside worker threads on some
// Node versions). The .mjs bootstrap registers tsx via its API instead.
const WORKER_OPTS = { execArgv: [] };
export const FAST_FAIL_MS = 2000;
export const MAX_FAST_FAILS = 5;
// cumulative per-generation crash budget. The rapid (fast-fail) counter resets the
// moment a child/worker survives >= FAST_FAIL_MS, so a SLOW-crash loop (lives ~3s, dies,
// repeat) would respawn forever. This bound counts EVERY crash in a generation, so such
// a loop is eventually left down too. Shared by the WASM and native grind pools.
export const MAX_CRASHES_PER_GEN = 12;

export type OnSolved = (nonce: number, hash: Uint8Array) => void;
export type OnHashrate = (hashesPerSec: number) => void;
/** Called when every worker has exhausted its nonce range without finding a solution.
 *  The caller should rebuild the template (new timestamp) and call start() again. */
export type OnExhausted = () => void;
export type OnError = (err: Error) => void;

interface WorkerRange {
  start: number;
  end: number;
}

interface ActiveGrind {
  headerHex: string;
  targetHex: string;
  throttle: number;
  continuous: boolean;
  gen: number;
  ranges: WorkerRange[];
}

/** Pool of grind workers. One template at a time; first valid solve per generation wins. */
export class GrindPool {
  private workers: Worker[] = [];
  private gen = 0;
  private solvedThisGen = false;
  private onSolved: OnSolved = () => {};
  private onExhausted: OnExhausted = () => {};
  private onError: OnError = (err) => console.error('[GrindPool] worker error:', err);
  private hashCounts = new Map<number, number>(); // worker index -> hashes since last tick
  private rateTimer: ReturnType<typeof setInterval> | null = null;
  private exhaustedThisGen = 0; // count of workers that reported 'exhausted' this gen
  private permanentlyDownThisGen = 0; // workers left down by the fast-fail breaker
  private continuous = false;   // pool share mode: keep grinding after each hit
  private activeGrind: ActiveGrind | null = null;
  private terminating = false;
  private spawnTimes: number[] = [];
  private fastFailures: number[] = [];
  private fastFailureReported: boolean[] = [];
  private crashesThisGen: number[] = []; // cumulative crashes per worker this gen
  private workerDown: boolean[] = [];
  private pendingRespawns = new Map<number, ReturnType<typeof setTimeout>>();

  constructor(private readonly workerCount: number, private throttle = 1) {
    for (let i = 0; i < workerCount; i++) this.spawn(i);
  }

  setThrottle(throttle: number): void {
    const t = Math.min(1, Math.max(0.05, throttle));
    this.throttle = t;
    if (this.activeGrind) this.activeGrind.throttle = t;
    for (const w of this.workers) w.postMessage({ type: 'setThrottle', throttle: t });
  }

  private resetFastFailures(): void {
    this.fastFailures = Array.from({ length: this.workerCount }, () => 0);
    this.fastFailureReported = Array.from({ length: this.workerCount }, () => false);
    this.crashesThisGen = Array.from({ length: this.workerCount }, () => 0);
  }

  /** Fire onExhausted once every worker has either scanned its range OR been left
   *  permanently down by the fast-fail breaker — so an all-down pool still
   *  completes the generation (→ the caller rebuilds/respawns) instead of stalling
   *  silently, which in solo (no watchdog) would hang mining. */
  private maybeExhausted(): void {
    if (this.exhaustedThisGen + this.permanentlyDownThisGen < this.workers.length) return;
    if (this.rateTimer) { clearInterval(this.rateTimer); this.rateTimer = null; }
    this.activeGrind = null;
    this.onExhausted();
  }

  private clearPendingRespawns(): void {
    for (const handle of this.pendingRespawns.values()) clearTimeout(handle);
    this.pendingRespawns.clear();
  }

  private reviveDownWorkers(): void {
    for (let i = 0; i < this.workerCount; i++) {
      if (this.workerDown[i] || !this.workers[i]) this.spawn(i);
    }
  }

  private postActiveGrind(index: number, state: ActiveGrind): void {
    const range = state.ranges[index];
    const worker = this.workers[index];
    if (!range || !worker) return;
    worker.postMessage({
      type: 'grind',
      gen: state.gen,
      headerHex: state.headerHex,
      targetHex: state.targetHex,
      start: range.start,
      end: range.end,
      throttle: state.throttle,
      continuous: state.continuous,
    });
  }

  private scheduleRespawn(index: number, delay: number, genAtExit: number): void {
    const existing = this.pendingRespawns.get(index);
    if (existing) clearTimeout(existing);
    const handle = setTimeout(() => {
      this.pendingRespawns.delete(index);
      if (this.terminating) return;
      this.spawn(index);
      const state = this.activeGrind;
      if (!state || this.terminating || state.gen !== genAtExit || state.gen !== this.gen || (!state.continuous && this.solvedThisGen)) return;
      this.postActiveGrind(index, state);
    }, delay);
    this.pendingRespawns.set(index, handle);
  }

  private spawn(index: number): void {
    const previous = this.workers[index];
    previous?.removeAllListeners('exit');
    void previous?.terminate();
    const w = new Worker(WORKER_URL, WORKER_OPTS);
    this.spawnTimes[index] = Date.now();
    this.workerDown[index] = false;
    w.on('message', (m: { type: string; gen: number; nonce?: number; hash?: Uint8Array; hashes?: number }) => {
      if (m.gen !== this.gen) return; // stale message from a superseded template
      if (m.type === 'solved') {
        if (this.continuous) {
          // Pool share mode: every hit is a share. Keep ALL workers grinding the
          // rest of their slot — don't stop, don't latch solvedThisGen.
          this.onSolved(m.nonce!, m.hash!);
        } else if (!this.solvedThisGen) {
          this.solvedThisGen = true;
          // Solo: one solution = one block. Halt all sibling workers immediately so
          // they stop burning CPU on this already-solved template and cannot race in
          // with a competing solution.
          for (const sibling of this.workers) sibling.postMessage({ type: 'stop' });
          if (this.rateTimer) { clearInterval(this.rateTimer); this.rateTimer = null; }
          this.onSolved(m.nonce!, m.hash!);
        }
      } else if (m.type === 'hashrate') {
        this.hashCounts.set(index, (this.hashCounts.get(index) ?? 0) + (m.hashes ?? 0));
      } else if (m.type === 'exhausted') {
        this.exhaustedThisGen++;
        this.maybeExhausted();
      }
    });
    // An unhandled 'error' event on a Worker propagates as an uncaught exception
    // and crashes the host process. Surface it via the onError callback instead.
    w.on('error', (err) => this.onError(err));
    w.on('exit', (code) => {
      if (this.terminating) return;
      this.workerDown[index] = true;
      const livedMs = Date.now() - (this.spawnTimes[index] ?? 0);
      this.fastFailures[index] = livedMs < FAST_FAIL_MS ? (this.fastFailures[index] ?? 0) + 1 : 0;
      this.crashesThisGen[index] = (this.crashesThisGen[index] ?? 0) + 1; // cumulative, never resets
      const failures = this.fastFailures[index] ?? 0;
      const totalCrashes = this.crashesThisGen[index] ?? 0;
      // Leave the worker permanently down if it fails RAPIDLY (MAX_FAST_FAILS) OR exceeds
      // the cumulative per-generation crash budget (a slow-crash loop resets the
      // rapid counter). A down worker is counted toward exhaustion so the gen still
      // completes instead of stalling.
      if (failures >= MAX_FAST_FAILS || totalCrashes >= MAX_CRASHES_PER_GEN) {
        this.permanentlyDownThisGen++;
        if (!this.fastFailureReported[index]) {
          this.fastFailureReported[index] = true;
          const why = failures >= MAX_FAST_FAILS ? `failed ${MAX_FAST_FAILS}x rapidly` : `crashed ${totalCrashes}x this generation`;
          this.onError(new Error(`grind worker ${index} ${why} — leaving it down (pool degraded)`));
        }
        this.maybeExhausted();
        return;
      }
      const delay = Math.min(FAST_FAIL_MS, 100 * 2 ** failures);
      this.onError(new Error(`grind worker ${index} exited (code=${code}) — respawning in ${delay}ms`));
      this.scheduleRespawn(index, delay, this.gen);
    });
    this.workers[index] = w;
  }

  /** Start grinding a template. Aborts any previous template.
   *  @param onExhausted - called when all workers exhaust their nonce ranges (no solution found).
   *  @param onError     - called if a worker thread crashes (optional; defaults to console.error). */
  start(
    headerBytes: Uint8Array,
    targetHex: string,
    onSolved: OnSolved,
    onHashrate: OnHashrate,
    onExhausted: OnExhausted = () => {},
    onError: OnError = (err) => console.error('[GrindPool] worker error:', err),
    nonceStart?: number,
    nonceEnd?: number,
    continuous = false,
  ): void {
    this.gen++;
    this.solvedThisGen = false;
    this.exhaustedThisGen = 0;
    this.permanentlyDownThisGen = 0;
    this.continuous = continuous;
    this.onSolved = onSolved;
    this.onExhausted = onExhausted;
    this.onError = onError;
    this.clearPendingRespawns();
    this.resetFastFailures();
    this.reviveDownWorkers();
    this.hashCounts.clear();
    const headerHex = bytesToHex(headerBytes);
    // Solo passes no bounds -> full [0, 2^32). Pool passes the assigned slot.
    const ranges = partitionNonceSpace(this.workers.length, nonceStart, nonceEnd);
    this.activeGrind = { headerHex, targetHex, throttle: this.throttle, continuous, gen: this.gen, ranges };
    this.workers.forEach((w, i) => {
      const range = ranges[i];
      if (!range) return;
      w.postMessage({ type: 'grind', gen: this.gen, headerHex, targetHex, start: range.start, end: range.end, throttle: this.throttle, continuous });
    });
    if (this.rateTimer) clearInterval(this.rateTimer);
    this.rateTimer = setInterval(() => {
      let total = 0;
      for (const v of this.hashCounts.values()) total += v;
      this.hashCounts.clear();
      onHashrate(total); // hashes in the last ~1s window
    }, 1000);
  }

  /** Abort the current template; workers go idle. */
  stop(): void {
    this.gen++;
    this.solvedThisGen = true;
    this.activeGrind = null;
    for (const w of this.workers) w.postMessage({ type: 'stop' });
    if (this.rateTimer) { clearInterval(this.rateTimer); this.rateTimer = null; }
  }

  terminate(): void {
    this.terminating = true;
    this.gen++;               // a message already queued for the old gen is now stale
    this.solvedThisGen = true;
    this.clearPendingRespawns();
    this.activeGrind = null;
    if (this.rateTimer) { clearInterval(this.rateTimer); this.rateTimer = null; }
    for (const w of this.workers) void w.terminate();
    this.workers = [];
  }

  /** Replace every worker and leave the pool idle for the caller's next start(). */
  respawn(): void {
    this.terminating = true;
    this.clearPendingRespawns();
    this.resetFastFailures();
    this.gen++;
    this.solvedThisGen = true;
    this.exhaustedThisGen = 0;
    this.activeGrind = null;
    this.hashCounts.clear();
    if (this.rateTimer) { clearInterval(this.rateTimer); this.rateTimer = null; }
    for (const w of this.workers) {
      w.removeAllListeners('exit');
      void w.terminate();
    }
    this.workers = [];
    for (let i = 0; i < this.workerCount; i++) this.spawn(i);
    this.terminating = false;
  }
}
