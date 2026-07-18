// src/minerd/reporter.ts
//
// Reporter abstraction. The mining core (miner.ts / poolClient.ts) routes all of
// its user-facing output through a MinerReporter instead of writing to the
// console directly. ConsoleReporter reproduces today's plain-log output exactly,
// so `npm run mine` / `mine:dryrun` are unchanged. DashboardReporter (tui.ts) is
// an alternate implementation that renders a full-screen numbers dashboard.
import { createWriteStream, mkdirSync, type WriteStream } from 'node:fs';
import { join } from 'node:path';
import { blockReward, COIN } from '../chain/genesis.js';

/** Group an integer with thousands separators (e.g. 11772 → '11,772'). */
function grp(n: number): string {
  if (!Number.isFinite(n)) return '0';
  return Math.round(n).toLocaleString('en-US');
}

/** ISO timestamps keep plain miner logs directly sortable/graphable. */
function stamp(): string { return new Date().toISOString(); }
function line(message: string): void { console.log(`[${stamp()}] ${message}`); }
function errorLine(message: string): void { console.error(`[${stamp()}] ${message}`); }
function warnLine(message: string): void { console.warn(`[${stamp()}] ${message}`); }

type JsonlFields = Record<string, unknown>;

/** Optional machine-readable sidecar. Console output remains the primary log;
 * this stream is append-only JSONL for jq, Python, or a later metrics collector. */
class JsonlLogger {
  private stream: WriteStream | null = null;
  private context: JsonlFields = {};

  constructor(path = process.env.MINER_LOG_FILE) {
    if (!path && process.env.MINER_LOG_DIR?.trim()) {
      const dir = process.env.MINER_LOG_DIR.trim();
      const now = new Date();
      const fileStamp = now.toISOString().replace(/[-:]/g, '').replace('T', '-').replace(/\.\d{3}Z$/, '');
      path = join(dir, `miner-${fileStamp}-pid${process.pid}.jsonl`);
      try { mkdirSync(dir, { recursive: true }); } catch { path = undefined; }
    }
    if (!path || path.trim() === '') return;
    try {
      this.stream = createWriteStream(path, { flags: 'a' });
      // Logging must never be able to bring down a miner because a path/disk
      // becomes unavailable.
      this.stream.on('error', () => { this.stream = null; });
    } catch {
      this.stream = null;
    }
  }

  emit(event: string, fields: JsonlFields = {}): void {
    if (!this.stream) return;
    try {
      this.stream.write(`${JSON.stringify({ ts: new Date().toISOString(), event, ...this.context, ...fields })}\n`);
    } catch {
      this.stream = null;
    }
  }

  setContext(fields: JsonlFields): void {
    this.context = { ...this.context, ...fields };
  }

  close(): void {
    this.stream?.end();
    this.stream = null;
  }
}

function logTextEvent(logger: JsonlLogger, level: string, message: string): void {
  const base = { level, message };
  const text = message.trim();
  let match = /^\[pool-miner\] CUDA_POOL_JOB id=(\S+)/.exec(text);
  if (match) return logger.emit('cuda_pool_job', { ...base, jobId: match[1] });
  match = /^\[pool-miner\] CUDA_JOB token=(\d+)/.exec(text);
  if (match) return logger.emit('cuda_job', { ...base, token: Number(match[1]) });
  match = /^\[pool-miner\] CUDA_BATCH selected=(\d+) workspace_mib=(\d+) free_mib=(\d+) total_mib=(\d+) reserve_mib=(\d+) guard_mib=(\d+)/.exec(text);
  if (match) return logger.emit('cuda_batch', {
    ...base, batch: Number(match[1]), workspaceMiB: Number(match[2]),
    freeMiB: Number(match[3]), totalMiB: Number(match[4]),
    reserveMiB: Number(match[5]), guardMiB: Number(match[6]),
  });
  match = /^\[pool-miner\] CUDA_BATCH rebalance_pending=(\d+) observations=(\d+)/.exec(text);
  if (match) return logger.emit('cuda_rebalance', {
    ...base, batch: Number(match[1]), observations: Number(match[2]), phase: 'pending',
  });
  match = /^\[pool-miner\] CUDA_BATCH rebalanced=(\d+)(?: candidate=(\d+))?/.exec(text);
  if (match) return logger.emit('cuda_rebalance', {
    ...base, batch: Number(match[1]), candidateBatch: match[2] ? Number(match[2]) : 0, phase: 'applied',
  });
  match = /^\[pool-miner\] CUDA_MODE persistent iterations=(\d+)/.exec(text);
  if (match) return logger.emit('cuda_mode', { ...base, persistent: true, iterations: Number(match[1]) });
  if (message.includes('nonce slot exhausted')) return logger.emit('nonce_slot_exhausted', base);
  if (message.includes('BLOCK FOUND')) return logger.emit('block_found', base);
  if (message.includes('grind error')) return logger.emit('grind_error', base);
  logger.emit('message', base);
}

