// src/minerd/menu.ts
//
// Arrow-key startup menu (TUI mode only). It is the first thing `npm start`
// shows in a real terminal and doubles as the settings screen the dashboard's
// `s` key returns to. Pure ANSI + node:readline keypresses — no dependencies.
//
// CRITICAL ownership rule: the menu and the DashboardReporter must NEVER both
// hold stdin raw-mode / keypress listeners at the same time. The menu owns raw
// mode while it is open and fully tears down (restore terminal, remove
// listeners, leave the alternate screen) before it resolves — only then does
// start.ts construct the dashboard, and vice-versa. start.ts alternates:
//   menu → (Start) → dashboard → (`s`) → menu → …
//
// Persistence goes through the shared envLocal helpers and also updates
// process.env so the next control-loop iteration re-reads the new config.
import * as readline from 'node:readline';
import {
  persist, readExtraPools, type PoolEntry,
} from './envLocal.js';
import { FULGURPOOL_NAME, FULGURPOOL_PAGE, REPO_URL } from './config.js';
import { link, STRIP_OSC8 } from './link.js';
import {
  THROTTLE_PRESETS, throttleLabel, throttleIndex, throttleNum,
  clampWorkers, MAX_WORKERS, DEFAULT_WORKERS, workersDisplay, currentEngine,
  MODE_OPTIONS, currentMode, modeIndex, modeLabel,
} from './selectors.js';
import { ROW_EXPLAIN, modeExplain, whereExplain } from './menuCopy.js';

// --- ANSI helpers (kept local so the menu has no import coupling to tui.ts) --
const ESC = '\x1b[';
const ALT_ON = `${ESC}?1049h`;
const ALT_OFF = `${ESC}?1049l`;
const CURSOR_HIDE = `${ESC}?25l`;
const CURSOR_SHOW = `${ESC}?25h`;
const HOME = `${ESC}H`;
const CLEAR_LINE = `${ESC}K`;
const CLEAR_DOWN = `${ESC}J`;
const RESET = `${ESC}0m`;
const BOLD = `${ESC}1m`;
const DIM = `${ESC}2m`;
const CYAN = `${ESC}36m`;
const GREEN = `${ESC}32m`;
const YELLOW = `${ESC}33m`;
const RED = `${ESC}31m`;
const INVERT = `${ESC}7m`;

const HEX64 = /^[0-9a-f]{64}$/i;

// Two-pane (item A): render the explanation pane only when the terminal is at
// least this wide; below it, fall back to a single column with the explanation
// inline. LABEL_W is the value-row label column, sized for "Check for updates".
const TWO_PANE_MIN = 64;
const LABEL_W = 17;

/** What the user chose to do when the menu resolved. */
export type MenuResult = 'start' | 'quit';

export type RowKind =
  | 'action-start' | 'wallet' | 'target' | 'workers' | 'mode' | 'throttle' | 'engine'
  | 'update-check' | 'help' | 'action-quit';

interface Row {
  kind: RowKind;
  /** Static label shown in the left column. */
  label: string;
  /** Whether this row supports inline editing / cycling. */
  editable: boolean;
}

const ROWS: Row[] = [
  { kind: 'action-start', label: 'Start mining', editable: false },
  { kind: 'wallet', label: 'Wallet', editable: true },
  { kind: 'target', label: 'Where to mine', editable: true },
  { kind: 'workers', label: 'Workers', editable: true },
  { kind: 'mode', label: 'Mode', editable: true },
  { kind: 'throttle', label: 'Throttle', editable: true },
  { kind: 'engine', label: 'Engine', editable: true },
  { kind: 'update-check', label: 'Check for updates', editable: true },
  { kind: 'help', label: 'Help / How it works', editable: false },
  { kind: 'action-quit', label: 'Quit', editable: false },
];

/** A target option the Target row cycles through. */
interface TargetOption {
  /** Display label. */
  label: string;
  /** MINER_POOL value to persist; undefined = unset (follow the default pool). */
  value: string | undefined;
  /** Optional website for the clickable host link (FulgurPool / custom pools). */
  page?: string;
}

/**
 * StartMenu — owns the terminal while open. Construct it, await `run()`, and it
 * resolves to 'start' or 'quit' AFTER it has fully restored the terminal and
 * removed every listener. The caller (start.ts) only then builds the dashboard.
 *
 * Exported as a class (not just a function) so the key handler and renderer can
 * be unit-exercised headlessly without a real TTY.
 */
export class StartMenu {
  /** Which screen is visible. The main menu, a picker, or the full-screen help overlay. */
  private screen: 'main' | 'where' | 'mode' | 'help' = 'main';
  private selected = 0;
  /** Inline wallet edit only (workers/throttle/engine are now selectors, not text). */
  private editing: { kind: 'wallet'; buffer: string; error: string } | null = null;
  /** A transient notice shown under the menu (e.g. "set a wallet first"). */
  private notice = '';
  private targets: TargetOption[] = [];
  private targetIndex = 0;
  private extras: PoolEntry[] = [];

