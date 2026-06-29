// gui/server.mjs — zero-dependency control panel for FulgurMiner (solo mining).
//
// Node built-ins only. Spawns `npm run mine` as a child with the env vars the
// headless miner needs (it does NOT read .env.local), parses the miner's
// plain-mode stdout for live metrics, and serves a tiny JSON API + single-page
// UI bound to 127.0.0.1 only.
//
// Cross-platform (Windows / macOS / Linux):
//   • spawn      — `npm` on POSIX, `npm.cmd` on Windows.
//   • kill tree  — npm → tsx → worker hosts. POSIX: spawn detached (own process
//                  group) and kill -pid. Windows: `taskkill /PID <pid> /T /F`.
//   • keep-awake — macOS `caffeinate -i -m -s`, Linux `systemd-inhibit`,
//                  Windows `SetThreadExecutionState` via a tiny PowerShell loop.
//                  All best-effort: if the tool is missing it silently no-ops.
//
// Wallet balance: read from the miner's own verified chain-state snapshot at
// ~/.fulgurminer/snapshot-*.json (rows of [addressHex, balanceWei, nonce]). This
// is the confirmed/finalized balance the miner has validated locally — no API
// for balances exists, the wallet app runs a full node. 1 BRC = 1e8 wei.

import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { readFile as readFileAsync } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_DIR = path.resolve(__dirname, '..');
const STATE_FILE = path.join(__dirname, 'state.json');
const INDEX_HTML = path.join(__dirname, 'index.html');

const IS_WIN = process.platform === 'win32';
const IS_MAC = process.platform === 'darwin';
const IS_LINUX = process.platform === 'linux';

const HOST = '127.0.0.1';
const PORT = 7311;
const CORES = Math.max(1, os.cpus().length);
// No baked-in payout address: each user sets their own in the panel (or via
// POST /api/config). Mining refuses to start until a valid 64-hex wallet is set.
const DEFAULT_WALLET = '';
const COIN = 1e8; // 1 BRC = 1e8 wei
// FulgurPool — the project's default pool (same value the miner uses).
const FULGURPOOL_URL = 'https://pool.fulgurpool.xyz';

// ─── Persistent settings ──────────────────────────────────────────────────
const DEFAULT_SETTINGS = {
  engine: 'native',          // 'native' | 'wasm'
  mode: 'max',               // 'max' | 'considerate' | 'manual'
  workers: Math.max(1, CORES - 1),
  throttle: 0.75,            // 0.05..1, only meaningful in manual mode
  wallet: DEFAULT_WALLET,
  pool: 'solo',              // 'solo' | 'pool'  (where to mine)
  poolUrl: FULGURPOOL_URL,   // pool endpoint used when pool === 'pool'
};

function loadSettings() {
  try {
    if (existsSync(STATE_FILE)) {
      const s = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
      return sanitizeSettings({ ...DEFAULT_SETTINGS, ...s });
    }
  } catch (e) {
    console.error('[gui] could not read state.json, using defaults:', e.message);
  }
  return { ...DEFAULT_SETTINGS };
}

// `fallbackWallet` is the wallet to keep when the incoming one is invalid — pass
// the CURRENT wallet from the config handler so a typo can never silently reset
// the payout address (at first load there is no current, so it falls to default).
function sanitizeSettings(s, fallbackWallet = DEFAULT_WALLET) {
  const engine = s.engine === 'wasm' ? 'wasm' : 'native';
  const mode = ['max', 'considerate', 'manual'].includes(s.mode) ? s.mode : 'max';
  let workers = Math.floor(Number(s.workers));
  if (!Number.isFinite(workers)) workers = DEFAULT_SETTINGS.workers;
  workers = Math.min(CORES, Math.max(1, workers));
  let throttle = Number(s.throttle);
  if (!Number.isFinite(throttle)) throttle = 0.75;
  throttle = Math.min(1, Math.max(0.05, throttle));
  let wallet = String(s.wallet || '').trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(wallet)) wallet = fallbackWallet;
  const pool = s.pool === 'pool' ? 'pool' : 'solo';
  let poolUrl = String(s.poolUrl || '').trim();
  if (!/^https?:\/\/[^\s]+$/i.test(poolUrl)) poolUrl = FULGURPOOL_URL;
  poolUrl = poolUrl.replace(/\/+$/, '');
  return { engine, mode, workers, throttle, wallet, pool, poolUrl };
}

