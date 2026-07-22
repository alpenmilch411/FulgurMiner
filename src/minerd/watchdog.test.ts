import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  watchdogDecision,
  WATCHDOG_STALL_MS,
  WATCHDOG_BOOT_GRACE_MS,
  WATCHDOG_RESPAWN_AFTER_STRIKES,
} from './poolClient.js';

// The pool grind watchdog recovers an ACTIVE job that stops producing hashes. The old
// version respawned ALL workers on the FIRST 12s stall, which on a constrained VPS costs
// more than the stall window and self-sustains ("keep getting no hashes for >12s —
// restarting grind"). watchdogDecision escalates instead, and distinguishes two states:
//   - a grind that has NOT produced a hash yet (booting / re-issued): judged by time
//     since the episode (re)started, with a BOOT grace so a slow worker isn't killed
//     mid-boot;
//   - a grind that WAS producing and went silent: judged by time since the last hash
//     (STALL), independent of job churn so ordinary job changes can't mask a real stall.
// First (K-1) strikes re-apply the job to existing workers (cheap); the Kth respawns.

const OK = 'ok';
const pastStall = WATCHDOG_STALL_MS + 1;
const pastBoot = WATCHDOG_BOOT_GRACE_MS + 1;

const base = {
  stopped: false,
  hasActiveJob: true,
  producing: true,
  msSinceTick: 0,
  msSinceGrindStart: pastBoot,
  strikes: 0,
};

test('watchdogDecision: dormant when the pool is stopped', () => {
  assert.equal(watchdogDecision({ ...base, stopped: true, producing: false, msSinceGrindStart: pastBoot }), OK);
});

test('watchdogDecision: dormant when there is no active job (idle between jobs)', () => {
  assert.equal(watchdogDecision({ ...base, hasActiveJob: false, producing: false, msSinceGrindStart: pastBoot }), OK);
});

test('watchdogDecision: producing + recent hash (within stall) is ok', () => {
  assert.equal(watchdogDecision({ ...base, producing: true, msSinceTick: WATCHDOG_STALL_MS }), OK);
});

test('watchdogDecision: producing but silent past the stall → escalate (re-apply first)', () => {
  assert.equal(watchdogDecision({ ...base, producing: true, msSinceTick: pastStall, strikes: 0 }), 're-apply');
});

test('watchdogDecision: a producing-then-stalled grind is NOT shielded by a fresh grindStart (job churn cannot mask a stall)', () => {
  // Regression for the job-churn blind spot: once producing, the decision keys on
  // msSinceTick, NOT the boot clock — a recently-reset grindStart must not suppress it.
  assert.equal(watchdogDecision({ ...base, producing: true, msSinceTick: pastStall, msSinceGrindStart: 0, strikes: 0 }), 're-apply');
});

test('watchdogDecision: not-yet-producing within the boot grace is ok (slow worker still booting)', () => {
  assert.equal(watchdogDecision({ ...base, producing: false, msSinceGrindStart: WATCHDOG_BOOT_GRACE_MS }), OK);
});

test('watchdogDecision: not-yet-producing past the boot grace → escalate', () => {
  assert.equal(watchdogDecision({ ...base, producing: false, msSinceGrindStart: pastBoot, strikes: 0 }), 're-apply');
});

test('watchdogDecision: a persistent stall (enough strikes) escalates to a respawn', () => {
  assert.equal(
    watchdogDecision({ ...base, producing: true, msSinceTick: pastStall, strikes: WATCHDOG_RESPAWN_AFTER_STRIKES - 1 }),
    'respawn',
  );
});

test('watchdogDecision: strikes below the respawn threshold keep re-applying', () => {
  const strikes = Math.max(0, WATCHDOG_RESPAWN_AFTER_STRIKES - 2);
  assert.equal(
    watchdogDecision({ ...base, producing: false, msSinceGrindStart: pastBoot, strikes }),
    WATCHDOG_RESPAWN_AFTER_STRIKES <= 1 ? 'respawn' : 're-apply',
  );
});
