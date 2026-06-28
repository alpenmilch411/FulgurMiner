// src/minerd/engine.ts
//
// Native-engine resolution (§3). The Engine selector persists MINER_NATIVE; at
// the moment of starting a session we resolve what that selection can actually
// run on this machine and reconcile process.env.MINER_NATIVE so the rest of the
// miner (buildStatus / runMiner) just reads the env as before.
//
// Resolution (never blocks mining):
//   wasm selected                    → wasm.
//   native selected + binary exists  → native.
//   native selected + binary missing →
//       cargo on PATH  → offer to build (cargo build --release in native/brc-pow)
//                        with a status line; success → native, failure → wasm.
//       cargo missing  → print the exact build command, fall back to wasm.
//
// `MINER_NATIVE=1` set directly in the environment behaves exactly the same: it
// makes `native` the selection, and this resolver verifies/offers the build.
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { NATIVE_BIN } from './nativeGrindPool.js';
import { currentEngine } from './selectors.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
/** Directory of the native Rust crate (where cargo build runs). */
export const NATIVE_DIR = resolve(__dirname, '../../native/brc-pow');
/** The exact command a user runs to build the native engine by hand. */
export const BUILD_CMD = 'cd native/brc-pow && cargo build --release';

/**
 * True when the native engine can actually run on this machine: either a binary
 * is already built, OR cargo is on PATH to build it on first start. When false,
 * choosing native silently falls back to wasm — the UI surfaces a "needs Rust"
 * notice instead of letting the selection do nothing. (Spawns `cargo --version`
 * once via hasCargo(); callers should cache the result, not call it per render.)
 */
export function nativeEngineAvailable(): boolean {
  return existsSync(NATIVE_BIN) || hasCargo();
}

/** True when `cargo` is callable on PATH. */
export function hasCargo(): boolean {
  try {
    const r = spawnSync('cargo', ['--version'], { stdio: 'ignore' });
    return r.status === 0;
  } catch {
    return false;
  }
}

/** Run `cargo build --release` in the native crate. Returns true on success. */
export function buildNative(): boolean {
  try {
    // Verify the crate dir is where we computed it BEFORE spawning cargo: if the
    // compiled code was relocated/bundled and NATIVE_DIR no longer points at the
    // Rust crate, a cargo spawn there fails with a confusing error. Bail with a
    // clear false instead (the caller falls back to wasm and prints BUILD_CMD).
    if (!existsSync(resolve(NATIVE_DIR, 'Cargo.toml'))) return false;
    const r = spawnSync('cargo', ['build', '--release'], { cwd: NATIVE_DIR, stdio: 'inherit' });
    return r.status === 0 && existsSync(NATIVE_BIN);
  } catch {
    return false;
  }
}

/** How a confirmation prompt is answered. Injectable so it can be headless/non-TTY. */
export type Confirm = (question: string) => Promise<boolean>;

/** Default confirm: a one-line y/N readline prompt (used in plain mode). */
async function readlineConfirm(question: string): Promise<boolean> {
  const rl = createInterface({ input, output });
  try {
    const a = (await rl.question(`  ${question} (y/N) `)).trim().toLowerCase();
    return a === 'y' || a === 'yes';
  } finally {
    rl.close();
  }
}

/** A line-printer for status output (defaults to console.log). */
export type Log = (msg: string) => void;

/**
 * Reconcile process.env.MINER_NATIVE with what this machine can run, possibly
 * building the native engine. Mutates process.env.MINER_NATIVE so downstream
 * code reads the resolved engine. Returns the engine actually selected.
 *
 * `confirm` is either a y/N prompt function OR the literal `'non-interactive'`
 * sentinel. Pass `'non-interactive'` from any caller that must NEVER block on
 * input (a pipe / no-TTY plain run): the build offer is auto-declined and we fall
 * back to wasm. This makes the no-blocking contract explicit at the call site
 * rather than relying on a hand-injected `async () => false` confirm. It defaults
 * to an interactive readline y/N prompt. `log` defaults to console.log.
 */
export async function resolveEngine(
  confirm: Confirm | 'non-interactive' = readlineConfirm,
  log: Log = (m) => console.log(m),
): Promise<'wasm' | 'native'> {
  // Normalise the sentinel to a declining confirm so the body has one code path.
  const nonInteractive = confirm === 'non-interactive';
  const ask: Confirm = nonInteractive ? (async () => false) : confirm;
  if (currentEngine(process.env.MINER_NATIVE) !== 'native') return 'wasm';

  // native selected.
  if (existsSync(NATIVE_BIN)) return 'native';

  // Missing binary — try to get one, but NEVER block mining.
  if (hasCargo()) {
    let build = false;
    try {
      build = await ask('Native engine not built yet. Build it now? (~1 min)');
    } catch {
      build = false;
    }
    if (build) {
      log('  Building the native engine (cargo build --release)…');
      if (buildNative()) {
        log('  Native engine built. Using native.');
        return 'native';
      }
      log('  Native build failed — using the wasm engine. If cargo printed a linker/');
      log('  compiler error, install a C toolchain (Windows: the MSVC build tools via the');
      log('  Visual Studio installer; macOS: xcode-select --install; Linux: build-essential),');
      log('  then try again.');
    }
  } else {
    log('  The native engine is ~1.6x faster but needs the Rust toolchain.');
    log('    1) Install Rust from https://rustup.rs (on Windows it also installs the MSVC build tools).');
    log('    2) Open a NEW terminal so cargo is on PATH, then build it:');
    log(`         ${BUILD_CMD}`);
    log('  Continuing with the portable wasm engine for now.');
  }

  // Fall back to wasm: clear MINER_NATIVE so status/runMiner show wasm and the
  // worker_threads GrindPool is used.
  delete process.env.MINER_NATIVE;
  return 'wasm';
}
