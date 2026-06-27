// Unit tests for the update-check logic (node:test). Covers the GitHub release-tag
// parsing, semver compare, the Node-version guard, and — the core of the v0.2.2/0.2.3
// fix — that an "update available" line is produced ONLY when genuinely behind, while
// a bare pool `notice` (e.g. a fork heads-up while already current) does NOT.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseReleaseTag, semverLt, updateCommand, checkForUpdate } from './updateCheck.js';
import { nodeVersionOk, VERSION } from './version.js';
import type { MinerReporter, UpdateNotice } from './reporter.js';

/** A reporter that only captures updateNotice() calls. */
function captureReporter(): { notices: UpdateNotice[]; reporter: MinerReporter } {
  const notices: UpdateNotice[] = [];
  const reporter = { updateNotice: (n: UpdateNotice) => notices.push(n) } as unknown as MinerReporter;
  return { notices, reporter };
}

/** A fake fetch whose response yields the given GitHub release JSON body. */
function fakeFetch(body: unknown, ok = true, status = 200): typeof fetch {
  return (async () => ({
    ok,
    status,
    headers: new Headers(),
    text: async () => JSON.stringify(body),
  })) as unknown as typeof fetch;
}

test('semverLt: numeric, not lexical', () => {
  assert.equal(semverLt('0.1.0', '0.2.0'), true);
  assert.equal(semverLt('1.0.0', '1.0.0'), false);
  assert.equal(semverLt('0.9.9', '1.0.0'), true);
  assert.equal(semverLt('1.2.3', '1.2.10'), true);   // numeric: 3 < 10
  assert.equal(semverLt('1.2.10', '1.2.3'), false);
});

test('updateCommand: a git-pull-from-source instruction with the repo link (no npm/npx)', () => {
  const cmd = updateCommand();
  assert.match(cmd, /git pull/);
  assert.match(cmd, /github\.com\/alpenmilch411\/FulgurMiner/);
  assert.doesNotMatch(cmd, /npm i -g|npx/); // runs from source — no npm/npx install commands
});

test('parseReleaseTag accepts v-prefixed and bare semver, rejects junk', () => {
  assert.equal(parseReleaseTag('v0.2.3'), '0.2.3');
  assert.equal(parseReleaseTag('0.2.3'), '0.2.3');
  assert.equal(parseReleaseTag('V1.2.3'), '1.2.3');
  assert.equal(parseReleaseTag('v0.2.3-rc1'), null); // not x.y.z
  assert.equal(parseReleaseTag('latest'), null);
  assert.equal(parseReleaseTag(123), null);
  assert.equal(parseReleaseTag(undefined), null);
});

test('nodeVersionOk: boundary around 20.6.0', () => {
  assert.equal(nodeVersionOk('20.6.0'), true);
  assert.equal(nodeVersionOk('20.5.9'), false);
  assert.equal(nodeVersionOk('18.20.0'), false);
  assert.equal(nodeVersionOk('22.12.0'), true);
  assert.equal(nodeVersionOk('20.19.0'), true);
  assert.equal(nodeVersionOk('v20.6.0'), true); // tolerate a pasted `node --version`
});

test('checkForUpdate: newer GitHub release → available=true', async () => {
  const { notices, reporter } = captureReporter();
  const n = await checkForUpdate({ reporter, doFetch: fakeFetch({ tag_name: 'v999.0.0' }) });
  assert.ok(n);
  assert.equal(n.available, true);
  assert.equal(n.latestVersion, '999.0.0');
  assert.equal(n.mustUpdate, false);
  assert.equal(notices.length, 1);
});

test('checkForUpdate: bare pool notice while current → notice shown, available=false (the v0.2.2 bug)', async () => {
  const { notices, reporter } = captureReporter();
  // GitHub reports an OLDER tag than us (we're current); pool sends a notice.
  const n = await checkForUpdate({
    reporter,
    doFetch: fakeFetch({ tag_name: 'v0.0.1' }),
    poolVersionFields: { latestMinerVersion: '0.0.1', notice: 'Heads-up: fork on 2026-07-05' },
  });
  assert.ok(n);
  assert.equal(n.available, false);                       // NOT "update available"
  assert.equal(n.notice, 'Heads-up: fork on 2026-07-05'); // the notice is carried
  assert.equal(notices.length, 1);
});

test('checkForUpdate: no update + no notice → null (nothing rendered)', async () => {
  const { notices, reporter } = captureReporter();
  const n = await checkForUpdate({ reporter, doFetch: fakeFetch({ tag_name: 'v0.0.1' }) });
  assert.equal(n, null);
  assert.equal(notices.length, 0);
});

test('checkForUpdate: minMinerVersion above us → mustUpdate', async () => {
  const { reporter } = captureReporter();
  const n = await checkForUpdate({
    reporter,
    doFetch: fakeFetch({ tag_name: 'v0.0.1' }),
    poolVersionFields: { minMinerVersion: '999.0.0' },
  });
  assert.ok(n);
  assert.equal(n.mustUpdate, true);
  assert.equal(n.latestVersion, '999.0.0'); // target reflects the required version, not "?"
});

test('checkForUpdate: GitHub unreachable is fail-silent (no throw)', async () => {
  const { reporter } = captureReporter();
  const throwingFetch = (async () => { throw new Error('network down'); }) as unknown as typeof fetch;
  const n = await checkForUpdate({ reporter, doFetch: throwingFetch });
  assert.equal(n, null);
});

test('checkForUpdate: FULGUR_NO_UPDATE_CHECK opts out', async () => {
  const prev = process.env.FULGUR_NO_UPDATE_CHECK;
  process.env.FULGUR_NO_UPDATE_CHECK = '1';
  try {
    const { reporter } = captureReporter();
    const n = await checkForUpdate({ reporter, doFetch: fakeFetch({ tag_name: 'v999.0.0' }) });
    assert.equal(n, null);
  } finally {
    if (prev === undefined) delete process.env.FULGUR_NO_UPDATE_CHECK;
    else process.env.FULGUR_NO_UPDATE_CHECK = prev;
  }
});

test('VERSION is a sane semver (sanity)', () => {
  assert.match(VERSION, /^\d+\.\d+\.\d+$/);
});