function saveSettings() {
  try {
    writeFileSync(STATE_FILE, JSON.stringify(settings, null, 2));
  } catch (e) {
    console.error('[gui] could not write state.json:', e.message);
  }
}

let settings = loadSettings();

// ─── Live miner state ───────────────────────────────────────────────────────
const HASH_WINDOW = 30; // rolling-average window (~30 samples ≈ 30s)
let child = null;             // the current miner process (its .{_stopped} marks an intentional kill)
let caffeinate = null;        // per-mine keep-awake handle
let serverCaffeinate = null;  // server-lifetime keep-awake handle

const state = {
  status: 'idle',          // idle | syncing | mining | error
  backend: null,           // native | wasm
  startedAt: null,
  height: 0,
  difficulty: null,        // compact-bits hex string from the hot line
  hashNow: 0,
  hashPeak: 0,
  hashSamples: [],         // rolling window for the average
  blocks: 0,
  shares: 0,
  sync: { current: 0, target: 0, pct: 0 },
  pool: { earned: null, pending: null, paid: null }, // BRC, parsed in pool mode
  lastError: null,
  log: [],                 // ring buffer of human-readable log lines
};

function resetRun() {
  state.backend = null;
  state.height = 0;
  state.difficulty = null;
  state.hashNow = 0;
  state.hashPeak = 0;
  state.hashSamples = [];
  state.blocks = 0;
  state.shares = 0;
  state.sync = { current: 0, target: 0, pct: 0 };
  state.pool = { earned: null, pending: null, paid: null };
  state.lastError = null;
}

const LOG_MAX = 250;
function pushLog(line) {
  const clean = line.replace(/\s+$/, '');
  if (!clean) return;
  state.log.push({ t: Date.now(), line: clean });
  if (state.log.length > LOG_MAX) state.log.splice(0, state.log.length - LOG_MAX);
}

function avgHash() {
  if (!state.hashSamples.length) return 0;
  return state.hashSamples.reduce((a, b) => a + b, 0) / state.hashSamples.length;
}

// ─── Miner stdout parsing ─────────────────────────────────────────────────
const RE_SYNC = /verifying BrowserCoin blockchain ([\d,]+)\s*\/\s*([\d,]+)\s*\((\d+)%\)/;
const RE_SYNCED = /synced to height\s*([\d,]+)/;
const RE_BACKEND = /grind backend:\s*(\w+)/;
const RE_HOT = /h=(\d+)\s+diff=(\w+)\s+hps:(\d+)/g;
const RE_FOUND = /FOUND height=(\d+)/;
const RE_SHARE = /share (accepted|rejected)/;
// Pool-mode (MINER_POOL=<url>) plain output: hashrate + running earnings.
const RE_POOL_HPS = /\[pool-miner\]\s+([\d.]+)\s*H\/s/;
const RE_POOL_EARN = /earnings:\s*([\d.]+)\s*BRC\s*\(pending\s*([\d.]+),\s*paid\s*([\d.]+)\)/;
const num = (s) => Number(String(s).replace(/,/g, ''));

let lineBuf = '';

