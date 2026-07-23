// src/minerd/negotiatedClient.ts — Stratum-V2-style negotiated pool mode.
//
// Some BrowserCoin pools (first: brcpool.cryptec.tech) no longer hand out
// pool-built jobs: they require every miner to run its OWN chain view and build
// its OWN block templates (parent + transaction set), with the coinbase paying
// the pool. The pool validates the registered template, accepts shares against
// it, and aggregates payouts — but it can never point the pooled hashrate at a
// chain of its choosing, so a large pool stops being a 51%-attack risk.
//
// Wire protocol (WebSocket, JSON):
//   → { type: 'auth', address, mode: 'negotiated' }
//   ← { type: 'chain_info', height, tipHash, blockMtp, poolAddress, mempool[] … }
//   → { type: 'template', blockHex }             (our locally-built block)
//   ← { type: 'template_result', accepted, templateId, headerHex, poolTargetHex … }
//   → { type: 'share', jobId: templateId, nonce, hashHex }
//   ← { type: 'share_result', accepted, block?, reason? }
//   ← { type: 'share_target', templateId, poolTargetHex }   (vardiff retarget)
//   → { type: 'hashrate', hashesPerSecond }                 (drives pool stats)
//
// A pool that requires this mode answers HTTP POST /register with 410 — see
// negotiatedRequired() and the hand-off in poolClient.ts.
//
// Reuses the existing solo machinery: HelperPool (failover reads), ChainSync +
// VerifierPool (parallel-PoW bootstrap), GrindPool (wasm grind workers,
// continuous share mode). Native engine + smart throttle control are follow-ups;
// the start duty still honors Smart Max (straight to 1.0).
import { Blockchain } from '../chain/blockchain.js';
import {
  computeTxRoot, encodeBlock, encodeHeader, type Block, type BlockHeader,
} from '../chain/block.js';
import { MAX_BLOCK_BYTES } from '../chain/genesis.js';
import { applyBlockTxs, cloneState, stateRoot } from '../chain/state.js';
import { decodeTx, encodeTx, validateTxStructure, type Transaction } from '../chain/transaction.js';
import { bytesToHex, hexToBytes } from '../util/binary.js';
import { resolveHelpers } from './config.js';
import { GrindPool } from './grindPool.js';
import { HelperPool } from './helperPool.js';
import { isFulgurPool } from './pools.js';
import { ConsoleReporter, type MinerReporter, type ReporterStatus } from './reporter.js';
import { smartStartDuty } from './smartController.js';
import { startPoolStats } from './poolStats.js';
import { ChainSync } from './sync.js';
import { checkForUpdate } from './updateCheck.js';
import { VerifierPool, verifyBlocksParallel } from './verify.js';

// Stay above the pool's 2s per-connection template throttle.
export const REGISTER_MIN_INTERVAL_MS = 2_200;
// If a registered template gets no template_result (ws blip, server hiccup),
// re-register rather than sit idle forever.
const TEMPLATE_RESULT_TIMEOUT_MS = 12_000;
// Capped re-registration interval. Must stay well below OUTSTANDING_TTL_MS: the
// two together decide how slow a pool can be and still get its answer
// correlated. TTL / this cap = the number of registrations that can pile up
// before the oldest ages out, and that has to stay under
// MAX_OUTSTANDING_TEMPLATES or a registration is evicted while still live.
const TEMPLATE_RESULT_TIMEOUT_MAX_MS = 120_000;
const RECONNECT_DELAY_MS = 5_000;
const RETRY_BUILD_DELAY_MS = 5_000;
// A register that arrives while another is mid-flight is deferred, not dropped.
const RETRY_REGISTER_BUSY_MS = 250;
// The pool marks a miner's hashrate stale after ~15s without a report.
const HASHRATE_REPORT_MS = 5_000;
// Leave room for the header + varint/count framing when packing transactions.
const TX_BYTE_BUDGET = MAX_BLOCK_BYTES - 1_024;
// Input bounds on the pool-announced mempool (see decodeMempool).
const MAX_MEMPOOL_ENTRIES = 4_096;
const MAX_TX_HEX_LEN = TX_BYTE_BUDGET * 2;
// Aggregate input bound: a per-entry cap alone still allows thousands of large
// entries. One block's worth of hex, doubled for slack, is far more than any
// honest mempool announcement needs.
const TOTAL_HEX_BUDGET = TX_BYTE_BUDGET * 4;
// A slow pool can leave more than one registration in flight (the result
// watchdog re-registers). Keep the recent ones so a late result is correlated to
// the template it belongs to instead of clobbering a newer one.
//
// Entries leave by AGE, not by count — evicting on count alone recreates the
// never-start-grinding livelock against a pool slower than cap × watchdog. A
// registration stays correlatable for half an hour; with the watchdog capped at
// 120s the worst case is ~18 sends in that window (12s, 24s, 48s, 96s, then
// 120s apart), comfortably under the count cap, so nothing live is ever evicted
// by count and a pool is tolerated up to a 30-minute answer. Past that it is not
// a slow pool, it is a dead one, and the reconnect/tip-change paths take over.
const OUTSTANDING_TTL_MS = 30 * 60_000;
const MAX_OUTSTANDING_TEMPLATES = 64;
// Cap on remembered per-template nonces (see submittedNonces). At a normal
// vardiff target this holds a handful; the cap only matters if a pool serves a
// near-maximal share target, where every hash is a share and an unbounded set
// would grow at the hash rate.
const MAX_SUBMITTED_NONCES = 50_000;