/** Sum the halving-accurate coinbase reward (BRC) for the given accepted block heights. */
export function soloEarnedBrc(heights: number[]): number {
  let wei = 0n;
  for (const h of heights) wei += blockReward(h);
  return Number(wei) / Number(COIN);
}

export interface ReporterStatus {
  mode: 'solo' | 'pool';
  /** Human label for the target: 'FulgurPool' | a pool URL | 'solo'. */
  target: string;
  /** Canonical mining/site URL whose host is shown next to the label (default pool). */
  targetUrl?: string;
  /** Website to hyperlink the shown host to (OSC 8). Falls back to targetUrl. */
  targetPage?: string;
  backend: 'wasm' | 'native' | 'cuda';
  /** Optional one-line note about the backend choice, e.g. why native fell back to
   *  wasm. Shown persistently so the user doesn't have to quit to discover it. */
  backendNote?: string;
  workers: number;
  throttle: number;
  /** Full 64-hex payout address. */
  address: string;
}

export interface FoundInfo {
  height: number;
  hash: string;
  accepted: boolean;
  detail: string;
}

export interface SmartInfo {
  mode: 'max' | 'considerate';
  throttle: number;
  clamped: boolean;
  phase: 'ramping' | 'holding' | 'easing';
}

// ─── Optional KPI payloads ────────────────────────────────
// These types + the optional reporter methods below are the locked interface
// seam for the pool-integration KPIs (Earnings/Jackpot/update nudge).
// Both reporters accept the calls and render NOTHING unless a caller emits
// the data. Defining them keeps the MinerReporter shape stable; adding data later is
// a pure fill-in (data + rendering).

/** Earnings KPI. solo = blockReward × blocksFound (local); pool = GET /balance. */
export interface EarningsInfo {
  kind: 'solo' | 'pool-balance' | 'pool-shares';
  /** solo: blocksFound × blockReward (BRC). pool-balance: earnedBrc. */
  earnedBrc?: number;
  pendingBrc?: number; // pool-balance only
  paidBrc?: number;    // pool-balance only
  shares?: number;     // pool-shares (other pools)
  pageUrl?: string;    // pool-shares: link to the pool's stats page
}

/** Jackpot KPI (FulgurPool finder-bonus). From GET /jackpot. */
export interface JackpotInfo {
  /** Finder-bonus fraction, e.g. 0.03. */
  finderBonusPct: number;
  /** Block-strikes credited to this miner. */
  yourBlockStrikes: number;
  lastWinner?: string;       // address/label of the last jackpot winner
  lastStrikeHeight?: number; // height of the last strike
}

/** One-line update nudge. The latest version comes from the repo's GitHub release;
 *  the miner updates via `git pull` from the public repo. */
export interface UpdateNotice {
  currentVersion: string;
  latestVersion?: string;
  /** true ⇒ a newer version exists (currentVersion < latestVersion). Only then is
   *  an "update available" line shown; a bare `notice` while current must not. */
  available?: boolean;
  /** true ⇒ 426 / minMinerVersion gate: must update before mining continues. */
  mustUpdate: boolean;
  /** Free-form pool 'notice' string from /register or GET /version. */
  notice?: string;
}

