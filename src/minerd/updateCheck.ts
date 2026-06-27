// src/minerd/updateCheck.ts — fail-silent update nudge from the POOL's version
// signaling. The npm-registry poll was removed (the miner has no npm package): the
// miner runs from source (git clone → npm install → npm start), so an update is a
// `git pull` from the public repo (REPO_URL). The pool 426 / minMinerVersion hard
// gate still drives a `mustUpdate` notice (see poolClient).
import { VERSION } from './version.js';
import { REPO_URL } from './config.js';
import type { UpdateNotice, MinerReporter } from './reporter.js';

let lastNotice: UpdateNotice | null = null;

export function getLastNotice(): UpdateNotice | null {
  return lastNotice;
}

export function semverLt(a: string, b: string): boolean {
  const pa = a.split('.').map(Number); const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) { const x = pa[i] ?? 0; const y = pb[i] ?? 0; if (x !== y) return x < y; }
  return false;
}

/** How to update — the miner runs from source, so it's a `git pull` from the repo. */
export function updateCommand(): string {
  return `git pull && npm install   (${REPO_URL})`;
}

export async function checkForUpdate(opts: {
  reporter: MinerReporter;
  poolVersionFields?: { latestMinerVersion?: string | null; minMinerVersion?: string | null; notice?: string | null; releaseNotesUrl?: string | null };
  signal?: AbortSignal;
}): Promise<UpdateNotice | null> {
  if (process.env.FULGUR_NO_UPDATE_CHECK) return null;
  const pf = opts.poolVersionFields ?? {};
  // Latest version comes from the pool's signaling only (no npm registry poll).
  const latest = pf.latestMinerVersion ?? undefined;
  const mustUpdate = !!(pf.minMinerVersion && semverLt(VERSION, pf.minMinerVersion));
  const hasUpdate = !!(latest && semverLt(VERSION, latest));
  if (!hasUpdate && !mustUpdate && !pf.notice) return null;
  const notice: UpdateNotice & { releaseNotesUrl?: string } = {
    currentVersion: VERSION,
    latestVersion: latest,
    mustUpdate,
    notice: pf.notice ?? undefined,
    releaseNotesUrl: pf.releaseNotesUrl ?? undefined,
  };
  lastNotice = notice;
  opts.reporter.updateNotice?.(notice);
  return notice;
}