/** Does this /register failure mean "pool requires negotiated mode"? (410 is the
 *  documented signal; the error text is a fallback for proxies that rewrite the
 *  status.) The text fallback is bounded to 400 on purpose: every other fatal
 *  status already has its own handler in poolClient (426 = upgrade required is
 *  the one that matters), and a body that merely MENTIONS the mode must not be
 *  able to divert those away from it. Exported for unit tests. */
export function negotiatedRequired(status: number, body: unknown): boolean {
  if (status === 410) return true;
  if (status !== 400) return false;
  const err = (body as { error?: string } | null)?.error;
  return typeof err === 'string' && err.toLowerCase().includes('negotiated');
}

interface ChainInfo {
  type: 'chain_info';
  height: number;
  tipHash: string;
  blockMtp: number;
  poolAddress: string;
  mempool: string[];
}

/** Is this pool-supplied mempool entry worth decoding at all, given how much
 *  input we have already scanned? Purely an INPUT bound — nothing here says the
 *  entry is a valid transaction. Split out so the bound itself is testable
 *  without having to observe an allocation. Exported for unit tests. */
export function mempoolEntryAcceptable(hex: unknown, scannedHex: number): boolean {
  if (typeof hex !== 'string' || hex.length === 0) return false;
  if (hex.length > MAX_TX_HEX_LEN) return false;
  return scannedHex + hex.length <= TOTAL_HEX_BUDGET;
}

/** Decode the pool-announced mempool hexes into structurally-valid txs, bounded
 *  by the block byte budget. Consensus validity is enforced by the applyBlockTxs
 *  simulation in buildNegotiatedTemplate — a set that fails there falls back to
 *  an empty block. Exported for unit tests. */
export function decodeMempool(hexes: string[]): Transaction[] {
  const txs: Transaction[] = [];
  let bytes = 0;
  let seen = 0;
  let scannedHex = 0;
  for (const hex of hexes) {
    // Bound the POOL-SUPPLIED input BEFORE touching it. hexToBytes materialises
    // the whole string, and decodeTx does not require full consumption — so a
    // single huge entry (or a valid tx followed by megabytes of trailing junk)
    // would be allocated and parsed before the byte budget below could reject
    // it. The budget below bounds our OUTPUT; these bound the INPUT.
    //
    // The per-entry cap alone is not enough: `bytes` only counts successfully
    // decoded canonical txs, so thousands of entries that each fail to decode
    // (or carry huge trailing junk) would still all be allocated. TOTAL_HEX_BUDGET
    // bounds the aggregate regardless of how many of them turn out to be usable.
    if (++seen > MAX_MEMPOOL_ENTRIES) break;
    if (!mempoolEntryAcceptable(hex, scannedHex)) continue;
    scannedHex += (hex as string).length;
    try {
      const { tx } = decodeTx(hexToBytes(hex));
      if (validateTxStructure(tx) !== null) continue;
      const size = encodeTx(tx).length;
      if (bytes + size > TX_BYTE_BUDGET) break;
      bytes += size;
      txs.push(tx);
    } catch { /* malformed entry — skip */ }
  }
  return txs;
}

/**
 * Build a block off OUR tip with the coinbase paying the pool. Includes the
 * pool-announced mempool when the whole set applies cleanly against our state;
 * otherwise falls back to an empty block (the pool's mempool is normally
 * self-consistent, so the fallback is a rare race, not the steady state).
 */
