// src/minerd/crashGuard.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isTerminalGoneError, handleFatal, installCrashGuard } from './crashGuard.js';

test('isTerminalGoneError: console/pipe-gone codes are terminal-gone', () => {
  assert.equal(isTerminalGoneError({ code: 'EPIPE' }), true);
  assert.equal(isTerminalGoneError({ code: 'EIO' }), true);
  assert.equal(isTerminalGoneError({ code: 'ENXIO' }), true);
  assert.equal(isTerminalGoneError({ code: 'ECONNRESET' }), true);
  assert.equal(isTerminalGoneError({ code: 'ERR_STREAM_DESTROYED' }), true);
});

test('isTerminalGoneError: unrelated errors are not terminal-gone', () => {
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