  // --- "Where to mine" picker state ---------------------------------------
  /** Highlighted row in the picker (0..targets.length-1 = destinations, then Back). */
  private whereCursor = 0;

  // --- Mode picker state --------------------------------------------------
  /** Highlighted row in the picker (0..MODE_OPTIONS.length-1 = modes, then Back). */
  private modeCursor = 0;

  private rawModeOn = false;
  private closed = false;
  private resolveRun: ((r: MenuResult) => void) | null = null;

  private readonly onKeypress = (str: string, key: readline.Key): void => { this.handleKey(str, key); };
  private readonly onResize = (): void => this.render();
  private readonly onProcExit = (): void => this.restoreTerminal();

  constructor() {
    this.refreshTargets();
  }

  /** Re-read pools.json + current MINER_POOL and rebuild the Target cycle list. */
  private refreshTargets(): void {
    this.extras = readExtraPools();
    const opts: TargetOption[] = [
      { label: FULGURPOOL_NAME, value: undefined, page: FULGURPOOL_PAGE },
      { label: 'Solo', value: 'solo' },
    ];
    for (const p of this.extras) opts.push({ label: p.name, value: p.url, page: p.page });
    this.targets = opts;
    // Sync targetIndex to the current MINER_POOL so the row shows the live value.
    const raw = (process.env.MINER_POOL ?? '').trim();
    if (raw === '') this.targetIndex = 0;
    else if (/^(solo|off|none)$/i.test(raw)) this.targetIndex = 1;
    else {
      const norm = raw.replace(/\/+$/, '');
      const i = this.targets.findIndex((t) => t.value && t.value.replace(/\/+$/, '') === norm);
      this.targetIndex = i >= 0 ? i : 0;
    }
  }

  // --- lifecycle ----------------------------------------------------------
  /** Open the menu, drive it on keypresses, resolve after full teardown. */
  run(): Promise<MenuResult> {
    return new Promise<MenuResult>((resolve) => {
      this.resolveRun = resolve;
      process.stdout.write(ALT_ON + CURSOR_HIDE + HOME + CLEAR_DOWN);

      if (process.stdin.isTTY) {
        try {
          readline.emitKeypressEvents(process.stdin);
          process.stdin.setRawMode(true);
          this.rawModeOn = true;
          process.stdin.resume();
          process.stdin.on('keypress', this.onKeypress);
        } catch {
          this.rawModeOn = false;
        }
      }
      process.stdout.on('resize', this.onResize);
      process.on('SIGINT', this.handleSigint);
      process.on('SIGTERM', this.handleSigint);
      process.on('exit', this.onProcExit);
      this.render();
    });
  }

  private handleSigint = (): void => {
    // Ctrl+C at the menu = quit the whole program. Restore the terminal right
    // now (idempotent), then resolve as 'quit' so start.ts exits its loop.
    this.finish('quit');
    process.exit(130);
  };

  /** Tear down fully, then resolve run(). Idempotent. */
  private finish(result: MenuResult): void {
    if (this.closed) return;
    this.closed = true;
    process.stdout.removeListener('resize', this.onResize);
    process.removeListener('SIGINT', this.handleSigint);
    process.removeListener('SIGTERM', this.handleSigint);
    process.removeListener('exit', this.onProcExit);
    if (this.rawModeOn) {
      try { process.stdin.removeListener('keypress', this.onKeypress); } catch { /* ignore */ }
      try { process.stdin.setRawMode(false); } catch { /* ignore */ }
      try { process.stdin.pause(); } catch { /* ignore */ }
      this.rawModeOn = false;
    }
    this.restoreTerminal();
    const r = this.resolveRun;
    this.resolveRun = null;
    r?.(result);
  }

  /** Restore cursor + leave the alternate screen. Idempotent; safe on exit. */
  private restoreTerminal(): void {
    try { process.stdout.write(CURSOR_SHOW + ALT_OFF); } catch { /* ignore */ }
  }