export function buildNegotiatedTemplate(chain: Blockchain, poolPub: Uint8Array, mempoolHexes: string[]): Block {
  // The pool address arrives as hex over the wire. A wrong length would produce
  // a header that is not 148 bytes, which nothing downstream can decode — fail
  // here, where the caller turns it into a warn-and-retry, rather than shipping
  // a malformed template.
  if (poolPub.length !== 32) throw new Error(`pool address must be 32 bytes, got ${poolPub.length}`);
  const height = chain.height + 1;
  const sctx = chain.nextBlockScriptContext();
  const timestamp = Math.max(Math.floor(Date.now() / 1000), sctx.blockMtp + 1);
  const difficulty = chain.expectedNextDifficulty(timestamp);

  let txs = decodeMempool(mempoolHexes);
  let sim = cloneState(chain.tipState);
  if (txs.length > 0 && applyBlockTxs(sim, height, poolPub, txs, sctx) !== null) {
    // Some tx conflicts with our state view (e.g. already confirmed) — mine an
    // empty block rather than none at all.
    txs = [];
    sim = cloneState(chain.tipState);
  }
  if (txs.length === 0) {
    const err = applyBlockTxs(sim, height, poolPub, [], sctx);
    if (err) throw new Error(`coinbase apply failed: ${err}`);
  }

  const header: BlockHeader = {
    height,
    prevHash: chain.tip.hash,
    txRoot: computeTxRoot(txs),
    stateRoot: stateRoot(sim),
    timestamp,
    difficulty,
    nonce: 0,
    miner: poolPub,
  };
  return { header, transactions: txs };
}

/**
 * The header the pool echoes back in `template_result` MUST be the one we just
 * registered — byte for byte, nonce zeroed.
 *
 * This is the load-bearing check of the whole mode. Negotiated mining is only
 * worth anything because the MINER picks the parent block and the transaction
 * set; grinding whatever header the pool returns would hand that choice straight
 * back to the pool (a different `prevHash` steers our hashrate onto a chain of
 * its choosing, a different `txRoot` censors), which is precisely the power the
 * mode exists to remove. The pool's own protocol defines the field as our
 * 148-byte header with the nonce zeroed, so an honest pool always matches.
 *
 * Exported for unit tests.
 */
export function headerMatchesTemplate(block: Block, headerHex: unknown): boolean {
  if (typeof headerHex !== 'string') return false;
  return headerHex.toLowerCase() === bytesToHex(encodeHeader(block.header)).toLowerCase();
}

/**
 * Correlate an accepted `template_result` to the templates still in flight.
 *
 * A single "the last one I sent" slot is wrong: if the pool takes longer than
 * the result watchdog to answer, a second template is registered while the
 * first is still pending, and the two results cancel each other out — the first
 * is checked against the second, refused, and clears it; the second then finds
 * nothing pending. With a consistently slow pool that repeats forever and the
 * miner never starts grinding at all.
 *
 * Only the MATCHED entry is removed, never "everything older than it". The
 * protocol gives no ordering guarantee between a registration and its result,
 * so dropping older entries on a match means an out-of-order pair (B answered
 * before A) discards A, and A's own valid result then reads as foreign and
 * kills the perfectly good grind that B started.
 *
 * Returns the matched template and the templates still outstanding, or null if
 * the header belongs to no template this miner built — which must never be
 * ground. Exported for unit tests.
 */
export function settleOutstanding<T extends { block: Block }>(
  outstanding: readonly T[], headerHex: unknown,
): { matched: T; rest: T[] } | null {
  const idx = outstanding.findIndex((e) => headerMatchesTemplate(e.block, headerHex));
  if (idx < 0) return null;
  const rest = outstanding.slice();
  rest.splice(idx, 1);
  return { matched: outstanding[idx]!, rest };
}

/**
 * What to do with a `template_result`.
 *
 * An ACCEPTED result carries the header, so it correlates itself no matter how
 * many registrations are in flight. A REJECTED one carries nothing — the only
 * time it is unambiguous is when it answered the sole unanswered send.
 *
 * `inFlightAfter` is the number of sends still unanswered AFTER this result, not
 * the length of the outstanding list: the list is cleared on a tip change while
 * the pool's answer to the pre-change send is still on its way, and keying on
 * the list would then settle a registration this rejection was never about.
 *
 * Exported for unit tests.
 */
export type TemplateResultAction = 'match-accepted' | 'settle-and-retry' | 'ignore-ambiguous';
export function classifyTemplateResult(accepted: boolean, inFlightAfter: number): TemplateResultAction {
  if (accepted) return 'match-accepted';
  return inFlightAfter === 0 ? 'settle-and-retry' : 'ignore-ambiguous';
}

