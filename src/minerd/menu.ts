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
// Persistence goes through the shared envLocal/targets helpers and also
// updates process.env so the next control-loop iteration re-reads the new
// config.
//
// "Where to mine" is now a full picker: it renders targets.ts's shared
// TargetModel (never re-sorted here), can add and remove custom pools inline,
// and surfaces pools.json parse problems as a picker row — that row is the
// ONLY way a user learns their file was rejected, now that envLocal.ts's
// console.warn (which the alt-screen redraw wiped before anyone could read
// it) is gone.
//
// "Throttle" is a picker too, not a ←/→ cycle: cycleThrottle() used to take
// whatever MINER_THROTTLE held, snap it to the nearest preset, and PERSIST that
// — so a user who hand-set 0.77 in .env.local lost it the moment they merely
// touched the row (same shape as 0.2.7's MINER_WORKERS clamp-and-persist
// blocker). No navigation key writes MINER_THROTTLE now; only an explicit
// Enter on a picker row, or a committed Custom... entry, does.
import * as readline from 'node:readline';
import { persist } from './envLocal.js';
import { REPO_URL } from './config.js';
import { link, STRIP_OSC8 } from './link.js';
import {
  THROTTLE_PRESETS, throttleLabel, throttleAmount, throttleNum, parseThrottle,
  clampWorkers, MAX_WORKERS, DEFAULT_WORKERS, workersDisplay, currentEngine, engineRowValue,
  MODE_OPTIONS, currentMode, modeIndex, modeLabel,
  type ThrottlePreset,
} from './selectors.js';
import {
  ROW_EXPLAIN, modeExplain, whereExplain, NATIVE_NEEDS_RUST, FULL_BLAST_CAUTION, SMART_THROTTLE_EXPLAIN,
  ADD_POOL_EXPLAIN, POOL_ISSUES_EXPLAIN, throttlePresetExplain, throttleCustomExplain, THROTTLE_CUSTOM_EDIT_EXPLAIN,
} from './menuCopy.js';
import { nativeEngineAvailable } from './engine.js';
import {
  buildTargetModel, persistTarget, validateNewPool, addCustomPool, removeCustomPool,
  NAME_MAX, URL_MAX,
  type Target, type TargetModel,
} from './targets.js';

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

/**
 * The wallet row's inline text edit, the "+ Add a pool..." form's two steps,
 * and the Throttle picker's "Custom..." editor share one buffer mechanism.
 * `name` carries the pool name across the pool-name → pool-url step. Every
 * switch over `kind` below (editCap, commitEdit) is written so each new kind
 * is one additive case, never a restructure.
 */
type Editing = {
  kind: 'wallet' | 'pool-name' | 'pool-url' | 'throttle';
  buffer: string;
  error: string;
  truncated: boolean;
  name?: string;
};

/** One row of the "Where to mine" picker, beyond the model's own destinations. */
type WhereRow =
  | { kind: 'target'; target: Target }
  | { kind: 'add' }
  | { kind: 'issues' }
  | { kind: 'back' };

/** One row of the Throttle picker: a preset, the current hand-set value (only
 *  when it matches no preset), the "Custom..." row that opens the editor, or Back. */
