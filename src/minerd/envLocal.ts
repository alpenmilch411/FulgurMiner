// src/minerd/envLocal.ts
// Small helpers for reading and persisting the .env.local file and the optional
// pools.json. Factored out of start.ts so both the launcher and the settings
// menu share one implementation. KEY=VALUE subset only, '#' comments ignored.
import { readFileSync, writeFileSync, existsSync, copyFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const ENV_FILE = resolve(process.cwd(), '.env.local');
export const POOLS_FILE = resolve(process.cwd(), 'pools.json');

export interface PoolEntry {
  name: string;
  /** Mining endpoint (validated `^https?://`). */
  url: string;
  /** Optional website to link to when the pool is named (OSC 8). */
  page?: string;
}

/**
 * A pool URL is well-formed when it is an absolute http(s) URL with no embedded
 * control characters. The control-char guard matters because the URL can be
 * embedded in an OSC 8 hyperlink, where a stray BEL/ESC would prematurely
 * terminate the escape sequence and corrupt the rendered line.
 */
export function isValidPoolUrl(u: string): boolean {
  const v = u.trim();
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(v)) return false;
  if (!/^https?:\/\/.+/i.test(v)) return false;
  try {
    const parsed = new URL(v);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
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
 * silently shadow the value we just wrote. Mode 0600 as before (it applies when the
 * file is created); a missing file is created.
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
}

/**
 * Read user-registered extra pools from pools.json. Both a bare array and a
 * `{ pools: [...] }` wrapper are accepted on read. Malformed entries are skipped.
 * An optional `page` (website) is carried through when it is an http(s) URL.
 */
export function readExtraPools(path: string = POOLS_FILE): PoolEntry[] {
  if (!existsSync(path)) return [];
  try {
    const data = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    const list = Array.isArray(data) ? data : (data as { pools?: unknown }).pools;
    if (!Array.isArray(list)) return [];
    const parsed = list
      .map((p) => {
        const rawPage = String((p as PoolEntry).page ?? '').trim().replace(/\/+$/, '');
        const entry: PoolEntry = {
          name: String((p as PoolEntry).name ?? '').trim(),
          url: String((p as PoolEntry).url ?? '').trim().replace(/\/+$/, ''),
        };
        if (rawPage && isValidPoolUrl(rawPage)) entry.page = rawPage;
        return entry;
      })
      .filter((p) => p.name && isValidPoolUrl(p.url));
    // Surface silent data loss: if usable entries were dropped (missing name /
    // invalid URL), warn once so a typo'd or corrupt pools.json doesn't quietly
    // vanish a pool. writeExtraPools also keeps a .bak before each overwrite, so a
    // bad edit is recoverable. Only fires when entries were actually lost.
    if (parsed.length < list.length) {
      console.warn(`  (pools.json: ${list.length - parsed.length} malformed entry/entries skipped — check name + http(s) url.)`);
    }
    return parsed;
  } catch {
    console.warn('  (pools.json could not be parsed — ignoring it.)');
    return [];
  }
}

/**
 * Persist the pool list to pools.json in the canonical `{ pools: [...] }` shape.
 * Only the recognised fields (name, url, optional page) are written, so a
 * round-trip normalises the file. Written 0600 (it can carry private endpoints).
 */
export function writeExtraPools(pools: PoolEntry[], path: string = POOLS_FILE): void {
  const clean = pools.map((p) => {
    const out: PoolEntry = { name: p.name.trim(), url: p.url.trim().replace(/\/+$/, '') };
    const page = (p.page ?? '').trim().replace(/\/+$/, '');
    if (page) out.page = page;
    return out;
  });
  // Keep a single .bak of the previous file before overwriting so a mistaken
  // edit (or a refresh that drops a malformed entry) is recoverable. Best-effort:
  // a backup failure must never block the write.
  if (existsSync(path)) {
    try { copyFileSync(path, `${path}.bak`); } catch { /* non-fatal — proceed with the write */ }
  }
  writeFileSync(path, JSON.stringify({ pools: clean }, null, 2) + '\n', { mode: 0o600 });
}

/**
 * Add a pool. Returns the new list. A name that already exists (case-insensitive)
 * is updated in place rather than duplicated, so add is idempotent on name.
 */
export function addPool(entry: PoolEntry, path: string = POOLS_FILE): PoolEntry[] {
  const pools = readExtraPools(path);
  const i = pools.findIndex((p) => p.name.toLowerCase() === entry.name.trim().toLowerCase());
  if (i >= 0) pools[i] = entry;
  else pools.push(entry);
  writeExtraPools(pools, path);
  return pools;
}

/** Replace the pool at `index` with `entry`. Out-of-range index is a no-op. */
export function updatePool(index: number, entry: PoolEntry, path: string = POOLS_FILE): PoolEntry[] {
  const pools = readExtraPools(path);
  if (index < 0 || index >= pools.length) return pools;
  pools[index] = entry;
  writeExtraPools(pools, path);
  return pools;
}

/** Remove the pool at `index`. Out-of-range index is a no-op. */
export function removePool(index: number, path: string = POOLS_FILE): PoolEntry[] {
  const pools = readExtraPools(path);
  if (index < 0 || index >= pools.length) return pools;
  pools.splice(index, 1);
  writeExtraPools(pools, path);
  return pools;
}
