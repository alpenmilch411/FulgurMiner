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

/** Error codes that unambiguously mean "the local console/pipe we were writing to
 *  is gone" — a dead console pipe, a closed stdout. Deliberately NARROW: it drives
 *  a global swallow (see `onFatal`), so it must NOT include network-ambiguous codes
 *  like `ECONNRESET`/`ERR_STREAM_DESTROYED` — a socket reset is a real fatal, not a
 *  lost console. Console-stream errors are caught code-agnostically by the stream
 *  sink anyway (it's scoped to process.stdout/stderr), so this set need only cover
 *  the codes that identify a lost console from an arbitrary uncaught error with no
 *  stream context. */
const TERMINAL_GONE_CODES = new Set([
  'EPIPE',
  'EIO',
  'ENXIO',
]);

/** True when `err` is a lost-local-console write error (EPIPE/EIO/ENXIO). */
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
 *
 * A lost console (EPIPE et al.) is deliberately NOT fatal: a miner's real work —
 * grinding and submitting shares — is network-bound and entirely independent of
 * stdout, so a dead console is no reason to stop earning. Such an error is
 * swallowed and mining continues. (Tearing down here would also be worse than
 * useless: `process.exit` while grind workers/children are live trips a libuv
 * teardown assertion — `!(handle->flags & UV_HANDLE_CLOSING)`, src\win\async.c —
 * on some Windows 10 consoles, turning a clean stop into a native abort.) The
 * normal path for these is the stream-level sink below; this branch is the
 * belt-and-braces for an EPIPE that surfaces via a rejected promise instead.
 */
export function installCrashGuard(io: CrashGuardIO = {}): () => void {
  let done = false;
  const onFatal = (error: unknown): void => {
    if (isTerminalGoneError(error)) return; // lost console — keep mining, don't exit
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

/** Minimal event-emitter surface the stdio sink touches (process.stdout/stderr). */
interface ErrorEmitter {
  on(event: 'error', listener: (err: unknown) => void): unknown;
  removeListener(event: 'error', listener: (err: unknown) => void): unknown;
}

export interface StdioErrorSink {
  /** Stream to guard (default process.stdout). */
  out?: ErrorEmitter;
  /** Stream to guard (default process.stderr). */
  err?: ErrorEmitter;
}

/**
 * Attach permanent `'error'` listeners to stdout and stderr so a dead console
 * pipe can never become an UNHANDLED stream error — which Node turns into a
 * process-killing throw. Node only crashes on a stream `'error'` when there is
 * NO listener; a no-op listener makes the write failure benign.
 *
 * This is the load-bearing fix for the "miner vanishes on a flaky console" bug:
 * the dashboard already guards its own writes, but once it hands off to plain
 * mode (removing its listener) a plain-mode write to the same broken pipe was
 * unguarded → unhandled `'error'` → crash. A process-wide sink covers BOTH the
 * dashboard and plain mode, and every transitional `console.log` in between, so
 * the miner keeps running on a console it can no longer write to.
 *
 * Returns an uninstaller (used by tests; production installs once and never
 * removes it).
 */
export function installStdioErrorSink(sink: StdioErrorSink = {}): () => void {
  const out = sink.out ?? process.stdout;
  const err = sink.err ?? process.stderr;
  // A failed console write is nothing the miner can act on — discard it. Mining
  // is network-bound, so output loss never affects earnings.
  const swallow = (): void => { /* lost/closed console — intentionally ignored */ };
  out.on('error', swallow);
  err.on('error', swallow);
  return () => {
    out.removeListener('error', swallow);
    err.removeListener('error', swallow);
  };
}
