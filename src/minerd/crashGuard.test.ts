// src/minerd/crashGuard.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { isTerminalGoneError, handleFatal, installCrashGuard, installStdioErrorSink } from './crashGuard.js';

test('isTerminalGoneError: only unambiguous local-console-write codes are terminal-gone', () => {
  assert.equal(isTerminalGoneError({ code: 'EPIPE' }), true);
  assert.equal(isTerminalGoneError({ code: 'EIO' }), true);
  assert.equal(isTerminalGoneError({ code: 'ENXIO' }), true);
});

test('isTerminalGoneError: network-ambiguous and unrelated errors are NOT terminal-gone', () => {
  // ECONNRESET / ERR_STREAM_DESTROYED are not console-specific (a socket reset is
  // a real fatal). They must stay fatal at the global handler; a *console-stream*
  // error of any code is still absorbed by the stdout/stderr sink, which is scoped
  // to the stream rather than keyed on the code.
  assert.equal(isTerminalGoneError({ code: 'ECONNRESET' }), false);
  assert.equal(isTerminalGoneError({ code: 'ERR_STREAM_DESTROYED' }), false);
  assert.equal(isTerminalGoneError({ code: 'ENOENT' }), false);
  assert.equal(isTerminalGoneError(new Error('boom')), false);
  assert.equal(isTerminalGoneError(null), false);
  assert.equal(isTerminalGoneError(undefined), false);
});

test('handleFatal restores the terminal, reports an unexpected error, and exits non-zero', () => {
  const out: string[] = [];
  const err: string[] = [];
  let exitCode: number | null = null;
  handleFatal(new Error('unexpected boom'), {
    out: { write: (s: string) => { out.push(s); return true; } },
    err: { write: (s: string) => { err.push(s); return true; } },
    exit: (c: number) => { exitCode = c; },
  });
  const written = out.join('');
  assert.ok(written.includes('\x1b[?25h'), 'shows the cursor');
  assert.ok(written.includes('\x1b[?1049l'), 'leaves the alternate screen');
  assert.ok(err.join('').includes('unexpected boom'), 'surfaces the error to stderr');
  assert.equal(exitCode, 1);
});

test('handleFatal gives a calm message (no stack) for a lost terminal/console', () => {
  const err: string[] = [];
  let exitCode: number | null = null;
  handleFatal(Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }), {
    out: { write: () => true },
    err: { write: (s: string) => { err.push(s); return true; } },
    exit: (c: number) => { exitCode = c; },
  });
  const msg = err.join('');
  assert.match(msg, /terminal|console/i);
  assert.ok(!/\n\s+at /.test(msg), 'no raw stack trace for a lost terminal');
  assert.equal(exitCode, 1);
});

test('handleFatal never throws even if the restore write fails', () => {
  let exitCode: number | null = null;
  assert.doesNotThrow(() => handleFatal(new Error('boom'), {
    out: { write: () => { throw new Error('stdout dead'); } },
    err: { write: () => { throw new Error('stderr dead'); } },
    exit: (c: number) => { exitCode = c; },
  }));
  assert.equal(exitCode, 1);
});

test('installStdioErrorSink: a stdout/stderr error is swallowed (never unhandled) and is removable', () => {
  const out = new EventEmitter();
  const err = new EventEmitter();
  const uninstall = installStdioErrorSink({ out, err });
  assert.equal(out.listenerCount('error'), 1, 'attaches an error listener to stdout');
  assert.equal(err.listenerCount('error'), 1, 'attaches an error listener to stderr');
  // With a listener attached, emit('error') must NOT throw. Without the sink a
  // stream 'error' event with no listener crashes the process — that is exactly
  // the lost-console death we are preventing (the miner keeps running instead).
  assert.doesNotThrow(() => out.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' })));
  assert.doesNotThrow(() => err.emit('error', new Error('stderr broke')));
  uninstall();
  assert.equal(out.listenerCount('error'), 0, 'uninstall removes the stdout listener');
  assert.equal(err.listenerCount('error'), 0, 'uninstall removes the stderr listener');
});

test('installCrashGuard: a lost console does NOT exit the miner and does NOT latch out a later real crash', () => {
  let exits = 0;
  const before = process.listeners('uncaughtException');
  const uninstall = installCrashGuard({ exit: () => { exits++; }, out: { write: () => true }, err: { write: () => true } });
  const after = process.listeners('uncaughtException');
  const onFatal = after.find((h) => !before.includes(h)) as (e: unknown) => void;
  assert.ok(onFatal, 'captured the installed handler');

  // A terminal-gone error (EPIPE et al.) is benign for a miner — grinding and
  // share submission are network-bound, independent of stdout. Swallow + keep
  // mining; never tear down (process.exit also trips a libuv teardown assertion
  // on some Windows consoles).
  onFatal(Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }));
  assert.equal(exits, 0, 'a lost console must not exit the miner');

  // A network-ambiguous code (ECONNRESET) is NOT a lost console — it must stay
  // fatal so a real socket failure is never silently swallowed.
  onFatal(Object.assign(new Error('socket reset'), { code: 'ECONNRESET' }));
  assert.equal(exits, 1, 'a network reset is a real fatal, not a lost console');

  // The swallow must NOT consume the once-guard for the earlier EPIPE; but once a
  // real fatal has fired, the guard latches (the process is already exiting).
  onFatal(new Error('a later bug'));
  assert.equal(exits, 1, 'handleFatal fires once; subsequent errors are ignored');

  uninstall();
});

test('installCrashGuard wires both process handlers and can be removed', () => {
  const beforeUncaught = process.listenerCount('uncaughtException');
  const beforeReject = process.listenerCount('unhandledRejection');
  const uninstall = installCrashGuard({ exit: () => {}, out: { write: () => true }, err: { write: () => true } });
  assert.equal(process.listenerCount('uncaughtException'), beforeUncaught + 1);
  assert.equal(process.listenerCount('unhandledRejection'), beforeReject + 1);
  uninstall();
  assert.equal(process.listenerCount('uncaughtException'), beforeUncaught);
  assert.equal(process.listenerCount('unhandledRejection'), beforeReject);
});
