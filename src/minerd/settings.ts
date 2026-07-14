// src/minerd/settings.ts
//
// In-app settings menu over .env.local. Reachable two ways:
//   1. `npm run settings` (runs this file directly), and
//   2. pressing `s` in the TUI (start.ts awaits runSettings() then restarts).
//
// It is a line-based prompt menu (node:readline/promises) so it works the same
// in a real terminal and in a pipe — plain text only, ASCII, no colour/SGR, no
// OSC-8 hyperlinks. Persisting also updates process.env so the next launcher
// loop picks up the change immediately.
//
// "Where to mine" renders the SAME shared targets.ts model the arrow menu does
// (buildTargetModel / persistTarget / validateNewPool / addCustomPool /
// removeCustomPool) — this file owns no pool list and no MINER_POOL persist
// call of its own. "Throttle" validates a hand-typed rate with the same
// selectors.ts parseThrottle the TUI's Custom... editor uses, and persists it
// exactly as typed — never rounded to a preset (menu.ts's file header explains
// why a clamp-and-persist here would be a blocker-class bug).
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { persist } from './envLocal.js';
import { FULGURPOOL_NAME, REPO_URL } from './config.js';
import { FULL_BLAST_CAUTION, SMART_THROTTLE_EXPLAIN } from './menuCopy.js';
import {
  THROTTLE_PRESETS, throttleLabel, throttleAmount, parseThrottle,
  clampWorkers, MAX_WORKERS, DEFAULT_WORKERS,
  currentEngine, currentMode, modeLabel, MODE_OPTIONS, type SmartMode,
} from './selectors.js';
import { nativeEngineAvailable } from './engine.js';
import {
  buildTargetModel, persistTarget, validateNewPool, addCustomPool, removeCustomPool,
  NAME_MAX, URL_MAX, REMOVE_ACTIVE_REFUSAL, REMOVE_BUILTIN_REFUSAL,
  type TargetModel,
} from './targets.js';

const HEX64 = /^[0-9a-f]{64}$/i;

/**
 * The one method these editors need from a readline interface. A plain object
 * with just `question` satisfies this too (structurally) — that is what
 * settings.test.ts uses to drive the prompts without a real TTY, and it is why
 * this stays a narrow interface rather than `ReturnType<typeof createInterface>`.
 */
interface RL {
  question(prompt: string): Promise<string>;
}

/** Label for the currently active "where to mine" destination. activeIndex is
 *  never -1 (targets.ts's invariant); the fallback is only defensive. */
function activeTargetLabel(model: TargetModel): string {
  return model.targets[model.activeIndex]?.label ?? FULGURPOOL_NAME;
}

function currentWallet(): string {
  const w = (process.env.MINER_PUBKEY ?? '').trim().toLowerCase();
  if (!w) return '(not set)';
  return HEX64.test(w) ? `${w.slice(0, 4)}...${w.slice(-4)}` : '(invalid)';
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

function printMenu(model: TargetModel): void {
  console.log('\n  Settings');
  console.log(`    [1] Wallet address   (current ${currentWallet()})`);
  console.log(`    [2] Where to mine    (current ${activeTargetLabel(model)})`);
  console.log(`    [3] Workers          (current ${currentWorkers()})`);
  console.log(`    [4] Mode             (current ${currentModeLabel()})`);
  console.log(`    [5] Throttle         (current ${currentThrottle()})`);
  console.log(`    [6] Engine           (current ${currentEngineLabel()})`);
  console.log(`    [7] Check for updates (current ${currentUpdateCheckLabel()})`);
  console.log('    [?] Help   [Enter] Start mining   [q] Quit\n');
}

/** Short text help for plain mode (mirrors the in-app ? overlay, condensed). */
function printHelp(): void {
  console.log('\n  FulgurMiner - how it works');
  console.log('    Mines BrowserCoin from your terminal. Rewards go to your wallet');
  console.log('    address (public, no password or private key).');
  console.log('    First run downloads + verifies the chain so you mine on the right one;');
  console.log('    restarts are fast (the chain is saved under ~/.fulgurminer/).');
  console.log('    Settings: wallet - where to mine (FulgurPool default / solo / pools) -');
  console.log('    workers - Mode (Manual vs Smart auto-tuning) - throttle (more/higher =');
  console.log('    faster but hotter & louder) - engine (wasm runs anywhere; native (Rust)');
  console.log('    is faster) - update checks.');
  console.log("    Where to mine: FulgurPool (the project's own pool) by default; pick");
  console.log('    solo or a pool. Add or remove pools from [2] Where to mine.\n');
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
    console.log("  That doesn't look right - exactly 64 hex characters (0-9, a-f). Try again.\n");
  }
}

