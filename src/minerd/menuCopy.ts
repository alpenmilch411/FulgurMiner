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

/** Explanation for a Smart Mode option, shown in the Mode picker's right pane. */
export function modeExplain(mode: SmartMode): string {
  if (mode === 'off') {
    return 'You set the duty cycle by hand with the Throttle setting. No auto-tuning.';
  }
  if (mode === 'max') {
    return 'Auto-tunes the duty cycle to the highest your machine sustains. On a well-cooled machine this is about the same as running at 100% by hand — the win is it finds that point for you and adapts to heat and load.';
  }
  return 'Auto-tunes like Max, but adapts to what the rest of your machine is doing — eases off when your other apps need the CPU, and ramps back up when they go quiet. You mine the spare capacity. Best everyday average.';
}
