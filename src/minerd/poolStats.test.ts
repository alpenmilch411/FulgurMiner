import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mapBalance, mapJackpot, startPoolStats } from './poolStats.js';
import type { EarningsInfo, JackpotInfo, MinerReporter } from './reporter.js';

test('mapBalance: valid -> pool-balance; invalid -> null', () => {
  assert.deepEqual(mapBalance({ address: 'a', earnedBrc: 1.5, pendingBrc: 0.5, paidBrc: 1, currency: 'BRC' }),
    { kind: 'pool-balance', earnedBrc: 1.5, pendingBrc: 0.5, paidBrc: 1 });
  assert.equal(mapBalance({ error: 'nope' }), null);
  assert.equal(mapBalance(null), null);
});

test('mapJackpot: valid -> JackpotInfo; invalid -> null', () => {
  assert.deepEqual(mapJackpot({ finderBonusPct: 0.03, yourBlockStrikes: 2, lastWinner: 'x', lastStrikeHeight: 99 }),
    { finderBonusPct: 0.03, yourBlockStrikes: 2, lastWinner: 'x', lastStrikeHeight: 99 });
  assert.equal(mapJackpot({}), null);
  assert.equal(mapJackpot(null), null);
});

// ─── startPoolStats: the jackpot gate (FIX 1) + the ghost-interval fix (FIX 2) ──

/** A minimal fetch Response stand-in — only what poolFetch/fetchJsonWithTimeout
 *  reads (status/ok/headers/text()). Mirrors the pattern used across this repo's
 *  other *.test.ts files (updateCheck.test.ts, http.test.ts). */
function jsonResponse(status: number, body: unknown): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: new Headers(),
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function captureReporter(): { earningsCalls: EarningsInfo[]; jackpotCalls: JackpotInfo[]; reporter: MinerReporter } {
  const earningsCalls: EarningsInfo[] = [];
  const jackpotCalls: JackpotInfo[] = [];
  const reporter = {
    earnings: (e: EarningsInfo) => earningsCalls.push(e),
    jackpot: (j: JackpotInfo) => jackpotCalls.push(j),
  } as unknown as MinerReporter;
  return { earningsCalls, jackpotCalls, reporter };
}

test('startPoolStats: wantJackpot=false (a non-FulgurPool pool) never requests /jackpot — /balance still polls', async () => {
  const urls: string[] = [];
  const doFetch: typeof fetch = (async (url: unknown) => {
    const u = String(url);
    urls.push(u);
    // The fake FAILS the test if /jackpot is ever requested for a non-FulgurPool
    // pool — a third-party pool must never be hit with a request for a feature it
    // doesn't have.
    if (u.includes('/jackpot')) throw new Error('TEST FAILURE: /jackpot requested for a non-FulgurPool pool');
    if (u.includes('/balance')) return jsonResponse(200, { earnedBrc: 1.5, pendingBrc: 0.5, paidBrc: 1 });
    throw new Error(`unexpected URL: ${u}`);
  }) as unknown as typeof fetch;
  const { earningsCalls, jackpotCalls, reporter } = captureReporter();
  const handle = startPoolStats({
    poolUrl: 'https://brcpool.cryptec.tech', address: 'a'.repeat(64), getAcceptedShares: () => 0,
    reporter, wantJackpot: false, doFetch, intervalMs: 10_000,
  });
  try {
    await new Promise((r) => setTimeout(r, 20)); // let the immediate first tick settle
    assert.ok(urls.some((u) => u.includes('/balance')), '/balance was requested');
    assert.ok(!urls.some((u) => u.includes('/jackpot')), '/jackpot was never requested');
    assert.equal(jackpotCalls.length, 0, 'reporter.jackpot was never called');
    assert.equal(earningsCalls.length, 1);
    assert.equal(earningsCalls[0]!.kind, 'pool-balance');
  } finally {
    handle.stop();
  }
});

