// src/minerd/menu.test.ts
//
// TEMP CWD, AND WHY THE IMPORT IS DYNAMIC: menu.ts pulls in targets.ts, which
// pulls in envLocal.ts, which resolves ENV_FILE/POOLS_FILE from process.cwd()
// at MODULE LOAD time. Once this suite started exercising add/remove-a-pool
// (real writes), a static top-level import would have bound the developer's
// real .env.local / pools.json — exactly the trap targets.test.ts's own header
// comment documents. So: chdir into a temp dir BEFORE importing menu.js.
// `node --test` runs each test FILE in its own child process, so the chdir
// cannot leak into another suite.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';

const TMP = mkdtempSync(path.join(os.tmpdir(), 'fulgur-menu-'));
process.chdir(TMP);

const ENV_LOCAL = path.join(TMP, '.env.local');
const POOLS = path.join(TMP, 'pools.json');

const { StartMenu } = await import('./menu.js');
const T = await import('./targets.js');

const WIDTHS = [100, 80, 64, 50, 40];

beforeEach(() => {
  for (const f of [ENV_LOCAL, `${ENV_LOCAL}.bak`, POOLS, `${POOLS}.bak`]) if (existsSync(f)) rmSync(f);
  delete process.env.MINER_POOL;
  delete process.env.MINER_THROTTLE;
});

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

/** Reconstruct a single-column (cols < 64) frame's body text in reading order:
 *  strip box-drawing borders per line, then join with a space so a sentence
 *  the renderer word-wrapped across two body rows reassembles correctly. Only
 *  valid for the NARROW fallback (single box, no side-by-side interleaving) —
 *  that's also exactly the layout the narrow-fallback regression tests need. */
