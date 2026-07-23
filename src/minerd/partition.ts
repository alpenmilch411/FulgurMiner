// src/minerd/partition.ts
export const NONCE_SPACE = 0x1_0000_0000; // 2^32 (exclusive upper bound; nonce is u32)

export interface NonceRange {
  start: number; // inclusive
  end: number;   // exclusive
}

/**
 * Split [spaceStart, spaceEnd) into `workers` disjoint contiguous ranges.
 *
 * Defaults to the full [0, 2^32) space — solo mining owns the whole nonce space
 * and builds its own template, so it passes no bounds and the split is identical
 * to before. Pool mining passes the per-worker slot the pool assigned via
 * /register and /job (nonceStart/nonceEnd); the pool rejects out-of-slot nonces
 * before hashing, so the grinder MUST stay inside the served window.
 */
export function partitionNonceSpace(workers: number, spaceStart = 0, spaceEnd = NONCE_SPACE): NonceRange[] {
  const n = Math.max(1, Math.floor(workers));
  const lo = Math.max(0, Math.min(Math.floor(spaceStart), NONCE_SPACE));
  const hi = Math.max(lo, Math.min(Math.floor(spaceEnd), NONCE_SPACE));
  const width = hi - lo;
  const base = Math.floor(width / n);
  const rem = width - base * n; // 0..n-1 extra units, one each to the first `rem` workers
  const ranges: NonceRange[] = [];
  let cursor = lo;
  for (let i = 0; i < n; i++) {
    const size = base + (i < rem ? 1 : 0);
    const start = cursor;
    const end = i === n - 1 ? hi : start + size; // last absorbs any rounding, stays == hi
    ranges.push({ start, end });
    cursor = end;
  }
  return ranges;
}
