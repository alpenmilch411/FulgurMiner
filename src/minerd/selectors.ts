// src/minerd/selectors.ts
//
// Shared, machine-aware bounded selectors for Workers, Throttle, and Engine.
// Both the arrow menu (menu.ts) and the plain settings prompt (settings.ts)
// build on these so the two UIs constrain to the SAME sensible values.
//
// loadConfig() already clamps MINER_WORKERS / MINER_THROTTLE at runtime, so
// these selectors only shape the UI — the underlying validation is unchanged.
import os from 'node:os';

/** Real usable core count (≥1). The Workers selector never exceeds this. */
export const MAX_WORKERS = Math.max(1, os.cpus().length);

/** Default = leave one core free so the machine stays responsive (and cooler). */
export const DEFAULT_WORKERS = Math.max(1, MAX_WORKERS - 1);

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
 * Human label for a throttle value, snapped to the nearest preset for the word.
 * E.g. 0.75 → "0.75  Default"; a custom env value → "<v>  Default" (nearest).
 */
export function throttleLabel(raw: string | undefined): string {
  const v = (raw ?? '').trim();
  const num = v === '' ? 0.75 : Number(v);
  const value = Number.isFinite(num) ? num : 0.75;
  // Snap to nearest preset for the word.
  let best = THROTTLE_PRESETS[DEFAULT_THROTTLE_INDEX]!;
  let bestD = Infinity;
  for (const p of THROTTLE_PRESETS) {
    const d = Math.abs(p.value - value);
    if (d < bestD) { bestD = d; best = p; }
  }
  return `${throttleNum(value)}  ${best.label}`;
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