type ThrottleRow =
  | { kind: 'preset'; preset: ThrottlePreset }
  | { kind: 'custom'; value: number }
  | { kind: 'edit' }
  | { kind: 'back' };

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
  private screen: 'main' | 'where' | 'mode' | 'throttle' | 'help' = 'main';
  private selected = 0;
  /** The one inline text-edit buffer, shared by the wallet row and the add-a-pool form. */
  private editing: Editing | null = null;
  /** A transient notice shown under the menu (e.g. "set a wallet first"). */
  private notice = '';
  /** The shared "where to mine" model (targets.ts). Never re-sorted here. */
  private model!: TargetModel;

  // --- "Where to mine" picker state ---------------------------------------
  /** Highlighted row in the picker (0..targets.length-1 = destinations, then + Add, [issues], Back). */
  private whereCursor = 0;
  /** Set while a highlighted custom pool's removal awaits an explicit confirm. */
  private removeConfirm: Target | null = null;
  /** The reason the last remove attempt was refused (or ''). Always a BODY row, never the hint. */
  private removeError = '';
  /** True while the "! pools.json: N problem(s)" row is showing its detail view. */
  private whereIssuesOpen = false;

  // --- Mode picker state --------------------------------------------------
  /** Highlighted row in the picker (0..MODE_OPTIONS.length-1 = modes, then Back). */
  private modeCursor = 0;

  // --- Throttle picker state -----------------------------------------------
  /** Highlighted row in the picker (presets, then — only when MINER_THROTTLE
   *  holds a non-preset value — that value's own row, then Custom..., then Back). */
  private throttleCursor = 0;

  private rawModeOn = false;
  private closed = false;
  private resolveRun: ((r: MenuResult) => void) | null = null;
  // Whether the native engine can actually run here (a built binary, or cargo to
  // build it on first start). Computed ONCE — nativeEngineAvailable() spawns
  // `cargo --version`, so it must not be called per render. Drives the greyed
  // "native (needs Rust)" value + the red "install Rust" About-pane notice.
  private readonly nativeAvailable = nativeEngineAvailable();

  private readonly onKeypress = (str: string, key: readline.Key): void => { this.handleKey(str, key); };
  private readonly onResize = (): void => this.render();
  private readonly onProcExit = (): void => this.restoreTerminal();

  constructor() {
    this.refreshTargets();
  }

  /** Re-read pools.json + current MINER_POOL and rebuild the shared target model. */
  private refreshTargets(): void {
    this.model = buildTargetModel();
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

    // An inline edit (wallet, or the add-a-pool form) consumes its own keys
    // regardless of which screen it is open on — the wallet edit lives on
    // 'main', the pool form on 'where'.
    if (this.editing) {
      this.handleEditKey(str, k);
      return !this.closed;
    }

    // Route by screen. Sub-screens consume their own keys and never fall through
    // to the main menu's start/quit handling.
    if (this.screen === 'help') { this.handleHelpKey(k); return !this.closed; }
    if (this.screen === 'where') { this.handleWhereKey(k); return !this.closed; }
    if (this.screen === 'mode') { this.handleModeKey(k); return !this.closed; }
    if (this.screen === 'throttle') { this.handleThrottleKey(k); return !this.closed; }

    // --- main screen ---
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

  /** ←/→ on a selectable row cycles its value (workers/engine/update-check).
   *  'target' (Where to mine), 'mode', and 'throttle' are NOT a ←/→ cycle —
   *  Enter opens their picker. Throttle used to be a ←/→ cycle over the presets
   *  that SNAPPED the current value and PERSISTED the snap on every press — see
   *  the file header for why that was a blocker-class bug and why it is gone. */
  private cycleRow(delta: number): void {
    switch (this.currentRow().kind) {
      case 'workers': this.cycleWorkers(delta); break;
      case 'engine': this.cycleEngine(); break;
      case 'update-check': this.cycleUpdateCheck(); break;
      default: break;
    }
  }

  /** The character cap for the field currently being edited. Caps for the pool
   *  form come from targets.ts, so the TUI and `npm run settings` never accept
   *  different lengths. The throttle cap is generous (well past any valid 0.05–1
   *  value) — parseThrottle, not truncation, is what rejects a bad number. */
  private editCap(kind: Editing['kind']): number {
    switch (kind) {
      case 'wallet': return 64; // wallet is exactly 64 hex
      case 'pool-name': return NAME_MAX;
      case 'pool-url': return URL_MAX;
      case 'throttle': return 16;
    }
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
      ed.truncated = false;
      this.render();
      return;
    }
    // Accept printable single chars only (ignore arrows/fn keys etc). Once the
    // field's cap is reached, an over-length paste is NOT silently dropped: flag
    // it and show why, rather than swallowing the excess without a trace.
    if (typeof str === 'string' && str.length === 1 && str >= ' ' && !k.ctrl && !k.meta) {
      const cap = this.editCap(ed.kind);
      if (ed.buffer.length >= cap) {
        ed.truncated = true;
        ed.error = `Longer than ${cap} characters — the rest was dropped.`;
        this.render();
        return;
      }
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
          this.editing = { kind: 'wallet', buffer: '', error: '', truncated: false };
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
        this.openThrottle();
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
        this.editing = { kind: 'wallet', buffer: HEX64.test(cur) ? cur : '', error: '', truncated: false };
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

  /** Persist the chosen destination through targets.ts's ONE writer. */
  private selectTarget(target: Target): void {
    persistTarget(target);
  }

  // ==================== Where-to-mine picker ===============================
  private openWhere(): void {
    this.refreshTargets();
    this.whereCursor = this.model.activeIndex; // start on the active destination
    this.editing = null;
    this.removeConfirm = null;
    this.removeError = '';
    this.whereIssuesOpen = false;
    this.screen = 'where';
    this.render();
  }

  /** Picker rows: the model's destinations, then "+ Add a pool...", then (only
   *  when pools.json has problems) the issues row, then "← Back". */
  private whereRows(): WhereRow[] {
    const rows: WhereRow[] = this.model.targets.map((target): WhereRow => ({ kind: 'target', target }));
    rows.push({ kind: 'add' });
    if (this.model.issues.length > 0) rows.push({ kind: 'issues' });
    rows.push({ kind: 'back' });
    return rows;
  }

  private whereRowCount(): number {
    return this.whereRows().length;
  }

  private handleWhereKey(k: readline.Key): void {
    if (this.removeConfirm) { this.handleRemoveConfirmKey(k); return; }
    if (this.whereIssuesOpen) { this.handleIssuesKey(k); return; }
    switch (k.name) {
      case 'up': case 'k': this.moveWhere(-1); break;
      case 'down': case 'j': this.moveWhere(1); break;
      case 'escape': case 'q': case 'left': this.backToMain(); break;
      case 'return': case 'space': this.activateWhereRow(); break;
      case 'd': case 'delete': this.requestRemove(); break;
      default: break;
    }
  }

  private moveWhere(delta: number): void {
    const n = this.whereRowCount();
    this.whereCursor = (this.whereCursor + delta + n) % n;
    this.removeError = '';
    this.render();
  }

  private activateWhereRow(): void {
    const rows = this.whereRows();
    const row = rows[this.whereCursor];
    if (!row) { this.backToMain(); return; }
    if (row.kind === 'target') {
      this.selectTarget(row.target);
      this.backToMain();
      return;
    }
    if (row.kind === 'add') {
      this.removeError = '';
      this.editing = { kind: 'pool-name', buffer: '', error: '', truncated: false };
      this.render();
      return;
    }
    if (row.kind === 'issues') {
      this.whereIssuesOpen = true;
      this.render();
      return;
    }
    this.backToMain(); // 'back'
  }

  /** `d` / Delete on a highlighted CUSTOM row asks for an explicit confirm.
   *  Built-in / solo / unknown rows ignore the key entirely. */
  private requestRemove(): void {
    const rows = this.whereRows();
    const row = rows[this.whereCursor];
    if (!row || row.kind !== 'target' || !row.target.removable) return;
    this.removeConfirm = row.target;
    this.removeError = '';
    this.render();
  }

  private handleRemoveConfirmKey(k: readline.Key): void {
    if (k.name === 'return' || k.name === 'y') { this.commitRemove(); return; }
    if (k.name === 'escape' || k.name === 'n' || k.name === 'left' || k.name === 'q') {
      this.removeConfirm = null;
      this.render();
    }
  }

  private commitRemove(): void {
    const t = this.removeConfirm;
    this.removeConfirm = null;
    if (!t) { this.render(); return; }
    const r = removeCustomPool(t);
    if (r.ok) {
      this.model = r.model;
      this.removeError = '';
      const max = Math.max(0, this.whereRowCount() - 1);
      if (this.whereCursor > max) this.whereCursor = max;
    } else {
      // Refuses the pool you are currently mining on, or a non-removable row —
      // surfaced as a body row (see whereBody), never the hint line.
      this.removeError = r.reason;
    }
    this.render();
  }

  private handleIssuesKey(_k: readline.Key): void {
    // Any key closes the detail view and returns to the picker list.
    this.whereIssuesOpen = false;
    this.render();
  }

  // --- the add-a-pool form: step 1 (name) → step 2 (url) -> commit ---------
  private commitPoolNameEdit(ed: Editing): void {
    // A buffer at the cap that was truncated (the rest was dropped) must
    // never be committed as-is — Enter would silently carry a chopped name
    // into step 2. handleEditKey already set ed.error to the "Longer than N
    // characters" notice, which stays on screen; just refuse to advance.
    if (ed.truncated) { this.render(); return; }
    const name = ed.buffer.trim();
    if (name === '') {
      ed.error = 'Give the pool a name.';
      this.render();
      return;
    }
    this.editing = { kind: 'pool-url', buffer: '', error: '', truncated: false, name };
    this.render();
  }

  private commitPoolUrlEdit(ed: Editing): void {
    // Same guard as commitPoolNameEdit: a truncated url must never be saved —
    // `npm run settings` rejects the same over-length input via
    // validateNewPool, and committing here anyway would silently persist a
    // chopped endpoint the two UIs then disagree about.
    if (ed.truncated) { this.render(); return; }
    const name = ed.name ?? '';
    const v = validateNewPool(name, ed.buffer, this.model.targets);
    if (!v.ok) {
      if (v.field === 'name') {
        // The name looked fine at step 1 (non-blank) but validateNewPool caught
        // something step 1 doesn't check (reserved, duplicate, non-ASCII) — step
        // back so the user can fix it without retyping the URL.
        this.editing = { kind: 'pool-name', buffer: name, error: v.reason, truncated: false };
      } else {
        ed.error = v.reason;
      }
      this.render();
      return;
    }
    // addCustomPool re-validates against a FRESH read of pools.json (targets.ts's
    // own doc comment: "the picker's model may be minutes old"), so a write can
    // still be refused here even though `v.ok` above passed against our snapshot
    // — e.g. another `npm run settings` process added the same name/url, or the
    // file went unreadable, in the gap between opening this picker and now. The
    // return shape doesn't distinguish "wrote it" from "refused, unchanged", so
    // don't just trust it: confirm the entry actually landed before declaring
    // success, the same TOCTOU care removeCustomPool already takes.
    const updated = addCustomPool(v.entry.name, v.entry.url);
    this.model = updated;
    const idx = updated.targets.findIndex((t) => t.kind === 'custom' && t.value === v.entry.url);
    if (idx < 0) {
      ed.error = 'pools.json changed before this could be saved — try again.';
      this.render();
      return;
    }
    this.editing = null;
    // Land the cursor on the pool that was just added.
    this.whereCursor = idx;
    this.render();
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

  // ==================== Throttle picker =====================================
  private openThrottle(): void {
    const rows = this.throttleRows();
    const value = throttleAmount(process.env.MINER_THROTTLE);
    const idx = rows.findIndex((r) =>
      (r.kind === 'preset' && r.preset.value === value) || (r.kind === 'custom' && r.value === value));
    this.throttleCursor = idx >= 0 ? idx : 0;
    this.editing = null;
    this.screen = 'throttle';
    this.render();
  }

  /** Picker rows: each preset, then — ONLY when the current MINER_THROTTLE is a
   *  hand-set value that matches none of them — that value gets its own row (the
   *  same "don't silently fold an unrecognised value into a row it isn't" pattern
   *  targets.ts's 'unknown' row uses for MINER_POOL) — then "Custom...", then Back. */
  private throttleRows(): ThrottleRow[] {
    const rows: ThrottleRow[] = THROTTLE_PRESETS.map((preset): ThrottleRow => ({ kind: 'preset', preset }));
    const value = throttleAmount(process.env.MINER_THROTTLE);
    if (!THROTTLE_PRESETS.some((p) => p.value === value)) rows.push({ kind: 'custom', value });
    rows.push({ kind: 'edit' });
    rows.push({ kind: 'back' });
    return rows;
  }

  private throttleRowCount(): number {
    return this.throttleRows().length;
  }

  private handleThrottleKey(k: readline.Key): void {
    switch (k.name) {
      case 'up': case 'k': this.moveThrottle(-1); break;
      case 'down': case 'j': this.moveThrottle(1); break;
      case 'escape': case 'q': case 'left': this.backToMain(); break;
      case 'return': case 'space': this.activateThrottleRow(); break;
      default: break;
    }
  }

  private moveThrottle(delta: number): void {
    const n = this.throttleRowCount();
    this.throttleCursor = (this.throttleCursor + delta + n) % n;
    this.render();
  }

  private activateThrottleRow(): void {
    const rows = this.throttleRows();
    const row = rows[this.throttleCursor];
    if (!row) { this.backToMain(); return; }
    if (row.kind === 'preset') {
      this.selectThrottle(row.preset.value);
      this.backToMain();
      return;
    }
    if (row.kind === 'custom') {
      // Already the active value — re-confirming it is an explicit commit like any
      // other row (mirrors the "Where to mine" picker re-selecting the active pool).
      this.selectThrottle(row.value);
      this.backToMain();
      return;
    }
    if (row.kind === 'edit') {
      const cur = throttleAmount(process.env.MINER_THROTTLE);
      this.editing = { kind: 'throttle', buffer: String(cur), error: '', truncated: false };
      this.render();
      return;
    }
    this.backToMain(); // 'back'
  }

  /** The ONLY MINER_THROTTLE writer. Only ever reached from an explicit commit —
   *  Enter on a picker row, or a validated Custom... entry — never from ←/→ or
   *  merely opening/navigating the picker (that clamp-and-persist shape is the
   *  bug this picker replaces; see the file header). */
  private selectThrottle(value: number): void {
    const v = String(value);
    persist({ MINER_THROTTLE: v });
    process.env.MINER_THROTTLE = v;
  }

  /** Dispatch the in-progress edit's commit (Enter) by kind. */
  private commitEdit(): void {
    const ed = this.editing;
    if (!ed) return;
    switch (ed.kind) {
      case 'wallet': this.commitWalletEdit(ed); return;
      case 'pool-name': this.commitPoolNameEdit(ed); return;
      case 'pool-url': this.commitPoolUrlEdit(ed); return;
      case 'throttle': this.commitThrottleEdit(ed); return;
    }
  }

  /** Validate + persist the in-progress Custom... throttle edit through the ONE
   *  shared validator (selectors.ts's parseThrottle) — an out-of-range or
   *  non-numeric entry is refused with a reason and persists nothing, exactly
   *  like the wallet and pool-url edits refuse bad input. */
  private commitThrottleEdit(ed: Editing): void {
    const r = parseThrottle(ed.buffer);
    if (!r.ok) {
      ed.error = r.reason;
      this.render();
      return;
    }
    this.selectThrottle(r.value);
    this.editing = null;
    this.backToMain();
  }

  /** Validate + persist the in-progress wallet edit, or set an error and re-prompt. */
  private commitWalletEdit(ed: Editing): void {
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
    this.editing = null;
    this.removeConfirm = null;
    this.removeError = '';
    this.whereIssuesOpen = false;
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
   * active destination has a `page`. Host only — no banners/promo. activeIndex is
   * never -1 (targets.ts's invariant), so the `!opt` branch is only a defensive
   * fallback against a genuinely empty model.
   */
  private targetValue(): string {
    const opt = this.model.targets[this.model.activeIndex];
    if (!opt) return '';
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
    const val = engineRowValue(e, this.nativeAvailable);
    // Grey it out when native is chosen but can't run (no Rust) — the matching
    // red About-pane notice (see buildMain) explains how to enable it.
    return e === 'native' && !this.nativeAvailable ? `${DIM}${val}${RESET}` : val;
  }

  /** True when the Engine row is on native but native can't run here (no Rust).
   *  Drives the greyed value + the red "install Rust" notice. */
  private nativeUnavailableSelected(): boolean {
    return currentEngine(process.env.MINER_NATIVE) === 'native' && !this.nativeAvailable;
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
      case 'throttle': return this.buildThrottle(cols);
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
  private twoPane(cols: number, leftTitle: string, leftBodyFn: (inner: number) => string[], explain: string, hint: string, explainStyle: string = DIM): string[] | null {
    if (cols < TWO_PANE_MIN) return null;
    const gap = 1;
    const leftOuter = Math.min(46, Math.max(34, Math.floor((cols - 1) / 2)));
    const rightOuter = (cols - 1) - leftOuter - gap;
    if (rightOuter < 26) return null;
    const leftBody = leftBodyFn(leftOuter - 2);
    const right = this.wrap(explain, rightOuter - 3).map((ln) => `${explainStyle}${ln}${RESET}`);
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
        if (this.editing && this.editing.kind === 'wallet' && isSel && row.kind === 'wallet') {
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
    // On the Engine row, when native is selected but Rust isn't installed, replace
    // the normal dim "About" text with a RED notice explaining the wasm fallback
    // and how to enable native (rustup.rs + repo README).
    const onEngineNeedsRust = this.currentRow().kind === 'engine' && this.nativeUnavailableSelected();
    // On the Throttle row, when Manual mode + Max throttle (full blast), show a
    // YELLOW caution about instability and sustained heat. native-needs-rust wins
    // if both apply (engine row and throttle row are different, so they can't
    // both be true, but the precedence is stated explicitly for clarity).
    // Read the raw duty cycle directly, not via the nearest preset: now that a
    // hand-set value (via Custom...) can land anywhere in 0.05–1, snapping a
    // 0.90 to "nearest preset is Max" would falsely fire this caution for a rate
    // that never asked for full blast.
    const onFullBlast = !onEngineNeedsRust
      && this.currentRow().kind === 'throttle'
      && currentMode(process.env.MINER_SMART) === 'off'
      && throttleAmount(process.env.MINER_THROTTLE) >= 1;
    // On the Throttle row in Smart mode, show a DIM explanation that the value
    // is a starting point, not a fixed rate (can't collide with full-blast,
    // which requires Manual; full-blast check already gates on MINER_SMART === 'off').
    const onSmartThrottle = !onEngineNeedsRust
      && !onFullBlast
      && this.currentRow().kind === 'throttle'
      && currentMode(process.env.MINER_SMART) !== 'off';
    const explain = onEngineNeedsRust ? NATIVE_NEEDS_RUST
      : onFullBlast ? FULL_BLAST_CAUTION
      : onSmartThrottle ? SMART_THROTTLE_EXPLAIN
      : (ROW_EXPLAIN[this.currentRow().kind] ?? '');
    const explainStyle = onEngineNeedsRust ? RED : onFullBlast ? YELLOW : DIM;
    const paned = this.twoPane(cols, 'FulgurMiner', (inner) => this.buildMainRows(inner), explain, this.mainHint(), explainStyle);
    if (paned) return paned;
    const inner = this.mainWidth(cols) - 2;
    const body = this.buildMainRows(inner);
    body.push('');
    for (const ln of this.wrap(explain, inner - 1)) body.push(`${explainStyle}${ln}${RESET}`);
    return this.frame(inner, 'FulgurMiner', body, this.mainHint());
  }

  // --- "Where to mine" picker body: list, add-a-pool form, remove confirm,
  //      and the pools.json issues detail all render inside the SAME box, so
  //      none of it is at risk from the hint line's clamping/truncation. ------
  private editFieldLine(label: string, buffer: string, active: boolean, inner: number): string {
    const labelCol = label.padEnd(6);
    if (!active) return `${DIM}${labelCol}${RESET}${buffer}`;
    // Same tail-show budget as the wallet's inline edit cell (item A pattern).
    const budget = Math.max(1, inner - labelCol.length - 2);
    const shown = buffer.length > budget ? buffer.slice(buffer.length - budget) : (buffer || ' ');
    return `${DIM}${labelCol}${RESET}${INVERT} ${shown} ${RESET}`;
  }

  private buildAddPoolForm(inner: number): string[] {
    const ed = this.editing!;
    const body: string[] = [`${BOLD}Add a pool${RESET}`, ''];
    body.push(this.editFieldLine('Name', ed.kind === 'pool-name' ? ed.buffer : (ed.name ?? ''), ed.kind === 'pool-name', inner));
    if (ed.kind === 'pool-url') {
      body.push(this.editFieldLine('URL', ed.buffer, true, inner));
    }
    if (ed.error) {
      body.push('');
      for (const ln of this.wrap(ed.error, Math.max(10, inner - 1))) body.push(`${RED}${ln}${RESET}`);
    }
    return body;
  }

  private buildIssuesRows(inner: number): string[] {
    const body: string[] = [`${BOLD}pools.json problems${RESET}`, ''];
    for (const issue of this.model.issues) {
      for (const ln of this.wrap(`${issue.entry}: ${issue.reason}`, Math.max(10, inner - 1))) body.push(ln);
    }
    return body;
  }

  /** Picker radio-list rows: each destination (• marks the active one), then
   *  "+ Add a pool...", the issues row (only when there are any), and Back. */
  private buildWhereRows(): string[] {
    const rows = this.whereRows();
    const body: string[] = [];
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]!;
      const isSel = i === this.whereCursor;
      const marker = isSel ? `${CYAN}▶${RESET} ` : '  ';
      if (row.kind === 'target') {
        const opt = row.target;
        // Target rows occupy indices [0, model.targets.length) in whereRows(),
        // in the exact same order as model.targets — so `i` lines up directly
        // with model.activeIndex without any re-derivation.
        const isActive = i === this.model.activeIndex;
        const radio = isActive ? `${GREEN}(•)${RESET}` : `${DIM}( )${RESET}`;
        const name = isSel ? `${BOLD}${opt.label}${RESET}` : opt.label;
        const host = opt.page ? ` ${DIM}· ${link(this.hostOf(opt.page), opt.page)}${RESET}` : '';
        const tag = opt.kind === 'unknown' ? ` ${YELLOW}· unrecognised${RESET}` : '';
        body.push(`${marker}${radio} ${name}${host}${tag}`);
      } else if (row.kind === 'add') {
        const label = isSel ? `${BOLD}+ Add a pool...${RESET}` : `${DIM}+ Add a pool...${RESET}`;
        body.push(`${marker}${label}`);
      } else if (row.kind === 'issues') {
        const n = this.model.issues.length;
        const text = `! pools.json: ${n} problem${n === 1 ? '' : 's'}`;
        const label = isSel ? `${BOLD}${YELLOW}${text}${RESET}` : `${YELLOW}${text}${RESET}`;
        body.push(`${marker}${label}`);
      } else {
        const label = isSel ? `${BOLD}← Back${RESET}` : `${DIM}← Back${RESET}`;
        body.push(`${marker}${label}`);
      }
    }
    return body;
  }

  /** The picker's body content for the current sub-state: the add-pool form,
   *  the issues detail view, or the normal list (with a remove confirm / error
   *  appended as its own body rows — never the hint line, which the two-pane
   *  layout clamps horizontally and drops first on a short terminal). */
  private whereBody(inner: number): string[] {
    if (this.editing && (this.editing.kind === 'pool-name' || this.editing.kind === 'pool-url')) {
      return this.buildAddPoolForm(inner);
    }
    if (this.whereIssuesOpen) {
      return this.buildIssuesRows(inner);
    }
    const body = this.buildWhereRows();
    if (this.removeConfirm) {
      body.push('');
      for (const ln of this.wrap(`Remove "${this.removeConfirm.label}"? This cannot be undone.`, Math.max(10, inner - 1))) {
        body.push(`${YELLOW}${ln}${RESET}`);
      }
      body.push(`${YELLOW}Enter/y confirm  ·  Esc/n cancel${RESET}`);
    } else if (this.removeError) {
      body.push('');
      for (const ln of this.wrap(this.removeError, Math.max(10, inner - 1))) body.push(`${RED}${ln}${RESET}`);
    }
    return body;
  }

  private whereExplainText(row: WhereRow | undefined): string {
    if (!row) return 'Go back to the menu without changing where you mine.';
    if (row.kind === 'target') return whereExplain(row.target);
    if (row.kind === 'add') return ADD_POOL_EXPLAIN;
    if (row.kind === 'issues') return POOL_ISSUES_EXPLAIN;
    return 'Go back to the menu without changing where you mine.';
  }

  private whereHint(): string {
    if (this.editing && this.editing.kind === 'pool-name') return `${DIM}type · Enter next · Esc cancel${RESET}`;
    if (this.editing && this.editing.kind === 'pool-url') return `${DIM}type · Enter save · Esc cancel${RESET}`;
    if (this.whereIssuesOpen) return `${DIM}press any key to close${RESET}`;
    return `${DIM}↑/↓ move · Enter choose · d remove · Esc back${RESET}`;
  }

  /** "Where to mine" picker — radio list + per-row explanation. */
  private buildWhere(cols: number): string[] {
    const rows = this.whereRows();
    const sel = rows[this.whereCursor];
    const explain = this.whereExplainText(sel);
    const hint = this.whereHint();
    const buildRows = (inner: number): string[] => this.whereBody(inner);
    const paned = this.twoPane(cols, 'Where to mine', buildRows, explain, hint);
    if (paned) return paned;
    // Narrow fallback: append the wrapped explanation to the body instead of
    // discarding it — below TWO_PANE_MIN the per-row descriptions AND the
    // pools.json issues text used to be invisible here (buildMain already got
    // this right; buildWhere and buildMode did not).
    const inner = this.mainWidth(cols) - 2;
    const body = buildRows(inner);
    // A pending remove-confirm must stay the LAST thing in the body: render()
    // scrolls to the tail to keep it on-screen on a short terminal (see
    // there), which only works if nothing is appended after it. The per-row
    // explanation is skippable in that state — the confirm text already says
    // what's about to happen.
    if (!this.removeConfirm) {
      body.push('');
      for (const ln of this.wrap(explain, inner - 1)) body.push(`${DIM}${ln}${RESET}`);
    }
    return this.frame(inner, 'Where to mine', body, hint);
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
    // Same narrow-fallback fix as buildWhere: append the wrapped explanation
    // instead of dropping it below TWO_PANE_MIN.
    const inner = this.mainWidth(cols) - 2;
    const body = [...rows];
    body.push('');
    for (const ln of this.wrap(explain, inner - 1)) body.push(`${DIM}${ln}${RESET}`);
    return this.frame(inner, 'Mode', body, hint);
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

  // --- Throttle picker body: the preset/custom radio list, or the Custom...
  //     numeric editor — same "one box, no hint-line risk" rule as whereBody. ---
  private buildThrottleEditForm(inner: number): string[] {
    const ed = this.editing!;
    const body: string[] = [`${BOLD}Custom throttle${RESET}`, ''];
    body.push(this.editFieldLine('Value', ed.buffer, true, inner));
    if (ed.error) {
      body.push('');
      for (const ln of this.wrap(ed.error, Math.max(10, inner - 1))) body.push(`${RED}${ln}${RESET}`);
    }
    return body;
  }

  /** Picker radio-list rows: each preset (• marks an exact match), the current
   *  hand-set value's own row when it matches no preset, "Custom...", then Back. */
  private buildThrottleRows(): string[] {
    const rows = this.throttleRows();
    const body: string[] = [];
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]!;
      const isSel = i === this.throttleCursor;
      const marker = isSel ? `${CYAN}▶${RESET} ` : '  ';
      if (row.kind === 'preset') {
        const isActive = row.preset.value === throttleAmount(process.env.MINER_THROTTLE);
        const radio = isActive ? `${GREEN}(•)${RESET}` : `${DIM}( )${RESET}`;
        const label = `${throttleNum(row.preset.value)}  ${row.preset.label}`;
        const name = isSel ? `${BOLD}${label}${RESET}` : label;
        body.push(`${marker}${radio} ${name}`);
      } else if (row.kind === 'custom') {
        // This row only exists when it IS the active value (throttleRows only adds
        // it for a non-preset current MINER_THROTTLE) — the radio is always filled.
        const label = `${throttleNum(row.value)}  custom`;
        const name = isSel ? `${BOLD}${label}${RESET}` : label;
        body.push(`${marker}${GREEN}(•)${RESET} ${name}`);
      } else if (row.kind === 'edit') {
        const label = isSel ? `${BOLD}Custom...${RESET}` : `${DIM}Custom...${RESET}`;
        body.push(`${marker}${label}`);
      } else {
        const label = isSel ? `${BOLD}← Back${RESET}` : `${DIM}← Back${RESET}`;
        body.push(`${marker}${label}`);
      }
    }
    return body;
  }

  private throttleBody(inner: number): string[] {
    if (this.editing && this.editing.kind === 'throttle') return this.buildThrottleEditForm(inner);
    return this.buildThrottleRows();
  }

  private throttleExplainText(row: ThrottleRow | undefined): string {
    if (!row) return 'Go back without changing the throttle.';
    if (row.kind === 'preset') return throttlePresetExplain(row.preset);
    if (row.kind === 'custom') return throttleCustomExplain(row.value);
    if (row.kind === 'edit') return THROTTLE_CUSTOM_EDIT_EXPLAIN;
    return 'Go back without changing the throttle.';
  }

  private throttleHint(): string {
    if (this.editing && this.editing.kind === 'throttle') return `${DIM}type · Enter save · Esc cancel${RESET}`;
    return `${DIM}↑/↓ move · Enter choose · Esc back${RESET}`;
  }

  /** Throttle picker — radio list (presets + the honest "custom" row) plus the
   *  Custom... numeric editor, per-row explanation. */
  private buildThrottle(cols: number): string[] {
    const rows = this.throttleRows();
    // While editing, the cursor stays on the 'edit' row throughout (no move key
    // reaches moveThrottle while this.editing is set — see handleKey), so this
    // already resolves to THROTTLE_CUSTOM_EDIT_EXPLAIN without a special case.
    const sel = rows[this.throttleCursor];
    const explain = this.throttleExplainText(sel);
    const hint = this.throttleHint();
    const buildRows = (inner: number): string[] => this.throttleBody(inner);
    const paned = this.twoPane(cols, 'Throttle', buildRows, explain, hint);
    if (paned) return paned;
    // Same narrow-fallback as buildWhere/buildMode: append the wrapped
    // explanation instead of dropping it below TWO_PANE_MIN.
    const inner = this.mainWidth(cols) - 2;
    const body = buildRows(inner);
    body.push('');
    for (const ln of this.wrap(explain, inner - 1)) body.push(`${DIM}${ln}${RESET}`);
    return this.frame(inner, 'Throttle', body, hint);
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
      `  Runs from source — update with ${D('git pull --autostash && npm install')}.`,
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
    // A pending remove-confirm must NEVER be the part a short terminal
    // silently drops: it's a destructive action, and Enter still deletes even
    // when the user can't see the prompt asking them to confirm it. The
    // confirm block (and its "Enter/y confirm" hint) is always the LAST thing
    // in the frame before its closing border (see whereBody/buildWhere), so
    // when the full frame doesn't fit, scroll to the TAIL instead of the
    // head — rows/border above scroll off-screen, but the destructive prompt
    // stays on screen for as long as it's armed.
    const start = this.removeConfirm && lines.length > max ? lines.length - max : 0;
    for (let i = 0; i < max; i++) {
      // Hard safety net: even though the frame is sized to the terminal, a very
      // narrow window (below the min frame width) could still exceed `cols`.
      // Truncate each line to the visible width so we can never overflow.
      out += this.clampVisible(lines[start + i] ?? '', cols) + CLEAR_LINE;
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
