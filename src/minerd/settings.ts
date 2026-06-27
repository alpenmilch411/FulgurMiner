// src/minerd/settings.ts
//
// In-app settings menu over .env.local. Reachable two ways:
//   1. `npm run settings` (runs this file directly), and
//   2. pressing `s` in the TUI (start.ts awaits runSettings() then restarts).
//
// It is a line-based prompt menu (node:readline/promises) so it works the same
// in a real terminal and in a pipe. Persisting also updates process.env so the
// next launcher loop picks up the change immediately.
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import {
  readEnvFile, persist, readExtraPools, type PoolEntry,
} from './envLocal.js';
import { FULGURPOOL_NAME } from './config.js';
import {
  THROTTLE_PRESETS, throttleLabel, clampWorkers, MAX_WORKERS, DEFAULT_WORKERS, currentEngine,
  currentMode, modeLabel, MODE_OPTIONS, type SmartMode,
} from './selectors.js';

const HEX64 = /^[0-9a-f]{64}$/i;

type RL = ReturnType<typeof createInterface>;

/** Resolve the human label for the currently configured target. */
function targetLabel(): string {
  const raw = (process.env.MINER_POOL ?? '').trim();
  if (raw === '') return FULGURPOOL_NAME;
  if (/^(solo|off|none)$/i.test(raw)) return 'Solo';
  return raw;
}

function currentWallet(): string {
  const w = (process.env.MINER_PUBKEY ?? '').trim().toLowerCase();
  if (!w) return '(not set)';
  return HEX64.test(w) ? `${w.slice(0, 4)}…${w.slice(-4)}` : '(invalid)';
}

function currentWorkers(): string {
  const w = (process.env.MINER_WORKERS ?? '').trim();
  if (w === '') return `auto (${DEFAULT_WORKERS})`;
  return `${clampWorkers(Number(w))} of ${MAX_WORKERS} cores`;
}

function currentThrottle(): string {
  if (currentMode(process.env.MINER_SMART) !== 'off') return '(auto)';
  return throttleLabel(process.env.MINER_THROTTLE);
}

function currentModeLabel(): string {
  return modeLabel(process.env.MINER_SMART);
}

function currentEngineLabel(): string {
  return currentEngine(process.env.MINER_NATIVE) === 'native' ? 'native (faster)' : 'wasm (portable)';
}

function currentUpdateCheckLabel(): string {
  return process.env.FULGUR_NO_UPDATE_CHECK ? 'off' : 'on';
}

function printMenu(): void {
  console.log('\n  Settings');
  console.log(`    [1] Wallet address   (current ${currentWallet()})`);
  console.log(`    [2] Where to mine    (current ${targetLabel()})`);
  console.log(`    [3] Workers          (current ${currentWorkers()})`);
  console.log(`    [4] Mode             (current ${currentModeLabel()})`);
  console.log(`    [5] Throttle         (current ${currentThrottle()})`);
  console.log(`    [6] Engine           (current ${currentEngineLabel()})`);
  console.log(`    [7] Check for updates (current ${currentUpdateCheckLabel()})`);
  console.log('    [?] Help   [Enter] Start mining   [q] Quit\n');
}

/** Short text help for plain mode (mirrors the in-app ? overlay, condensed). */
function printHelp(): void {
  console.log('\n  FulgurMiner — how it works');
  console.log('    Mines BrowserCoin from your terminal. Rewards go to your wallet');
  console.log('    address (public, no password or private key).');
  console.log('    First run downloads + verifies the chain so you mine on the right one;');
  console.log('    restarts are fast (the chain is saved under ~/.fulgurminer/).');
  console.log('    Settings: wallet · where to mine (FulgurPool default / solo / pools) ·');
  console.log('    workers · Mode (Manual vs Smart auto-tuning) · throttle (more/higher = faster but hotter & louder) ·');
  console.log('    engine (wasm runs anywhere; native (Rust) is faster) · update checks.');
  console.log('    Where to mine: FulgurPool (the project’s own pool) by default; pick');
  console.log('    solo or a pool.');
  console.log('    Add more pools by editing pools.json (see the README).\n');
}

async function editWallet(rl: RL): Promise<void> {
  console.log('\n  Paste your 64-hex wallet address (or leave blank to cancel).');
  for (;;) {
    const v = (await rl.question('  Wallet: ')).trim().toLowerCase();
    if (v === '') return;
    if (HEX64.test(v)) {
      persist({ MINER_PUBKEY: v });
      process.env.MINER_PUBKEY = v;
      console.log('  Saved wallet address.\n');
      return;
    }
    console.log("  That doesn't look right — exactly 64 hex characters (0-9, a-f). Try again.\n");
  }
}