export interface MinerReporter {
  /** Called once, after the backend is chosen. */
  status(s: ReporterStatus): void;
  /**
   * Sync progress while bootstrapping the chain. `current` is the height applied
   * so far, `target` the tip height we're catching up to. Implementations should
   * clamp `current ≤ target` and treat `target ≤ 0` as indeterminate. Called
   * after each page; reporters throttle their own output.
   */
  syncProgress(current: number, target: number): void;
  /** Called once, after bootstrap/registration completes. */
  synced(height: number): void;
  /** Current pool worker identity, refreshed after registration/reregistration. */
  workerId?(id: string): void;
  /** Called ~1×/sec with the number of hashes in the last window. */
  hashrate(hps: number): void;
  /** Latest chain tip height + difficulty (hex). */
  chain(height: number, difficultyHex: string): void;
  /** A solo block was found and submitted. */
  found(info: FoundInfo): void;
  /** A pool share result came back. */
  share(accepted: boolean, result: string): void;
  /** A free-form event line (info/warn/error). */
  event(level: 'info' | 'warn' | 'error', msg: string): void;
  /** Live smart-mode throttle. Optional so non-smart callers can ignore it. */
  smart?(info: SmartInfo): void;
  /** Earnings KPI. Optional — renders nothing when not provided. */
  earnings?(e: EarningsInfo): void;
  /** Canonical-tip reorg delta, used to prune orphaned solo rewards. */
  reorg?(connectedHashes: string[], disconnectedHashes: string[]): void;
  /** A deep-reorg chain reset (reset() fires no tip-change): orphan all recorded solo
   *  rewards; the replay re-connects survivors via reorg(). */
  soloReorgReset?(): void;
  /** Jackpot KPI / FulgurPool. Optional — renders nothing when not provided. */
  jackpot?(j: JackpotInfo): void;
  /** Update-available nudge. Optional — renders nothing when not provided. */
  updateNotice?(n: UpdateNotice): void;
  /** Optional teardown — the TUI restores the screen here. */
  close?(): void;
}

/**
 * ConsoleReporter — plain-log reporter that reproduces the miner's pre-TUI
 * output. Same `[minerd]` / `[pool-miner]` prefixes; keeps the familiar
 * carriage-return status line refreshed on every hashrate tick.
 *
 * INVARIANT: ConsoleReporter must NEVER emit colour/SGR (`\x1b[…m`), OSC 8
 * hyperlinks (the `link()` helper / `\x1b]8;;…` wrappers), or any other ANSI
 * control sequence. It is the reporter for plain mode AND for piped/non-TTY
 * output, where escape codes would corrupt greppable logs and downstream tools.
 * All clickable-host / colour rendering lives only in the DashboardReporter (TUI).
 * The lone `\r` carriage return below is plain ASCII, not an ANSI escape.
 */
export class ConsoleReporter implements MinerReporter {
  private readonly jsonl = new JsonlLogger();
  private height = 0;
  private difficultyHex = '0';
  private status_: ReporterStatus | null = null;
  private workerId_: string | null = null;
  // Sync-progress throttling: emit at most ~1/sec or on a ≥2% jump so plain logs
  // show steady progress without flooding. -1 = no line emitted yet this sync.
  private lastSyncLogAt = 0;
  private lastSyncPct = -1;
  private soloBlocks: { height: number; hash: string }[] = [];
  private orphanedSoloHashes = new Set<string>();
  private smart_: SmartInfo | null = null;
  // Session-end guard for the jackpot panel: once a session has ended, a late
  // jackpot() call (e.g. a /jackpot response that was already in flight when the
  // pool stopped) must not print a stale finder-bonus line into what now reads as
  // a new session's log.
  private closed_ = false;

  private canonicalSolo(): { heights: number[]; earnedBrc: number; count: number } {
    const heights = this.soloBlocks
      .filter((b) => !this.orphanedSoloHashes.has(b.hash))
      .map((b) => b.height);
    return { heights, earnedBrc: soloEarnedBrc(heights), count: heights.length };
  }

