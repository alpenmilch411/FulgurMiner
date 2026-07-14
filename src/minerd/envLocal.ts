// src/minerd/envLocal.ts
// The file layer under the miner's settings: .env.local (a KEY=VALUE subset, '#'
// comments ignored) and the optional pools.json. Shared by the launcher, the TUI
// menu and `npm run settings` so there is exactly one implementation.
//
// TWO INVARIANTS, both learned from a real user's file:
//
//   1. A WRITE NEVER DESTROYS WHAT IT DID NOT UNDERSTAND. persist() splices the raw
//      .env.local TEXT (comments, blank lines, key order and unknown keys survive),
//      and writePoolsFile() splices the raw JSON ARRAY (a malformed entry, an unknown
//      per-entry key and the wrapper's other top-level keys all survive).
//
//   2. NOTHING HERE PRINTS. A pools.json problem comes back as PoolIssue[] and is
//      rendered by the UI. A warning printed from this module is invisible: it fires
//      from the menu's constructor before the alt-screen opens, or from inside it
//      where the next frame erases it. That is how a real user's pools.json got
//      silently discarded. There is a test that greps this file for that call.
import { readFileSync, writeFileSync, existsSync, copyFileSync, chmodSync } from 'node:fs';
import { resolve } from 'node:path';
import { canonicalisePoolUrl, sanitiseForDisplay } from './pools.js';

export const ENV_FILE = resolve(process.cwd(), '.env.local');
export const POOLS_FILE = resolve(process.cwd(), 'pools.json');

export interface PoolEntry {
  name: string;
  /** Mining endpoint. CANONICAL (see canonicalisePoolUrl) once it has been read. */
  url: string;
  /** Optional website, rendered as an OSC 8 link next to the name. Canonical. */
  page?: string;
}

/**
 * A pools.json entry - or the whole file - that we could not use. The UI renders
 * these (Tasks 7 and 10); this module never prints them.
 */
export interface PoolIssue {
  /** The offending pool's name; `entry N` when it has none; POOLS_FILE_ISSUE for the file itself. */
  entry: string;
  reason: string;
}

/**
 * PoolIssue.entry when the problem is the FILE (bad JSON / wrong shape), not one
 * entry. A caller that sees this MUST NOT WRITE - rawList is empty, so a write would
 * truncate a file we could not read. (A malformed entry literally named "pools.json"
 * would be mistaken for this: it fails safe - writes are refused, nothing is lost.)
 */
export const POOLS_FILE_ISSUE = 'pools.json';

export interface PoolsFile {
  /** What we could use, in file order, url + page canonicalised, each pointing at its rawList slot. */
  pools: { entry: PoolEntry; rawIndex: number }[];
  /** What we could NOT use. Never thrown, never printed - and never dropped from rawList. */
  issues: PoolIssue[];
  /**
   * The raw JSON array exactly as it is on disk (empty when the file is absent or
   * broken). THIS is what a write emits: a caller splices it by rawIndex (remove) or
   * pushes to it (add), and everything it never understood rides along untouched.
   */
  rawList: unknown[];
  /** The wrapper's other top-level keys (e.g. "_comment"). Preserved on write. */
  extraKeys: Record<string, unknown>;
}

/**
 * A pool URL is well-formed when canonicalisePoolUrl accepts it: absolute http(s), no
 * control characters, no credentials. Kept as an export because docs/tools/probe-poolsjson.ts
 * imports it; pools.ts is the implementation.
 */
export function isValidPoolUrl(u: string): boolean {
  return canonicalisePoolUrl(u).ok;
}