test('startPoolStats: wantJackpot=true (FulgurPool) requests /jackpot and the panel renders', async () => {
  const urls: string[] = [];
  const doFetch: typeof fetch = (async (url: unknown) => {
    const u = String(url);
    urls.push(u);
    if (u.includes('/jackpot')) return jsonResponse(200, { finderBonusPct: 0.03, yourBlockStrikes: 2 });
    if (u.includes('/balance')) return jsonResponse(200, { earnedBrc: 1, pendingBrc: 0, paidBrc: 0 });
    throw new Error(`unexpected URL: ${u}`);
  }) as unknown as typeof fetch;
  const { jackpotCalls, reporter } = captureReporter();
  const handle = startPoolStats({
    poolUrl: 'https://pool.fulgurpool.xyz', address: 'a'.repeat(64), getAcceptedShares: () => 0,
    reporter, wantJackpot: true, doFetch, intervalMs: 10_000,
  });
  try {
    await new Promise((r) => setTimeout(r, 20));
    assert.ok(urls.some((u) => u.includes('/jackpot')), '/jackpot WAS requested');
    assert.equal(jackpotCalls.length, 1);
    assert.equal(jackpotCalls[0]!.finderBonusPct, 0.03);
    assert.equal(jackpotCalls[0]!.yourBlockStrikes, 2);
  } finally {
    handle.stop();
  }
});

test('startPoolStats: stop() clears the interval — no further /balance or /jackpot after stop (the ghost is dead)', async () => {
  let balanceCalls = 0;
  let jackpotCalls = 0;
  const doFetch: typeof fetch = (async (url: unknown) => {
    const u = String(url);
    if (u.includes('/balance')) { balanceCalls++; return jsonResponse(200, { earnedBrc: 1, pendingBrc: 0, paidBrc: 0 }); }
    if (u.includes('/jackpot')) { jackpotCalls++; return jsonResponse(200, { finderBonusPct: 0.01, yourBlockStrikes: 0 }); }
    throw new Error(`unexpected URL: ${u}`);
  }) as unknown as typeof fetch;
  const { reporter } = captureReporter();
  // signal intentionally omitted (undefined) — the exact headless shape
  // (`npm run mine` / plain `npm start`) that shipped with the ghost-interval bug.
  const handle = startPoolStats({
    poolUrl: 'https://pool.fulgurpool.xyz', address: 'a'.repeat(64), getAcceptedShares: () => 0,
    reporter, wantJackpot: true, doFetch, intervalMs: 15,
  });
  await new Promise((r) => setTimeout(r, 40)); // let a couple of ticks fire
  const balanceAtStop = balanceCalls;
  const jackpotAtStop = jackpotCalls;
  assert.ok(balanceAtStop > 0, 'sanity: at least one tick fired before stop()');
  handle.stop();
  await new Promise((r) => setTimeout(r, 60)); // well past where a few more ticks would have fired
  assert.equal(balanceCalls, balanceAtStop, 'no further /balance after stop()');
  assert.equal(jackpotCalls, jackpotAtStop, 'no further /jackpot after stop()');
});

test('startPoolStats: stop() is idempotent', async () => {
  const doFetch: typeof fetch = (async () => jsonResponse(200, { earnedBrc: 0, pendingBrc: 0, paidBrc: 0 })) as unknown as typeof fetch;
  const { reporter } = captureReporter();
  const handle = startPoolStats({
    poolUrl: 'https://pool.fulgurpool.xyz', address: 'a'.repeat(64), getAcceptedShares: () => 0,
    reporter, doFetch, intervalMs: 10_000,
  });
  handle.stop();
  assert.doesNotThrow(() => handle.stop());
});

test('startPoolStats: an abort signal still stops the poller (the TUI teardown path)', async () => {
  let calls = 0;
  const doFetch: typeof fetch = (async () => { calls++; return jsonResponse(200, { earnedBrc: 0, pendingBrc: 0, paidBrc: 0 }); }) as unknown as typeof fetch;
  const { reporter } = captureReporter();
  const ac = new AbortController();
  startPoolStats({
    poolUrl: 'https://pool.fulgurpool.xyz', address: 'a'.repeat(64), getAcceptedShares: () => 0,
    reporter, signal: ac.signal, doFetch, intervalMs: 15,
  });
  await new Promise((r) => setTimeout(r, 20));
  ac.abort();
  const callsAtAbort = calls;
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(calls, callsAtAbort, 'no further requests after the signal aborts');
});
