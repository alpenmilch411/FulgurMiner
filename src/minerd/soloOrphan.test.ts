import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ConsoleReporter, soloEarnedBrc, type EarningsInfo } from './reporter.js';
import { DashboardReporter } from './tui.js';

function captureConsoleLog(fn: () => void): string[] {
  const lines: string[] = [];
  const oldLog = console.log;
  console.log = (...args: unknown[]) => { lines.push(args.join(' ')); };
  try {
    fn();
  } finally {
    console.log = oldLog;
  }
  return lines;
}

function soloStatus(): Parameters<ConsoleReporter['status']>[0] {
  return {
    mode: 'solo',
    target: 'solo',
    backend: 'wasm',
    workers: 1,
    throttle: 1,
    address: 'a'.repeat(64),
  };
}

function poolStatus(): Parameters<ConsoleReporter['status']>[0] {
  return {
    mode: 'pool',
    target: 'pool',
    backend: 'wasm',
    workers: 1,
    throttle: 1,
    address: 'a'.repeat(64),
  };
}

test('ConsoleReporter prunes and restores orphaned solo earnings by block hash', () => {
  const h1 = 'block-1';
  const h2 = 'block-2';
  const lines = captureConsoleLog(() => {
    const r = new ConsoleReporter();
    r.status(soloStatus());
    r.found({ height: 1, hash: h1, accepted: true, detail: 'ok' });
    r.found({ height: 2, hash: h2, accepted: true, detail: 'ok' });
    r.reorg([], [h1]);
    r.reorg([], ['deadbeef-not-ours']);
    r.reorg([h1], []);
  });

  assert.deepEqual(lines.filter((l) => l.includes('earnings (est):')), [
    `[minerd] earnings (est): ${soloEarnedBrc([1])} BRC (1 blocks)`,
    `[minerd] earnings (est): ${soloEarnedBrc([1, 2])} BRC (2 blocks)`,
    `[minerd] earnings (est): ${soloEarnedBrc([2])} BRC (1 blocks)`,
    `[minerd] earnings (est): ${soloEarnedBrc([1, 2])} BRC (2 blocks)`,
  ]);
});

test('soloReorgReset orphans all solo rewards; the replay re-connect restores only survivors', () => {
  const lines = captureConsoleLog(() => {
    const r = new ConsoleReporter();
    r.status(soloStatus());
    r.found({ height: 1, hash: 'block-1', accepted: true, detail: 'ok' });
    r.found({ height: 2, hash: 'block-2', accepted: true, detail: 'ok' });
    r.soloReorgReset();        // deep-reorg reset → orphan ALL (earnings → 0)
    r.reorg(['block-1'], []);  // replay re-connects block-1 (still canonical) → restored
    // block-2 is never re-connected (genuinely orphaned) → stays excluded
  });
  assert.deepEqual(lines.filter((l) => l.includes('earnings (est):')), [
    `[minerd] earnings (est): ${soloEarnedBrc([1])} BRC (1 blocks)`,
    `[minerd] earnings (est): ${soloEarnedBrc([1, 2])} BRC (2 blocks)`,
    `[minerd] earnings (est): ${soloEarnedBrc([])} BRC (0 blocks)`,
    `[minerd] earnings (est): ${soloEarnedBrc([1])} BRC (1 blocks)`,
  ]);
});

test('ConsoleReporter pool mode does not record solo blocks and reorg is a no-op', () => {
  const lines = captureConsoleLog(() => {
    const r = new ConsoleReporter();
    r.status(poolStatus());
    r.found({ height: 1, hash: 'pool-block', accepted: true, detail: 'ok' });
    r.reorg([], ['pool-block']);
  });
  assert.equal(lines.filter((l) => l.includes('earnings (est):')).length, 0);
});

class CapturingDashboardReporter extends DashboardReporter {
  readonly emitted: EarningsInfo[] = [];

  override earnings(e: EarningsInfo): void {
    this.emitted.push(e);
    super.earnings(e);
  }
}

test('DashboardReporter mirrors solo orphan prune and reconnect accounting', () => {
  const oldWrite = process.stdout.write;
  process.stdout.write = (() => true) as typeof process.stdout.write;
  let r: CapturingDashboardReporter | null = null;
  try {
    r = new CapturingDashboardReporter({ onSettings: () => {}, onQuit: () => {} });
    r.status(soloStatus());
    r.found({ height: 1, hash: 'block-1', accepted: true, detail: 'ok' });
    r.found({ height: 2, hash: 'block-2', accepted: true, detail: 'ok' });
    r.reorg([], ['block-1']);
    r.reorg([], ['deadbeef-not-ours']);
    r.reorg(['block-1'], []);
    assert.deepEqual(r.emitted.map((e) => e.earnedBrc), [
      soloEarnedBrc([1]),
      soloEarnedBrc([1, 2]),
      soloEarnedBrc([2]),
      soloEarnedBrc([1, 2]),
    ]);
  } finally {
    r?.close();
    process.stdout.write = oldWrite;
  }
});
