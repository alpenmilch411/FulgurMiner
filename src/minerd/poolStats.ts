// src/minerd/poolStats.ts — best-effort pool stats poller (read bucket). Never throws, never blocks mining.
import { poolFetch } from './poolHttp.js';
import type { EarningsInfo, JackpotInfo, MinerReporter } from './reporter.js';

export function mapBalance(body: any): EarningsInfo | null {
  if (!body || typeof body.earnedBrc !== 'number') return null;
  return { kind: 'pool-balance', earnedBrc: body.earnedBrc, pendingBrc: body.pendingBrc, paidBrc: body.paidBrc };
}

export function mapJackpot(body: any): JackpotInfo | null {
  if (!body || typeof body.finderBonusPct !== 'number' || typeof body.yourBlockStrikes !== 'number') return null;
  return { finderBonusPct: body.finderBonusPct, yourBlockStrikes: body.yourBlockStrikes, lastWinner: body.lastWinner ?? undefined, lastStrikeHeight: body.lastStrikeHeight ?? undefined };
}

/** A handle to stop the poller. `stop()` is idempotent — safe to call more than
 *  once, and safe to call whether or not the abort signal ever fires. */
export interface PoolStatsHandle {
  stop(): void;
}

export function startPoolStats(opts: {
  poolUrl: string; address: string; getAcceptedShares: () => number; pageUrl?: string;
  reporter: MinerReporter; signal?: AbortSignal; intervalMs?: number;
  /** FulgurPool-only feature. When false (any other pool), /jackpot is NEVER
   *  requested and reporter.jackpot is NEVER called — the caller decides this from
   *  pool IDENTITY (isFulgurPool), not from whether a response happens to parse.
   *  Defaults to false so a bare/omitted call never hits a third-party pool with a
   *  request for an endpoint it doesn't have. */
  wantJackpot?: boolean;
  /** Injectable fetch for tests; defaults to the global fetch. */
  doFetch?: typeof fetch;
}): PoolStatsHandle {
  const { poolUrl, address, getAcceptedShares, pageUrl, reporter, signal, wantJackpot = false, doFetch } = opts;
  const tick = async (): Promise<void> => {
    try {
      const b = await poolFetch(`${poolUrl}/balance?address=${address}`, {}, undefined, doFetch);
      const earnings = b.status === 200 ? mapBalance(b.body) : null;
      reporter.earnings?.(earnings ?? { kind: 'pool-shares', shares: getAcceptedShares(), pageUrl });
    } catch { reporter.earnings?.({ kind: 'pool-shares', shares: getAcceptedShares(), pageUrl }); }
    if (!wantJackpot) return; // not FulgurPool — never ask for a feature it doesn't have
    try {
      const j = await poolFetch(`${poolUrl}/jackpot?address=${address}`, {}, undefined, doFetch);
      const jp = j.status === 200 ? mapJackpot(j.body) : null;
      if (jp) reporter.jackpot?.(jp);
    } catch { /* skip jackpot */ }
  };
  void tick();
  const timer = setInterval(() => { void tick(); }, opts.intervalMs ?? 25_000);
  let stopped = false;
  // Ghost-process fix: BOTH headless call sites (`npm run mine`, plain `npm start`)
  // invoke runPoolClient with signal===undefined, so the old abort-only teardown
  // never cleared this interval — the process kept the event loop alive forever
  // after pool mode stopped (426/400/failed reregister), mining nothing. The
  // caller must call stop() on every exit path, not just via the abort listener.
  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
  };
  signal?.addEventListener('abort', stop, { once: true });
  return { stop };
}