// ==================== Where to mine =========================================
// Renders targets.ts's shared TargetModel — the same rows, in the same order,
// as the arrow menu's picker. persistTarget/validateNewPool/addCustomPool/
// removeCustomPool are the ONLY functions that touch MINER_POOL or pools.json;
// nothing here re-parses MINER_POOL or re-implements a pool-URL check.

async function editTarget(rl: RL, initial: TargetModel): Promise<void> {
  let model = initial;
  for (;;) {
    console.log('\n  Where do you want to mine?');
    model.targets.forEach((t, i) => {
      const marker = i === model.activeIndex ? '*' : ' ';
      const extra = t.value !== undefined && t.kind !== 'solo' ? ` (${t.value})` : '';
      console.log(`   ${marker} [${i + 1}] ${t.label}${extra} - ${t.description}`);
    });
    console.log('    [a] Add a pool...');
    console.log('    [r] Remove a pool...');
    if (model.issues.length > 0) {
      console.log(`\n  pools.json: ${model.issues.length} problem(s):`);
      for (const issue of model.issues) console.log(`    - ${issue.entry}: ${issue.reason}`);
    }
    console.log('\n    [Enter] Cancel\n');

    const ans = (await rl.question('  Choose: ')).trim().toLowerCase();
    if (ans === '') return;
    if (ans === 'a') { model = await addPoolFlow(rl, model); continue; }
    if (ans === 'r') { model = await removePoolFlow(rl, model); continue; }
    const idx = Number(ans) - 1;
    if (Number.isInteger(idx) && idx >= 0 && idx < model.targets.length) {
      const target = model.targets[idx]!;
      persistTarget(target);
      console.log(`  Target set to ${target.label}.\n`);
      return;
    }
    console.log('  Please enter one of the numbers above, "a" to add, "r" to remove, or Enter to cancel.\n');
  }
}

/** "+ Add a pool" — the same validator and writer the TUI's form uses
 *  (targets.ts), so the two UIs accept identical input and write identically. */
async function addPoolFlow(rl: RL, model: TargetModel): Promise<TargetModel> {
  console.log('\n  Add a pool - a name and its mining endpoint URL.');
  console.log(`  Name up to ${NAME_MAX} characters, URL up to ${URL_MAX} characters. Leave the name blank to cancel.`);
  for (;;) {
    const name = (await rl.question('\n  Name: ')).trim();
    if (name === '') return model;
    const url = (await rl.question('  URL: ')).trim();
    const v = validateNewPool(name, url, model.targets);
    if (!v.ok) {
      console.log(`  ${v.reason}\n`);
      continue;
    }
    // addCustomPool returns the rebuilt model on BOTH success AND refusal (e.g.
    // the file became unreadable, or a concurrent write) — its return type does
    // not distinguish them, so confirm the entry actually landed before telling
    // the user it was saved (the TUI hit exactly this and would otherwise have
    // reported success while saving nothing).
    const updated = addCustomPool(v.entry.name, v.entry.url);
    const added = updated.targets.some((t) => t.kind === 'custom' && t.value === v.entry.url);
    if (!added) {
      console.log('  pools.json changed before this could be saved - try again.\n');
      return updated;
    }
    console.log(`  Added ${v.entry.name}.\n`);
    return updated;
  }
}

/** "Remove a pool" — custom pools only, behind an explicit y/N confirm.
 *  Non-removable and currently-active rows are annotated with targets.ts's own
 *  refusal text (never a retyped copy of it) so the user sees why up front, but
 *  the annotation is only a courtesy: removeCustomPool's own answer is what
 *  actually decides, and its reason is what gets printed on a refusal. */
async function removePoolFlow(rl: RL, model: TargetModel): Promise<TargetModel> {
  console.log('\n  Remove which pool? Only pools you added yourself can be removed.');
  model.targets.forEach((t, i) => {
    const isActive = i === model.activeIndex;
    const note = !t.removable ? `  (${REMOVE_BUILTIN_REFUSAL})`
      : isActive ? `  (${REMOVE_ACTIVE_REFUSAL})`
      : '';
    console.log(`    [${i + 1}] ${t.label}${note}`);
  });
  console.log('    [Enter] Cancel\n');

  const ans = (await rl.question('  Choose: ')).trim();
  if (ans === '') return model;
  const idx = Number(ans) - 1;
  if (!Number.isInteger(idx) || idx < 0 || idx >= model.targets.length) {
    console.log('  Please enter one of the numbers above, or Enter to cancel.\n');
    return model;
  }
  const target = model.targets[idx]!;
  const confirm = (await rl.question(`  Remove "${target.label}"? This cannot be undone. [y/N]: `)).trim().toLowerCase();
  if (confirm !== 'y' && confirm !== 'yes') {
    console.log('  Cancelled.\n');
    return model;
  }
  const r = removeCustomPool(target);
  if (r.ok) {
    console.log(`  Removed ${target.label}.\n`);
    return r.model;
  }
  console.log(`  ${r.reason}\n`);
  return model;
}

