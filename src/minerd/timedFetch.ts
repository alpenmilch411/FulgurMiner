// A leak-free fetch-with-timeout that bounds the ENTIRE request — including the
// response BODY read — with a per-request timeout composed with the caller's
// teardown signal. Returns the parsed JSON, not a bare Response, BY DESIGN.
//
// Why read the body here instead of returning a Response? `fetch()` resolves as
// soon as the response HEADERS arrive; the body is read later (res.json()/text()).
// If the timeout/abort scope ends when fetch() resolves (e.g. a helper that returns
// a Response and clears its timer in finally), the body read runs UNBOUNDED — a
// server that sends 200 headers then stalls the body wedges the read forever,
// cancellable by nothing. On the /share path that pins an in-flight slot and
// silently loses payable shares; on solo sync it hangs/crashes bootstrap. So the
// body read MUST happen inside the timed scope, before the timer/listener are
// released.
//
// Why not AbortSignal.any([caller, AbortSignal.timeout(ms)])? AbortSignal.any holds
// the composite as a STRONG dependant of each source and only releases it when a
// SOURCE aborts. The miner's teardown signal stays un-aborted for the whole run, so
// every request would leak a composite onto it → unbounded heap → OOM. Instead: one
// per-request AbortController, with BOTH the timer and the caller listener released
// in `finally`, so nothing is held past the request.
//
// The reason-name distinction is load-bearing downstream: a fired timeout aborts
// with 'TimeoutError', a caller teardown forwards the caller's reason ('AbortError').
// Retry logic treats 'AbortError' as teardown (stop) and everything else — including
// 'TimeoutError' and body-stream errors — as a retryable transient.

export interface TimedJson {
  status: number;
  ok: boolean;
  headers: Headers;
  /** Parsed JSON, or null if the body was empty or failed to parse. */
  body: any;
  /** True iff a non-empty body could not be parsed as JSON. */
  parseError: boolean;
}

export async function fetchJsonWithTimeout(
  url: string,
  init: RequestInit = {},
  ms: number,
  doFetch: typeof fetch = fetch,
): Promise<TimedJson> {
  const caller = init.signal ?? undefined;
  // Fast-path a caller that already aborted: reject with its reason, no fetch.
  if (caller?.aborted) throw caller.reason ?? new DOMException('aborted', 'AbortError');

  const ac = new AbortController();
  const timer = setTimeout(() => {
    ac.abort(new DOMException(`request timed out after ${ms}ms`, 'TimeoutError'));
  }, ms);
  const onCallerAbort = (): void => {
    ac.abort(caller?.reason ?? new DOMException('aborted', 'AbortError'));
  };
  if (caller) caller.addEventListener('abort', onCallerAbort, { once: true });

  try {
    const res = await doFetch(url, { ...init, signal: ac.signal });
    // Read the body INSIDE the timed scope so a mid-body stall is bounded too.
    const text = await res.text();
    let body: any = null;
    let parseError = false;
    if (text.length > 0) {
      try { body = JSON.parse(text); } catch { parseError = true; }
    }
    return { status: res.status, ok: res.ok, headers: res.headers, body, parseError };
  } finally {
    clearTimeout(timer);
    if (caller) caller.removeEventListener('abort', onCallerAbort);
  }
}