function handleChunk(buf, stream) {
  const chunk = buf.toString('utf8');

  // ── Metrics: parse the raw chunk directly so we never miss the \r-only hot
  //    lines (which carry no newline). Take the LAST hot match in the chunk.
  let m;
  let lastHot = null;
  RE_HOT.lastIndex = 0;
  while ((m = RE_HOT.exec(chunk)) !== null) lastHot = m;
  if (lastHot) {
    state.height = Number(lastHot[1]);
    state.difficulty = lastHot[2];
    const hps = Number(lastHot[3]);
    state.hashNow = hps;
    state.hashSamples.push(hps);
    if (state.hashSamples.length > HASH_WINDOW) state.hashSamples.shift();
    if (hps > state.hashPeak) state.hashPeak = hps;
    if (child && state.status !== 'error') state.status = 'mining';
  }

  const sy = chunk.match(RE_SYNC);
  if (sy) {
    state.sync = { current: num(sy[1]), target: num(sy[2]), pct: Number(sy[3]) };
    if (child && state.status !== 'error') state.status = 'syncing';
  }
  const sd = chunk.match(RE_SYNCED);
  if (sd) {
    state.height = num(sd[1]);
    if (child && state.status !== 'error') state.status = 'mining';
  }
  const be = chunk.match(RE_BACKEND);
  if (be) state.backend = be[1];
  const fd = chunk.match(RE_FOUND);
  if (fd) state.blocks += 1;
  const sh = chunk.match(RE_SHARE);
  if (sh && sh[1] === 'accepted') state.shares += 1;

  // Pool mode: the miner reports its own hashrate (no local h=/hps hot line) and
  // a running earnings line. Feed both into the same metrics the UI already shows.
  const ph = chunk.match(RE_POOL_HPS);
  if (ph) {
    const hps = Number(ph[1]);
    if (Number.isFinite(hps)) {
      state.hashNow = hps;
      state.hashSamples.push(hps);
      if (state.hashSamples.length > HASH_WINDOW) state.hashSamples.shift();
      if (hps > state.hashPeak) state.hashPeak = hps;
      if (child && state.status !== 'error') state.status = 'mining';
    }
  }
  const pe = chunk.match(RE_POOL_EARN);
  if (pe) state.pool = { earned: Number(pe[1]), pending: Number(pe[2]), paid: Number(pe[3]) };

  // ── Visible log: treat \r as a line break (it's an in-place refresh), split,
  //    and drop the high-frequency h=/hps spam.
  lineBuf += chunk.replace(/\r/g, '\n');
  const parts = lineBuf.split('\n');
  lineBuf = parts.pop(); // keep trailing partial line
  for (const raw of parts) {
    const line = raw.replace(/\s+$/, '');
    if (!line) continue;
    if (/h=\d+\s+diff=\w+\s+hps:/.test(line)) continue; // drop hot spam
    if (/^\[pool-miner\]\s+\d+\s*H\/s/.test(line)) continue; // pool hashrate refresh
    pushLog(line);
  }
}

// ─── Difficulty (compact bits) → est. blocks/day ───────────────────────────
function estimate() {
  const blank = { blocksPerDay: null, hoursPerBlock: null, brcPerDay: null };
  if (state.status !== 'mining') return blank;
  if (!state.difficulty) return blank;
  const hashrate = avgHash();
  if (!(hashrate > 0)) return blank;
  try {
    const compact = parseInt(state.difficulty, 16);
    if (!Number.isFinite(compact)) return blank;
    const exp = (compact >>> 24) & 0xff;
    const mant = BigInt(compact & 0xffffff);
    const e = BigInt(exp);
    const target = exp <= 3 ? mant >> (8n * (3n - e)) : mant << (8n * (e - 3n));
    const p = Number(target) / Number(1n << 256n);
    const blocksPerDay = hashrate * p * 86400;
    if (!(blocksPerDay > 0)) return blank;
    return {
      blocksPerDay,
      hoursPerBlock: 24 / blocksPerDay,
      brcPerDay: 50 * blocksPerDay,
    };
  } catch {
    return blank;
  }
}

// ─── Wallet balance (from the miner's local verified snapshot) ─────────────
// The miner persists its verified chain state to ~/.fulgurminer/snapshot-*.json
// every ~50 blocks / 60s. Each `state` row is [addressHex, balanceWei, nonce]
// at the finalized anchor (~100 blocks deep), so this is the CONFIRMED balance.
// We cache the parse (the file is ~10MB) and only re-read when its mtime changes.
const SNAP_DIR = path.join(os.homedir(), '.fulgurminer');
let balCache = { wallet: null, file: null, mtimeMs: 0, brc: null, anchorHeight: null };

function newestSnapshot() {
  try {
    const files = readdirSync(SNAP_DIR).filter((f) => /^snapshot-.*\.json$/.test(f));
    let best = null, bestM = 0;
    for (const f of files) {
      const full = path.join(SNAP_DIR, f);
      const st = statSync(full);
      if (st.mtimeMs > bestM) { bestM = st.mtimeMs; best = full; }
    }
    return best ? { file: best, mtimeMs: bestM } : null;
  } catch {
    return null;
  }
}

let refreshingBalance = false;

