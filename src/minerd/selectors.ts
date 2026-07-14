// src/minerd/selectors.ts
//
// Shared, machine-aware bounded selectors for Workers, Throttle, and Engine.
// Both the arrow menu (menu.ts) and the plain settings prompt (settings.ts)
// build on these so the two UIs constrain to the SAME sensible values.
//
// loadConfig() already clamps MINER_WORKERS / MINER_THROTTLE at runtime, so
// these selectors only shape the UI — the underlying validation is unchanged.
import { autoWorkers, cpuBudget } from './cpuBudget.js';

const BUDGET = cpuBudget();

/**
 * Upper bound of the Workers selector — the HOST's cores, deliberately.
 *
 * It is NOT the container allowance, even though the auto default now is. The UI
 * clamps whatever it displays and PERSISTS the result to .env.local, so binding this
 * to a detected allowance would let a single arrow-press silently rewrite an operator's
 * explicit `MINER_WORKERS=2` down to 1 — halving a node's hashrate through a setting
 * they never touched. The auto default is the thing that needed fixing; a hand-set
 * value stays the user's to choose.
 */
export const MAX_WORKERS = BUDGET.hostCores;

/**
 * Default: leave one core free so the machine stays responsive — except inside a
 * CPU-limited container, where the allowance IS the reservation and leaving one free
 * just halves a 2-CPU node. See cpuBudget.autoWorkers().
 */
export const DEFAULT_WORKERS = autoWorkers(BUDGET);

/** Clamp any worker count into 1…MAX_WORKERS (floored, finite-guarded). */
export function clampWorkers(n: number): number {
  if (!Number.isFinite(n)) return DEFAULT_WORKERS;
  return Math.min(MAX_WORKERS, Math.max(1, Math.floor(n)));
}

/**
 * Display string for the current MINER_WORKERS env value:
 *   unset/blank → `auto (7)`   (auto resolves to DEFAULT_WORKERS)
 *   a number    → `7  (of 8 cores)`
 */
export function workersDisplay(raw: string | undefined): string {
  const v = (raw ?? '').trim();
  if (v === '') return `auto (${DEFAULT_WORKERS})`;
  const n = clampWorkers(Number(v));
  return `${n}  (of ${MAX_WORKERS} cores)`;
}

/** Throttle presets, low → high. The selector cycles over these. */
export interface ThrottlePreset {
  value: number;
  label: string;
}
export const THROTTLE_PRESETS: ThrottlePreset[] = [
  { value: 0.25, label: 'Quiet' },
  { value: 0.40, label: 'Low' },
  { value: 0.50, label: 'Balanced' },
  { value: 0.75, label: 'Default' },
  { value: 1.00, label: 'Max' },
];

/** The default preset index (0.75 Default). */
export const DEFAULT_THROTTLE_INDEX = THROTTLE_PRESETS.findIndex((p) => p.value === 0.75);

/** Two-decimal string of a throttle value (e.g. 0.4 → "0.40"). */
export function throttleNum(value: number): string {
  return value.toFixed(2);
}

/**
 * Parse a MINER_THROTTLE-shaped string into a number: unset/blank/non-numeric
 * defaults to the balanced 0.75 preset. Does NOT clamp to [0.05, 1] — config.ts
 * owns that at mine time; this only tells the UI what is actually set. Shared by
 * throttleLabel, the picker's active-row lookup (menu.ts), and the full-blast
 * check, so all three agree on the exact same number.
 */
export function throttleAmount(raw: string | undefined): number {
  const v = (raw ?? '').trim();
  const num = v === '' ? 0.75 : Number(v);
  return Number.isFinite(num) ? num : 0.75;
}

/**
 * Human label for a throttle value. A value that matches a preset EXACTLY shows
 * that preset's name; anything else — a hand-set value the UI does not own —
 * shows "custom" rather than the nearest preset's name. Snapping the WORD to the
 * nearest preset (the old behavior) is how a manually-set 0.77 used to render as
 * "0.77  Default", which is what let cycleThrottle's snap-and-persist bug hide in
 * plain sight: the label already looked like a preset before anything wrote it.
 */
