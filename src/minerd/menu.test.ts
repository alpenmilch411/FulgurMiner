import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StartMenu } from './menu.js';

const WIDTHS = [100, 80, 64, 50, 40];

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

function openMode(menu: StartMenu): void {
  withMutedStdout(() => {
    for (let i = 0; i < 4; i++) menu.handleKey(undefined, { name: 'down' });
    menu.handleKey('\r', { name: 'return' });
  });
}

test('main menu and mode picker fit within common terminal widths', () => {
  const oldSmart = process.env.MINER_SMART;
  try {
    delete process.env.MINER_SMART;
    const main = new StartMenu();
    for (const cols of WIDTHS) assertFits(main.buildLines(cols), cols);

    const mode = new StartMenu();
    openMode(mode);
    for (const cols of WIDTHS) assertFits(mode.buildLines(cols), cols);
  } finally {
    if (oldSmart === undefined) delete process.env.MINER_SMART;
    else process.env.MINER_SMART = oldSmart;
  }
});

test('main menu renders the default Manual mode', () => {
  const oldSmart = process.env.MINER_SMART;
  try {
    delete process.env.MINER_SMART;
    const menu = new StartMenu();
    const text = menu.buildLines(80).map(visible).join('\n');
    assert.match(text, /Mode\s+Manual/);
  } finally {
    if (oldSmart === undefined) delete process.env.MINER_SMART;
    else process.env.MINER_SMART = oldSmart;
  }
});

test('smart mode shows the selected mode and automatic throttle', () => {
  const oldSmart = process.env.MINER_SMART;
  try {
    process.env.MINER_SMART = 'considerate';
    const menu = new StartMenu();
    const text = menu.buildLines(100).map(visible).join('\n');
    assert.match(text, /Mode\s+Smart: Considerate/);
    assert.match(text, /Throttle\s+\(auto\)/);
  } finally {
    if (oldSmart === undefined) delete process.env.MINER_SMART;
    else process.env.MINER_SMART = oldSmart;
  }
});
