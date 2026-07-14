// src/minerd/targets.ts
//
// THE target model. Both UIs render THIS array - the arrow menu (menu.ts) and the
// plain readline editor (settings.ts) - so "where to mine" cannot be spelled two
// ways. Today each of menu.ts / settings.ts / start.ts carries its OWN MINER_POOL
// parser, its OWN list order and its OWN persist branch, and they have already
// drifted on exactly this surface. This module is the structural cure: nothing
// else owns the model, and persistTarget() is the ONE writer of MINER_POOL.
//
// SEMANTICS - PRESERVED EXACTLY, NOT CHANGED (locked, do not "fix" this):
//   MINER_POOL unset/blank    -> follow the default pool (FulgurPool). Persisted
//                                 as the KEY BEING ABSENT - not as FulgurPool's URL.
//   MINER_POOL = solo|off|none -> solo.
//   MINER_POOL = <url>         -> that pool (a built-in, a pools.json entry, or -
//                                 if it matches neither - its own 'unknown' row).
// There is no "not chosen" state here: activeIndex always points at a real row.
// FulgurPool being an absence, not a value, is why Target.value stays
// `string | undefined` - collapsing it to `string` would make "follow the
// default" and "explicitly pinned to FulgurPool's URL" the same write.
//
// Invariants, all pinned in targets.test.ts:
//   - row order is ALWAYS Solo, FulgurPool, brcpool, then custom pools;
//   - activeIndex is NEVER -1 - unset resolves to the FulgurPool row, exactly as
//     config.ts's resolvePoolUrl() already treats it;
//   - a MINER_POOL we do not recognise (a valid url matching no row, or outright
//     garbage) gets its OWN 'unknown' row, carrying the real value - it is NEVER
//     relabelled as a built-in. (menu.ts:155 does `this.targetIndex = i >= 0 ? i
//     : 0`, which relabels an unrecognised MINER_POOL as "FulgurPool" while the
//     miner mines elsewhere; one Enter in the picker then persists `undefined`
//     and ERASES it. This module exists in part to kill that by construction.)
//   - building the model NEVER writes: only persistTarget/addCustomPool/
//     removeCustomPool touch disk, and only from an explicit commit (no
//     navigation key - arrow, open, render - may reach them; clamp-and-persist is
//     a known BLOCKER class in this codebase).
//
// This module also owns the SHARED COPY for this surface (the two removal
// refusals, the add-a-pool caps) so the two UIs cannot print two different
// sentences, or accept two different input lengths, for the same event.
import {
  persist,
  readPoolsFile,
  writePoolsFile,
  POOLS_FILE_ISSUE,
  type PoolsFile,
  type PoolIssue,
} from './envLocal.js';
import {
  BUILTIN_POOLS,
  builtinByUrl,
  canonicalisePoolUrl,
  decodePoolChoice,
  sanitiseForDisplay,
} from './pools.js';

/** One issue shape for the whole tree - re-exported so consumers need only this module. */
export type { PoolIssue } from './envLocal.js';

/** One row of the "Where to mine" list. */
export interface Target {
  /** Stable id: 'solo' | a BuiltinPoolId | `custom:<url>` | 'unknown'. */
  key: string;
  label: string;
  /**
   * EXACTLY what persistTarget writes to MINER_POOL. `undefined` means the key is
   * left ABSENT - which is how "follow the default pool (FulgurPool)" is spelled,
   * today and after this change. 'solo' means solo. Anything else is a canonical
   * pool URL.
   */
  value: string | undefined;
  /** What this destination IS - never what you might earn (no fee/variance/income copy). */
  description: string;
  kind: 'solo' | 'builtin' | 'custom' | 'unknown';
  /** Optional website for the clickable host link (OSC 8). */
  page?: string;
  removable: boolean;
}

export interface TargetModel {
  targets: Target[];
  issues: PoolIssue[];
  /** Index into `targets`. Never -1 - every MINER_POOL value resolves to a real row. */
  activeIndex: number;
}

const SOLO_DESC = 'mine on your own, no pool';
const CUSTOM_DESC = 'a pool you added yourself';
const UNKNOWN_DESC = 'the MINER_POOL value in your configuration - not a built-in, and not in pools.json';

