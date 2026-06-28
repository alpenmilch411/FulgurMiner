// src/minerd/crashGuard.ts
//
// Process-level safety net. The miner runs long-lived event loops (grind
// workers/children, poll timers, the TUI render timer). An error thrown from any
// of those async callbacks is an UNHANDLED event/rejection — Node's default
// behavior is to print a raw stack and exit, which on Windows closes the console
// window with no clue why. Worse, if it happens while the dashboard owns the
// alternate screen, the terminal is left dirty.
//
// This installs last-resort handlers that restore the terminal and surface the
// error in a calm, readable form before exiting. It does NOT mask bugs — an
// uncaught exception still ends the process (Node docs: the process is in an
// undefined state and must exit) — it just makes the failure visible instead of
// a silent vanish. The common concrete trigger is a `write EPIPE` from the
// dashboard when the console pipe goes away (seen on some Windows 10 consoles).

/** Cursor-show + leave-alternate-screen. Same bytes the dashboard uses to
 *  restore the terminal, duplicated here so the guard has no TUI dependency. */
const RESTORE_TERMINAL = '\x1b[?25h\x1b[?1049l';

/** Error codes that mean "the thing we were writing to is gone" — a dead console
 *  pipe, a closed stdout, a reset socket. Not application bugs; nothing to retry. */
const TERMINAL_GONE_CODES = new Set([
  'EPIPE',
  'EIO',
  'ENXIO',
  'ECONNRESET',
  'ERR_STREAM_DESTROYED',
]);

/** True when `err` is a "consumer/console went away" error (EPIPE et al.). */
export function isTerminalGoneError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | null | undefined)?.code;
  return typeof code === 'string' && TERMINAL_GONE_CODES.has(code);
}

/** Minimal writable sink — just enough of the stream surface the guard touches. */
interface WriteSink {
  write(s: string): unknown;
}

export interface CrashGuardIO {
  /** Where to write the terminal-restore sequence (default process.stdout). */
  out?: WriteSink;
  /** Where to write the human-readable failure report (default process.stderr). */
  err?: WriteSink;
  /** How to exit (default process.exit). Injectable for tests. */
  exit?: (code: number) => void;
}

/**
 * Restore the terminal, print a readable failure report, then exit non-zero.
 * Every step is wrapped so a dead stdout/stderr (the very thing that may have
 * triggered this) can never turn the guard itself into a second crash.
 */
export function handleFatal(error: unknown, io: CrashGuardIO = {}): void {
  const out = io.out ?? process.stdout;
  const err = io.err ?? process.stderr;
  const exit = io.exit ?? ((code: number) => process.exit(code));

  try { out.write(RESTORE_TERMINAL); } catch { /* stdout may be the dead pipe */ }

  // A lost console (EPIPE et al.) gets a calm one-liner — there's no bug to report,
  // the terminal just went away. Anything else prints the stack so it can be filed.
  let report: string;
  if (isTerminalGoneError(error)) {
    report = '\n  FulgurMiner stopped: the terminal/console connection was lost.\n';
  } else {
    const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
    report = `\n  FulgurMiner stopped unexpectedly:\n  ${detail}\n\n  If this keeps happening, please report it with the lines above.\n`;
  }
  try { err.write(report); } catch { /* stderr may be gone too */ }

  exit(1);
}

/**
 * Install the uncaughtException + unhandledRejection handlers. Fires `handleFatal`
 * at most once (the first fatal wins; a follow-on error during teardown is
 * ignored). Returns an uninstaller (used by tests; production never uninstalls).
 */
export function installCrashGuard(io: CrashGuardIO = {}): () => void {
  let done = false;
  const onFatal = (error: unknown): void => {
    if (done) return;
    done = true;
    handleFatal(error, io);
  };
  process.on('uncaughtException', onFatal);
  process.on('unhandledRejection', onFatal);
  return () => {
    process.removeListener('uncaughtException', onFatal);
    process.removeListener('unhandledRejection', onFatal);
  };
}
