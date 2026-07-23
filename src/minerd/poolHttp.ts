// src/minerd/poolHttp.ts — pool-only HTTP: UA header, status classification,
// transient retry with backoff. Does NOT touch http.ts (consensus-adjacent).
import { VERSION } from './version.js';
import { fetchJsonWithTimeout } from './timedFetch.js';

export const MINER_UA = `FulgurMiner/${VERSION}`;

// Bound every pool request so a half-open connection can't wedge the miner. A
// fired timeout is a 'TimeoutError' (!= 'AbortError'), so withPoolRetry and the
// /share loop treat it as a retryable transient, while a real teardown
// (AbortError on the caller signal) still cancels.
const POOL_FETCH_TIMEOUT_MS = 15_000;

export type RespClass = 'ok' | 'transient' | 'fatal';
export function classify(status: number): RespClass {
  if (status === 200) return 'ok';
  // 429 + any 5xx are transient: a cold origin (Render/Cloudflare) commonly answers
  // 502/500/504 while spinning up, and every miner in the field would otherwise crash
  // on it (withPoolRetry throws PoolError -> register/refresh rethrow -> process exit
  // on the headless path). 4xx stay fatal so the explicit 400/404/410/426 handlers run.
  if (status === 429 || (status >= 500 && status <= 599)) return 'transient';
  return 'fatal';
}

export function backoffDelay(attempt: number, opts: { retryAfterMs?: number; rnd?: () => number } = {}): number {
  // Clamp a server-supplied Retry-After to the same 30s ceiling as the exponential
  // path: an unbounded header (Retry-After: 86400, or a ratelimit-reset parsed as an
  // absolute epoch) would otherwise park registration idle for hours. The /share path
  // already clamps via clampShareDelay; this makes the register/poll path match.
  if (opts.retryAfterMs && opts.retryAfterMs > 0) return Math.min(30_000, opts.retryAfterMs);
  const rnd = opts.rnd ?? Math.random;
  const base = Math.min(30_000, 1_000 * 2 ** attempt);
  const jitter = base * 0.2 * (rnd() * 2 - 1); // ±20%
  return Math.max(0, Math.round(base + jitter));
}

export function parseRetryAfterMs(headers: Headers): number | undefined {
  const ra = headers.get('retry-after') ?? headers.get('ratelimit-reset');
  if (!ra) return undefined;
  const secs = Number(ra);
  return Number.isFinite(secs) && secs >= 0 ? Math.round(secs * 1000) : undefined;
}

export class PoolError extends Error {
  constructor(public readonly status: number, public readonly body: unknown) {
    super(`pool request failed: ${status}`);
    this.name = 'PoolError';
  }
}

export async function poolFetch(
  url: string,
  init: RequestInit = {},
  timeoutMs: number = POOL_FETCH_TIMEOUT_MS,
  doFetch: typeof fetch = fetch,
): Promise<{ status: number; body: any; headers: Headers }> {
  const headers = new Headers(init.headers);
  headers.set('user-agent', MINER_UA);
  if (init.body && !headers.has('content-type')) headers.set('content-type', 'application/json');
  // Bound each request — INCLUDING the body read — with a per-request timeout
  // composed leak-free with the caller's teardown signal (init.signal flows through
  // ...init). A fired timeout or mid-body stall throws (TimeoutError/stream error,
  // != AbortError) so callers treat it as a retryable transient, while a real
  // teardown still cancels. timeoutMs is overridable for the /job long-poll (which
  // legitimately holds ~wait seconds); doFetch is injectable for tests.
  const r = await fetchJsonWithTimeout(url, { ...init, headers }, timeoutMs, doFetch);
  return { status: r.status, body: r.body, headers: r.headers };
}

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export async function withPoolRetry(
  attempt: () => Promise<{ status: number; body: any; headers: Headers }>,
  opts: { signal?: AbortSignal; onWait?: (attempt: number, delayMs: number) => void; sleep?: (ms: number) => Promise<void> } = {},
): Promise<{ status: number; body: any }> {
  const sleep = opts.sleep ?? defaultSleep;
  for (let i = 0; ; i++) {
    if (opts.signal?.aborted) throw new DOMException('aborted', 'AbortError');
    let r: { status: number; body: any; headers: Headers };
    try {
      r = await attempt();
    } catch (e) {
      // A thrown error here is a network-level failure (fetch rejected: DNS,
      // connection refused, reset, timeout) — treat it like a transient HTTP
      // status: back off and retry. Honor abort. This keeps register/poll
      // resilient to a pool that is briefly unreachable, not just one returning
      // 503 while syncing.
      if ((e as Error)?.name === 'AbortError') throw e;
      const delay = backoffDelay(i);
      opts.onWait?.(i, delay);
      await sleep(delay);
      continue;
    }
    const cls = classify(r.status);
    if (cls === 'ok') return { status: r.status, body: r.body };
    if (cls === 'fatal') throw new PoolError(r.status, r.body);
    const delay = backoffDelay(i, { retryAfterMs: parseRetryAfterMs(r.headers) });
    opts.onWait?.(i, delay);
    await sleep(delay);
  }
}
