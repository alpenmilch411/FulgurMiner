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
// A slow pool can leave more than one registration in flight (the result
// watchdog re-registers at 12s). Keep the recent ones so a late result is
// correlated to the template it belongs to instead of clobbering a newer one.
const MAX_OUTSTANDING_TEMPLATES = 4;

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

/** Decode the pool-announced mempool hexes into structurally-valid txs, bounded
 *  by the block byte budget. Consensus validity is enforced by the applyBlockTxs
 *  simulation in buildNegotiatedTemplate — a set that fails there falls back to
 *  an empty block. Exported for unit tests. */
export function decodeMempool(hexes: string[]): Transaction[] {
  const txs: Transaction[] = [];
  let bytes = 0;
  let seen = 0;
  for (const hex of hexes) {
    // Bound the POOL-SUPPLIED input BEFORE touching it. hexToBytes materialises
    // the whole string, and decodeTx does not require full consumption — so a
    // single huge entry (or a valid tx followed by megabytes of trailing junk)
    // would be allocated and parsed before the byte budget below could reject
    // it. The budget bounds our OUTPUT; these bound the INPUT.
    if (++seen > MAX_MEMPOOL_ENTRIES) break;
    if (typeof hex !== 'string' || hex.length > MAX_TX_HEX_LEN) continue;
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
 * A single "last one I sent" slot is wrong: if the pool takes longer than the
 * result watchdog to answer, a second template is registered while the first is
 * still pending, and the two results cancel each other out — the first is
 * checked against the second, refused, and clears it; the second then finds
 * nothing pending. With a consistently slow pool that repeats forever and the
 * miner never starts grinding at all.
 *
 * Returns the matched template and the templates still outstanding after it
 * (the match and anything older are settled), or null if the header belongs to
 * no template this miner built — which must never be ground.
 *
 * Exported for unit tests.
 */
export function settleOutstanding(
  outstanding: readonly Block[], headerHex: unknown,
): { matched: Block; rest: Block[] } | null {
  const idx = outstanding.findIndex((b) => headerMatchesTemplate(b, headerHex));
  if (idx < 0) return null;
  return { matched: outstanding[idx]!, rest: outstanding.slice(idx + 1) };
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
  let outstanding: Block[] = [];
  // True while registerTemplate() is between its first await and its send, so a
  // timer-driven second call cannot skip the catch-up branch and build on a tip
  // that has not converged yet.
  let registering = false;
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
        submittedNonces.add(nonce);
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
    if (registering) { scheduleRegister(RETRY_REGISTER_BUSY_MS); return; }
    registering = true;
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
      registering = false;
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
    lastRegisterAt = Date.now();
    outstanding.push(block);
    if (outstanding.length > MAX_OUTSTANDING_TEMPLATES) outstanding.shift();
    send({ type: 'template', blockHex: bytesToHex(encodeBlock(block)) });
    reporter.chain(block.header.height, block.header.difficulty.toString(16));
    if (resultWatchdog) clearTimeout(resultWatchdog);
    resultWatchdog = setTimeout(() => {
      reporter.event('warn', '[nego-miner] no template_result — re-registering');
      scheduleRegister(0);
    }, TEMPLATE_RESULT_TIMEOUT_MS);
  }

  function handleMsg(msg: Record<string, unknown>): void {
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
        if (resultWatchdog) { clearTimeout(resultWatchdog); resultWatchdog = null; }
        if (msg.accepted !== true) {
          // A rejection is not correlated to a specific template by the protocol;
          // drop the oldest in-flight one so a stuck entry can't accumulate.
          outstanding.shift();
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
          reporter.event('warn', '[nego-miner] pool returned a header that is not a template this miner built — refusing to grind it, rebuilding. (If this repeats, the pool is not honouring negotiated mode; switch pools or mine solo.)');
          grind.stop();
          grinding = null;
          scheduleRegister(RETRY_BUILD_DELAY_MS);
          break;
        }
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
