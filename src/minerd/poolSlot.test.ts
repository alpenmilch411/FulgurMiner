import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isValidSlot, isValidJob, jobRestartKey, shouldRegrind, resolveJobPollMs } from './poolClient.js';

const HDR = 'a'.repeat(296); // a 148-byte header (HEADER_LEN*2), valid hex
const TGT = '00ab3e' + '0'.repeat(58); // a 32-byte share target (64 hex)

test('isValidSlot: accepts a real pool slot, rejects missing/degenerate/out-of-range', () => {
  assert.equal(isValidSlot(8388608, 12582912), true);   // a real served slot
  assert.equal(isValidSlot(0, 0x1_0000_0000), true);     // full space is valid
  assert.equal(isValidSlot(0, 0), false);                // zero-width
  assert.equal(isValidSlot(100, 100), false);            // zero-width
  assert.equal(isValidSlot(200, 100), false);            // inverted
  assert.equal(isValidSlot(-1, 100), false);             // negative start
  assert.equal(isValidSlot(0, 0x1_0000_0001), false);    // past 2^32
  assert.equal(isValidSlot(undefined, 100), false);      // missing
  assert.equal(isValidSlot(1.5, 100), false);            // non-integer
  assert.equal(isValidSlot('0', '100'), false);          // wrong type
});

test('jobRestartKey: changes when the slot changes even if jobId + target are identical', () => {
  const base = { jobId: '13331-7', shareTargetHex: TGT, headerHex: HDR, nonceStart: 0, nonceEnd: 100 };
  const sameJobNewSlot = { ...base, nonceStart: 100, nonceEnd: 200 };
  assert.notEqual(jobRestartKey(base), jobRestartKey(sameJobNewSlot)); // would restart
  assert.equal(jobRestartKey(base), jobRestartKey({ ...base }));        // identical -> no restart
});

test('jobRestartKey: changes when the HEADER template changes even if jobId+target+slot are identical', () => {
  const base = { jobId: '13331-7', shareTargetHex: TGT, headerHex: HDR, nonceStart: 0, nonceEnd: 100 };
  const sameJobNewHeader = { ...base, headerHex: 'b'.repeat(296) };
  assert.notEqual(jobRestartKey(base), jobRestartKey(sameJobNewHeader)); // must restart on a new template
});

test('shouldRegrind: exhausted key idles until pool serves changed work', () => {
  const exhausted = jobRestartKey({ jobId: '13331-7', shareTargetHex: TGT, headerHex: HDR, nonceStart: 0, nonceEnd: 100 });
  const changed = jobRestartKey({ jobId: '13331-8', shareTargetHex: TGT, headerHex: HDR, nonceStart: 0, nonceEnd: 100 });

  assert.equal(shouldRegrind(exhausted, null, exhausted), false);
  assert.equal(shouldRegrind(changed, null, exhausted), true);
  assert.equal(shouldRegrind(changed, changed, null), false);
});

test('resolveJobPollMs: defaults to 1000ms and honors a valid JOB_POLL_MS', () => {
  // Default when unset/blank — the post-tip-advance "leg 3" window is closed by
  // polling /job every ~1s instead of the old ~3s.
  assert.equal(resolveJobPollMs({}), 1000);
  assert.equal(resolveJobPollMs({ JOB_POLL_MS: '' }), 1000);
  assert.equal(resolveJobPollMs({ JOB_POLL_MS: '   ' }), 1000);
  // A valid override is honored.
  assert.equal(resolveJobPollMs({ JOB_POLL_MS: '1500' }), 1500);
  assert.equal(resolveJobPollMs({ JOB_POLL_MS: '500' }), 500);
});

test('resolveJobPollMs: junk falls back to the default and absurd values are clamped', () => {
  assert.equal(resolveJobPollMs({ JOB_POLL_MS: 'fast' }), 1000); // non-numeric
  assert.equal(resolveJobPollMs({ JOB_POLL_MS: '0' }), 1000);    // non-positive
  assert.equal(resolveJobPollMs({ JOB_POLL_MS: '-5' }), 1000);   // negative
  assert.equal(resolveJobPollMs({ JOB_POLL_MS: '10' }), 250);    // below floor -> clamp up (don't hammer the pool)
  assert.equal(resolveJobPollMs({ JOB_POLL_MS: '999999' }), 60_000); // above ceiling -> clamp down (don't stall refresh)
});

test('isValidJob: accepts a well-formed job, rejects each malformed field', () => {
  const ok = { jobId: '19033-176', headerHex: HDR, shareTargetHex: TGT, nonceStart: 0, nonceEnd: 4194304 };
  assert.equal(isValidJob(ok), true);
  assert.equal(isValidJob({ ...ok, jobId: '' }), false);                       // empty jobId
  assert.equal(isValidJob({ ...ok, jobId: 123 }), false);                      // non-string jobId
  assert.equal(isValidJob({ ...ok, headerHex: 'a'.repeat(294) }), false);      // wrong header length
  assert.equal(isValidJob({ ...ok, headerHex: 'g'.repeat(296) }), false);      // non-hex header
  assert.equal(isValidJob({ ...ok, shareTargetHex: '0004802c' }), false);      // wrong target length
  assert.equal(isValidJob({ ...ok, shareTargetHex: 'zz'.repeat(32) }), false); // non-hex target
  assert.equal(isValidJob({ ...ok, nonceStart: 100, nonceEnd: 100 }), false);  // degenerate slot
  assert.equal(isValidJob({ ...ok, nonceEnd: undefined }), false);             // missing slot field
  assert.equal(isValidJob(null), false);
  assert.equal(isValidJob('nope'), false);
  assert.equal(isValidJob({}), false);
});