  status(s: ReporterStatus): void {
    this.status_ = s;
    const machine = `${s.backend}/${s.mode}`;
    this.jsonl.setContext({ machine, backend: s.backend });
    this.jsonl.emit('status', { mode: s.mode, target: s.target, backend: s.backend, workers: s.workers, throttle: s.throttle, address: s.address });
    if (s.backendNote) line(`[${s.mode === 'pool' ? 'pool-miner' : 'minerd'}] ${s.backendNote}`);
    if (s.mode === 'pool') return; // pool registration line is emitted by poolClient flow
    const backend = s.backend === 'native'
      ? 'native (Rust)'
      : s.backend === 'cuda'
        ? 'cuda'
        : 'wasm (worker_threads)';
    // Mirror miner.ts's old startup lines so plain mode looks unchanged.
    line(`[minerd] mining to ${s.address.slice(0, 16)}… (${s.workers} workers, throttle ${s.throttle})`);
    line(`[minerd] grind backend: ${backend}`);
  }

  syncProgress(current: number, target: number): void {
    // Indeterminate target: still surface that we're advancing so there's never a
    // long silent gap during bootstrap, just without a percentage. The wording
    // makes plain WHAT is happening — we download + verify BrowserCoin's chain so
    // the miner builds on the correct one.
    if (!Number.isFinite(target) || target <= 0) {
      const now = Date.now();
      // Throttle indeterminate updates a bit tighter (500ms) so a slow burst of
      // pages still shows visible progress and never a long silent gap.
      if (now - this.lastSyncLogAt < 500) return;
      this.lastSyncLogAt = now;
      line(`[minerd] verifying BrowserCoin blockchain ${grp(current)} blocks…`);
      return;
    }
    const cur = Math.max(0, Math.min(current, target));
    const pct = Math.floor((cur / target) * 100);
    const now = Date.now();
    // Throttle: at most ~1/sec, but always allow a ≥2% change through so progress
    // is visible even if pages land faster than once per second.
    const enoughTime = now - this.lastSyncLogAt >= 1000;
    const enoughChange = this.lastSyncPct < 0 || pct - this.lastSyncPct >= 2;
    if (!enoughTime && !enoughChange) return;
    this.lastSyncLogAt = now;
    this.lastSyncPct = pct;
    this.jsonl.emit('sync_progress', { current: cur, target, percent: pct });
    line(`[minerd] verifying BrowserCoin blockchain ${grp(cur)} / ${grp(target)} (${pct}%)`);
  }

  synced(height: number): void {
    this.height = height;
    this.jsonl.emit('synced', { height });
    const prefix = this.status_?.mode === 'pool' ? '[pool-miner]' : '[minerd]';
    line(`${prefix} synced to height ${height}`);
  }

  workerId(id: string): void {
    this.workerId_ = id;
    const backend = this.status_?.backend ?? 'unknown';
    this.jsonl.setContext({ machine: `${backend}/${id}`, backend, workerId: id });
    this.jsonl.emit('worker_id', { workerId: id });
  }

  hashrate(hps: number): void {
    this.jsonl.emit('hashrate', { hps, height: this.height, workerId: this.workerId_ });
    let smartSuffix = '';
    if (this.smart_) {
      const pct = Math.round(this.smart_.throttle * 100);
      let label: string;
      switch (this.smart_.phase) {
        case 'ramping': label = 'ramping'; break;
        case 'holding': label = 'max'; break;
        default: label = this.smart_.throttle <= 0.15 ? 'yielding' : 'easing off'; break;
      }
      smartSuffix = ` auto ${pct}% ${label}`;
    }
    if (this.status_?.mode === 'pool') {
      process.stdout.write(`\r[${stamp()}] [pool-miner] ${hps} H/s${smartSuffix}   `);
    } else {
      process.stdout.write(`\r[${stamp()}] [minerd] h=${this.height} diff=${this.difficultyHex} hps:${hps}${smartSuffix}   `);
    }
  }

  chain(height: number, difficultyHex: string): void {
    this.height = height;
    this.difficultyHex = difficultyHex;
    this.jsonl.emit('chain', { height, difficultyHex });
  }

  found(info: FoundInfo): void {
    this.jsonl.emit('found', { height: info.height, hash: info.hash, accepted: info.accepted, detail: info.detail });
    line(`\n[minerd] FOUND height=${info.height} hash=${info.hash} ${info.detail}`);
    if (info.accepted && this.status_?.mode !== 'pool') {
      this.soloBlocks.push({ height: info.height, hash: info.hash });
      this.earnings({ kind: 'solo', earnedBrc: this.canonicalSolo().earnedBrc });
    }
  }