/** SHARED COPY. Defined HERE, exported to both UIs - nobody retypes these. */
export const REMOVE_ACTIVE_REFUSAL =
  'You are mining on this pool - switch to another destination first, then remove it.';
export const REMOVE_BUILTIN_REFUSAL = 'That pool is built in - it cannot be removed.';
/** removeCustomPool's other two refusals: the file itself can't be used, or it moved under us. */
export const POOLS_FILE_BROKEN = 'pools.json could not be read - fix the file by hand first.';
export const POOLS_FILE_CHANGED = 'pools.json changed on disk - reopen this screen.';

/** Caps. Enforced INSIDE validateNewPool, so the TUI and `npm run settings` accept
 *  identical input - a per-UI cap is how they would drift (and how one UI could
 *  silently truncate a paste that the other rejects outright). */
export const NAME_MAX = 40;
export const URL_MAX = 256;

/** Printable ASCII only: menu.ts's vlen() counts UTF-16 units, so a double-width
 *  name would under-count its row and tear the two-pane frame. */
const ASCII_NAME = /^[\x20-\x7e]+$/;

/** Names that would collide with a built-in destination or a MINER_POOL token. */
const RESERVED_NAMES = new Set<string>(['solo', 'off', 'none', ...BUILTIN_POOLS.map((p) => p.name.toLowerCase())]);

function soloTarget(): Target {
  return { key: 'solo', label: 'Solo', value: 'solo', description: SOLO_DESC, kind: 'solo', removable: false };
}

function unknownTarget(value: string): Target {
  return { key: 'unknown', label: value, value, description: UNKNOWN_DESC, kind: 'unknown', removable: false };
}

/** True when readPoolsFile could not use the FILE (not merely one entry). rawList
 *  is [] in that case, so a write would replace the user's pools with nothing. */
function fileBroken(file: PoolsFile): boolean {
  return file.issues.some((i) => i.entry === POOLS_FILE_ISSUE);
}

/** Everything printed to a terminal is sanitised: an issue can quote a name straight
 *  out of a hand-edited pools.json, and a stray ESC/BEL would corrupt the frame. */
function sanitiseIssues(issues: readonly PoolIssue[]): PoolIssue[] {
  return issues.map((i) => ({ entry: sanitiseForDisplay(i.entry), reason: sanitiseForDisplay(i.reason) }));
}

