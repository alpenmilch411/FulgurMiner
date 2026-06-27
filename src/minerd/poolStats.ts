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

export function startPoolStats(opts: {
  poolUrl: string; address: string; getAcceptedShares: () => number; pageUrl?: string;
  reporter: MinerReporter; signal?: AbortSignal; intervalMs?: number;
}): void {
  const { poolUrl, address, getAcceptedShares, pageUrl, reporter, signal } = opts;
  const tick = async (): Promise<void> => {
    try {
      const b = await poolFetch(`${poolUrl}/balance?address=${address}`);
      const earnings = b.status === 200 ? mapBalance(b.body) : null;
      reporter.earnings?.(earnings ?? { kind: 'pool-shares', shares: getAcceptedShares(), pageUrl });
    } catch { reporter.earnings?.({ kind: 'pool-shares', shares: getAcceptedShares(), pageUrl }); }
    try {
      const j = await poolFetch(`${poolUrl}/jackpot?address=${address}`);
      const jp = j.status === 200 ? mapJackpot(j.body) : null;
      if (jp) reporter.jackpot?.(jp);
    } catch { /* skip jackpot */ }
  };
  void tick();
  const timer = setInterval(() => { void tick(); }, opts.intervalMs ?? 25_000);
  signal?.addEventListener('abort', () => clearInterval(timer), { once: true });
}