/** Parse a .env.local file into a record (small KEY=VALUE subset, # comments). */
export function readEnvFile(path: string = ENV_FILE): Record<string, string> {
  if (!existsSync(path)) return {};
  const out: Record<string, string> = {};
  for (const raw of readFileSync(path, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    if (key) out[key] = line.slice(eq + 1).trim();
  }
  return out;
}

/** Merge .env.local values into process.env without overriding real env vars. */
export function loadEnvLocal(path: string = ENV_FILE): void {
  for (const [k, v] of Object.entries(readEnvFile(path))) {
    if (process.env[k] === undefined) process.env[k] = v;
  }
}

/**
 * Merge ONLY these keys from .env.local into process.env, and only where the real
 * environment has not already spoken. `npm run mine` uses this instead of loadEnvLocal:
 * a headless miner must see the destination the user chose in the menu (MINER_POOL) and
 * their wallet (MINER_PUBKEY) - and nothing else. Every other setting stays env-var-only,
 * so a stale .env.local line can never change how a headless miner runs (D9).
 */
export function loadEnvLocalKeys(keys: readonly string[], path: string = ENV_FILE): void {
  const file = readEnvFile(path);
  for (const k of keys) {
    if (process.env[k] !== undefined) continue;                       // a real env var wins
    if (!Object.prototype.hasOwnProperty.call(file, k)) continue;     // never read a key off Object.prototype
    process.env[k] = file[k];
  }
}

/**
 * Delete MINER_POOL from the environment when it is DEFINED BUT BLANK.
 *
 * Both loaders only fill keys that are `undefined`, so an exported `MINER_POOL=` (an
 * empty value, not an absent one) shadows .env.local forever: the miner would decode
 * 'unset' and refuse to start while .env.local plainly says `solo`. A blank value has
 * never meant anything, so dropping it loses nothing.
 *
 * It lives HERE, not in start.ts, so index.ts and settings.ts can call it without
 * importing the launcher. Call it BEFORE the loader.
 */
export function dropBlankPoolEnv(env: NodeJS.ProcessEnv = process.env): void {
  const v = env.MINER_POOL;
  if (typeof v === 'string' && v.trim() === '') delete env.MINER_POOL;
}

/**
 * Persist updates back to .env.local by SPLICING THE RAW TEXT - never by
 * regenerating the file from parsed keys (that is what deleted every comment and
 * every blank line up to 0.2.8, from a file .env.example tells people to hand-write).
 *
 *   - the FIRST non-comment line whose key matches is rewritten IN PLACE;
 *   - a key the file does not have is APPENDED at the end;
 *   - `undefined` DELETES the key;
 *   - every other line - comments, blanks, unknown keys, ordering - is untouched.
 *
 * A duplicate line for a key we are writing is dropped, so exactly one line for it
 * remains: readEnvFile is last-wins, and leaving a stale duplicate behind would
 * silently shadow the value we just wrote. Mode 0600 is enforced with an explicit
 * chmod, not just the writeFileSync `mode` option: that option only applies when the
 * underlying file is newly created, so a pre-existing file (e.g. hand-written at the
 * shell's default 0644) would otherwise keep its looser mode across every write.
 * A missing file is created.
 */
export function persist(updates: Record<string, string | undefined>, path: string = ENV_FILE): void {
  const before = existsSync(path) ? readFileSync(path, 'utf8') : '';
  // A file that ended with a newline still ends with one; one that did not, does not.
  const trailingNewline = before === '' || before.endsWith('\n');
  const lines = before === '' ? [] : before.replace(/\n$/, '').split('\n');

  // hasOwnProperty, NOT `k in updates`: a line named `constructor=...` would
  // otherwise look like a key we were asked to update, and get deleted.
  const has = (k: string): boolean => Object.prototype.hasOwnProperty.call(updates, k);
  const keyOf = (line: string): string | null => {
    const t = line.trim();
    if (!t || t.startsWith('#')) return null;
    const eq = t.indexOf('=');
    if (eq === -1) return null;
    return t.slice(0, eq).trim() || null;
  };

  const out: string[] = [];
  const written = new Set<string>();
  for (const line of lines) {
    const k = keyOf(line);
    if (k === null || !has(k)) { out.push(line); continue; }   // comment / blank / a key we were not asked about
    if (written.has(k)) continue;                              // a duplicate of a key we already wrote
    written.add(k);
    const v = updates[k];
    if (v === undefined) continue;                             // delete: the line goes
    out.push(`${k}=${v}`);                                     // rewrite in place, keeping its position
  }
  for (const [k, v] of Object.entries(updates)) {
    if (v === undefined || written.has(k)) continue;
    out.push(`${k}=${v}`);                                     // a key the file did not have
  }

  const body = out.length ? out.join('\n') + (trailingNewline ? '\n' : '') : '';
  writeFileSync(path, body, { mode: 0o600 });
  chmodSync(path, 0o600);
}

/** How an issue names the offending entry: its name, or its position when it has none. */
function entryLabel(i: number, name: string): string {
  const n = sanitiseForDisplay(name).trim();     // it lands in a terminal - strip control chars
  return n !== '' ? n : `entry ${i + 1}`;
}

/** Parse one raw pools.json element into the entry we can use (or null) plus what went wrong. */
function parseEntry(item: unknown, i: number): { entry: PoolEntry | null; issues: PoolIssue[] } {
  if (item === null || typeof item !== 'object' || Array.isArray(item)) {
    return { entry: null, issues: [{ entry: `entry ${i + 1}`, reason: 'not a JSON object' }] };
  }
  const rec = item as Record<string, unknown>;
  const name = typeof rec.name === 'string' ? rec.name.trim() : '';
  const label = entryLabel(i, name);
  if (name === '') return { entry: null, issues: [{ entry: label, reason: 'no "name"' }] };

  const rawUrl = typeof rec.url === 'string' ? rec.url.trim() : '';
  if (rawUrl === '') return { entry: null, issues: [{ entry: label, reason: 'no "url"' }] };
  const url = canonicalisePoolUrl(rawUrl);
  if (!url.ok) return { entry: null, issues: [{ entry: label, reason: `"url" is not usable: ${url.reason}` }] };

  const entry: PoolEntry = { name, url: url.url };
  const issues: PoolIssue[] = [];
  const rawPage = typeof rec.page === 'string' ? rec.page.trim() : '';
  if (rawPage !== '') {
    const page = canonicalisePoolUrl(rawPage);
    if (page.ok) entry.page = page.url;
    else issues.push({ entry: label, reason: `"page" is not usable: ${page.reason} - the pool was kept, without its website link` });
  }
  return { entry, issues };
}

/**
 * Read pools.json. Both a `{ pools: [...] }` wrapper and a bare array are accepted.
 * NEVER throws and NEVER prints: what we could not use comes back as issues[] for the
 * UI to render, and rawList[] carries the file's array exactly as it is on disk so a
 * later write can splice it instead of regenerating it.
 */
export function readPoolsFile(path: string = POOLS_FILE): PoolsFile {
  const empty = (issues: PoolIssue[] = []): PoolsFile => ({ pools: [], issues, rawList: [], extraKeys: {} });
  if (!existsSync(path)) return empty();

  let data: unknown;
  try {
    data = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch {
    return empty([{ entry: POOLS_FILE_ISSUE, reason: 'is not valid JSON - it was ignored, and nothing in it was changed' }]);
  }

  const isWrapper = data !== null && typeof data === 'object' && !Array.isArray(data);
  const list = Array.isArray(data) ? data : isWrapper ? (data as Record<string, unknown>).pools : undefined;
  if (!Array.isArray(list)) {
    return empty([{ entry: POOLS_FILE_ISSUE, reason: 'should be { "pools": [ ... ] } or a plain array of pools' }]);
  }

  const extraKeys: Record<string, unknown> = {};
  if (isWrapper) {
    for (const [k, v] of Object.entries(data as Record<string, unknown>)) {
      if (k === 'pools') continue;
      // defineProperty, not `extraKeys[k] = v`: a top-level "__proto__" key would
      // otherwise set this object's prototype instead of becoming a key we can write back.
      Object.defineProperty(extraKeys, k, { value: v, writable: true, enumerable: true, configurable: true });
    }
  }

  const pools: { entry: PoolEntry; rawIndex: number }[] = [];
  const issues: PoolIssue[] = [];
  list.forEach((item, i) => {
    const r = parseEntry(item, i);
    if (r.entry) pools.push({ entry: r.entry, rawIndex: i });
    issues.push(...r.issues);
  });
  return { pools, issues, rawList: list, extraKeys };
}

/**
 * Write pools.json back. The caller owns the splice: it pushes onto file.rawList to
 * add, or splices file.rawList by `rawIndex` to remove. We emit rawList verbatim, so
 * an element we could not parse - and any per-entry key we do not know about - is
 * still there afterwards. The wrapper's other top-level keys ride along in extraKeys.
 * A bare-array file is written back in the canonical { "pools": [ ... ] } shape.
 *
 * CALLERS MUST REFUSE TO WRITE when readPoolsFile reported a POOLS_FILE_ISSUE: rawList
 * is empty for a file we could not read, and a blind write would truncate it. The .bak
 * (one, overwritten each time) is the last line of defence, not the plan.
 *
 * Mode 0600 - pools.json can carry a private endpoint. Enforced with an explicit
 * chmod, not just the writeFileSync `mode` option: that option only applies when the
 * underlying file is newly created, so a pre-existing file (e.g. hand-written at the
 * shell's default 644) would otherwise keep its looser mode across every write.
 */
export function writePoolsFile(file: PoolsFile, path: string = POOLS_FILE): void {
  if (existsSync(path)) {
    // Best-effort: a failed backup must never block the write.
    try { copyFileSync(path, `${path}.bak`); } catch { /* non-fatal - proceed */ }
  }
  // Spread (not Object.assign): a "__proto__" key stays a plain data property.
  const outer = { ...file.extraKeys, pools: file.rawList };
  writeFileSync(path, JSON.stringify(outer, null, 2) + '\n', { mode: 0o600 });
  chmodSync(path, 0o600);
}