/** Drop registrations too old to still be answered, then bound the list. Age is
 *  the primary rule — see OUTSTANDING_TTL_MS. Exported for unit tests. */
export function pruneOutstanding<T extends { at: number }>(entries: T[], now: number): T[] {
  const fresh = entries.filter((e) => now - e.at <= OUTSTANDING_TTL_MS);
  return fresh.length > MAX_OUTSTANDING_TEMPLATES
    ? fresh.slice(fresh.length - MAX_OUTSTANDING_TEMPLATES)
    : fresh;
}

/** http(s)://pool → ws(s)://pool/ws. Scheme match is case-insensitive: the
 *  headless path resolves MINER_POOL without canonicalising it, so `HTTPS://…`
 *  reaches here verbatim — fetch does not care, but `new WebSocket()` would
 *  throw on the un-rewritten scheme. */
export function poolWsUrl(poolUrl: string): string {
  // Rewrite the WHOLE scheme, not the `http` prefix: a case-insensitive prefix
  // swap on `HTTPS://` leaves the S behind and yields `wsS://`.
  return poolUrl
    .replace(/\/+$/, '')
    .replace(/^https?:/i, (m) => (m.toLowerCase() === 'https:' ? 'wss:' : 'ws:')) + '/ws';
}

/**
 * Live negotiated pool client: bootstrap our own chain, connect to the pool WS,
 * build + register templates, grind them against the personal (vardiff) share
 * target, submit shares. Runs until `signal` aborts (or a fatal setup error).
 * Not unit-tested as a whole (network); the pure pieces above are.
 */
