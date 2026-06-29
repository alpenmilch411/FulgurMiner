// src/minerd/menuCopy.ts
//
// Pure presentation copy for the arrow-key start menu: the right-pane "About"
// explanation text (the two-pane menu) and the "Where to mine" picker
// descriptions. Kept out of menu.ts so the controller stays focused and all the
// user-facing prose lives in one place.
//
// This module imports NOTHING from menu.ts at runtime — the `RowKind` import is
// type-only (erased by the compiler), so there is no import cycle.
import type { RowKind } from './menu.js';
import type { SmartMode } from './selectors.js';
import { REPO_URL } from './config.js';

/**
 * Shown (in red) in the right "About" pane when Native is selected but the Rust
 * toolchain isn't installed — so the selection would silently fall back to wasm.
 * Explains the effect and the fix instead of leaving the user wondering why
 * native "didn't take".
 */
export const NATIVE_NEEDS_RUST =
  `Native (Rust) is faster, but the Rust toolchain isn't installed on this machine — so this stays on the portable WASM engine for now. To enable native: install Rust from https://rustup.rs, then restart FulgurMiner. Step-by-step in the repo README: ${REPO_URL}`;

/**
 * Shown (in yellow) in the right "About" pane when the user has Manual mode and
 * Throttle at Max (100%) — the "full blast" configuration that pins every CPU
 * core. Warns about instability and sustained heat, and recommends Considerate
 * for long or unattended sessions.
 */
export const FULL_BLAST_CAUTION =
  `Full blast: Manual at 100% runs every CPU core flat-out. On a machine with\n` +
  `limited cooling this can cause instability (graphics glitches or crashes),\n` +
  `and sustained use keeps temperatures high — which can accelerate hardware\n` +
  `wear over time. For long or unattended mining, Smart: Considerate is safer:\n` +
  `it leaves headroom and eases off when you need the CPU.`;

/**
 * One short explanation per main-menu row, shown in the right "About" pane when
 * that row is highlighted (self-documenting menu). Plain sentences — the menu
 * renderer adds any styling/wrapping. Keyed by RowKind so every row is covered.
 */
export const ROW_EXPLAIN: Record<RowKind, string> = {
  'action-start':
    'Begin mining with the settings shown on the left. You can come back here any time by pressing s in the dashboard.',
  wallet:
    'Your BrowserCoin address — where mining rewards are paid. It is public; no password or private key is needed. Press Enter to edit it.',
  target:
    'Where your hashes go. FulgurPool (the project’s own pool) is the default; press Enter to choose Solo or one of your own pools.',
  workers:
    'How many CPU cores grind in parallel. More is faster but hotter and louder. Use ←/→ to change; one core is left free by default.',
  mode:
    'Manual lets you set the duty cycle by hand; Smart auto-tunes it. Press Enter to choose.',
  throttle:
    'How hard each worker pushes the CPU. Balanced stays cool and quiet; Max is fastest but runs hot. Use ←/→ to change.',
  engine:
    'wasm runs anywhere Node runs; native (Rust) is faster but is built on first use. Use ←/→ to switch.',
  'update-check':
    'Check for newer FulgurMiner versions at startup. Turn this off to skip the startup check; during mining, press u to show the update command.',
  help:
    'A short guide to what FulgurMiner does, the dashboard panels, and the keys. Press Enter to open.',
  'action-quit':
    'Exit FulgurMiner. Your settings are saved to .env.local, so the next start remembers them.',
};

/**
 * Explanation for a "Where to mine" destination, shown in the picker's right
 * pane. `isDefault` marks the FulgurPool default row; `isSolo` marks Solo;
 * otherwise it is a user-configured custom pool.
 */
export function whereExplain(opts: { isDefault: boolean; isSolo: boolean; name: string }): string {
  if (opts.isDefault) {
    return `${opts.name} is the project’s own pool and the default. Pooled mining smooths out rewards into steady, smaller payouts instead of rare whole blocks.`;
  }
  if (opts.isSolo) {
    return 'Solo mining builds blocks on your own — no pool. You keep the full block reward when you find one, but finds are rare and irregular.';
  }
  return `${opts.name} is one of your configured pools. Mining here sends your shares to that pool.`;
}

/**
 * Shown (in DIM) in the right "About" pane when the user highlights the
 * Throttle row while Smart mode is active. Explains that the Throttle is a
 * starting point, not a fixed value, and describes how the auto-tuner adapts.
 */
export const SMART_THROTTLE_EXPLAIN =
  `In Smart mode this is the STARTING point the auto-tuner climbs from — not a fixed value. ` +
  `The live rate floats on its own: up toward the most your machine sustains, and (Considerate) ` +
  `down to as low as 5% when your apps need the CPU. It ramps gradually, so give it a minute. ` +
  `To set a fixed rate instead, switch Mode to Manual.`;

/** Explanation for a Smart Mode option, shown in the Mode picker's right pane. */
export function modeExplain(mode: SmartMode): string {
  if (mode === 'off') {
    return 'You set the duty cycle by hand with the Throttle setting. No auto-tuning.';
  }
  if (mode === 'max') {
    return 'Auto-tunes to the highest level your machine sustains and stays there (no headroom reserved). Starts from your Throttle and ramps up gradually. Best for a dedicated mining machine.';
  }
  return 'Auto-tunes the throttle and eases off when your other apps need the CPU. Starts from your Throttle setting and ramps up gradually toward the most your machine sustains, backing down to as low as 5% while you\'re using the PC. Best for set-and-forget on a machine you also use. On a dedicated server or VPS, use Max or Manual instead — on shared/virtual CPUs the idle reading is unreliable and can make it oscillate.';
}
