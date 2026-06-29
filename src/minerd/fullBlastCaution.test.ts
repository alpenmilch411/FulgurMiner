// src/minerd/fullBlastCaution.test.ts
//
// Tests for the "full blast caution" shown in the right-hand About pane when
// the user has Manual mode + Throttle at Max (100%).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StartMenu } from './menu.js';
import { FULL_BLAST_CAUTION } from './menuCopy.js';

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
  try {
    fn();
  } finally {
    process.stdout.write = write;
  }
}

/** Navigate to the Throttle row (index 5 in ROWS: start, wallet, target, workers, mode, throttle). */
function navigateToThrottleRow(menu: StartMenu): void {
  withMutedStdout(() => {
    for (let i = 0; i < 5; i++) menu.handleKey(undefined, { name: 'down' });
  });
}

// ---------------------------------------------------------------------------
// Test 1: FULL_BLAST_CAUTION text appears when on Throttle row, Manual mode,
//         Throttle at Max (1.00)
// ---------------------------------------------------------------------------
test('full-blast caution shown on throttle row in Manual mode at Max throttle', () => {
  const oldSmart = process.env.MINER_SMART;
  const oldThrottle = process.env.MINER_THROTTLE;
  try {
    delete process.env.MINER_SMART;           // Manual mode (MINER_SMART unset)
    process.env.MINER_THROTTLE = '1.00';      // Max throttle

    const menu = new StartMenu();
    navigateToThrottleRow(menu);
    const text = menu.buildLines(80).map(visible).join('\n');

    // The caution text must appear somewhere in the rendered output
    assert.ok(
      text.includes('Full blast'),
      `Expected "Full blast" caution in output. Got:\n${text}`,
    );
  } finally {
    if (oldSmart === undefined) delete process.env.MINER_SMART;
    else process.env.MINER_SMART = oldSmart;
    if (oldThrottle === undefined) delete process.env.MINER_THROTTLE;
    else process.env.MINER_THROTTLE = oldThrottle;
  }
});

// ---------------------------------------------------------------------------
// Test 2: FULL_BLAST_CAUTION NOT shown in Smart mode (even if throttle env = 1.00)
// ---------------------------------------------------------------------------
test('full-blast caution NOT shown when in Smart (Considerate) mode', () => {
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
// Test 3: FULL_BLAST_CAUTION NOT shown at a lower throttle (e.g. 0.75 Default)
// ---------------------------------------------------------------------------
test('full-blast caution NOT shown at throttle < Max in Manual mode', () => {
  const oldSmart = process.env.MINER_SMART;
  const oldThrottle = process.env.MINER_THROTTLE;
  try {
    delete process.env.MINER_SMART;
    process.env.MINER_THROTTLE = '0.75';     // Default, not Max

    const menu = new StartMenu();
    navigateToThrottleRow(menu);
    const text = menu.buildLines(80).map(visible).join('\n');

    assert.ok(
      !text.includes('Full blast'),
      `Expected no "Full blast" caution at 0.75 throttle. Got:\n${text}`,
    );
  } finally {
    if (oldSmart === undefined) delete process.env.MINER_SMART;
    else process.env.MINER_SMART = oldSmart;
    if (oldThrottle === undefined) delete process.env.MINER_THROTTLE;
    else process.env.MINER_THROTTLE = oldThrottle;
  }
});

// ---------------------------------------------------------------------------
// Test 4: FULL_BLAST_CAUTION NOT shown on other rows (e.g. wallet row)
// ---------------------------------------------------------------------------
test('full-blast caution NOT shown on non-throttle rows', () => {
  const oldSmart = process.env.MINER_SMART;
  const oldThrottle = process.env.MINER_THROTTLE;
  try {
    delete process.env.MINER_SMART;
    process.env.MINER_THROTTLE = '1.00';

    const menu = new StartMenu();
    // Stay on first row (action-start), no navigation
    const text = menu.buildLines(80).map(visible).join('\n');

    assert.ok(
      !text.includes('Full blast'),
      `Expected no "Full blast" caution on start row. Got:\n${text}`,
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
//         when full-blast caution is active
// ---------------------------------------------------------------------------
test('full-blast caution fits within all common terminal widths', () => {
  const oldSmart = process.env.MINER_SMART;
  const oldThrottle = process.env.MINER_THROTTLE;
  try {
    delete process.env.MINER_SMART;
    process.env.MINER_THROTTLE = '1.00';

    for (const cols of WIDTHS) {
      const menu = new StartMenu();
      navigateToThrottleRow(menu);
      const lines = menu.buildLines(cols);
      assertFits(lines, cols);
    }
  } finally {
    if (oldSmart === undefined) delete process.env.MINER_SMART;
    else process.env.MINER_SMART = oldSmart;
    if (oldThrottle === undefined) delete process.env.MINER_THROTTLE;
    else process.env.MINER_THROTTLE = oldThrottle;
  }
});

// ---------------------------------------------------------------------------
// Test 6: FULL_BLAST_CAUTION export is a non-empty string mentioning key terms
// ---------------------------------------------------------------------------
test('FULL_BLAST_CAUTION export contains key warning terms', () => {
  assert.ok(typeof FULL_BLAST_CAUTION === 'string' && FULL_BLAST_CAUTION.length > 0);
  assert.ok(FULL_BLAST_CAUTION.includes('100%'), 'should mention 100%');
  assert.ok(FULL_BLAST_CAUTION.toLowerCase().includes('instabilit'), 'should mention instability');
  assert.ok(FULL_BLAST_CAUTION.toLowerCase().includes('considerate'), 'should recommend Considerate');
});