// Refresh the cached balance OFF the request path. The snapshot is ~10 MB, so a
// synchronous read+parse inside /api/status (polled ~1s) would stall the event
// loop — blocking start/stop and child stdout — every time the miner rewrites the
// snapshot (~60s). Instead this runs on a timer (and on demand) with an async read.
async function refreshBalance() {
  const wallet = settings.wallet;
  if (!/^[0-9a-f]{64}$/.test(wallet)) {
    balCache = { wallet, file: null, mtimeMs: 0, brc: null, anchorHeight: null };
    return;
  }
  const snap = newestSnapshot();
  if (!snap) return;
  // Up to date for this wallet + snapshot? Nothing to do.
  if (balCache.wallet === wallet && balCache.file === snap.file && balCache.mtimeMs === snap.mtimeMs) return;
  if (refreshingBalance) return; // a parse is already in flight
  refreshingBalance = true;
  try {
    const j = JSON.parse(await readFileAsync(snap.file, 'utf8'));
    const row = (j.state || []).find((r) => String(r[0]).toLowerCase() === wallet);
    // Snapshot balances are integer wei strings; tolerate anything else without throwing.
    let wei = 0n;
    try { if (row) wei = BigInt(row[1]); } catch { wei = 0n; }
    // Exact within BrowserCoin's max supply (21M BRC = 2.1e15 wei < MAX_SAFE_INTEGER).
    balCache = { wallet, file: snap.file, mtimeMs: snap.mtimeMs, brc: Number(wei) / COIN, anchorHeight: j.anchorHeight ?? null };
  } catch {
    /* keep the previous cache on read/parse error */
  } finally {
    refreshingBalance = false;
  }
}

// Synchronous, non-blocking read of the cached balance for the status payload.
// Returns the cache only when it matches the current wallet; otherwise it kicks
// off a refresh (fire-and-forget) and reports null until that completes.
function balanceForStatus() {
  if (balCache.wallet === settings.wallet && balCache.brc != null) {
    return { brc: balCache.brc, anchorHeight: balCache.anchorHeight };
  }
  refreshBalance();
  return null;
}

// ─── Pending (unconfirmed) balance ─────────────────────────────────────────
// The balance above is the FINALIZED snapshot (tip − ~100 blocks, ~4h deep), so a
// freshly-won block is invisible there until it finalizes. To surface earned-but-
// not-yet-finalized rewards immediately, read the canonical UNFINALIZED tail from
// the same public helper API the miner uses, decode each block header in PURE JS
// (no chain-code import — keeps this server dependency-free), and sum the coinbase
// reward of every block whose `miner` field is our wallet. Chain-derived, so it
// captures wins from BOTH machines and survives restarts (not session state).
const HELPERS = (process.env.MINER_HELPERS
  ? process.env.MINER_HELPERS.split(',')
  : ['https://api1.browsercoin.org', 'https://api2.browsercoin.org']
).map((h) => h.trim().replace(/\/+$/, '')).filter(Boolean);

const HALVING_INTERVAL = 210_000;
const INITIAL_REWARD = 50n * BigInt(COIN); // 50 BRC in wei
// Coinbase subsidy at a height — mirrors src/chain/genesis.ts blockReward().
function blockReward(height) {
  const h = Math.floor(height / HALVING_INTERVAL);
  return h >= 64 ? 0n : INITIAL_REWARD >> BigInt(h);
}
// Block-header layout (src/chain/block.ts: fixed 148-byte header). In the hex
// encoding (2 chars/byte): height = u32be at bytes 0..4 (hex 0..8); the 32-byte
// `miner` coinbase pubkey is the last header field, bytes 116..148 (hex 232..296).
const HEX_HEIGHT = [0, 8];
const HEX_MINER = [232, 296];

let pendCache = { wallet: null, brc: null, blocks: [], live: null, tip: null, at: 0, error: null };
let refreshingPending = false;

async function fetchHelperJson(pathname) {
  for (const base of HELPERS) {
    try {
      const r = await fetch(base + pathname, { signal: AbortSignal.timeout(8000) });
      if (r.ok) return await r.json();
    } catch { /* try the next helper */ }
  }
  return null;
}