export function throttleLabel(raw: string | undefined): string {
  const value = throttleAmount(raw);
  const preset = THROTTLE_PRESETS.find((p) => p.value === value);
  return `${throttleNum(value)}  ${preset ? preset.label : 'custom'}`;
}

/**
 * The one throttle-input validator, shared by the TUI's Custom... editor and (in
 * a later task) `npm run settings`' own custom prompt — so the two UIs can never
 * accept different numbers. Accepts 0.05–1 inclusive (config.ts's own runtime
 * clamp range). An out-of-range or non-numeric value is an ERROR WITH A REASON —
 * never silently clamped to the nearest bound or preset. A silent clamp-and-persist
 * is the exact bug class this validator exists to end (see cycleThrottle's removal,
 * and 0.2.7's MINER_WORKERS clamp-and-persist before it).
 */
export function parseThrottle(raw: string): { ok: true; value: number } | { ok: false; reason: string } {
  const v = raw.trim();
  const n = Number(v);
  if (v === '' || !Number.isFinite(n) || n < 0.05 || n > 1) {
    return { ok: false, reason: 'Enter a number from 0.05 to 1 (5%-100%).' };
  }
  return { ok: true, value: n };
}

/** Index of the preset matching the current MINER_THROTTLE, else the default. */
export function throttleIndex(raw: string | undefined): number {
  const v = (raw ?? '').trim();
  if (v === '') return DEFAULT_THROTTLE_INDEX;
  const num = Number(v);
  if (!Number.isFinite(num)) return DEFAULT_THROTTLE_INDEX;
  let bi = DEFAULT_THROTTLE_INDEX;
  let bd = Infinity;
  for (let i = 0; i < THROTTLE_PRESETS.length; i++) {
    const d = Math.abs(THROTTLE_PRESETS[i]!.value - num);
    if (d < bd) { bd = d; bi = i; }
  }
  return bi;
}

/** Engine options: wasm (portable, default) | native (Rust, faster). */
export type Engine = 'wasm' | 'native';

/** Current engine from MINER_NATIVE (truthy → native). */
export function currentEngine(raw: string | undefined): Engine {
  return raw && raw.trim() !== '' && raw.trim() !== '0' ? 'native' : 'wasm';
}

/**
 * Display label for the Engine selector. `nativeAvailable` is whether the native
 * engine can actually run here (a built binary or a cargo toolchain to build it);
 * when it can't, native reads "(needs Rust)" so the UI can flag — rather than
 * silently ignore — a native selection that would fall back to wasm.
 */
export function engineRowValue(engine: Engine, nativeAvailable: boolean): string {
  if (engine === 'native') return nativeAvailable ? 'native  (faster)' : 'native  (needs Rust)';
  return 'wasm  (portable)';
}

/** Smart mode options: off/manual, max throughput, or considerate auto-tuning. */
export type SmartMode = 'off' | 'max' | 'considerate';

export interface ModeOption {
  value: SmartMode;
  label: string;
}

export const MODE_OPTIONS: ModeOption[] = [
  { value: 'off', label: 'Manual' },
  { value: 'max', label: 'Smart: Max' },
  { value: 'considerate', label: 'Smart: Considerate' },
];

/** Current smart mode from MINER_SMART. */
export function currentMode(raw: string | undefined): SmartMode {
  const v = (raw ?? '').trim().toLowerCase();
  return v === 'max' ? 'max' : v === 'considerate' ? 'considerate' : 'off';
}

/** Index of the mode matching the current MINER_SMART, else Manual. */
export function modeIndex(raw: string | undefined): number {
  return MODE_OPTIONS.findIndex((option) => option.value === currentMode(raw));
}

/** Human label for the current MINER_SMART mode. */
export function modeLabel(raw: string | undefined): string {
  return MODE_OPTIONS[modeIndex(raw)]!.label;
}

/** Cycle through smart modes with wrapping. */
export function nextMode(mode: SmartMode, delta: number): SmartMode {
  const index = MODE_OPTIONS.findIndex((option) => option.value === mode);
  const next = ((index + delta) % MODE_OPTIONS.length + MODE_OPTIONS.length) % MODE_OPTIONS.length;
  return MODE_OPTIONS[next]!.value;
}
