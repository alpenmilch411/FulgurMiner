import { test } from 'node:test';
import assert from 'node:assert/strict';
import { semverLt, updateCommand } from './updateCheck.js';

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