async function editTarget(rl: RL, extras: PoolEntry[]): Promise<void> {
  console.log('\n  Where do you want to mine?');
  console.log(`    [1] ${FULGURPOOL_NAME} — the default`);
  extras.forEach((p, i) => console.log(`    [${i + 2}] ${p.name} — ${p.url}`));
  console.log('    [s] Solo — mine on your own');
  console.log('    [Enter] Cancel\n');

  for (;;) {
    const ans = (await rl.question('  Choose: ')).trim().toLowerCase();
    if (ans === '') return;
    if (ans === '1') {
      // FulgurPool default → remove MINER_POOL so the miner follows the default.
      persist({ MINER_POOL: undefined });
      delete process.env.MINER_POOL;
      console.log(`  Target set to ${FULGURPOOL_NAME}.\n`);
      return;
    }
    if (ans === 's') {
      persist({ MINER_POOL: 'solo' });
      process.env.MINER_POOL = 'solo';
      console.log('  Target set to Solo.\n');
      return;
    }
    const idx = Number(ans) - 2;
    if (Number.isInteger(idx) && idx >= 0 && idx < extras.length) {
      const url = extras[idx]!.url;
      persist({ MINER_POOL: url });
      process.env.MINER_POOL = url;
      console.log(`  Target set to ${extras[idx]!.name} (${url}).\n`);
      return;
    }
    console.log('  Please enter one of the numbers above, "s" for solo, or Enter to cancel.\n');
  }
}

async function editWorkers(rl: RL): Promise<void> {
  // Bounded selector: any number is clamped to 1…cores; blank = auto.
  console.log(`\n  Worker threads — pick 1…${MAX_WORKERS} (your machine has ${MAX_WORKERS} cores).`);
  console.log(`  Blank = auto (${DEFAULT_WORKERS}, leaves one core free).`);
  for (;;) {
    const v = (await rl.question(`  Workers [${currentWorkers()}]: `)).trim();
    if (v === '') {
      persist({ MINER_WORKERS: undefined });
      delete process.env.MINER_WORKERS;
      console.log('  Workers reset to auto.\n');
      return;
    }
    const n = Math.floor(Number(v));
    if (Number.isFinite(n) && n >= 1) {
      const clamped = clampWorkers(n);
      persist({ MINER_WORKERS: String(clamped) });
      process.env.MINER_WORKERS = String(clamped);
      console.log(`  Workers set to ${clamped} (of ${MAX_WORKERS} cores).\n`);
      return;
    }
    console.log(`  Enter a whole number between 1 and ${MAX_WORKERS}, or blank for auto.\n`);
  }
}

function modeLine(mode: SmartMode): string {
  switch (mode) {
    case 'off': return 'set duty cycle by hand';
    case 'max': return 'auto-tunes to sustained max, ~same as full-blast on a well-cooled machine';
    case 'considerate': return 'auto-tunes but adapts to your other apps — eases off when they need the CPU, ramps back when they go quiet';
  }
}

async function editMode(rl: RL): Promise<void> {
  console.log('\n  Mode:');
  MODE_OPTIONS.forEach((option, i) => console.log(`    [${i + 1}] ${option.label} — ${modeLine(option.value)}`));
  console.log('    [Enter] Cancel\n');
  for (;;) {
    const v = (await rl.question('  Choose: ')).trim().toLowerCase();
    if (v === '') return;
    const idx = Number(v) - 1;
    if (Number.isInteger(idx) && idx >= 0 && idx < MODE_OPTIONS.length) {
      const mode = MODE_OPTIONS[idx]!.value;
      if (mode === 'off') {
        persist({ MINER_SMART: undefined });
        delete process.env.MINER_SMART;
      } else {
        persist({ MINER_SMART: mode });
        process.env.MINER_SMART = mode;
      }
      console.log(`  Mode set to ${MODE_OPTIONS[idx]!.label}.\n`);
      return;
    }
    console.log(`  Enter a number 1–${MODE_OPTIONS.length}, or Enter to cancel.\n`);
  }
}

