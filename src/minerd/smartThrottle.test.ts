// src/minerd/smartThrottle.test.ts
//
// Tests for the SMART_THROTTLE_EXPLAIN About-pane behaviour on the Throttle row
// when Smart mode is active. Mirrors the fullBlastCaution.test.ts structure.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StartMenu } from './menu.js';
import { SMART_THROTTLE_EXPLAIN } from './menuCopy.js';

const WIDTHS = [100, 80, 64, 50, 40];

/** Strip ANSI SGR sequences and OSC-8 hyperlink escapes. */
function visible(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s
    .replace(/\x1b\]8;;[^\x07\x1b]*(\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '');
}

function assertFits(lines: string[], cols: number): void {
  for (const line of lines) {
    assert.ok(
      visible(line).length <= cols,
      `line exceeds ${cols} cols: ${visible(line).length} ${JSON.stringify(visible(line))}`,
    );
  }
}

function withMutedStdout(fn: () => void): void {
  const write = process.stdout.write;
  process.stdout.write = (() => true) as typeof process.stdout.write;
  try { fn(); } finally { process.stdout.write = write; }
}

/** Navigate to the Throttle row (index 5: start, wallet, target, workers, mode, throttle). */
function navigateToThrottleRow(menu: StartMenu): void {
  withMutedStdout(() => {
    for (let i = 0; i < 5; i++) menu.handleKey(undefined, { name: 'down' });
  });
}

// ---------------------------------------------------------------------------
// Test 1: SMART_THROTTLE_EXPLAIN appears when on Throttle row in Smart (Considerate) mode
// ---------------------------------------------------------------------------
test('SMART_THROTTLE_EXPLAIN shown on Throttle row in Smart (Considerate) mode', () => {
  const oldSmart = process.env.MINER_SMART;
  try {
    process.env.MINER_SMART = 'considerate';
    const menu = new StartMenu();
    navigateToThrottleRow(menu);
    const text = menu.buildLines(100).map(visible).join('\n');
    assert.ok(
      text.includes('auto-tuner'),
      `Expected SMART_THROTTLE_EXPLAIN (auto-tuner sets the rate) in output. Got:\n${text}`,
    );
  } finally {
    if (oldSmart === undefined) delete process.env.MINER_SMART;
    else process.env.MINER_SMART = oldSmart;
  }
});

// ---------------------------------------------------------------------------
// Test 2: SMART_THROTTLE_EXPLAIN appears in Smart (Max) mode too
// ---------------------------------------------------------------------------
test('SMART_THROTTLE_EXPLAIN shown on Throttle row in Smart (Max) mode', () => {
  const oldSmart = process.env.MINER_SMART;
  try {
    process.env.MINER_SMART = 'max';
    const menu = new StartMenu();
    navigateToThrottleRow(menu);
    const text = menu.buildLines(100).map(visible).join('\n');
    assert.ok(
      text.includes('auto-tuner'),
      `Expected SMART_THROTTLE_EXPLAIN in Smart/Max output. Got:\n${text}`,
    );
  } finally {
    if (oldSmart === undefined) delete process.env.MINER_SMART;
    else process.env.MINER_SMART = oldSmart;
  }
});

// ---------------------------------------------------------------------------
// Test 3: SMART_THROTTLE_EXPLAIN NOT shown in Manual mode
// ---------------------------------------------------------------------------
test('SMART_THROTTLE_EXPLAIN NOT shown on Throttle row in Manual mode', () => {
  const oldSmart = process.env.MINER_SMART;
  try {
    delete process.env.MINER_SMART;
    const menu = new StartMenu();
    navigateToThrottleRow(menu);
    const text = menu.buildLines(80).map(visible).join('\n');
    assert.ok(
      !text.includes('auto-tuner'),
      `Expected no SMART_THROTTLE_EXPLAIN in Manual mode. Got:\n${text}`,
    );
  } finally {
    if (oldSmart === undefined) delete process.env.MINER_SMART;
    else process.env.MINER_SMART = oldSmart;
  }
});

// ---------------------------------------------------------------------------
// Test 4: FULL_BLAST_CAUTION does NOT appear when in Smart mode at Max throttle
//         (the Smart-throttle case must not collide with full-blast)
// ---------------------------------------------------------------------------
test('full-blast caution NOT shown when Smart mode is on (even at throttle=1.00)', () => {
  const oldSmart = process.env.MINER_SMART;
  const oldThrottle = process.env.MINER_THROTTLE;
  try {
    process.env.MINER_SMART = 'considerate';
    process.env.MINER_THROTTLE = '1.00';
    const menu = new StartMenu();
    navigateToThrottleRow(menu);
    const text = menu.buildLines(80).map(visible).join('\n');
    assert.ok(
      !text.includes('Full blast'),
      `Expected no "Full blast" caution in Smart mode. Got:\n${text}`,
    );
  } finally {
    if (oldSmart === undefined) delete process.env.MINER_SMART;
    else process.env.MINER_SMART = oldSmart;
    if (oldThrottle === undefined) delete process.env.MINER_THROTTLE;
    else process.env.MINER_THROTTLE = oldThrottle;
  }
});

// ---------------------------------------------------------------------------
// Test 5: Width probe — no visible line exceeds cols at 100/80/64/50/40
//         when SMART_THROTTLE_EXPLAIN is active (throttle row + Smart mode)
// ---------------------------------------------------------------------------
test('SMART_THROTTLE_EXPLAIN fits within all common terminal widths (100/80/64/50/40)', () => {
  const oldSmart = process.env.MINER_SMART;
  try {
    process.env.MINER_SMART = 'considerate';
    for (const cols of WIDTHS) {
      const menu = new StartMenu();
      navigateToThrottleRow(menu);
      const lines = menu.buildLines(cols);
      assertFits(lines, cols);
    }
  } finally {
    if (oldSmart === undefined) delete process.env.MINER_SMART;
    else process.env.MINER_SMART = oldSmart;
  }
});

// ---------------------------------------------------------------------------
// Test 6: SMART_THROTTLE_EXPLAIN export is a non-empty string with key terms
// ---------------------------------------------------------------------------
test('SMART_THROTTLE_EXPLAIN export contains key informational terms', () => {
  assert.ok(typeof SMART_THROTTLE_EXPLAIN === 'string' && SMART_THROTTLE_EXPLAIN.length > 0);
  assert.ok(
    SMART_THROTTLE_EXPLAIN.toLowerCase().includes('auto-tuner'),
    'should say the auto-tuner sets the rate',
  );
  assert.ok(
    SMART_THROTTLE_EXPLAIN.toLowerCase().includes('not used'),
    'should say the Throttle value is not used under Smart',
  );
  assert.ok(
    SMART_THROTTLE_EXPLAIN.toLowerCase().includes('manual'),
    'should mention switching to Manual',
  );
});