/** Build the ordered row list + the active index from an already-read pools.json. */
function modelFrom(file: PoolsFile, env: NodeJS.ProcessEnv): TargetModel {
  const targets: Target[] = [soloTarget()];

  for (const p of BUILTIN_POOLS) {
    const t: Target = {
      key: p.id,
      label: p.name,
      // FulgurPool is the default pool: its row persists as an ABSENT MINER_POOL
      // key, not as its own URL (that is the semantic this task must not touch).
      // brcpool has no such role - its row persists its real URL, like any other pool.
      value: p.id === 'fulgurpool' ? undefined : p.url,
      description: p.description,
      kind: 'builtin',
      removable: false,
    };
    if (p.page) t.page = p.page;
    targets.push(t);
  }

  // pools.json. Entries that would duplicate a destination already on screen are NOT
  // silently dropped (silent dropping is the thing this release exists to end) - they
  // are reported as issues, so the user can see why their entry is not in the list.
  const extraIssues: PoolIssue[] = [];
  const seen = new Set(targets.map((t) => t.value));
  for (const { entry } of file.pools) {
    // envLocal hands back canonical URLs already; re-canonicalising is idempotent
    // and keeps this function correct even if that ever changes.
    const c = canonicalisePoolUrl(entry.url);
    if (!c.ok) {
      extraIssues.push({ entry: entry.name, reason: c.reason });
      continue;
    }
    const b = builtinByUrl(c.url);
    if (b) {
      extraIssues.push({ entry: entry.name, reason: `points at ${b.name}, which is built in` });
      continue;
    }
    if (seen.has(c.url)) {
      extraIssues.push({ entry: entry.name, reason: 'the same pool URL is already in your list' });
      continue;
    }
    seen.add(c.url);
    const t: Target = {
      key: `custom:${c.url}`,
      label: sanitiseForDisplay(entry.name),
      value: c.url,
      description: CUSTOM_DESC,
      kind: 'custom',
      removable: true,
    };
    if (entry.page) t.page = entry.page;
    targets.push(t);
  }

  // activeIndex: NEVER -1. There is no "not chosen" state - unset resolves to the
  // FulgurPool row (index 1), exactly as config.ts's resolvePoolUrl already treats
  // an unset/blank MINER_POOL.
  const choice = decodePoolChoice(env.MINER_POOL);
  let activeIndex: number;
  if (choice.kind === 'unset') {
    activeIndex = 1; // FulgurPool is always row 1: Solo, FulgurPool, brcpool, ...
  } else if (choice.kind === 'solo') {
    activeIndex = 0;
  } else if (choice.kind === 'pool') {
    // The built-in id (which also resolves a legacy FulgurPool origin via
    // FULGURPOOL_ALIASES) wins over a raw URL match, so an aliased origin lights up
    // the FulgurPool row instead of appearing as an unrecognised pool.
    const id = choice.builtin;
    activeIndex = id
      ? targets.findIndex((t) => t.kind === 'builtin' && t.key === id)
      : targets.findIndex((t) => t.value === choice.url);
    if (activeIndex < 0) {
      // A URL in no list. Give it a row of its own, carrying the REAL value - the
      // one thing we must never do is silently re-point it at a pool we like.
      targets.push(unknownTarget(choice.url));
      activeIndex = targets.length - 1;
    }
  } else {
    // choice.kind === 'invalid': not even a well-formed pool URL (garbage, a
    // typo'd solo, a non-http(s) scheme, control characters). It still gets a row
    // of its own rather than silently becoming FulgurPool or vanishing.
    targets.push(unknownTarget(sanitiseForDisplay(choice.raw)));
    activeIndex = targets.length - 1;
  }

  return { targets, issues: sanitiseIssues([...file.issues, ...extraIssues]), activeIndex };
}

/**
 * The one list both UIs render: Solo, the built-ins, the user's pools.json pools,
 * and - only when MINER_POOL holds a value none of them match - an explicit
 * 'unknown' row carrying the real value. READ-ONLY: it never writes.
 */
export function buildTargetModel(env: NodeJS.ProcessEnv = process.env): TargetModel {
  return modelFrom(readPoolsFile(), env);
}

/**
 * THE ONLY MINER_POOL WRITER IN THE TREE. Both UIs and the plain first-run chooser
 * call this and nothing else, so "where do I mine" cannot be spelled two ways.
 *
 * Only ever called from an EXPLICIT commit (Enter on a picker row, a confirmed
 * answer in the plain chooser). No navigation key - arrow, open, render - may
 * reach it (clamp-and-persist is a known BLOCKER class in this codebase).
 */
export function persistTarget(t: Target): void {
  persist({ MINER_POOL: t.value });
  if (t.value === undefined) delete process.env.MINER_POOL;
  else process.env.MINER_POOL = t.value;
}

/**
 * The one add-a-pool validator, used by the TUI form AND `npm run settings` - so the
 * two UIs can never accept different strings. The CAPS ARE HERE for the same
 * reason: a per-UI cap is how one UI could come to silently truncate a paste the
 * other rejects in full.
 *
 * `existing` is the LIVE target list, so duplicates are checked against what is
 * actually on screen (built-ins included).
 */
export function validateNewPool(
  name: string,
  url: string,
  existing: readonly Target[],
): { ok: true; entry: { name: string; url: string } } | { ok: false; field: 'name' | 'url'; reason: string } {
  const n = name.trim();
  if (!n) return { ok: false, field: 'name', reason: 'Give the pool a name.' };
  if (n.length > NAME_MAX) {
    return { ok: false, field: 'name', reason: `A name is limited to ${NAME_MAX} characters.` };
  }
  if (!ASCII_NAME.test(n)) {
    return { ok: false, field: 'name', reason: 'Use plain ASCII letters, digits, spaces and - _ .' };
  }
  if (RESERVED_NAMES.has(n.toLowerCase())) {
    return { ok: false, field: 'name', reason: 'That name belongs to a built-in destination.' };
  }
  if (existing.some((t) => t.label.toLowerCase() === n.toLowerCase())) {
    return { ok: false, field: 'name', reason: 'A pool with that name is already in your list.' };
  }

  const u = url.trim();
  if (u.length > URL_MAX) {
    return { ok: false, field: 'url', reason: `A pool URL is limited to ${URL_MAX} characters.` };
  }
  const c = canonicalisePoolUrl(u);
  if (!c.ok) return { ok: false, field: 'url', reason: c.reason };
  // builtinByUrl also resolves the FulgurPool aliases, so a legacy origin is
  // recognised as the built-in it is rather than being added a second time under
  // another name.
  if (builtinByUrl(c.url)) return { ok: false, field: 'url', reason: 'That pool is already built in.' };
  if (existing.some((t) => t.value === c.url)) {
    return { ok: false, field: 'url', reason: 'That pool URL is already in your list.' };
  }

  return { ok: true, entry: { name: n, url: c.url } };
}

