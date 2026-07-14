// src/minerd/tui.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { DashboardReporter } from './tui.js';

/** A stand-in for process.stdout: an EventEmitter that also has write/columns/rows.
 *  write() is a no-op sink so constructing the dashboard never touches the real
 *  terminal; emit('error', …) simulates the console pipe dying. */
function makeFakeOut(): EventEmitter & { write: (s: string) => boolean; columns: number; rows: number } {
  const ee = new EventEmitter() as EventEmitter & { write: (s: string) => boolean; columns: number; rows: number };
  ee.write = () => true;
  ee.columns = 80;
  ee.rows = 24;
  return ee;
}

test('dashboard requests a plain-mode fallback when its output pipe dies (EPIPE)', () => {
  const out = makeFakeOut();
  let lost = 0;
  const r = new DashboardReporter(
    { onSettings: () => {}, onQuit: () => {}, onTerminalLost: () => { lost++; } },
    out,
  );
  try {
    // The console pipe goes away mid-render — Node emits 'error' on the stream.
    out.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }));
    assert.equal(lost, 1, 'onTerminalLost fired exactly once on EPIPE');
  } finally {
    r.close();
  }
});

test('dashboard falls back once on any stdout error and ignores repeats', () => {
  const out = makeFakeOut();
  let lost = 0;
  const r = new DashboardReporter(
    { onSettings: () => {}, onQuit: () => {}, onTerminalLost: () => { lost++; } },
    out,
  );
  try {
    // Any error means the dashboard can't draw — fall back regardless of code,
    // and only once (a dying stream often emits several errors in a row).
    out.emit('error', Object.assign(new Error('io'), { code: 'EIO' }));
    out.emit('error', Object.assign(new Error('again'), { code: 'EPIPE' }));
    assert.equal(lost, 1, 'fallback fires exactly once, then is idempotent');
  } finally {
    r.close();
  }
});

// ─── jackpot / session-end parity (FIX 3) ────────────────────────────────────

test('DashboardReporter: jackpot() after close() does not repaint — a stale panel must not survive session end', () => {
  const out = makeFakeOut();
  const r = new DashboardReporter({ onSettings: () => {}, onQuit: () => {} }, out);
  r.status({ mode: 'pool', target: 'FulgurPool', backend: 'wasm', workers: 2, throttle: 1, address: 'a'.repeat(64) });
  r.jackpot({ finderBonusPct: 0.03, yourBlockStrikes: 1 });
  r.close();
  let writes = 0;
  out.write = () => { writes++; return true; };
  r.jackpot({ finderBonusPct: 0.05, yourBlockStrikes: 2 }); // a late/straggler update
  assert.equal(writes, 0, 'no further terminal writes once the session has ended');
});

test('DashboardReporter: close() wipes the alt-screen before leaving it (no stale panel left in the buffer)', () => {
  const out = makeFakeOut();
  const writes: string[] = [];
  const origWrite = out.write.bind(out);
  out.write = (s: string) => { writes.push(s); return origWrite(s); };
  const r = new DashboardReporter({ onSettings: () => {}, onQuit: () => {} }, out);
  r.status({ mode: 'pool', target: 'FulgurPool', backend: 'wasm', workers: 2, throttle: 1, address: 'a'.repeat(64) });
  r.jackpot({ finderBonusPct: 0.03, yourBlockStrikes: 1 });
  writes.length = 0; // only inspect the close()-time write
  r.close();
  assert.equal(writes.length, 1, 'close() performs exactly one terminal-restore write');
  assert.match(writes[0]!, /\x1b\[J/, 'the restore write clears the alt screen (CLEAR_DOWN) before leaving it');
});
