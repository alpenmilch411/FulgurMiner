// src/minerd/helperPool.ts — solo-read helper failover + rotating primary.
// Miner-only transport (NOT shared consensus code). Reads the chain tip + blocks
// from the configured helper list, trying each in rotation order on failure so a
// single helper outage (5xx / timeout / network) becomes a silent failover instead
// of an error wall. Only a whole-round failure surfaces a warning; the primary
// rotates after sustained failures so reads stop leading with a dead helper.
import { getTip as httpGetTip, getBlocks as httpGetBlocks, type Tip, type GetJsonOpts } from './http.js';
import type { Block } from '../chain/block.js';

const DEFAULT_ROTATE_THRESHOLD = 3;
const DEFAULT_TIP_TIMEOUT_MS = 8_000;     // short: a black-holed helper fails over fast
const DEFAULT_BLOCKS_TIMEOUT_MS = 30_000; // generous: /blocks can return up to 200 blocks
const DEFAULT_BLOCKS_ROUNDS = 4;
const BLOCKS_BACKOFF_MS = [500, 1_000, 2_000, 4_000];
const blocksBackoff = (round: number): number => BLOCKS_BACKOFF_MS[Math.min(round, BLOCKS_BACKOFF_MS.length - 1)]!;

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new DOMException('aborted', 'AbortError'));
    let t: ReturnType<typeof setTimeout>;
    const onAbort = (): void => { clearTimeout(t); reject(new DOMException('aborted', 'AbortError')); };
    t = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export class AllHelpersFailed extends Error {
  constructor(public readonly errors: Array<{ base: string; error: Error }>) {
    super(`all ${errors.length} helpers failed: ${errors.map((e) => `${e.base} (${e.error.message})`).join('; ')}`);
    this.name = 'AllHelpersFailed';
  }
}

export interface HelperPoolOpts {
  getTip?: (base: string, opts: GetJsonOpts) => Promise<Tip>;
  getBlocks?: (base: string, from: number, max: number, signal: AbortSignal | undefined, opts: Omit<GetJsonOpts, 'signal'>) => Promise<Block[]>;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  onDebug?: (msg: string) => void; // per-helper failure (invisible by default)
  onInfo?: (msg: string) => void;  // primary rotation
  rotateThreshold?: number;
  tipTimeoutMs?: number;
  blocksTimeoutMs?: number;
  blocksRounds?: number;
}

export class HelperPool {
  private primaryIdx = 0;
  private primaryFails = 0;
  private readonly helpers: string[];
  private readonly getTipFn: NonNullable<HelperPoolOpts['getTip']>;
  private readonly getBlocksFn: NonNullable<HelperPoolOpts['getBlocks']>;
  private readonly sleep: NonNullable<HelperPoolOpts['sleep']>;
  private readonly onDebug: (m: string) => void;
  private readonly onInfo: (m: string) => void;
  private readonly rotateThreshold: number;
  private readonly tipTimeoutMs: number;
  private readonly blocksTimeoutMs: number;
  private readonly blocksRounds: number;

  constructor(helpers: string[], opts: HelperPoolOpts = {}) {
    if (helpers.length === 0) throw new Error('HelperPool needs at least one helper');
    this.helpers = helpers;
    this.getTipFn = opts.getTip ?? httpGetTip;
    this.getBlocksFn = opts.getBlocks ?? httpGetBlocks;
    this.sleep = opts.sleep ?? defaultSleep;
    this.onDebug = opts.onDebug ?? (() => {});
    this.onInfo = opts.onInfo ?? (() => {});
    this.rotateThreshold = opts.rotateThreshold ?? DEFAULT_ROTATE_THRESHOLD;
    this.tipTimeoutMs = opts.tipTimeoutMs ?? DEFAULT_TIP_TIMEOUT_MS;
    this.blocksTimeoutMs = opts.blocksTimeoutMs ?? DEFAULT_BLOCKS_TIMEOUT_MS;
    this.blocksRounds = opts.blocksRounds ?? DEFAULT_BLOCKS_ROUNDS;
  }

  primary(): string {
    return this.helpers[this.primaryIdx]!;
  }

  /** Helper indices to try this round, starting at the current primary. */
  private order(): number[] {
    const n = this.helpers.length;
    return Array.from({ length: n }, (_, k) => (this.primaryIdx + k) % n);
  }

  /** Record this round's primary outcome (exactly once per round) and rotate when
   *  the primary has failed `rotateThreshold` rounds in a row. */
  private recordPrimary(failed: boolean): void {
    if (!failed) { this.primaryFails = 0; return; }
    this.primaryFails++;
    if (this.primaryFails >= this.rotateThreshold && this.helpers.length > 1) {
      this.primaryIdx = (this.primaryIdx + 1) % this.helpers.length;
      this.primaryFails = 0;
      this.onInfo(`[minerd] switching primary helper to ${this.primary()}`);
    }
  }

  /** One failover round: try each helper once from the primary; first success wins.
   *  A caller AbortError propagates immediately (never retried/failed-over). */
  private async round<T>(label: string, attempt: (base: string) => Promise<T>): Promise<T> {
    const errors: Array<{ base: string; error: Error }> = [];
    const order = this.order(); // order[0] === primaryIdx
    for (let k = 0; k < order.length; k++) {
      const base = this.helpers[order[k]!]!;
      try {
        const value = await attempt(base);
        this.recordPrimary(k > 0); // primary failed iff a fallback (k>0) served the round
        return value;
      } catch (e) {
        if ((e as Error)?.name === 'AbortError') throw e;
        errors.push({ base, error: e as Error });
        this.onDebug(`${label} via ${base} failed: ${(e as Error).message}`);
      }
    }
    this.recordPrimary(true);
    throw new AllHelpersFailed(errors);
  }

  getTip(signal?: AbortSignal): Promise<Tip> {
    return this.round('tip poll', (base) => this.getTipFn(base, { attempts: 1, timeoutMs: this.tipTimeoutMs, signal }));
  }

  /** Multi-round retry for block fetches; may rotate the primary mid-call (intentional — rotation is not call-scoped). */
  async getBlocks(from: number, max = 200, signal?: AbortSignal): Promise<Block[]> {
    let lastErr: Error | undefined;
    for (let r = 0; r < this.blocksRounds; r++) {
      try {
        return await this.round('blocks', (base) => this.getBlocksFn(base, from, max, signal, { attempts: 1, timeoutMs: this.blocksTimeoutMs }));
      } catch (e) {
        if ((e as Error)?.name === 'AbortError') throw e;
        lastErr = e as Error;
        if (r < this.blocksRounds - 1) await this.sleep(blocksBackoff(r), signal);
      }
    }
    throw lastErr ?? new AllHelpersFailed([]);
  }

  async blockAt(height: number, signal?: AbortSignal): Promise<Block | undefined> {
    const blocks = await this.round('block', (base) => this.getBlocksFn(base, height, 1, signal, { attempts: 1, timeoutMs: this.blocksTimeoutMs }));
    return blocks[0];
  }
}