async function editWorkers(rl: RL): Promise<void> {
  // Bounded selector: any number is clamped to 1...cores; blank = auto.
  console.log(`\n  Worker threads - pick 1-${MAX_WORKERS} (this machine has ${MAX_WORKERS} cores).`);
  console.log(`  Blank = auto (${DEFAULT_WORKERS}) - one core is left free, except on a`);
  console.log('  CPU-limited container, where the whole allowance is used.');
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
    case 'max': return 'goes straight to 100% and holds - your Throttle setting is not used';
    case 'considerate': return 'starts at 50%, then adapts to your other apps - eases off when they need the CPU, climbs back when they go quiet (Throttle not used)';
  }
}

async function editMode(rl: RL): Promise<void> {
  console.log('\n  Mode:');
  MODE_OPTIONS.forEach((option, i) => console.log(`    [${i + 1}] ${option.label} - ${modeLine(option.value)}`));
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
    console.log(`  Enter a number 1-${MODE_OPTIONS.length}, or Enter to cancel.\n`);
  }
}

/** Word-wrap shared "About"-pane copy (menuCopy.ts) at 70 cols with a
 *  two-space indent, matching this menu's own prose. Embedded newlines in the
 *  source string are just whitespace to the wrapper, so a string authored for
 *  the TUI's fixed-width pane reflows correctly here too. Used so this file
 *  never re-derives copy it should be importing verbatim (a prior
 *  re-derivation of the full-blast caution silently dropped its actionable
 *  last line). */
function printWrapped(text: string): void {
  const words = text.split(/\s+/).filter(Boolean);
  const indent = '  ';
  const maxW = 70;
  console.log('');
  let line = indent;
  for (const w of words) {
    if (line.length + (line === indent ? 0 : 1) + w.length > maxW && line !== indent) {
      console.log(line);
      line = indent + w;
    } else {
      line += (line === indent ? '' : ' ') + w;
    }
  }
  if (line !== indent) console.log(line);
  console.log('');
}

/** The ONE MINER_THROTTLE writer in this file — persists exactly the number
 *  given (String(value)), never rounded or snapped to the nearest preset.
 *  Shared by the preset picker and the Custom... editor so both write the
 *  same way. */
function persistThrottle(value: number): void {
  const v = String(value);
  persist({ MINER_THROTTLE: v });
  process.env.MINER_THROTTLE = v;
}

/** Manual mode + >=100% ("full blast"): show the SAME caution the arrow menu
 *  shows, imported verbatim from menuCopy.ts rather than re-derived. Reads the
 *  raw duty cycle directly (throttleAmount), not via the nearest preset — a
 *  hand-set 0.90 must never trip this just because Max is its closest preset. */
function maybeShowFullBlastCaution(): void {
  if (currentMode(process.env.MINER_SMART) === 'off' && throttleAmount(process.env.MINER_THROTTLE) >= 1) {
    printWrapped(FULL_BLAST_CAUTION);
  }
}

async function editThrottle(rl: RL): Promise<void> {
  if (currentMode(process.env.MINER_SMART) !== 'off') {
    // Mirror the About-pane explanation from the arrow-key menu (menu<->settings
    // parity) — imported verbatim, never retyped.
    printWrapped(SMART_THROTTLE_EXPLAIN);
    return;
  }
  console.log('\n  Throttle - fraction of time spent hashing. Higher = faster but hotter/louder.');
  THROTTLE_PRESETS.forEach((p, i) => console.log(`    [${i + 1}] ${p.value.toFixed(2)}  ${p.label}`));
  console.log('    [c] Custom... - type an exact rate (0.05-1)');
  console.log('    [Enter] Cancel\n');
  for (;;) {
    const v = (await rl.question('  Choose: ')).trim();
    if (v === '') return;
    if (v.toLowerCase() === 'c') { await editThrottleCustom(rl); return; }
    const idx = Number(v) - 1;
    if (Number.isInteger(idx) && idx >= 0 && idx < THROTTLE_PRESETS.length) {
      const preset = THROTTLE_PRESETS[idx]!;
      persistThrottle(preset.value);
      console.log(`  Throttle set to ${preset.value.toFixed(2)} (${preset.label}).\n`);
      maybeShowFullBlastCaution();
      return;
    }
    console.log(`  Enter a number 1-${THROTTLE_PRESETS.length}, "c" for custom, or Enter to cancel.\n`);
  }
}