/**
 * Add a pool to pools.json and hand back the rebuilt model. Non-destructive: the
 * new entry is APPENDED to the RAW array, so entries we could not parse - and any
 * other top-level key - survive the round-trip.
 *
 * Validation re-runs against the file as it is RIGHT NOW: the picker's model may be
 * minutes old, and `npm run settings` in a second terminal can write the same file.
 * A rejected entry, or a file we could not read, writes NOTHING - the caller shows
 * the reason from validateNewPool() / the returned model's issues before it ever
 * gets here. This never touches MINER_POOL, so the returned activeIndex simply
 * reflects whatever is actually active right now - saving a bookmark must never
 * move anyone's hashrate.
 */
export function addCustomPool(name: string, url: string): TargetModel {
  const file = readPoolsFile();
  const model = modelFrom(file, process.env);

  const v = validateNewPool(name, url, model.targets);
  if (!v.ok) return model;
  if (fileBroken(file)) return model; // rawList is [] - a write would erase the file

  const rawList = [...file.rawList, { name: v.entry.name, url: v.entry.url }];
  writePoolsFile({ ...file, rawList });
  return buildTargetModel();
}

/**
 * Remove a custom pool. Refuses - never auto-heals - in four cases:
 *
 *  1. the row is not removable (Solo, a built-in, the unknown row);
 *  2. it is the pool you are mining on right now (auto-switching away, or clearing
 *     MINER_POOL, would be exactly the silent hashrate move this release exists to
 *     eliminate);
 *  3. pools.json cannot be read (rawList is [], so a write would erase it);
 *  4. pools.json no longer holds the entry we named.
 *
 * (3) and (4) are why this does ONE read, then locates the entry by matching it,
 * then does ONE write - never by an index captured earlier. pools.json can be
 * hand-edited or rewritten by `npm run settings` in another terminal between the
 * moment the picker opened and the moment Enter is pressed; a captured rawIndex is
 * a slot number that a splice elsewhere can point at a different pool by the time
 * we act on it, which would delete the WRONG entry while the confirm on screen
 * still names the right one. Re-reading right before mutating - and identifying
 * the row by its (url, name) rather than its old position - closes that window.
 *
 * The active-pool check reads the LIVE process.env.MINER_POOL for the same reason:
 * the Target the caller is holding can be stale too.
 */
export function removeCustomPool(
  target: Target,
): { ok: true; model: TargetModel } | { ok: false; reason: string } {
  if (!target.removable) return { ok: false, reason: REMOVE_BUILTIN_REFUSAL };

  const choice = decodePoolChoice(process.env.MINER_POOL);
  if (choice.kind === 'pool' && choice.url === target.value) {
    return { ok: false, reason: REMOVE_ACTIVE_REFUSAL };
  }

  const file = readPoolsFile();
  if (fileBroken(file)) return { ok: false, reason: POOLS_FILE_BROKEN };

  const hit = file.pools.find((p) => {
    const c = canonicalisePoolUrl(p.entry.url);
    return c.ok && c.url === target.value && sanitiseForDisplay(p.entry.name) === target.label;
  });
  if (!hit) return { ok: false, reason: POOLS_FILE_CHANGED };

  const rawList = [...file.rawList];
  rawList.splice(hit.rawIndex, 1);
  writePoolsFile({ ...file, rawList });
  return { ok: true, model: buildTargetModel() };
}