async function editThrottle(rl: RL): Promise<void> {
  if (currentMode(process.env.MINER_SMART) !== 'off') {
    console.log('\n  Throttle is automatic in Smart mode — switch Mode to Manual to set it by hand.\n');
    return;
  }
  // Bounded selector over the sensible presets.
  console.log('\n  Throttle — fraction of time spent hashing. Higher = faster but hotter/louder.');
  THROTTLE_PRESETS.forEach((p, i) => console.log(`    [${i + 1}] ${p.value.toFixed(2)}  ${p.label}`));
  console.log('    [Enter] Cancel\n');
  for (;;) {
    const v = (await rl.question('  Choose: ')).trim();
    if (v === '') return;
    const idx = Number(v) - 1;
    if (Number.isInteger(idx) && idx >= 0 && idx < THROTTLE_PRESETS.length) {
      const value = THROTTLE_PRESETS[idx]!.value.toFixed(2);
      persist({ MINER_THROTTLE: value });
      process.env.MINER_THROTTLE = value;
      console.log(`  Throttle set to ${value} (${THROTTLE_PRESETS[idx]!.label}).\n`);
      return;
    }
    console.log(`  Enter a number 1–${THROTTLE_PRESETS.length}, or Enter to cancel.\n`);
  }
}

async function editEngine(rl: RL): Promise<void> {
  console.log('\n  Mining engine:');
  console.log('    [1] wasm   — portable, runs anywhere Node runs (default)');
  console.log('    [2] native — Rust engine, faster (needs a one-time build)');
  console.log('    [Enter] Cancel\n');
  for (;;) {
    const v = (await rl.question('  Choose: ')).trim().toLowerCase();
    if (v === '') return;
    if (v === '1' || v === 'wasm') {
      persist({ MINER_NATIVE: undefined });
      delete process.env.MINER_NATIVE;
      console.log('  Engine set to wasm.\n');
      return;
    }
    if (v === '2' || v === 'native') {
      persist({ MINER_NATIVE: '1' });
      process.env.MINER_NATIVE = '1';
      console.log('  Engine set to native. It is built on first start if needed (see README).\n');
      return;
    }
    console.log('  Enter 1 (wasm) or 2 (native), or Enter to cancel.\n');
  }
}

async function editUpdateCheck(rl: RL): Promise<void> {
  console.log('\n  Check for updates:');
  console.log('    [1] on  — check for newer versions at startup (default)');
  console.log('    [2] off — do not check for updates');
  console.log('    [Enter] Cancel\n');
  for (;;) {
    const v = (await rl.question('  Choose: ')).trim().toLowerCase();
    if (v === '') return;
    if (v === '1' || v === 'on' || v === 'yes') {
      persist({ FULGUR_NO_UPDATE_CHECK: undefined });
      delete process.env.FULGUR_NO_UPDATE_CHECK;
      console.log('  Update checks turned on.\n');
      return;
    }
    if (v === '2' || v === 'off' || v === 'no') {
      persist({ FULGUR_NO_UPDATE_CHECK: '1' });
      process.env.FULGUR_NO_UPDATE_CHECK = '1';
      console.log('  Update checks turned off.\n');
      return;
    }
    console.log('  Enter 1 (on) or 2 (off), or Enter to cancel.\n');
  }
}

/**
 * Run the interactive settings menu. Returns when the user chooses to start
 * mining (Enter) or quit (q). Changes are persisted to .env.local and reflected
 * in process.env so a caller can re-read config immediately.
 */
export async function runSettings(): Promise<void> {
  const rl = createInterface({ input, output });
  try {
    for (;;) {
      const extras = readExtraPools();
      printMenu();
      const choice = (await rl.question('  > ')).trim().toLowerCase();
      if (choice === '' || choice === 'start') return;        // start mining
      if (choice === 'q' || choice === 'quit') { process.exitCode = 0; return; }
      if (choice === '1') { await editWallet(rl); continue; }
      if (choice === '2') { await editTarget(rl, extras); continue; }
      if (choice === '3') { await editWorkers(rl); continue; }
      if (choice === '4') { await editMode(rl); continue; }
      if (choice === '5') { await editThrottle(rl); continue; }
      if (choice === '6') { await editEngine(rl); continue; }
      if (choice === '7') { await editUpdateCheck(rl); continue; }
      if (choice === '?' || choice === 'help' || choice === 'h') { printHelp(); continue; }
      console.log('  Unknown option. Choose 1–7, ? for help, Enter to start, or q to quit.\n');
    }
  } finally {
    rl.close();
  }
}

// Allow `npm run settings` to run this file directly. When invoked this way we
// load .env.local first so the menu shows the user's saved values.
import { fileURLToPath } from 'node:url';
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { loadEnvLocal } = await import('./envLocal.js');
  loadEnvLocal();
  await runSettings();
  process.exit(process.exitCode ?? 0);
}