  // --- key handling -------------------------------------------------------
  /**
   * Dispatch one keypress. Public so a test can drive the menu without a TTY.
   * Returns true while the menu stays open, false once it has resolved.
   */
  handleKey(str: string | undefined, key: readline.Key | undefined): boolean {
    // A keypress can be queued in the event loop before finish() removes the
    // listener, then dispatched after `closed` is set. The closed flag ensures
    // any such late keypress is safely discarded (no finish() double-call, no
    // edit against a torn-down menu).
    if (this.closed) return false;
    const k = key ?? {};

    // Ctrl+C always quits, from any screen, even mid-edit.
    if (k.ctrl && k.name === 'c') { this.finish('quit'); return false; }

    // Route by screen. Sub-screens consume their own keys and never fall through
    // to the main menu's start/quit handling.
    if (this.screen === 'help') { this.handleHelpKey(k); return !this.closed; }
    if (this.screen === 'where') { this.handleWhereKey(k); return !this.closed; }
    if (this.screen === 'mode') { this.handleModeKey(k); return !this.closed; }

    // --- main screen ---
    if (this.editing) {
      this.handleEditKey(str, k);
      return !this.closed;
    }

    switch (k.name) {
      case 'up':
      case 'k':
        this.move(-1);
        break;
      case 'down':
      case 'j':
        this.move(1);
        break;
      case 'left':
        this.cycleRow(-1);
        break;
      case 'right':
        this.cycleRow(1);
        break;
      case 'return':
      case 'space':
        this.activate();
        break;
      case 'q':
        this.finish('quit');
        return false;
      default:
        // '?' opens the help overlay from the main menu.
        if (str === '?') { this.openHelp(); }
        break;
    }
    return !this.closed;
  }

  /** ←/→ on a selectable row cycles its value (target/workers/throttle/engine). */
  private cycleRow(delta: number): void {
    switch (this.currentRow().kind) {
      // 'target' (Where to mine) is no longer a ←/→ cycle — Enter opens the picker.
      case 'workers': this.cycleWorkers(delta); break;
      case 'throttle':
        if (currentMode(process.env.MINER_SMART) === 'off') this.cycleThrottle(delta);
        break;
      case 'engine': this.cycleEngine(); break;
      case 'update-check': this.cycleUpdateCheck(); break;
      default: break;
    }
  }

  /** Wallet is the only free-text field now; this stays scoped to it. */
  private editCap(_kind: 'wallet'): number {
    return 64; // wallet is exactly 64 hex
  }

  private handleEditKey(str: string | undefined, k: readline.Key): void {
    const ed = this.editing!;
    if (k.name === 'escape') { this.editing = null; this.render(); return; }
    if (k.name === 'return') { this.commitEdit(); return; }
    if (k.name === 'backspace') {
      // Backspace past the start is a harmless no-op: slice(0, -1) on an empty
      // string returns empty, so there's nothing to guard.
      ed.buffer = ed.buffer.slice(0, -1);
      ed.error = '';
      this.render();
      return;
    }
    // Accept printable single chars only (ignore arrows/fn keys etc), and stop
    // accepting once the field's cap is reached (drops the overflow of a paste).
    if (typeof str === 'string' && str.length === 1 && str >= ' ' && !k.ctrl && !k.meta) {
      if (ed.buffer.length >= this.editCap(ed.kind)) return;
      ed.buffer += str;
      ed.error = '';
      this.render();
    }
  }

  private move(delta: number): void {
    const n = ROWS.length;
    this.selected = (this.selected + delta + n) % n;
    this.notice = '';
    this.render();
  }

  private currentRow(): Row {
    return ROWS[this.selected]!;
  }

  /** Enter / Space on the highlighted row. */
  private activate(): void {
    const row = this.currentRow();
    switch (row.kind) {
      case 'action-start': {
        // Don't start without a valid wallet — bounce to the Wallet row instead
        // of letting loadConfig() throw once mining begins.
        const w = (process.env.MINER_PUBKEY ?? '').trim().toLowerCase();
        if (!HEX64.test(w)) {
          this.notice = 'Set a valid wallet address first.';
          this.selected = ROWS.findIndex((r) => r.kind === 'wallet');
          this.editing = { kind: 'wallet', buffer: '', error: '' };
          this.render();
          return;
        }
        this.finish('start');
        return;
      }
      case 'action-quit':
        this.finish('quit');
        return;
      case 'target':
        this.openWhere();
        return;
      case 'mode':
        this.openMode();
        return;
      case 'workers':
        this.cycleWorkers(1);
        return;
      case 'throttle':
        if (currentMode(process.env.MINER_SMART) !== 'off') return;
        this.cycleThrottle(1);
        return;
      case 'engine':
        this.cycleEngine();
        return;
      case 'update-check':
        this.cycleUpdateCheck();
        return;
      case 'wallet': {
        // Preload the current address so a small correction doesn't force a full
        // retype. A 64-hex value is valid input as-is; anything else (unset /
        // invalid) starts blank rather than seeding the buffer with junk.
        const cur = (process.env.MINER_PUBKEY ?? '').trim().toLowerCase();
        this.editing = { kind: 'wallet', buffer: HEX64.test(cur) ? cur : '', error: '' };
        this.render();
        return;
      }
      case 'help':
        this.openHelp();
        return;
    }
  }