/** The "Custom..." numeric editor. Validated by selectors.ts's parseThrottle —
 *  the SAME validator the TUI's Custom... editor uses — so an out-of-range or
 *  non-numeric entry is refused with a reason and persists nothing, exactly
 *  like the TUI refuses it. */
async function editThrottleCustom(rl: RL): Promise<void> {
  console.log('\n  Custom throttle - enter an exact rate from 0.05 to 1 (5%-100%). Leave blank to cancel.');
  for (;;) {
    const v = (await rl.question('  Value: ')).trim();
    if (v === '') return;
    const r = parseThrottle(v);
    if (!r.ok) {
      console.log(`  ${r.reason}\n`);
      continue;
    }
    persistThrottle(r.value);
    console.log(`  Throttle set to ${String(r.value)}.\n`);
    maybeShowFullBlastCaution();
    return;
  }
}

async function editEngine(rl: RL): Promise<void> {
  // Mirror the arrow-menu behavior: if the Rust toolchain isn't installed, native
  // can't run, so flag it rather than letting the choice silently fall back to wasm.
  const nativeOk = nativeEngineAvailable();
  console.log('\n  Mining engine:');
  console.log('    [1] wasm   - portable, runs anywhere Node runs (default)');
  console.log(nativeOk
    ? '    [2] native - Rust engine, faster (needs a one-time build)'
    : '    [2] native - Rust engine, faster - NEEDS RUST (not installed)');
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
      if (nativeOk) {
        console.log('  Engine set to native. It is built on first start if needed (see README).\n');
      } else {
        console.log("  Engine set to native, but the Rust toolchain isn't installed - mining will use");
        console.log('  the portable WASM engine until you install it. Install Rust from https://rustup.rs,');
        console.log(`  then restart. Step-by-step in the repo README: ${REPO_URL}\n`);
      }
      return;
    }
    console.log('  Enter 1 (wasm) or 2 (native), or Enter to cancel.\n');
  }
}

async function editUpdateCheck(rl: RL): Promise<void> {
  console.log('\n  Check for updates:');
  console.log('    [1] on  - check for newer versions at startup (default)');
  console.log('    [2] off - do not check for updates');
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
 *
 * `customInput` defaults to the real process.stdin; settings.test.ts passes a
 * scripted Readable instead so the whole settings path — main menu, the pool
 * editor, the throttle editor — can be driven end to end without a real TTY.
 */
export async function runSettings(customInput: NodeJS.ReadableStream = input): Promise<void> {
  const rl = createInterface({ input: customInput, output });
  try {
    for (;;) {
      const model = buildTargetModel();
      printMenu(model);
      const choice = (await rl.question('  > ')).trim().toLowerCase();
      if (choice === '' || choice === 'start') return;        // start mining
      if (choice === 'q' || choice === 'quit') { process.exitCode = 0; return; }
      if (choice === '1') { await editWallet(rl); continue; }
      if (choice === '2') { await editTarget(rl, model); continue; }
      if (choice === '3') { await editWorkers(rl); continue; }
      if (choice === '4') { await editMode(rl); continue; }
      if (choice === '5') { await editThrottle(rl); continue; }
      if (choice === '6') { await editEngine(rl); continue; }
      if (choice === '7') { await editUpdateCheck(rl); continue; }
      if (choice === '?' || choice === 'help' || choice === 'h') { printHelp(); continue; }
      console.log('  Unknown option. Choose 1-7, ? for help, Enter to start, or q to quit.\n');
    }
  } finally {
    rl.close();
  }
}

// Allow `npm run settings` to run this file directly. When invoked this way we
// load .env.local first so the menu shows the user's saved values.
import { fileURLToPath } from 'node:url';
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { installCrashGuard, installStdioErrorSink } = await import('./crashGuard.js');
  installStdioErrorSink();
  installCrashGuard();
  const { assertNodeVersion } = await import('./version.js');
  assertNodeVersion();
  const { loadEnvLocal } = await import('./envLocal.js');
  loadEnvLocal();
  await runSettings();
  process.exit(process.exitCode ?? 0);
}
