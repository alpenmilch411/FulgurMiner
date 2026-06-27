// src/minerd/version.ts — single source of the running version (for UA + updater)
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const pkgPath = join(dirname(fileURLToPath(import.meta.url)), '../../package.json');
export const VERSION: string = (JSON.parse(readFileSync(pkgPath, 'utf8')) as { version: string }).version;