  // --- workers / throttle / engine selectors ------------------------------
  private cycleWorkers(delta: number): void {
    // Step over 1…MAX_WORKERS, CLAMPED at both ends (not wrapping) so the count
    // can never exceed the machine — at the cap, → is a no-op; at 1, ← is a no-op.
    // Blank/unset → start from the auto default so the first ←/→ moves off
    // "auto (N)" to an explicit, persisted count.
    const raw = (process.env.MINER_WORKERS ?? '').trim();
    const cur = raw === '' ? DEFAULT_WORKERS : clampWorkers(Number(raw));
    const next = clampWorkers(cur + delta);
    persist({ MINER_WORKERS: String(next) });
    process.env.MINER_WORKERS = String(next);
    this.render();
  }

  private cycleThrottle(delta: number): void {
    if (currentMode(process.env.MINER_SMART) !== 'off') return;
    // Throttle is a short, closed preset cycle (Quiet…Max), so ←/→ WRAPS around
    // the presets (unlike Workers, which clamps at the real core count because
    // exceeding the machine is meaningless). Wrapping a 5-item preset ring is the
    // expected stepper behaviour and keeps every preset reachable in one direction.
    const idx = throttleIndex(process.env.MINER_THROTTLE);
    const n = THROTTLE_PRESETS.length;
    const next = (idx + delta + n) % n;
    const v = throttleNum(THROTTLE_PRESETS[next]!.value);
    persist({ MINER_THROTTLE: v });
    process.env.MINER_THROTTLE = v;
    this.render();
  }

  private cycleEngine(): void {
    const next = currentEngine(process.env.MINER_NATIVE) === 'native' ? 'wasm' : 'native';
    if (next === 'native') {
      persist({ MINER_NATIVE: '1' });
      process.env.MINER_NATIVE = '1';
    } else {
      persist({ MINER_NATIVE: undefined });
      delete process.env.MINER_NATIVE;
    }
    this.render();
  }

  private cycleUpdateCheck(): void {
    if (process.env.FULGUR_NO_UPDATE_CHECK) {
      persist({ FULGUR_NO_UPDATE_CHECK: undefined });
      delete process.env.FULGUR_NO_UPDATE_CHECK;
    } else {
      persist({ FULGUR_NO_UPDATE_CHECK: '1' });
      process.env.FULGUR_NO_UPDATE_CHECK = '1';
    }
    this.render();
  }

  /** Persist the chosen destination (FulgurPool / Solo / a custom pool) by its
   *  index in this.targets. Preserves the raw MINER_POOL tri-state: undefined =
   *  default pool, 'solo' = solo, url = a custom pool. */
  private selectTarget(index: number): void {
    if (index < 0 || index >= this.targets.length) return;
    this.targetIndex = index;
    const opt = this.targets[index]!;
    persist({ MINER_POOL: opt.value });
    if (opt.value === undefined) delete process.env.MINER_POOL;
    else process.env.MINER_POOL = opt.value;
  }

  // ==================== Where-to-mine picker ===============================
  private openWhere(): void {
    this.refreshTargets();
    this.whereCursor = this.targetIndex; // start on the active destination
    this.screen = 'where';
    this.render();
  }

  /** Picker rows: 0..N-1 = each destination, N = "← Back". */
  private whereRowCount(): number {
    return this.targets.length + 1;
  }

  private handleWhereKey(k: readline.Key): void {
    switch (k.name) {
      case 'up': case 'k': this.moveWhere(-1); break;
      case 'down': case 'j': this.moveWhere(1); break;
      case 'escape': case 'q': case 'left': this.backToMain(); break;
      case 'return': case 'space': this.activateWhereRow(); break;
      default: break;
    }
  }

  private moveWhere(delta: number): void {
    const n = this.whereRowCount();
    this.whereCursor = (this.whereCursor + delta + n) % n;
    this.render();
  }

  private activateWhereRow(): void {
    // Last row = Back; any earlier row picks that destination. Either way we
    // return to the main menu (backToMain re-derives targetIndex from MINER_POOL).
    if (this.whereCursor < this.targets.length) this.selectTarget(this.whereCursor);
    this.backToMain();
  }

  // ==================== Mode picker ========================================
  private openMode(): void {
    this.modeCursor = modeIndex(process.env.MINER_SMART);
    this.screen = 'mode';
    this.render();
  }

  /** Picker rows: 0..N-1 = each mode, N = "← Back". */
  private modeRowCount(): number {
    return MODE_OPTIONS.length + 1;
  }

  private handleModeKey(k: readline.Key): void {
    switch (k.name) {
      case 'up': case 'k': this.moveMode(-1); break;
      case 'down': case 'j': this.moveMode(1); break;
      case 'escape': case 'q': case 'left': this.backToMain(); break;
      case 'return': case 'space': this.activateModeRow(); break;
      default: break;
    }
  }

  private moveMode(delta: number): void {
    const n = this.modeRowCount();
    this.modeCursor = (this.modeCursor + delta + n) % n;
    this.render();
  }