export async function runNegotiatedPoolClient(
  poolUrl: string,
  payoutAddress: string,
  workers: number,
  throttle: number,
  reporter: MinerReporter = new ConsoleReporter(),
  signal?: AbortSignal,
  status?: ReporterStatus,
  smart: 'off' | 'max' | 'considerate' = 'off',
): Promise<void> {
  // Node's built-in (browser-style) WebSocket — stable since Node 22.
  if (typeof WebSocket === 'undefined') {
    reporter.event('error', '[nego-miner] this pool requires negotiated mode, which needs the built-in WebSocket (Node 22+). Please upgrade Node.js.');
    reporter.close?.();
    return;
  }

  const startDuty = smartStartDuty(smart, throttle);
  if (status) {
    status.backend = 'wasm';
    status.backendNote = 'negotiated mode — this miner builds its own blocks for the pool';
    status.throttle = startDuty;
  }
  reporter.status(status ?? {
    mode: 'pool',
    target: poolUrl,
    backend: 'wasm',
    backendNote: 'negotiated mode — this miner builds its own blocks for the pool',
    workers,
    throttle: startDuty,
    address: payoutAddress,
  });
  reporter.event('info', `[nego-miner] ${poolUrl} requires negotiated mode — this miner will build its own blocks (pool-payout coinbase) and mine those.`);

  // Runs BEFORE the chain bootstrap: that is a multi-minute full replay, and a
  // negotiated miner is a full consensus client — it is the one kind of pool
  // miner that WEDGES on a consensus fork if it doesn't update. The nudge has to
  // reach it, and reach it early. No pool version fields here (there is no
  // /register body in this mode), so this is the GitHub-release check alone.
  void checkForUpdate({ reporter, signal }).catch(() => {});

  // ── Own chain view (same pattern as solo, minus snapshot warm-start) ──
  const chain = new Blockchain();
  const helperPool = new HelperPool(resolveHelpers(process.env), {
    onInfo: (m) => reporter.event('info', m),
  });
  let verifier: VerifierPool | null = new VerifierPool(workers);
  const sync = new ChainSync({
    chain,
    cores: workers,
    getBlocks: (from, max) => helperPool.getBlocks(from, max, signal),
    verifyBlocksParallel: (blocks, cores) =>
      verifier ? verifier.verify(blocks) : verifyBlocksParallel(blocks, cores),
  });

  let targetHeight = 0;
  try { targetHeight = (await helperPool.getTip(signal)).height; } catch { /* indeterminate progress */ }
  reporter.event('info', `[nego-miner] syncing own chain from ${helperPool.primary()}${targetHeight ? ` (target height ${targetHeight.toLocaleString('en-US')})` : ''}…`);
  try {
    await sync.bootstrap((h) => reporter.syncProgress(h, targetHeight));
  } catch (e) {
    if (!signal?.aborted) reporter.event('error', `[nego-miner] chain bootstrap failed: ${(e as Error).message}`);
    void verifier?.terminate();
    reporter.close?.();
    return;
  }
  // Free the bootstrap workers; tail catch-ups verify one small page at a time.
  void verifier?.terminate();
  verifier = null;
  reporter.synced(chain.height);
  reporter.event('info', `[nego-miner] chain synced at height ${chain.height.toLocaleString('en-US')}`);

  const grind = new GrindPool(workers, startDuty);
  let acceptedShares = 0;
  const stats = startPoolStats({
    poolUrl, address: payoutAddress, getAcceptedShares: () => acceptedShares, reporter, signal,
    // Same identity gate as the classic path: /jackpot is a FulgurPool-only
    // endpoint and a third-party pool must never be asked for it, nor be able to
    // paint the branded panel. Derived from poolUrl so a FulgurPool that ever
    // adopts negotiated mode keeps its panel instead of silently losing it.
    wantJackpot: isFulgurPool(poolUrl),
  });

  // ── Connection + job state ──
  let ws: WebSocket | null = null;
  let stopped = false;
  let lastChainInfo: ChainInfo | null = null;
  let grinding: { templateId: string; headerBytes: Uint8Array; targetHex: string } | null = null;
  // Templates sent but not yet answered, oldest first. A single slot is not
  // enough: if a pool takes longer than TEMPLATE_RESULT_TIMEOUT_MS to validate,
  // the watchdog registers a second template while the first is still pending,
  // and a single slot makes the two results cancel each other out forever (A's
  // result is compared against B, refused, and clears B; B's result then finds
  // nothing pending) — the miner would never start grinding at all.
  let outstanding: { block: Block; at: number }[] = [];
  // Sends not yet answered by a template_result. Tracks the PROTOCOL state, not
  // our bookkeeping: `outstanding` is cleared on a tip change while the pool's
  // answer to the pre-change send is still in transit, so only this can tell
  // whether a header-less rejection is unambiguous. Reset on reconnect, where
  // answers to the old socket can no longer arrive.
  let inFlight = 0;
  // Which socket generation currently has a registration in flight (-1 = none).
  // Generation-tagged rather than a bare boolean: a registration awaiting a slow
  // catch-up on a socket that has since closed must not hold off registrations
  // on the RECONNECTED socket — the stale call cannot send anything anyway
  // (sessionOver catches it), so it must not gate a live one either.
  let registeringGen = -1;
  let socketGen = 0;
  // Consecutive result-watchdog firings, used to back the re-registration rate
  // off. A pool that answers slower than a fixed watchdog period would otherwise
  // be sent a fresh template every period forever, so results keep arriving for
  // registrations that have already aged out — and mining never starts. Backing
  // off pushes the registration interval past the pool's latency instead.
  let watchdogStrikes = 0;
  let lastRegisterAt = 0;
  let registerTimer: ReturnType<typeof setTimeout> | null = null;
  let resultWatchdog: ReturnType<typeof setTimeout> | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let syncing = false;
  let windowHashes = 0;

  const send = (msg: object): void => {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  };

  const hashrateTimer = setInterval(() => {
    send({ type: 'hashrate', hashesPerSecond: windowHashes / (HASHRATE_REPORT_MS / 1000) });
    windowHashes = 0;
  }, HASHRATE_REPORT_MS);

  const scheduleRegister = (delayMs: number): void => {
    if (stopped) return;
    if (registerTimer) clearTimeout(registerTimer);
    registerTimer = setTimeout(() => { void registerTemplate(); }, delayMs);
  };

  /** Still the same live session on the same socket? Checked after every await —
   *  teardown clears the timers that exist AT THAT MOMENT, so an async call
   *  already in flight would otherwise come back and arm fresh ones. */
  const sessionOver = (sock: WebSocket | null): boolean =>
    stopped || ws !== sock || sock === null || sock.readyState !== WebSocket.OPEN;

  // Nonces already submitted for the CURRENT template (see the share callback).
  const submittedNonces = new Set<number>();

  const startGrind = (): void => {
    if (!grinding) return;
    grind.start(
      grinding.headerBytes,
      grinding.targetHex,
      (nonce, hash) => {
        if (!grinding) return;
        // A vardiff retarget restarts the grind over the SAME header and the
        // same full nonce range, so already-submitted nonces get rehashed and
        // would be re-sent. The pool deduplicates per template and rate-limits
        // shares, so a resubmission costs a rejected share and burns budget for
        // real ones. Dedup locally, per template (cleared on every new one).
        if (submittedNonces.has(nonce)) return;
        // Bounded: at a near-maximal share target essentially every hash is a
        // share, and an unbounded set would grow at the hash rate. Past the cap
        // dedup degrades (the pool rejects a duplicate anyway) — memory does not.
        if (submittedNonces.size < MAX_SUBMITTED_NONCES) submittedNonces.add(nonce);
        send({ type: 'share', jobId: grinding.templateId, nonce, hashHex: bytesToHex(hash) });
      },
      (hps) => { reporter.hashrate(hps); windowHashes += hps; },
      () => {
        // Whole nonce space scanned without a network hit — rare, but rebuild
        // with a fresh timestamp so the header (and nonce space) changes.
        reporter.event('info', '[nego-miner] nonce space exhausted — rebuilding template');
        grinding = null;
        scheduleRegister(0);
      },
      (err) => reporter.event('warn', `[nego-miner] ${err.message}`),
      undefined,
      undefined,
      true, // continuous: every hit is a share; keep grinding
    );
  };

  async function registerTemplate(): Promise<void> {
    const sock = ws;
    if (sessionOver(sock)) return;
    const info = lastChainInfo;
    if (!info) return;
    // Single-flight. registerTemplate awaits a network catch-up in the middle,
    // and it is driven by timers — so without this a second call could start
    // mid-await, see `syncing === true`, SKIP the catch-up entirely and build on
    // a tip that has not converged. Reschedule rather than drop: a chain_info
    // arriving during a long catch-up must not be lost.
    const gen = socketGen;
    if (registeringGen === gen) { scheduleRegister(RETRY_REGISTER_BUSY_MS); return; }
    registeringGen = gen;
    try {
      // Converge our chain onto the pool's announced tip before building. The pool
      // only accepts templates built on ITS current tip; if we're momentarily ahead
      // (we synced a block it hasn't seen), the register below gets a 'stale parent'
      // rejection and the retry loop re-registers once the pool catches up.
      if (bytesToHex(chain.tip.hash) !== info.tipHash && !chain.hasBlock(info.tipHash)) {
        syncing = true;
        try {
          await sync.catchUp({ height: info.height, tipHash: info.tipHash });
        } catch (e) {
          if ((e as Error)?.name === 'AbortError') return;
          if (sessionOver(sock)) return;
          reporter.event('warn', `[nego-miner] catch-up failed: ${(e as Error).message} — retrying`);
          scheduleRegister(RETRY_BUILD_DELAY_MS);
          return;
        } finally {
          syncing = false;
        }
        // The catch-up above is the one await in this function: re-check that the
        // session is still live before arming any timer or sending anything.
        if (sessionOver(sock)) return;
        const wanted = (lastChainInfo ?? info).tipHash;
        if (bytesToHex(chain.tip.hash) !== wanted && !chain.hasBlock(wanted)) {
          // Helpers haven't served the pool's tip yet — retry shortly.
          scheduleRegister(RETRY_BUILD_DELAY_MS);
          return;
        }
      }

      await registerNow(info, sock);
    } finally {
      // Only release the slot if it is still ours: a reconnect may have handed
      // it to a newer generation while this call was awaiting.
      if (registeringGen === gen) registeringGen = -1;
    }
  }

  async function registerNow(info: ChainInfo, sock: WebSocket | null): Promise<void> {
    const latest = lastChainInfo ?? info;
    // Pool BEHIND us (e.g. replaying its chain after a restart): its announced
    // tip is a block we already hold below our tip. A template built on our tip
    // is guaranteed a 'stale parent' reject, so wait for the pool to catch up
    // instead of spamming doomed registrations.
    if (latest.tipHash !== bytesToHex(chain.tip.hash) && chain.hasBlock(latest.tipHash)) {
      scheduleRegister(RETRY_BUILD_DELAY_MS);
      return;
    }

    const wait = lastRegisterAt + REGISTER_MIN_INTERVAL_MS - Date.now();
    if (wait > 0) { scheduleRegister(wait); return; }

    let block: Block;
    try {
      block = buildNegotiatedTemplate(chain, hexToBytes(latest.poolAddress), latest.mempool ?? []);
    } catch (e) {
      reporter.event('warn', `[nego-miner] template build failed: ${(e as Error).message} — retrying`);
      scheduleRegister(RETRY_BUILD_DELAY_MS);
      return;
    }
    if (sessionOver(sock)) return;
    const now = Date.now();
    lastRegisterAt = now;
    outstanding = pruneOutstanding([...outstanding, { block, at: now }], now);
    inFlight++;
    send({ type: 'template', blockHex: bytesToHex(encodeBlock(block)) });
    reporter.chain(block.header.height, block.header.difficulty.toString(16));
    if (resultWatchdog) clearTimeout(resultWatchdog);
    // Exponential: 12s, 24s, 48s… capped. A fixed period against a pool slower
    // than that period is a re-registration treadmill that never converges.
    const resultWait = Math.min(
      TEMPLATE_RESULT_TIMEOUT_MS * 2 ** watchdogStrikes,
      TEMPLATE_RESULT_TIMEOUT_MAX_MS,
    );
    resultWatchdog = setTimeout(() => {
      watchdogStrikes++;
      reporter.event('warn', `[nego-miner] no template_result after ${Math.round(resultWait / 1000)}s — re-registering`);
      scheduleRegister(0);
    }, resultWait);
  }

  function handleMsg(msg: Record<string, unknown>): void {
    // Teardown terminates the grind pool but cannot un-queue messages already
    // delivered to the socket. Without this, a late accepted template_result
    // would call startGrind() on a terminated pool and re-arm its rate interval
    // — an interval nothing is left to clear.
    if (stopped) return;
    switch (msg.type) {
      case 'chain_info': {
        const info = msg as unknown as ChainInfo;
        const prevTip = lastChainInfo?.tipHash;
        lastChainInfo = info;
        // Periodic re-announce (mempool refresh) with an unchanged tip: our
        // current template is still valid — keep grinding it. `outstanding`
        // counts too: between our send and the pool's template_result we are
        // neither grinding nor idle, and re-registering there just puts a second
        // template in flight for the same parent.
        if ((grinding || outstanding.length > 0) && info.tipHash === prevTip) break;
        if (grinding) { grind.stop(); grinding = null; }
        // The tip moved: anything still in flight was built on the old parent.
        if (info.tipHash !== prevTip) outstanding = [];
        scheduleRegister(0);
        break;
      }

      case 'template_result': {
        inFlight = Math.max(0, inFlight - 1);
        const action = classifyTemplateResult(msg.accepted === true, inFlight);
        // THE RULE that keeps this list bounded: a result may only schedule a
        // new registration if it also removed one (or if nothing at all is left
        // in flight). Any result that both fails to settle an entry AND queues
        // another send is an accumulation loop — that is how a rejection stream,
        // and then an unmatched-acceptance stream, each filled the count cap and
        // evicted a live registration long before its TTL.
        if (action === 'ignore-ambiguous') {
          // Another send is still unanswered. Leave the watchdog alone too: it is
          // covering that send, and clearing it here would drop the only timer.
          reporter.event('warn', `[nego-miner] template rejected: ${String(msg.reason ?? 'unknown')} (another registration still pending)`);
          break;
        }
        if (action === 'settle-and-retry') {
          if (resultWatchdog) { clearTimeout(resultWatchdog); resultWatchdog = null; }
          outstanding = [];
          watchdogStrikes = 0; // a correlated answer — the pool is responding
          const reason = String(msg.reason ?? 'unknown');
          reporter.event('warn', `[nego-miner] template rejected: ${reason}`);
          if (reason.includes('rate limited')) scheduleRegister(REGISTER_MIN_INTERVAL_MS);
          else scheduleRegister(RETRY_BUILD_DELAY_MS);
          break;
        }
        // Never grind a header we did not build — that is the entire security
        // property of negotiated mode (see headerMatchesTemplate). A mismatch is
        // either a protocol bug or a pool trying to reclaim the parent/tx choice;
        // either way, refuse it and rebuild rather than mine it.
        //
        // Match against every template still in flight, not just the newest: a
        // slow pool plus the result watchdog can legitimately leave two pending,
        // and assuming "the result belongs to the last one I sent" makes the two
        // cancel each other out forever.
        const settled = settleOutstanding(outstanding, msg.headerHex);
        if (!settled) {
          reporter.event('warn', '[nego-miner] pool returned a header that is not a template this miner built — refusing to grind it. (If this repeats, the pool is not honouring negotiated mode; switch pools or mine solo.)');
          // Refuse the foreign header — but do NOT stop a grind already running
          // on a template we DID build and verify. Killing good work because a
          // stale or foreign result arrived is self-inflicted downtime, and it
          // would hand a misbehaving pool an easy way to stop us mining.
          //
          // Schedule only if nothing else is coming (see THE RULE above). An
          // unmatched acceptance is normally just a delayed answer for a template
          // a tip change already superseded — and that tip change scheduled its
          // own registration.
          if (inFlight === 0) {
            if (resultWatchdog) { clearTimeout(resultWatchdog); resultWatchdog = null; }
            scheduleRegister(RETRY_BUILD_DELAY_MS);
          }
          break;
        }
        if (resultWatchdog) { clearTimeout(resultWatchdog); resultWatchdog = null; }
        // Reset the backoff only on a CORRELATED answer. Resetting on any
        // message at all lets a foreign or uncorrelated result hold the
        // re-registration rate high against exactly the slow pool the backoff
        // exists to converge on.
        watchdogStrikes = 0;
        outstanding = settled.rest;
        submittedNonces.clear();
        grinding = {
          templateId: String(msg.templateId),
          headerBytes: hexToBytes(String(msg.headerHex)),
          targetHex: String(msg.poolTargetHex),
        };
        reporter.event('info', `[nego-miner] template accepted (height ${msg.height}) — grinding`);
        startGrind();
        break;
      }

      case 'share_target':
        // Vardiff retarget for the current template.
        if (grinding && msg.templateId === grinding.templateId) {
          grinding.targetHex = String(msg.poolTargetHex);
          startGrind();
        }
        break;

      case 'share_result': {
        const accepted = msg.accepted === true;
        if (accepted) acceptedShares++;
        reporter.share(accepted, accepted ? (msg.block === true ? 'accepted (BLOCK!)' : 'accepted') : String(msg.reason ?? 'rejected'));
        if (!accepted && String(msg.reason ?? '').includes('stale')) {
          // Our template's parent went stale — stop and rebuild off the new tip.
          grind.stop();
          grinding = null;
          scheduleRegister(0);
        }
        break;
      }

      case 'block_found':
        reporter.event('info', `[nego-miner] pool found block ${msg.height} (by ${String(msg.foundBy ?? '').slice(0, 12)}…)`);
        break;

      case 'error':
        reporter.event('warn', `[nego-miner] pool: ${msg.message}`);
        break;

      // pool_stats / your_stats / work — ignore
    }
  }

  function connect(): void {
    if (stopped) return;
    const url = poolWsUrl(poolUrl);
    reporter.event('info', `[nego-miner] connecting to ${url}…`);
    let sock: WebSocket;
    try {
      sock = new WebSocket(url);
    } catch (e) {
      // The constructor throws synchronously on a URL it cannot parse. The grind
      // workers, pool stats and the hashrate interval already exist by now, so
      // letting this escape would leave them all running behind a rejected
      // promise. Retry on the same backoff as a dropped connection instead.
      reporter.event('warn', `[nego-miner] cannot open ${url}: ${(e as Error).message} — retrying in ${RECONNECT_DELAY_MS / 1000}s`);
      reconnectTimer = setTimeout(connect, RECONNECT_DELAY_MS);
      return;
    }
    // New generation: any registration still awaiting a catch-up belongs to the
    // OLD socket and must stop gating registrations on this one.
    socketGen++;
    ws = sock;
    sock.onopen = () => {
      sock.send(JSON.stringify({ type: 'auth', address: payoutAddress, mode: 'negotiated' }));
    };
    sock.onmessage = (ev: MessageEvent) => {
      let msg: Record<string, unknown>;
      try { msg = JSON.parse(String(ev.data)); } catch { return; }
      handleMsg(msg);
    };
    sock.onclose = () => {
      if (ws !== sock || stopped) return;
      ws = null;
      grind.stop();
      grinding = null;
      outstanding = [];
      inFlight = 0;
      submittedNonces.clear();
      if (resultWatchdog) { clearTimeout(resultWatchdog); resultWatchdog = null; }
      if (registerTimer) { clearTimeout(registerTimer); registerTimer = null; }
      reporter.event('warn', `[nego-miner] pool connection lost — reconnecting in ${RECONNECT_DELAY_MS / 1000}s`);
      reconnectTimer = setTimeout(connect, RECONNECT_DELAY_MS);
    };
    sock.onerror = () => { /* onclose follows and handles the retry */ };
  }

  connect();

  // Run until aborted. All exits (abort or otherwise) tear down timers/workers.
  await new Promise<void>((resolve) => {
    if (!signal) return; // headless run without a signal: mine forever
    if (signal.aborted) return resolve();
    signal.addEventListener('abort', () => resolve(), { once: true });
  });

  stopped = true;
  clearInterval(hashrateTimer);
  if (registerTimer) clearTimeout(registerTimer);
  if (resultWatchdog) clearTimeout(resultWatchdog);
  if (reconnectTimer) clearTimeout(reconnectTimer);
  stats.stop();
  grind.terminate();
  try { (ws as WebSocket | null)?.close(); } catch { /* already closed */ }
  reporter.close?.();
}