// Refresh pending/unconfirmed rewards OFF the request path (network I/O + decode).
async function refreshPending() {
  const wallet = settings.wallet;
  if (!/^[0-9a-f]{64}$/.test(wallet)) {
    pendCache = { wallet, brc: null, blocks: [], live: null, tip: null, at: Date.now(), error: 'bad wallet' };
    return;
  }
  if (refreshingPending) return;
  refreshingPending = true;
  try {
    const tipResp = await fetchHelperJson('/tip');
    const tip = Number(tipResp && tipResp.height);
    if (!Number.isFinite(tip)) { pendCache = { ...pendCache, wallet, at: Date.now(), error: 'tip unavailable' }; return; }
    // Confirmed balance is finalized through balCache.anchorHeight; count wins
    // strictly ABOVE it so we never double-count what the confirmed total includes.
    const finalizedBrc = (balCache.wallet === wallet && balCache.brc != null) ? balCache.brc : 0;
    const anchor = (balCache.wallet === wallet && balCache.anchorHeight != null) ? balCache.anchorHeight : Math.max(0, tip - 100);
    let height = anchor + 1, pendingWei = 0n, blocks = [], guard = 0;
    while (height <= tip && guard++ < 16) {
      const resp = await fetchHelperJson(`/blocks?fromHeight=${height}&max=200`);
      const hexes = resp && Array.isArray(resp.blocks) ? resp.blocks : [];
      if (!hexes.length) break;
      for (const hex of hexes) {
        if (typeof hex !== 'string' || hex.length < HEX_MINER[1]) continue;
        const bh = parseInt(hex.slice(HEX_HEIGHT[0], HEX_HEIGHT[1]), 16);
        const minerHex = hex.slice(HEX_MINER[0], HEX_MINER[1]).toLowerCase();
        if (minerHex === wallet) { pendingWei += blockReward(bh); blocks.push(bh); }
      }
      height += hexes.length;
    }
    const brc = Number(pendingWei) / COIN;
    pendCache = { wallet, brc, blocks, live: finalizedBrc + brc, tip, at: Date.now(), error: null };
  } catch {
    pendCache = { ...pendCache, at: Date.now() }; // keep last good value on a transient failure
  } finally {
    refreshingPending = false;
  }
}

// Synchronous, non-blocking read of the cached pending data for the status payload.
function pendingForStatus() {
  if (pendCache.wallet === settings.wallet && pendCache.brc != null) {
    return { brc: pendCache.brc, blocks: pendCache.blocks, count: pendCache.blocks.length, live: pendCache.live, tip: pendCache.tip };
  }
  refreshPending();
  return null;
}

function statusPayload() {
  const est = estimate();
  return {
    status: state.status,
    running: child !== null,
    backend: state.backend,
    engine: settings.engine,
    mode: settings.mode,
    workers: settings.workers,
    throttle: settings.throttle,
    wallet: settings.wallet,
    pool: settings.pool,                   // 'solo' | 'pool'
    poolUrl: settings.poolUrl,
    poolStats: state.pool,                 // { earned, pending, paid } in BRC (pool mode)
    balance: balanceForStatus(),           // { brc, anchorHeight } | null (refreshed off the request path)
    pending: pendingForStatus(),           // { brc, blocks, count, live, tip } | null — unconfirmed rewards in the unfinalized tail
    cores: CORES,
    platform: process.platform,
    height: state.height,
    difficulty: state.difficulty,
    hashrate: { now: state.hashNow, avg: Math.round(avgHash()), peak: state.hashPeak },
    blocks: state.blocks,
    shares: state.shares,
    sync: state.sync,
    uptimeSec: state.startedAt ? Math.floor((Date.now() - state.startedAt) / 1000) : 0,
    est,
    lastError: state.lastError,
    log: state.log.slice(-120),
  };
}

// ─── Keep-awake (anti-sleep) — per-OS, best-effort ──────────────────────────
function spawnKeepAwake() {
  try {
    let proc = null;
    if (IS_MAC) {
      // -i (idle) works on battery too; -m (disk) + -s (system) cover the rest.
      proc = spawn('caffeinate', ['-i', '-m', '-s'], { stdio: 'ignore' });
    } else if (IS_LINUX) {
      // Holds an inhibitor lock for as long as `sleep infinity` runs.
      proc = spawn('systemd-inhibit',
        ['--what=idle:sleep', '--why=FulgurMiner mining', '--mode=block', 'sleep', 'infinity'],
        { stdio: 'ignore' });
    } else if (IS_WIN) {
      // ES_CONTINUOUS(0x80000000) | ES_SYSTEM_REQUIRED(0x1) — re-asserted in a loop.
      const ps = "$s='[DllImport(\"kernel32.dll\")] public static extern uint SetThreadExecutionState(uint e);';"
        + "$t=Add-Type -MemberDefinition $s -Name Sleep -Namespace Win32 -PassThru;"
        + "while($true){[void]$t::SetThreadExecutionState(0x80000001);Start-Sleep -Seconds 50}";
      proc = spawn('powershell', ['-NoProfile', '-WindowStyle', 'Hidden', '-Command', ps], { stdio: 'ignore' });
    }
    if (proc) proc.on('error', () => {}); // tool missing → silently skip
    return proc;
  } catch {
    return null;
  }
}