  private activateModeRow(): void {
    if (this.modeCursor < MODE_OPTIONS.length) this.selectMode(this.modeCursor);
    this.backToMain();
  }

  private selectMode(index: number): void {
    if (index < 0 || index >= MODE_OPTIONS.length) return;
    const mode = MODE_OPTIONS[index]!.value;
    if (mode === 'off') {
      persist({ MINER_SMART: undefined });
      delete process.env.MINER_SMART;
    } else {
      persist({ MINER_SMART: mode });
      process.env.MINER_SMART = mode;
    }
  }

  /** Validate + persist the in-progress wallet edit, or set an error and re-prompt. */
  private commitEdit(): void {
    const ed = this.editing!;
    const lower = ed.buffer.trim().toLowerCase();
    if (!HEX64.test(lower)) {
      ed.error = 'Address must be exactly 64 hex characters (0-9, a-f).';
      this.render();
      return;
    }
    persist({ MINER_PUBKEY: lower });
    process.env.MINER_PUBKEY = lower;
    this.editing = null;
    this.render();
  }

  private backToMain(): void {
    this.refreshTargets();
    this.screen = 'main';
    this.render();
  }

  // ==================== Help overlay =======================================
  private openHelp(): void {
    this.screen = 'help';
    this.render();
  }

  private handleHelpKey(_k: readline.Key): void {
    // Any key closes the help overlay and returns to the main menu.
    this.screen = 'main';
    this.render();
  }

  // --- current-value formatting ------------------------------------------
  private walletValue(): string {
    const w = (process.env.MINER_PUBKEY ?? '').trim().toLowerCase();
    if (!w) return '(not set)';
    if (!HEX64.test(w)) return '(invalid)';
    return `${w.slice(0, 4)}…${w.slice(-4)}`;
  }

  /**
   * Target value with the page host rendered DIM + as an OSC 8 hyperlink when the
   * selected pool has a `page`. FulgurPool always links to its page; custom pools
   * link to their optional page. Host only — no banners/promo.
   */
  private targetValue(): string {
    const opt = this.targets[this.targetIndex];
    if (!opt) return FULGURPOOL_NAME;
    const page = opt.page;
    if (!page) return opt.label;
    const host = this.hostOf(page);
    return `${opt.label} ${DIM}· ${link(host, page)}${RESET}`;
  }

  private workersValue(): string {
    return workersDisplay(process.env.MINER_WORKERS);
  }

  private throttleValue(): string {
    if (currentMode(process.env.MINER_SMART) !== 'off') return `${DIM}(auto)${RESET}`;
    return throttleLabel(process.env.MINER_THROTTLE);
  }

  private engineValue(): string {
    const e = currentEngine(process.env.MINER_NATIVE);
    return e === 'native' ? 'native  (faster)' : 'wasm  (portable)';
  }

  private updateCheckValue(): string {
    return process.env.FULGUR_NO_UPDATE_CHECK ? 'off' : 'on';
  }

  private rowValue(kind: RowKind): string {
    switch (kind) {
      case 'wallet': return this.walletValue();
      case 'target': return this.targetValue();
      case 'workers': return this.workersValue();
      case 'mode': return modeLabel(process.env.MINER_SMART);
      case 'throttle': return this.throttleValue();
      case 'engine': return this.engineValue();
      case 'update-check': return this.updateCheckValue();
      default: return '';
    }
  }

