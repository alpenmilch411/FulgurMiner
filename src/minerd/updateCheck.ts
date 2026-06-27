// src/minerd/updateCheck.ts — fail-silent update nudge. The newest published
// version is read from the public repo's LATEST GITHUB RELEASE (tag_name), so it
// is authoritative + self-maintaining (no hand-kept version field anywhere) and
// reaches SOLO miners too — they never talk to the pool. The miner runs from
// source, so applying an update is a `git pull` from the repo (REPO_URL). The pool
// still supplies a free-form `notice` (e.g. a fork heads-up) and the 426 /
// minMinerVersion hard gate; GitHub only supplies "what's the latest version".
import { VERSION } from './version.js';
import { REPO_URL, GITHUB_LATEST_RELEASE_API } from './config.js';
import { fetchJsonWithTimeout } from './timedFetch.js';
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

/** Parse a GitHub release `tag_name` ("v0.2.3" / "0.2.3") into a bare semver, or
 *  null if it isn't an `x.y.z`. Exported for unit testing. */
export function parseReleaseTag(tag: unknown): string | null {
  if (typeof tag !== 'string') return null;
  const v = tag.trim().replace(/^v/i, '');
  return /^\d+\.\d+\.\d+$/.test(v) ? v : null;
}

/** Fetch the latest published version from the repo's GitHub release. Fail-silent:
 *  any error (offline, rate-limited, non-2xx, unparseable) returns null and the
 *  check is simply skipped. Bounded by a short timeout so startup never hangs. */
export async function fetchLatestVersion(
  signal?: AbortSignal,
  doFetch: typeof fetch = fetch,
): Promise<string | null> {
  try {
    const r = await fetchJsonWithTimeout(
      GITHUB_LATEST_RELEASE_API,
      {
        headers: { 'User-Agent': `FulgurMiner/${VERSION}`, Accept: 'application/vnd.github+json' },
        signal,
      },
      5000,
      doFetch,
    );
    if (!r.ok || !r.body) return null;
    return parseReleaseTag((r.body as { tag_name?: unknown }).tag_name);
  } catch {
    return null;
  }
}

/** How to update — the miner runs from source, so it's a `git pull` from the repo. */
export function updateCommand(): string {
  return `git pull && npm install   (${REPO_URL})`;
}

export async function checkForUpdate(opts: {
  reporter: MinerReporter;
  poolVersionFields?: { latestMinerVersion?: string | null; minMinerVersion?: string | null; notice?: string | null; releaseNotesUrl?: string | null };
  signal?: AbortSignal;
  /** Injectable fetch for tests; defaults to global fetch. */
  doFetch?: typeof fetch;
}): Promise<UpdateNotice | null> {
  if (process.env.FULGUR_NO_UPDATE_CHECK) return null;
  const pf = opts.poolVersionFields ?? {};
  // Latest version: prefer the GitHub release; fall back to / take the max of any
  // pool-advertised version (so a pool that signals a newer build still works).
  const github = await fetchLatestVersion(opts.signal, opts.doFetch);
  // Target version = the max of GitHub's release, any pool-advertised latest, AND
  // the pool's required-minimum — so a 426 gate to a not-yet-released version still
  // shows a real "-> vX" target instead of "-> v?". (minMinerVersion can only raise
  // the target above VERSION when we're behind it, i.e. exactly the mustUpdate case.)
  const candidates = [github, pf.latestMinerVersion ?? null, pf.minMinerVersion ?? null]
    .filter((v): v is string => !!v);
  const latest = candidates.length
    ? candidates.reduce((a, b) => (semverLt(a, b) ? b : a))
    : undefined;
  const mustUpdate = !!(pf.minMinerVersion && semverLt(VERSION, pf.minMinerVersion));
  // `available` is true ONLY when we are genuinely behind the latest. A notice with
  // no real update (e.g. a fork heads-up while already current) must NOT render as
  // "update available v_cur -> v_old" — the renderers key off `available`.
  const available = !!(latest && semverLt(VERSION, latest));
  if (!available && !mustUpdate && !pf.notice) return null;
  const notice: UpdateNotice & { releaseNotesUrl?: string } = {
    currentVersion: VERSION,
    latestVersion: latest,
    available,
    mustUpdate,
    notice: pf.notice ?? undefined,
    releaseNotesUrl: pf.releaseNotesUrl ?? undefined,
  };
  lastNotice = notice;
  opts.reporter.updateNotice?.(notice);
  return notice;
}
