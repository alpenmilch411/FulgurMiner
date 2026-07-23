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
  computeTxRoot, encodeBlock, type Block, type BlockHeader,
} from '../chain/block.js';
import { MAX_BLOCK_BYTES } from '../chain/genesis.js';
import { applyBlockTxs, cloneState, stateRoot } from '../chain/state.js';
import { decodeTx, encodeTx, validateTxStructure, type Transaction } from '../chain/transaction.js';
import { bytesToHex, hexToBytes } from '../util/binary.js';
import { resolveHelpers } from './config.js';
import { GrindPool } from './grindPool.js';
import { HelperPool } from './helperPool.js';
import { ConsoleReporter, type MinerReporter, type ReporterStatus } from './reporter.js';
import { smartStartDuty } from './smartController.js';
import { startPoolStats } from './poolStats.js';
import { ChainSync } from './sync.js';
import { VerifierPool, verifyBlocksParallel } from './verify.js';

// Stay above the pool's 2s per-connection template throttle.
export const REGISTER_MIN_INTERVAL_MS = 2_200;
// If a registered template gets no template_result (ws blip, server hiccup),
// re-register rather than sit idle forever.
const TEMPLATE_RESULT_TIMEOUT_MS = 12_000;
const RECONNECT_DELAY_MS = 5_000;
const RETRY_BUILD_DELAY_MS = 5_000;
// The pool marks a miner's hashrate stale after ~15s without a report.
const HASHRATE_REPORT_MS = 5_000;
// Leave room for the header + varint/count framing when packing transactions.
const TX_BYTE_BUDGET = MAX_BLOCK_BYTES - 1_024;

/** Does this /register failure mean "pool requires negotiated mode"? (410 is the
 *  documented signal; the error text is a fallback for proxies that rewrite the
 *  status.) Exported for unit tests. */
export function negotiatedRequired(status: number, body: unknown): boolean {
  if (status === 410) return true;
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
  for (const hex of hexes) {
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

/** http(s)://pool → ws(s)://pool/ws */
export function poolWsUrl(poolUrl: string): string {
  return poolUrl.replace(/^http/, 'ws').replace(/\/+$/, '') + '/ws';
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
  });

  // ── Connection + job state ──
  let ws: WebSocket | null = null;
  let stopped = false;
  let lastChainInfo: ChainInfo | null = null;
  let grinding: { templateId: string; headerBytes: Uint8Array; targetHex: string } | null = null;
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
    if (registerTimer) clearTimeout(registerTimer);
    registerTimer = setTimeout(() => { void registerTemplate(); }, delayMs);
  };

  const startGrind = (): void => {
    if (!grinding) return;
    grind.start(
      grinding.headerBytes,
      grinding.targetHex,
      (nonce, hash) => {
        if (grinding) send({ type: 'share', jobId: grinding.templateId, nonce, hashHex: bytesToHex(hash) });
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
    if (stopped || !ws || ws.readyState !== WebSocket.OPEN) return;
    const info = lastChainInfo;
    if (!info) return;

    // Converge our chain onto the pool's announced tip before building. The pool
    // only accepts templates built on ITS current tip; if we're momentarily ahead
    // (we synced a block it hasn't seen), the register below gets a 'stale parent'
    // rejection and the retry loop re-registers once the pool catches up.
    if (bytesToHex(chain.tip.hash) !== info.tipHash && !chain.hasBlock(info.tipHash) && !syncing) {
      syncing = true;
      try {
        await sync.catchUp({ height: info.height, tipHash: info.tipHash });
      } catch (e) {
        if ((e as Error)?.name === 'AbortError') return;
        reporter.event('warn', `[nego-miner] catch-up failed: ${(e as Error).message} — retrying`);
        scheduleRegister(RETRY_BUILD_DELAY_MS);
        return;
      } finally {
        syncing = false;
      }
      const wanted = (lastChainInfo ?? info).tipHash;
      if (bytesToHex(chain.tip.hash) !== wanted && !chain.hasBlock(wanted)) {
        // Helpers haven't served the pool's tip yet — retry shortly.
        scheduleRegister(RETRY_BUILD_DELAY_MS);
        return;
      }
    }

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
    lastRegisterAt = Date.now();
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
        // current template is still valid — keep grinding it.
        if (grinding && info.tipHash === prevTip) break;
        if (grinding) { grind.stop(); grinding = null; }
        scheduleRegister(0);
        break;
      }

      case 'template_result': {
        if (resultWatchdog) { clearTimeout(resultWatchdog); resultWatchdog = null; }
        if (msg.accepted !== true) {
          const reason = String(msg.reason ?? 'unknown');
          reporter.event('warn', `[nego-miner] template rejected: ${reason}`);
          if (reason.includes('rate limited')) scheduleRegister(REGISTER_MIN_INTERVAL_MS);
          else scheduleRegister(RETRY_BUILD_DELAY_MS);
          break;
        }
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
    const sock = new WebSocket(url);
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