  /** Host portion of a URL, for the dim link text. */
  private hostOf(url: string): string {
    try { return new URL(url).host; } catch { return url.replace(/^https?:\/\//, '').replace(/\/.*$/, ''); }
  }

  // --- rendering ----------------------------------------------------------
  /** Strip OSC 8 hyperlink wrappers AND CSI/SGR codes (both zero-width). */
  private plain(s: string): string {
    // eslint-disable-next-line no-control-regex
    return s.replace(STRIP_OSC8, '').replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '');
  }

  /** Visible width of a string, ignoring OSC 8 + CSI/SGR sequences. */
  private vlen(s: string): number {
    return this.plain(s).length;
  }

  /** Truncate a colored/linked string to a visible width, appending an ellipsis. */
  private clampVisible(s: string, width: number): string {
    if (this.vlen(s) <= width) return s;
    // Dropping to plain text on truncation also drops any OSC 8 wrapper, so a
    // half-cut hyperlink can never leak an unterminated escape.
    const plain = this.plain(s);
    return plain.slice(0, Math.max(0, width - 1)) + '…';
  }

  /**
   * Build the visible frame as an array of lines, dispatching on the current
   * screen. Public so tests can assert the highlight + values render without a
   * TTY.
   */
  buildLines(cols: number): string[] {
    switch (this.screen) {
      case 'where': return this.buildWhere(cols);
      case 'mode': return this.buildMode(cols);
      case 'help': return this.buildHelp(cols);
      default: return this.buildMain(cols);
    }
  }

  // --- two-pane layout helpers (item A) -----------------------------------
  /** Word-wrap plain text to a visible width. */
  private wrap(text: string, width: number): string[] {
    const w = Math.max(1, width);
    const words = text.split(/\s+/).filter(Boolean);
    const lines: string[] = [];
    let cur = '';
    for (const word of words) {
      if (cur === '') cur = word;
      else if (this.vlen(cur) + 1 + this.vlen(word) <= w) cur += ' ' + word;
      else { lines.push(cur); cur = word; }
    }
    if (cur) lines.push(cur);
    return lines.length ? lines : [''];
  }

  /** Pad a (possibly colored) string to a visible width with trailing spaces. */
  private padToVis(s: string, width: number): string {
    const pad = width - this.vlen(s);
    return pad > 0 ? s + ' '.repeat(pad) : s;
  }

  /** Place two pre-framed boxes side by side, row-aligned, filling the shorter. */
  private buildTwoPane(left: string[], right: string[], leftOuter: number, rightOuter: number, gap: number): string[] {
    const n = Math.max(left.length, right.length);
    const blankL = ' '.repeat(leftOuter);
    const blankR = ' '.repeat(rightOuter);
    const out: string[] = [];
    for (let i = 0; i < n; i++) {
      const l = i < left.length ? this.padToVis(left[i]!, leftOuter) : blankL;
      const r = i < right.length ? this.padToVis(right[i]!, rightOuter) : blankR;
      out.push(`${l}${' '.repeat(gap)}${r}`);
    }
    return out;
  }

  /**
   * Compose a left "list" box and a right "About" explanation box side by side.
   * Pads the explanation to the left box's height so the bottom borders align,
   * and appends the hint line below both. Returns the framed lines, or null when
   * the terminal is too narrow for two panes (caller falls back to one column).
   */
  private twoPane(cols: number, leftTitle: string, leftBodyFn: (inner: number) => string[], explain: string, hint: string): string[] | null {
    if (cols < TWO_PANE_MIN) return null;
    const gap = 1;
    const leftOuter = Math.min(46, Math.max(34, Math.floor((cols - 1) / 2)));
    const rightOuter = (cols - 1) - leftOuter - gap;
    if (rightOuter < 26) return null;
    const leftBody = leftBodyFn(leftOuter - 2);
    const right = this.wrap(explain, rightOuter - 3).map((ln) => `${DIM}${ln}${RESET}`);
    while (right.length < leftBody.length) right.push('');
    const leftBox = this.frame(leftOuter - 2, leftTitle, leftBody, '');
    const rightBox = this.frame(rightOuter - 2, 'About', right, '');
    const paned = this.buildTwoPane(leftBox, rightBox, leftOuter, rightOuter, gap);
    paned.push(`  ${hint}`);
    return paned;
  }

  // --- a framed box around body lines, with a titled top bar --------------
  /** Frame `body` lines inside a box of interior width `inner` with `title`. */
  private frame(inner: number, title: string, body: string[], hint: string): string[] {
    const lines: string[] = [];
    const t = ` ${title} `;
    const dashes = inner - t.length - 1; // one leading ─ before the title
    lines.push(`${DIM}┌─${RESET}${BOLD}${CYAN}${t}${RESET}${DIM}${'─'.repeat(Math.max(0, dashes))}┐${RESET}`);
    for (const b of body) {
      const clamped = this.clampVisible(b, inner - 1);
      const pad = Math.max(0, inner - 1 - this.vlen(clamped));
      lines.push(`${DIM}│${RESET} ${clamped}${' '.repeat(pad)}${DIM}│${RESET}`);
    }
    if (hint) {
      const hi = this.clampVisible(hint, inner - 1);
      const hpad = Math.max(0, inner - 1 - this.vlen(hi));
      lines.push(`${DIM}│${RESET} ${hi}${' '.repeat(hpad)}${DIM}│${RESET}`);
    }
    lines.push(`${DIM}└${'─'.repeat(inner)}┘${RESET}`);
    return lines;
  }

  private mainWidth(cols: number): number {
    // Prefer a 34–60 col frame, but never demand more than the terminal has: on a
    // very narrow window (down to the 20-col hard floor in render()) the frame
    // shrinks to fit instead of overflowing. The 20 floor matches that minimum so
    // the box can never be wider than cols-1.
    return Math.max(20, Math.min(cols - 1, 60));
  }

  /** The left-column body rows (label + inline value). `inner` is the interior
   *  width, used only to size the inline wallet edit cell. Shared by the two-pane
   *  and narrow single-column main-menu layouts. */
  private buildMainRows(inner: number): string[] {
    const body: string[] = [];
    for (let i = 0; i < ROWS.length; i++) {
      const row = ROWS[i]!;
      const isSel = i === this.selected;
      const marker = isSel ? `${CYAN}▶${RESET} ` : '  ';
      let content: string;

      if (row.kind === 'action-start') {
        const txt = isSel ? `${BOLD}${GREEN}Start mining${RESET}` : `${GREEN}Start mining${RESET}`;
        content = `${marker}${txt}`;
      } else if (row.kind === 'action-quit') {
        const txt = isSel ? `${BOLD}Quit${RESET}` : `${DIM}Quit${RESET}`;
        content = `${marker}${txt}`;
      } else if (row.kind === 'help') {
        const txt = isSel ? `${BOLD}${row.label}${RESET}` : `${row.label}`;
        content = `${marker}${txt}`;
      } else {
        const labelCol = row.label.padEnd(LABEL_W);
        let body2: string;
        if (this.editing && isSel && row.kind === 'wallet') {
          // Fit the inverted edit cell inside the frame: budget = inner − 1 visible
          // (frame's per-line cap) − marker(2) − label(LABEL_W) − the two padding
          // spaces. Show the TAIL so the typing end (cursor) stays visible on a
          // narrow window; clampVisible would otherwise strip the highlight.
          const budget = Math.max(1, inner - 1 - 2 - labelCol.length - 2);
          const buf = this.editing.buffer;
          const shown = buf.length > budget ? buf.slice(buf.length - budget) : (buf || ' ');
          body2 = `${DIM}${labelCol}${RESET}${INVERT} ${shown} ${RESET}`;
        } else {
          const val = this.rowValue(row.kind);
          const valStyled = isSel ? `${BOLD}${val}${RESET}` : `${val}`;
          body2 = `${DIM}${labelCol}${RESET}${valStyled}`;
        }
        content = `${marker}${body2}`;
      }
      body.push(content);
    }
    return body;
  }

  private mainHint(): string {
    if (this.editing && this.editing.error) return `${RED}${this.editing.error}${RESET}`;
    if (this.editing) return `${DIM}type · Enter save · Esc cancel${RESET}`;
    if (this.notice) return `${RED}${this.notice}${RESET}`;
    return `${DIM}↑/↓ move · ←/→ change · Enter select · ? help · q quit${RESET}`;
  }

  /** Main menu — two-pane (list + About) when wide, single column with the
   *  explanation inline when narrow. */
  private buildMain(cols: number): string[] {
    const explain = ROW_EXPLAIN[this.currentRow().kind] ?? '';
    const paned = this.twoPane(cols, 'FulgurMiner', (inner) => this.buildMainRows(inner), explain, this.mainHint());
    if (paned) return paned;
    const inner = this.mainWidth(cols) - 2;
    const body = this.buildMainRows(inner);
    body.push('');
    for (const ln of this.wrap(explain, inner - 1)) body.push(`${DIM}${ln}${RESET}`);
    return this.frame(inner, 'FulgurMiner', body, this.mainHint());
  }

  /** "Where to mine" picker — radio list + per-destination explanation. */
  private buildWhere(cols: number): string[] {
    const rows = this.buildWhereRows();
    const sel = this.targets[this.whereCursor];
    const explain = sel
      ? whereExplain({ isDefault: this.whereCursor === 0, isSolo: sel.value === 'solo', name: sel.label })
      : 'Go back to the menu without changing where you mine.';
    const hint = `${DIM}↑/↓ move · Enter choose · Esc back${RESET}`;
    const paned = this.twoPane(cols, 'Where to mine', () => rows, explain, hint);
    if (paned) return paned;
    const inner = this.mainWidth(cols) - 2;
    return this.frame(inner, 'Where to mine', rows, hint);
  }

  /** Picker radio-list rows: each destination (• marks the active one) + a Back row. */
  private buildWhereRows(): string[] {
    const body: string[] = [];
    for (let i = 0; i < this.targets.length; i++) {
      const opt = this.targets[i]!;
      const isSel = i === this.whereCursor;
      const isActive = i === this.targetIndex;
      const marker = isSel ? `${CYAN}▶${RESET} ` : '  ';
      const radio = isActive ? `${GREEN}(•)${RESET}` : `${DIM}( )${RESET}`;
      const name = isSel ? `${BOLD}${opt.label}${RESET}` : opt.label;
      const host = opt.page ? ` ${DIM}· ${link(this.hostOf(opt.page), opt.page)}${RESET}` : '';
      body.push(`${marker}${radio} ${name}${host}`);
    }
    const backSel = this.whereCursor === this.targets.length;
    const marker = backSel ? `${CYAN}▶${RESET} ` : '  ';
    const back = backSel ? `${BOLD}← Back${RESET}` : `${DIM}← Back${RESET}`;
    body.push(`${marker}${back}`);
    return body;
  }

  /** Mode picker — radio list + per-mode explanation. */
  private buildMode(cols: number): string[] {
    const rows = this.buildModeRows();
    const sel = MODE_OPTIONS[this.modeCursor];
    const explain = sel
      ? modeExplain(sel.value)
      : 'Go back without changing the mode.';
    const hint = `${DIM}↑/↓ move · Enter choose · Esc back${RESET}`;
    const paned = this.twoPane(cols, 'Mode', () => rows, explain, hint);
    if (paned) return paned;
    const inner = this.mainWidth(cols) - 2;
    return this.frame(inner, 'Mode', rows, hint);
  }

  /** Picker radio-list rows: each mode (• marks the active one) + a Back row. */
  private buildModeRows(): string[] {
    const body: string[] = [];
    const active = modeIndex(process.env.MINER_SMART);
    for (let i = 0; i < MODE_OPTIONS.length; i++) {
      const opt = MODE_OPTIONS[i]!;
      const isSel = i === this.modeCursor;
      const isActive = i === active;
      const marker = isSel ? `${CYAN}▶${RESET} ` : '  ';
      const radio = isActive ? `${GREEN}(•)${RESET}` : `${DIM}( )${RESET}`;
      const name = isSel ? `${BOLD}${opt.label}${RESET}` : opt.label;
      body.push(`${marker}${radio} ${name}`);
    }
    const backSel = this.modeCursor === MODE_OPTIONS.length;
    const marker = backSel ? `${CYAN}▶${RESET} ` : '  ';
    const back = backSel ? `${BOLD}← Back${RESET}` : `${DIM}← Back${RESET}`;
    body.push(`${marker}${back}`);
    return body;
  }

  /** Full-screen help overlay. */
  private buildHelp(cols: number): string[] {
    const inner = Math.max(40, Math.min(cols - 1, 76)) - 2;
    const B = (s: string): string => `${BOLD}${s}${RESET}`;
    const D = (s: string): string => `${DIM}${s}${RESET}`;
    const body: string[] = [
      B('What it does'),
      '  Mines BrowserCoin from your terminal. Rewards are paid to your',
      `  wallet ${D('address')} — public, no password or private key needed.`,
      '',
      B('Syncing / verifying'),
      '  First run downloads + verifies the chain so you build on the',
      `  right one. ${D('Restarts are fast')} — the chain is saved locally`,
      `  ${D('(~/.fulgurminer/)')} and only the new blocks are fetched.`,
      '',
      B('Dashboard'),
      `  ${D('●')} status dot · SYNC bar · HASHRATE (now/avg/peak + spark)`,
      '  · SESSION · EVENTS.',
      '',
      B('Settings'),
      '  Wallet · Where to mine · Workers · Mode',
      '  · Throttle · Engine · Check for updates.',
      `  ${D('Mode')}: Manual sets the duty cycle by hand; Smart`,
      '  auto-tunes it (Considerate keeps the CPU free',
      '  for your work). More workers / higher throttle',
      `  = faster but hotter. Engine: ${D('native')} (Rust) is faster.`,
      `  During mining, press ${D('u')} to show the update command.`,
      '',
      B('Source & updates'),
      `  ${REPO_URL}`,
      `  Runs from source — update with ${D('git pull && npm install')}.`,
      '',
      B('Where to mine'),
      `  Default is ${B('FulgurPool')} ${D('(the project’s own pool)')}. Pick Solo`,
      '  or a pool under Where to mine.',
      '',
      B('Keys'),
      `  ${D('↑/↓')} move · ${D('Enter')} select · ${D('←/→')} change a value`,
      `  In the dashboard: ${D('q')} quit · ${D('s')} settings · ${D('u')} update · ${D('?')} help`,
    ];
    return this.frame(inner, 'How FulgurMiner works', body, `${DIM}press any key to close${RESET}`);
  }

  private render(): void {
    if (this.closed) return;
    const cols = Math.max(20, process.stdout.columns || 80);
    const rows = Math.max(8, process.stdout.rows || 24);
    const lines = this.buildLines(cols);

    let out = HOME;
    const max = Math.min(lines.length, rows - 1);
    for (let i = 0; i < max; i++) {
      // Hard safety net: even though the frame is sized to the terminal, a very
      // narrow window (below the min frame width) could still exceed `cols`.
      // Truncate each line to the visible width so we can never overflow.
      out += this.clampVisible(lines[i] ?? '', cols) + CLEAR_LINE;
      if (i < max - 1) out += '\n';
    }
    out += CLEAR_DOWN;
    try { process.stdout.write(out); } catch { /* ignore */ }
  }
}

/**
 * Convenience wrapper used by start.ts: construct, run, resolve. Returns after
 * the menu has fully restored the terminal so the caller can safely take over
 * stdin (build the dashboard) on the next line.
 */
export async function runStartMenu(): Promise<MenuResult> {
  const menu = new StartMenu();
  return menu.run();
}