function startServerCaffeinate() {
  // Held for the whole server lifetime so the panel keeps the machine awake even
  // before mining starts.
  serverCaffeinate = spawnKeepAwake();
}

// ─── Process-tree kill (per-OS) ─────────────────────────────────────────────
// IMPORTANT (Windows): taskkill /T walks the tree by parent pid, so it must run
// SYNCHRONOUSLY and we must NOT kill the root ourselves first — killing the root
// orphans the subtree and leaves taskkill nothing to cascade through. On POSIX a
// single kill of the negative pid takes down the whole detached process group.
function killTree(pid, childRef) {
  if (!pid) return;
  if (IS_WIN) {
    // shell cmd → npm → cmd → tsx → worker hosts: /T /F kills the whole tree.
    try { spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }); } catch {}
  } else {
    try { process.kill(-pid, 'SIGKILL'); } catch {}
    try { if (childRef) childRef.kill('SIGKILL'); } catch {}
  }
}

// ─── Child lifecycle ───────────────────────────────────────────────────────
function buildEnv() {
  const env = { ...process.env };
  // On POSIX, make Homebrew/standard node+npm resolvable even when launched from
  // a GUI (Finder/file manager) with a minimal PATH. Harmless to skip on Windows.
  if (!IS_WIN) env.PATH = `/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:${env.PATH || ''}`;
  env.MINER_PUBKEY = settings.wallet;
  // Where to mine: solo, or a pool URL (FulgurPool by default).
  env.MINER_POOL = settings.pool === 'pool' ? (settings.poolUrl || FULGURPOOL_URL) : 'solo';
  env.FULGUR_TUI = '0';
  env.FULGUR_NO_UPDATE_CHECK = '1';
  env.MINER_WORKERS = String(settings.workers);
  env.MINER_THROTTLE = String(settings.throttle);

  if (settings.engine === 'native') env.MINER_NATIVE = '1';
  else delete env.MINER_NATIVE;

  if (settings.mode === 'max') env.MINER_SMART = 'max';
  else if (settings.mode === 'considerate') env.MINER_SMART = 'considerate';
  else env.MINER_SMART = 'off'; // manual → use the throttle slider verbatim
  return env;
}

