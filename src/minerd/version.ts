// src/minerd/version.ts — single source of the running version (for UA + updater)
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const pkgPath = join(dirname(fileURLToPath(import.meta.url)), '../../package.json');
export const VERSION: string = (JSON.parse(readFileSync(pkgPath, 'utf8')) as { version: string }).version;

/** Minimum supported Node (matches package.json "engines"). */
const MIN_NODE = [20, 6, 0] as const;

/** True iff `v` (an "x.y.z" string) is >= the minimum supported Node. */
export function nodeVersionOk(v: string = process.versions.node): boolean {
  const p = v.replace(/^v/i, '').split('.').map((n) => Number.parseInt(n, 10));
  for (let i = 0; i < 3; i++) {
    const x = p[i] ?? 0; const y = MIN_NODE[i];
    if (x !== y) return x > y;
  }
  return true;
}

/** Print a friendly message and exit(1) when Node is too old. Called at every entry
 *  point so an old-Node user gets clear guidance instead of a cryptic crash deep in
 *  the miner. */
export function assertNodeVersion(): void {
  if (nodeVersionOk()) return;
  const min = MIN_NODE.join('.');
  process.stderr.write(
    `\n  FulgurMiner needs Node.js ${min} or newer — you have ${process.versions.node}.\n` +
    `  Install the latest LTS from https://nodejs.org, then run it again.\n\n`,
  );
  process.exit(1);
}