function narrowText(menu: InstanceType<typeof StartMenu>, cols = 50): string {
  return menu
    .buildLines(cols)
    .map(visible)
    .map((l) => l.replace(/^[┌└│]+/, '').replace(/[┐┘│]+$/, '').replace(/─+/g, '').trim())
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function pressKey(menu: InstanceType<typeof StartMenu>, name: string): void {
  withMutedStdout(() => menu.handleKey(undefined, { name } as import('node:readline').Key));
}

function pressReturn(menu: InstanceType<typeof StartMenu>): void {
  withMutedStdout(() => menu.handleKey('\r', { name: 'return' }));
}

function pressEscape(menu: InstanceType<typeof StartMenu>): void {
  pressKey(menu, 'escape');
}

function type(menu: InstanceType<typeof StartMenu>, text: string): void {
  withMutedStdout(() => {
    for (const ch of text) menu.handleKey(ch, {} as import('node:readline').Key);
  });
}

/** Move the picker cursor until the highlighted (▶) row matches `matcher`,
 *  pressing `down` up to `max` times. Robust against exact row-index math —
 *  what matters here is what's ON SCREEN, not which index it happens to be. */
function moveToRow(menu: InstanceType<typeof StartMenu>, cols: number, matcher: RegExp, max = 20): void {
  for (let i = 0; i < max; i++) {
    const lines = menu.buildLines(cols).map(visible);
    if (lines.some((l) => l.includes('▶') && matcher.test(l))) return;
    withMutedStdout(() => menu.handleKey(undefined, { name: 'down' }));
  }
  throw new Error(`row not found for ${matcher} within ${max} moves`);
}

function openWhere(menu: InstanceType<typeof StartMenu>): void {
  withMutedStdout(() => {
    for (let i = 0; i < 2; i++) menu.handleKey(undefined, { name: 'down' }); // action-start, wallet -> target
    menu.handleKey('\r', { name: 'return' });
  });
}

function openMode(menu: InstanceType<typeof StartMenu>): void {
  withMutedStdout(() => {
    for (let i = 0; i < 4; i++) menu.handleKey(undefined, { name: 'down' });
    menu.handleKey('\r', { name: 'return' });
  });
}

/** ROWS: action-start, wallet, target, workers, mode, throttle — 5 downs from the
 *  top lands on Throttle; Enter (only valid in Manual mode) opens its picker. */
function openThrottle(menu: InstanceType<typeof StartMenu>): void {
  withMutedStdout(() => {
    for (let i = 0; i < 5; i++) menu.handleKey(undefined, { name: 'down' });
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

test('the mode picker explanation survives the narrow (50-col) fallback', () => {
  const menu = new StartMenu();
  openMode(menu);
  // Manual (index 0) is highlighted by default (modeIndex of an unset MINER_SMART).
  const text = narrowText(menu, 50);
  assert.ok(text.includes('duty cycle by hand'), `Mode explain missing at 50 cols: ${text}`);
});

// -- the "Where to mine" picker -----------------------------------------------

test('an unknown MINER_POOL renders as an unknown row, never relabelled FulgurPool (the old bug)', () => {
  process.env.MINER_POOL = 'https://unknown.example/api';
  const menu = new StartMenu();
  openWhere(menu);
  const lines = menu.buildLines(100).map(visible);

  const fpLine = lines.find((l) => l.includes('FulgurPool'));
  assert.ok(fpLine, 'FulgurPool row must still render');
  assert.match(fpLine!, /\(\s\)/, 'FulgurPool must NOT be marked active');

  const unknownLine = lines.find((l) => l.includes('unknown.example'));
  assert.ok(unknownLine, 'the unrecognised MINER_POOL must get its own row');
  assert.match(unknownLine!, /\(•\)/, 'the unrecognised pool must be the active row');

  // One Enter on the (still-highlighted) row it opened on must not silently
  // relabel it as FulgurPool and erase it — confirm the model agrees too.
  const model = T.buildTargetModel(process.env);
  assert.equal(model.targets[model.activeIndex]!.kind, 'unknown');
});

test('adding a pool: it appears in the list and is selectable; an invalid url shows the reason and persists nothing', () => {
  const menu = new StartMenu();
  openWhere(menu);
  moveToRow(menu, 100, /\+ Add a pool/);
  pressReturn(menu); // -> pool-name step
  type(menu, 'MyPool');
  pressReturn(menu); // -> pool-url step

  type(menu, 'not a url'); // contains a space -> rejected by canonicalisePoolUrl
  pressReturn(menu);
  const afterBad = narrowText(menu, 50);
  assert.ok(/space|not a valid URL/i.test(afterBad), `expected a url-rejection reason, got: ${afterBad}`);
  assert.ok(!existsSync(POOLS), 'an invalid url must persist nothing');

  for (let i = 0; i < 20; i++) pressKey(menu, 'backspace');
  type(menu, 'pool.example.org');
  pressReturn(menu);

  const afterGood = menu.buildLines(100).map(visible).join('\n');
  assert.match(afterGood, /MyPool/, 'the new pool appears in the list');
  assert.ok(existsSync(POOLS));
  const raw = JSON.parse(readFileSync(POOLS, 'utf8')) as { pools: { name: string; url: string }[] };
  assert.equal(raw.pools[0]!.name, 'MyPool');
  assert.equal(raw.pools[0]!.url, 'https://pool.example.org');

  // Selectable: land on it and choose it.
  moveToRow(menu, 100, /MyPool/);
  pressReturn(menu);
  assert.equal(process.env.MINER_POOL, 'https://pool.example.org');
});

test('adding a pool never silently claims success when pools.json changed under us', () => {
  // Simulate another `npm run settings` process racing this one: pools.json
  // goes unreadable in the gap between opening the form (this.model snapshot)
  // and pressing the final Enter. addCustomPool refuses (fileBroken) and
  // returns the model UNCHANGED — the form must notice the entry never
  // actually landed rather than trusting its own pre-write validation.
  const menu = new StartMenu();
  openWhere(menu);
  moveToRow(menu, 100, /\+ Add a pool/);
  pressReturn(menu);
  type(menu, 'MyPool');
  pressReturn(menu);
  type(menu, 'pool.example.org');

  writeFileSync(POOLS, '{ not json'); // corrupt the file right before commit
  pressReturn(menu);

  const text = narrowText(menu, 50);
  assert.ok(text.includes('changed before this could be saved'), `expected a race-safe refusal, got: ${text}`);
  const raw = readFileSync(POOLS, 'utf8');
  assert.equal(raw, '{ not json', 'a refused add must never overwrite the file it could not read');
  // The form must still be open (not silently closed as if it had succeeded).
  assert.ok(narrowText(menu, 50).includes('Add a pool'), 'the form stays open so the user can retry');
});

test('an over-length pool-name paste is flagged (truncated + a body-row error), not silently dropped', () => {
  const menu = new StartMenu();
  openWhere(menu);
  moveToRow(menu, 100, /\+ Add a pool/);
  pressReturn(menu);
  type(menu, 'x'.repeat(T.NAME_MAX));
  type(menu, 'y'); // one char past the cap
  const text = narrowText(menu, 50);
  assert.ok(text.includes(`Longer than ${T.NAME_MAX}`), `expected a truncation notice, got: ${text}`);
});

// -- FIX 5: a truncated pool-name/pool-url edit must never be committed -------
// commitEdit() used to commit ed.buffer regardless of ed.truncated, so a
// pasted-over-cap name/url silently saved its chopped prefix while
// `npm run settings` refuses the SAME input via validateNewPool — the two UIs
// disagreed about what got saved. Enter on a truncated field must now refuse
// to commit and keep showing the existing over-length error.

test('a truncated pool-NAME edit refuses to commit — Enter does not advance to the url step', () => {
  const menu = new StartMenu();
  openWhere(menu);
  moveToRow(menu, 100, /\+ Add a pool/);
  pressReturn(menu);
  type(menu, 'x'.repeat(T.NAME_MAX));
  type(menu, 'y'); // one char past the cap -> truncated
  pressReturn(menu); // must NOT advance to the pool-url step
  const text = narrowText(menu, 50);
  assert.ok(text.includes(`Longer than ${T.NAME_MAX}`), `expected the truncation error to still be shown, got: ${text}`);
  assert.ok(/Enter next/.test(text), `expected to still be on the NAME step (its hint), got: ${text}`);
  assert.ok(!/Enter save/.test(text), 'must not have advanced to the URL step');
});

test('a truncated pool-URL edit does not persist and surfaces the error', () => {
  const menu = new StartMenu();
  openWhere(menu);
  moveToRow(menu, 100, /\+ Add a pool/);
  pressReturn(menu);
  type(menu, 'MyPool');
  pressReturn(menu); // -> pool-url step

  type(menu, 'x'.repeat(T.URL_MAX));
  type(menu, 'y'); // one char past the cap -> truncated
  pressReturn(menu); // must NOT commit the truncated url

  assert.ok(!existsSync(POOLS), 'a truncated url must persist nothing');
  const text = narrowText(menu, 50);
  assert.ok(text.includes(`Longer than ${T.URL_MAX}`), `expected a truncation notice, got: ${text}`);
  assert.ok(/Enter save/.test(text), 'must still be on the URL step (not committed, not bounced back to the list)');
});

test('remove requires a confirm; removing the active pool is refused; the remove key does nothing on a built-in', () => {
  writeFileSync(POOLS, JSON.stringify({ pools: [{ name: 'MyPool', url: 'https://pool.foo.org' }] }, null, 2) + '\n');

  // Built-in rows ignore 'd' entirely.
  const menu = new StartMenu();
  openWhere(menu);
  moveToRow(menu, 50, /FulgurPool/);
  pressKey(menu, 'd');
  assert.ok(!narrowText(menu, 50).includes('cannot be undone'), 'a built-in row must ignore the remove key');

  // A custom row: 'd' opens a confirm; Escape cancels without touching the file.
  moveToRow(menu, 50, /MyPool/);
  pressKey(menu, 'd');
  assert.ok(narrowText(menu, 50).includes('Remove "MyPool"'), 'the confirm is a body row');
  pressEscape(menu);
  assert.ok(!narrowText(menu, 50).includes('cannot be undone'), 'Escape cancels the confirm');
  let raw = JSON.parse(readFileSync(POOLS, 'utf8')) as { pools: unknown[] };
  assert.equal(raw.pools.length, 1, 'a cancelled remove touches nothing');

  // Removing the pool you are CURRENTLY mining on is refused.
  process.env.MINER_POOL = 'https://pool.foo.org';
  const menu2 = new StartMenu();
  openWhere(menu2);
  moveToRow(menu2, 50, /MyPool/);
  pressKey(menu2, 'd');
  pressReturn(menu2); // confirm
  assert.ok(narrowText(menu2, 50).includes(T.REMOVE_ACTIVE_REFUSAL), 'the refusal reason is shown as a body row');
  raw = JSON.parse(readFileSync(POOLS, 'utf8')) as { pools: unknown[] };
  assert.equal(raw.pools.length, 1, 'a refusal must never touch the file');

  // Switch away, then the same remove succeeds.
  delete process.env.MINER_POOL;
  const menu3 = new StartMenu();
  openWhere(menu3);
  moveToRow(menu3, 50, /MyPool/);
  pressKey(menu3, 'd');
  pressReturn(menu3);
  assert.ok(!menu3.buildLines(100).map(visible).join('\n').includes('MyPool'), 'removed from the list');
  raw = JSON.parse(readFileSync(POOLS, 'utf8')) as { pools: unknown[] };
  assert.equal(raw.pools.length, 0, 'confirmed removal deletes the entry');
});

test('the pools.json problems row appears, and its explanation survives the 50-col narrow fallback', () => {
  writeFileSync(POOLS, '{ not json');
  const menu = new StartMenu();
  openWhere(menu);

  const wide = menu.buildLines(100).map(visible);
  assert.ok(wide.some((l) => /pools\.json: 1 problem/.test(l)), 'the issues row appears in the list');

  moveToRow(menu, 50, /pools\.json:/);
  const highlighted = narrowText(menu, 50);
  assert.ok(highlighted.includes('Press Enter'), `issues explanation missing at 50 cols: ${highlighted}`);

  pressReturn(menu); // open the detail view
  const detail = narrowText(menu, 50);
  assert.ok(detail.includes('not valid JSON'), `issue detail missing at 50 cols: ${detail}`);
});

test('where picker fits within common terminal widths — list, add-pool form, and remove confirm', () => {
  writeFileSync(POOLS, JSON.stringify({ pools: [{ name: 'MyPool', url: 'https://pool.foo.org' }] }, null, 2) + '\n');
  const menu = new StartMenu();
  openWhere(menu);
  for (const cols of WIDTHS) assertFits(menu.buildLines(cols), cols);

  moveToRow(menu, 100, /\+ Add a pool/);
  pressReturn(menu);
  type(menu, 'x'.repeat(80)); // exercise the clamped inline field too
  for (const cols of WIDTHS) assertFits(menu.buildLines(cols), cols);
  pressEscape(menu);

  moveToRow(menu, 100, /MyPool/);
  pressKey(menu, 'd');
  for (const cols of WIDTHS) assertFits(menu.buildLines(cols), cols);
});

// -- FIX 4: a pending remove-confirm must stay visible on a short terminal ----
// render() used to clamp `buildLines()`'s output to the top `rows - 1` lines
// unconditionally. whereBody() always appends the remove-confirm (and its
// "Enter/y confirm" hint) as the LAST body rows, so with enough custom pools
// pushing the list past the terminal height, the confirm text — and the
// destructive "Enter deletes" hint — silently scrolled off the bottom while
// the highlighted row stayed on screen: the user could press `d`, see nothing,
// then press Enter expecting to select and delete the pool instead. This
// drives the real render() path (not just buildLines()) with a genuinely
// short terminal to prove the armed confirm is on screen.

test('a pending remove-confirm stays visible on a short terminal — render() scrolls to keep it on screen', () => {
  const pools = Array.from({ length: 40 }, (_, i) => ({ name: `Pool${i}`, url: `https://pool${i}.example.org` }));
  writeFileSync(POOLS, JSON.stringify({ pools }, null, 2) + '\n');

  const menu = new StartMenu();
  openWhere(menu);
  moveToRow(menu, 100, /Pool39/, 60); // the LAST custom pool — far down a long list

  const origWrite = process.stdout.write;
  const origCols = Object.getOwnPropertyDescriptor(process.stdout, 'columns');
  const origRows = Object.getOwnPropertyDescriptor(process.stdout, 'rows');
  let lastWrite = '';
  (process.stdout as unknown as { write: typeof process.stdout.write }).write = ((chunk: unknown) => {
    lastWrite = typeof chunk === 'string' ? chunk : Buffer.from(chunk as Uint8Array).toString('utf8');
    return true;
  }) as typeof process.stdout.write;
  try {
    Object.defineProperty(process.stdout, 'columns', { value: 100, configurable: true });
    Object.defineProperty(process.stdout, 'rows', { value: 10, configurable: true }); // a short terminal
    menu.handleKey(undefined, { name: 'd' } as import('node:readline').Key); // arm the confirm — triggers the real render()
    const written = visible(lastWrite);
    assert.ok(written.includes('Remove "Pool39"'), `expected the armed confirm to be on-screen on a short terminal, got:\n${written}`);
  } finally {
    process.stdout.write = origWrite;
    if (origCols) Object.defineProperty(process.stdout, 'columns', origCols); else delete (process.stdout as { columns?: number }).columns;
    if (origRows) Object.defineProperty(process.stdout, 'rows', origRows); else delete (process.stdout as { rows?: number }).rows;
  }
});

// -- the Throttle picker -------------------------------------------------------
// cycleThrottle() used to take whatever MINER_THROTTLE held, snap it to the
// nearest preset, and PERSIST that on every ←/→ press or Enter — so a user who
// hand-set 0.77 lost it the moment they merely touched the row (same shape as
// 0.2.7's MINER_WORKERS clamp-and-persist blocker). These tests pin: no
// navigation key writes MINER_THROTTLE, only an explicit commit does; a typed
// custom value persists exactly as entered; an invalid one persists nothing;
// and the picker honestly labels a hand-set value "custom" instead of folding
// it into whichever preset happens to be nearest.

test('the throttle regression: wandering the menu and the picker never writes; only an explicit commit does', () => {
  process.env.MINER_THROTTLE = '0.77';
  try {
    const menu = new StartMenu();
    // Wander the main menu first — ←/→ must never touch throttle again, even
    // when the Throttle row happens to be highlighted.
    withMutedStdout(() => {
      for (let i = 0; i < 5; i++) menu.handleKey(undefined, { name: 'down' }); // land on Throttle
      menu.handleKey(undefined, { name: 'left' });
      menu.handleKey(undefined, { name: 'right' });
      menu.handleKey(undefined, { name: 'left' });
      menu.handleKey(undefined, { name: 'up' });
      menu.handleKey(undefined, { name: 'down' });
    });
    assert.ok(!existsSync(ENV_LOCAL), '.env.local must not exist after mere navigation on the main menu');

    // Open the picker and wander INSIDE it too — up/down over every row,
    // including the "0.77  custom" row and "Custom..." — without ever pressing
    // Enter to commit anything.
    openThrottle(menu);
    withMutedStdout(() => {
      for (let i = 0; i < 8; i++) menu.handleKey(undefined, { name: 'down' });
      for (let i = 0; i < 8; i++) menu.handleKey(undefined, { name: 'up' });
    });
    pressEscape(menu); // back to main WITHOUT choosing anything

    assert.ok(!existsSync(ENV_LOCAL), '.env.local must still not exist — opening/navigating the picker wrote nothing');
    assert.equal(process.env.MINER_THROTTLE, '0.77', 'the hand-set value must survive untouched');
  } finally {
    delete process.env.MINER_THROTTLE;
  }
});

test('the throttle picker shows the hand-set value as its own "custom" row, not folded into a preset', () => {
  process.env.MINER_THROTTLE = '0.77';
  try {
    const menu = new StartMenu();
    openThrottle(menu);
    const text = menu.buildLines(100).map(visible).join('\n');
    assert.match(text, /0\.77\s+custom/, `expected a "0.77  custom" row, got:\n${text}`);
    // It must be the ACTIVE (filled) radio, and the picker must open already
    // highlighting it (openThrottle lands the cursor on the active row).
    const customLine = text.split('\n').find((l) => l.includes('0.77') && l.includes('custom'));
    assert.ok(customLine && customLine.includes('▶'), 'the custom row should be the highlighted row on open');
    assert.ok(customLine && customLine.includes('(•)'), 'the custom row must show a filled (active) radio');
  } finally {
    delete process.env.MINER_THROTTLE;
  }
});

test('selecting a preset row persists that preset and returns to the main menu', () => {
  const menu = new StartMenu();
  openThrottle(menu);
  moveToRow(menu, 100, /Quiet/);
  pressReturn(menu);

  assert.equal(process.env.MINER_THROTTLE, '0.25');
  assert.ok(existsSync(ENV_LOCAL));
  assert.match(readFileSync(ENV_LOCAL, 'utf8'), /MINER_THROTTLE=0\.25/);
  const text = menu.buildLines(100).map(visible).join('\n');
  assert.match(text, /Throttle\s+0\.25\s+Quiet/, 'back on the main menu, showing the newly-selected preset');
});

test('Custom... opens an editor pre-filled with the current value; a valid entry persists exactly as typed', () => {
  const menu = new StartMenu();
  openThrottle(menu);
  moveToRow(menu, 100, /Custom\.\.\./);
  pressReturn(menu); // -> editing, pre-filled with the current value (default 0.75)

  for (let i = 0; i < 20; i++) pressKey(menu, 'backspace'); // clear the pre-fill
  type(menu, '0.77');
  pressReturn(menu); // commit

  assert.equal(process.env.MINER_THROTTLE, '0.77', 'persisted exactly as typed — not reformatted to 0.77.00 or similar');
  assert.ok(existsSync(ENV_LOCAL));
  assert.match(readFileSync(ENV_LOCAL, 'utf8'), /MINER_THROTTLE=0\.77/);

  // Back on the main menu, the row now tells the truth: "custom", not "Default".
  const text = menu.buildLines(100).map(visible).join('\n');
  assert.match(text, /Throttle\s+0\.77\s+custom/);
});

test('an out-of-range or non-numeric custom value is refused with a reason, and persists nothing', () => {
  for (const bad of ['2', '0', 'abc']) {
    const menu = new StartMenu();
    openThrottle(menu);
    moveToRow(menu, 100, /Custom\.\.\./);
    pressReturn(menu);
    for (let i = 0; i < 20; i++) pressKey(menu, 'backspace');
    type(menu, bad);
    pressReturn(menu);

    const text = narrowText(menu, 50);
    assert.ok(/0\.05|enter a number/i.test(text), `expected a range/format error for ${JSON.stringify(bad)}, got: ${text}`);
    assert.ok(!existsSync(ENV_LOCAL), `${JSON.stringify(bad)} must persist nothing`);
    assert.equal(process.env.MINER_THROTTLE, undefined, `${JSON.stringify(bad)} must not touch process.env either`);
  }
});

test('the Smart gate still blocks the throttle row: (auto) shown, and Enter does not open the picker', () => {
  const oldSmart = process.env.MINER_SMART;
  try {
    process.env.MINER_SMART = 'max';
    const menu = new StartMenu();
    withMutedStdout(() => {
      for (let i = 0; i < 5; i++) menu.handleKey(undefined, { name: 'down' }); // land on Throttle
      menu.handleKey(undefined, { name: 'left' });
      menu.handleKey(undefined, { name: 'right' });
      menu.handleKey('\r', { name: 'return' }); // must NOT open the picker
    });
    const text = menu.buildLines(100).map(visible).join('\n');
    assert.match(text, /Throttle\s+\(auto\)/);
    assert.ok(!text.includes('Custom...'), 'Enter must not open the throttle picker while Smart mode is active');
    assert.ok(!existsSync(ENV_LOCAL), 'none of this may write .env.local');
  } finally {
    if (oldSmart === undefined) delete process.env.MINER_SMART;
    else process.env.MINER_SMART = oldSmart;
  }
});

test('throttle picker fits within common terminal widths — presets, the custom row, and the editor', () => {
  process.env.MINER_THROTTLE = '0.77';
  try {
    const menu = new StartMenu();
    openThrottle(menu);
    for (const cols of WIDTHS) assertFits(menu.buildLines(cols), cols);

    moveToRow(menu, 100, /Custom\.\.\./);
    pressReturn(menu);
    type(menu, 'x'.repeat(20)); // exercise the clamped inline field too (item A pattern)
    for (const cols of WIDTHS) assertFits(menu.buildLines(cols), cols);
  } finally {
    delete process.env.MINER_THROTTLE;
  }
});