function startMiner() {
  if (child) return { ok: true, already: true };
  if (!/^[0-9a-f]{64}$/.test(settings.wallet)) {
    state.status = 'error';
    state.lastError = 'Invalid wallet: need a 64-hex address.';
    return { ok: false, error: state.lastError };
  }
  resetRun();
  lineBuf = '';
  state.status = 'syncing';
  state.startedAt = Date.now();
  pushLog(`[gui] starting miner — engine=${settings.engine} mode=${settings.mode} workers=${settings.workers} throttle=${settings.throttle}`);

  let proc;
  try {
    proc = spawn(IS_WIN ? 'npm.cmd' : 'npm', ['run', 'mine'], {
      cwd: REPO_DIR,
      detached: !IS_WIN,         // POSIX: own process group → kill the whole tree
      shell: IS_WIN,             // Windows: spawning a .cmd needs a shell (else EINVAL,
                                 // thrown synchronously — see Node CVE-2024-27980 hardening)
      env: buildEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
    state.status = 'error';
    state.lastError = `spawn failed: ${e.message}`;
    pushLog(`[gui] ERROR ${state.lastError}`);
    child = null;
    return { ok: false, error: state.lastError };
  }
  child = proc;

  proc.stdout.on('data', (b) => handleChunk(b, 'out'));
  proc.stderr.on('data', (b) => handleChunk(b, 'err'));

  proc.on('error', (e) => {
    if (child !== proc) return;  // a newer miner already replaced this one
    state.status = 'error';
    state.lastError = `spawn failed: ${e.message}`;
    pushLog(`[gui] ERROR ${state.lastError}`);
    child = null;
    stopCaffeinate();
  });

  proc.on('exit', (code, signal) => {
    pushLog(`[gui] miner exited (code=${code} signal=${signal || '-'})`);
    stopCaffeinate();
    // Ignore a stale exit: if a restart already swapped in a newer child, this
    // late event must not null it out (that would orphan the running miner).
    if (child !== proc) return;
    child = null;
    // `_stopped` marks an intentional kill; on Windows taskkill /F surfaces as a
    // non-zero exit code (not a signal), so without it a stop looks like a crash.
    const wasIntentional = proc._stopped || signal === 'SIGKILL' || signal === 'SIGTERM';
    if (!wasIntentional && code) {
      state.status = 'error';
      if (!state.lastError) state.lastError = `miner exited with code ${code}`;
    } else {
      state.status = 'idle';
      state.startedAt = null;
    }
  });

  // Per-mine keep-awake (in addition to the server-lifetime one) — belt & braces.
  caffeinate = spawnKeepAwake();

  return { ok: true };
}

function stopCaffeinate() {
  if (caffeinate) {
    try { caffeinate.kill('SIGTERM'); } catch {}
    caffeinate = null;
  }
}

function stopMiner() {
  if (!child) {
    state.status = 'idle';
    state.startedAt = null;
    return { ok: true, already: true };
  }
  const proc = child;
  pushLog('[gui] stopping miner…');
  proc._stopped = true;
  killTree(proc.pid, proc);
  child = null;
  stopCaffeinate();
  state.status = 'idle';
  state.startedAt = null;
  return { ok: true };
}

function restartMiner() {
  if (!child) return;
  pushLog('[gui] config changed — restarting miner (chain is cached, fast)…');
  const proc = child;
  proc._stopped = true;
  killTree(proc.pid, proc);
  child = null;
  stopCaffeinate();
  // Give the OS a beat to release handles, then relaunch.
  setTimeout(startMiner, 400);
}

// ─── HTTP API ──────────────────────────────────────────────────────────────
function sendJSON(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 1e6) req.destroy(); });
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); }
      catch { resolve({}); }
    });
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  const p = url.pathname;

  if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
    try {
      const html = readFileSync(INDEX_HTML);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
    } catch {
      res.writeHead(500); res.end('index.html missing');
    }
    return;
  }

  if (req.method === 'GET' && p === '/api/status') {
    return sendJSON(res, 200, statusPayload());
  }

  if (req.method === 'POST' && p === '/api/start') {
    const r = startMiner();
    return sendJSON(res, r.ok ? 200 : 400, { ...r, ...statusPayload() });
  }

  if (req.method === 'POST' && p === '/api/stop') {
    const r = stopMiner();
    return sendJSON(res, 200, { ...r, ...statusPayload() });
  }

  if (req.method === 'POST' && p === '/api/config') {
    const body = await readBody(req);
    // Keep the current wallet if the incoming one is invalid (never silently reset).
    const next = sanitizeSettings({ ...settings, ...body }, settings.wallet);
    const walletChanged = next.wallet !== settings.wallet;
    const changed = JSON.stringify(next) !== JSON.stringify(settings);
    settings = next;
    saveSettings();
    if (walletChanged) { refreshBalance(); refreshPending(); } // recompute for the new address, off the request path
    if (changed && child) restartMiner();
    return sendJSON(res, 200, { ok: true, changed, ...statusPayload() });
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: false, error: 'not found' }));
});

// ─── Cleanup ────────────────────────────────────────────────────────────────
function cleanup() {
  try { if (child) killTree(child.pid); } catch {}
  stopCaffeinate();
  try { if (serverCaffeinate) serverCaffeinate.kill('SIGTERM'); } catch {}
}
process.on('SIGINT', () => { cleanup(); process.exit(0); });
process.on('SIGTERM', () => { cleanup(); process.exit(0); });
process.on('exit', cleanup);

server.listen(PORT, HOST, () => {
  startServerCaffeinate();
  // Keep the cached balance + pending rewards fresh off the request path.
  refreshBalance();
  setInterval(refreshBalance, 15000).unref();
  refreshPending();
  setInterval(refreshPending, 20000).unref();
  console.log(`[gui] FulgurMiner control panel → http://${HOST}:${PORT}`);
  console.log(`[gui] platform=${process.platform} repo=${REPO_DIR} cores=${CORES}`);
});