  reorg(connectedHashes: string[], disconnectedHashes: string[]): void {
    let changed = false;
    for (const h of disconnectedHashes) {
      if (this.soloBlocks.some((b) => b.hash === h) && !this.orphanedSoloHashes.has(h)) {
        this.orphanedSoloHashes.add(h);
        changed = true;
      }
    }
    for (const h of connectedHashes) {
      if (this.orphanedSoloHashes.has(h)) {
        this.orphanedSoloHashes.delete(h);
        changed = true;
      }
    }
    if (changed) this.earnings({ kind: 'solo', earnedBrc: this.canonicalSolo().earnedBrc });
  }

  soloReorgReset(): void {
    let changed = false;
    for (const b of this.soloBlocks) {
      if (!this.orphanedSoloHashes.has(b.hash)) {
        this.orphanedSoloHashes.add(b.hash);
        changed = true;
      }
    }
    if (changed) this.earnings({ kind: 'solo', earnedBrc: this.canonicalSolo().earnedBrc });
  }

  share(accepted: boolean, result: string): void {
    this.jsonl.emit(accepted ? 'share_accepted' : 'share_rejected', { accepted, result, workerId: this.workerId_ });
    process.stdout.write(`\n[${stamp()}] [pool-miner] share ${accepted ? 'accepted' : 'rejected'}: ${result}\n`);
  }

  event(level: 'info' | 'warn' | 'error', msg: string): void {
    logTextEvent(this.jsonl, level, msg);
    if (level === 'error') errorLine(`\n${msg}`);
    else if (level === 'warn') warnLine(`\n${msg}`);
    else line(msg);
  }

  smart(info: SmartInfo): void {
    this.smart_ = info;
    this.jsonl.emit('smart', { ...info });
  }

  // ─── Optional KPI channel ──────────────────────────────
  // Concrete no-op homes for the optional KPI methods. Filled with
  // ASCII-only plain lines (earnings / jackpot / update nudge) — never SGR or
  // OSC-8 per the INVARIANT above (this is also the piped/non-TTY path).
  earnings(e: EarningsInfo): void {
    this.jsonl.emit('earnings', { ...e, workerId: this.workerId_ });
    if (e.kind === 'pool-balance') {
      const id = this.workerId_ ? ` miner=${this.workerId_}` : '';
      line(`[pool-miner] earnings: ${e.earnedBrc} BRC (pending ${e.pendingBrc}, paid ${e.paidBrc})${id}`);
    } else if (e.kind === 'pool-shares') {
      const id = this.workerId_ ? ` miner=${this.workerId_}` : '';
      line(`[pool-miner] shares: ${e.shares}${e.pageUrl ? ` (stats: ${e.pageUrl})` : ''}${id}`);
    } else {
      line(`[minerd] earnings (est): ${e.earnedBrc} BRC (${this.canonicalSolo().count} blocks)`);
    }
  }

  jackpot(j: JackpotInfo): void {
    if (this.closed_) return; // the session has ended — never print a stale panel
    this.jsonl.emit('jackpot', { ...j });
    const last = j.lastWinner ? ` - last ${j.lastWinner.slice(0, 12)}...@${j.lastStrikeHeight ?? '?'}` : '';
    line(`[pool-miner] jackpot: ${Math.round(j.finderBonusPct * 100)}% finder bonus - blocks found: ${j.yourBlockStrikes}${last}`);
  }

  /** Session end. Plain mode has no persistent panel to erase, but this closes
   *  the door on any late jackpot() call (e.g. from an in-flight /jackpot request
   *  that was already underway when the session stopped) — TUI/plain parity. */
  close(): void {
    this.closed_ = true;
    this.jsonl.close();
  }

  updateNotice(n: UpdateNotice): void {
    this.jsonl.emit('update_notice', { ...n });
    if (n.mustUpdate) {
      line(`[minerd] UPDATE REQUIRED: v${n.currentVersion} -> v${n.latestVersion ?? '?'} - ${n.notice ?? 'run the update command'}`);
    } else if (n.available && n.latestVersion) {
      line(`[minerd] update available: v${n.currentVersion} -> v${n.latestVersion} (press 'u' for the command)`);
    } else if (n.notice) {
      line(`[minerd] notice: ${n.notice}`);
    }
  }
}
