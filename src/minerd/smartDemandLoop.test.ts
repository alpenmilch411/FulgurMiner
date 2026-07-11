import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SmartController } from './smartController.js';
import type { CpuReading, DemandSignal } from './demand.js';

// CLOSED-LOOP tests for Smart: Considerate.
//
// Every pre-existing demand test feeds the controller a CONSTANT idle fraction — which
// cannot express a feedback loop at all, and is exactly why the VPS sawtooth shipped.
// Here the measured idle is a FUNCTION of the duty the controller just applied:
//
//     busy      = min(capacity, workers·duty + competitorCores)
//     idleShare = (capacity − busy) / capacity
//
// so the signal moves with slope λ = workers/capacity against our own action, like the
// real machine does. The fixed point is where idleShare == headroom:
//
//     duty* = (capacity·(1 − headroom) − competitorCores) / workers
//
// A loop that oscillates instead of settling fails these tests; the shipped one does.

interface Plant {
  capacity: number;      // cores we can actually use
  workers: number;       // grind workers
  competitor: number;    // cores wanted by everything else
}

/** Drive the controller against the plant and return the applied-duty trace. */
function run(plant: Plant, ticks: number, headroom = 0.25, onTick?: (i: number) => void): number[] {
  let duty = 1;
  const sink = { setThrottle: (t: number) => { duty = t; } };
  const demand: DemandSignal = {
    cpuIdleFraction: () => null,
    read: (): CpuReading => {
      const busy = Math.min(plant.capacity, plant.workers * duty + plant.competitor);
      return {
        idleShare: Math.max(0, (plant.capacity - busy) / plant.capacity),
        capacityCores: plant.capacity,
        source: 'cgroup',
      };
    },
  };
  let now = 0;
  const sc = new SmartController(
    sink,
    // Dwell huge so the thermal hill-climb never runs: this isolates the demand loop.
    // start:1 puts the thermal ceiling at the top (applied = min(t, demandAllowed)), so
    // demandAllowed is the only thing binding — otherwise the ceiling, frozen at the
    // start value, would cap the duty below its own fixed point and mask the result.
    { dwellMs: 10_000_000, start: 1, step: 0.05 },
    () => now,
    { demand, headroom, workers: plant.workers },
  );
  const trace: number[] = [];
  for (let i = 0; i < ticks; i++) {
    now += 1000;
    sc.tick();
    trace.push(duty);
    onTick?.(i);
  }
  return trace;
}

const settled = (trace: number[], n = 20): number[] => trace.slice(-n);
const peakToPeak = (xs: number[]): number => Math.max(...xs) - Math.min(...xs);
const fixedPoint = (p: Plant, h = 0.25): number => (p.capacity * (1 - h) - p.competitor) / p.workers;

test('CL-1 bare-metal desktop: same fixed point as before, and it SETTLES (no limit cycle)', () => {
  // 8 cores, 7 workers, a light background load. This is the no-regression case: the
  // desktop keeps its 25% headroom and must land where it always did (~0.84 duty).
  const plant: Plant = { capacity: 8, workers: 7, competitor: 0.1 };
  const trace = run(plant, 80);
  const tail = settled(trace);
  assert.ok(
    peakToPeak(tail) <= 0.06,
    `must settle, not hunt. peak-to-peak=${peakToPeak(tail).toFixed(3)} tail=${tail.slice(-6).join(',')}`,
  );
  const want = fixedPoint(plant); // 0.843
  assert.ok(
    Math.abs(tail[tail.length - 1] - want) < 0.08,
    `settles at the headroom fixed point ~${want.toFixed(2)}, got ${tail[tail.length - 1].toFixed(2)}`,
  );
});

test('CL-2 container alone: uses the whole allowance minus the headroom, stable', () => {
  // A 2-CPU quota, 2 workers, nothing else in the cgroup. THE REPORTED BUG: the miner
  // used to read the 32-core HOST's idle here, which its own throttle barely moved →
  // feedback decoupled from action → 0-100-0-100. Reading our own cgroup, it settles.
  const plant: Plant = { capacity: 2, workers: 2, competitor: 0 };
  const trace = run(plant, 80);
  const tail = settled(trace);
  assert.ok(peakToPeak(tail) <= 0.06, `no sawtooth: peak-to-peak=${peakToPeak(tail).toFixed(3)}`);
  assert.ok(
    Math.abs(tail[tail.length - 1] - 0.75) < 0.08,
    `settles at ~0.75 (25% reserved of a 2-core box), got ${tail[tail.length - 1].toFixed(2)}`,
  );
});

test('CL-3 container + co-tenant: yields the co-tenant its cores, fast', () => {
  // A 0.5-core neighbour appears in the same cgroup. Considerate must give way — this
  // is the branch a zero headroom would have made unreachable (err = idle − h ≥ 0
  // always ⇒ the down-step is dead code ⇒ Considerate silently becomes Max).
  const alone: Plant = { capacity: 2, workers: 2, competitor: 0 };
  const shared: Plant = { capacity: 2, workers: 2, competitor: 0.5 };

  const before = settled(run(alone, 60)).pop()!;
  const after = settled(run(shared, 60)).pop()!;
  assert.ok(after < before, `yields when a neighbour shows up: ${after.toFixed(2)} < ${before.toFixed(2)}`);
  assert.ok(
    Math.abs(after - fixedPoint(shared)) < 0.08, // 0.5
    `the neighbour gets its full 0.5 core: duty ~${fixedPoint(shared).toFixed(2)}, got ${after.toFixed(2)}`,
  );
});

test('CL-4 steal VM: steal is lost capacity, not a competitor — full use of what is left', () => {
  // 4 vCPU at 50% steal = 2 usable cores, 3 workers. Steal must shrink the capacity
  // (it does: demand.ts sizes capacityCores by 1 − steal) without ever being counted
  // as someone else's work — otherwise the miner throttles against a phantom.
  const plant: Plant = { capacity: 2, workers: 3, competitor: 0 };
  const trace = run(plant, 80);
  const tail = settled(trace);
  assert.ok(peakToPeak(tail) <= 0.06, `stable under steal: peak-to-peak=${peakToPeak(tail).toFixed(3)}`);
  assert.ok(
    Math.abs(tail[tail.length - 1] - 0.5) < 0.08, // (2*0.75)/3
    `uses 75% of the 2 real cores, got duty ${tail[tail.length - 1].toFixed(2)}`,
  );
});

test('CL-5 competitor arrives then leaves: yields within a tick or two, recovers', () => {
  const plant: Plant = { capacity: 8, workers: 7, competitor: 0 };
  let duty = 1;
  const sink = { setThrottle: (t: number) => { duty = t; } };
  const demand: DemandSignal = {
    cpuIdleFraction: () => null,
    read: (): CpuReading => {
      const busy = Math.min(plant.capacity, plant.workers * duty + plant.competitor);
      return { idleShare: Math.max(0, (plant.capacity - busy) / plant.capacity), capacityCores: plant.capacity, source: 'procstat' };
    },
  };
  let now = 0;
  const sc = new SmartController(sink, { dwellMs: 10_000_000, start: 1, step: 0.05 }, () => now,
    { demand, headroom: 0.25, workers: plant.workers });

  for (let i = 0; i < 40; i++) { now += 1000; sc.tick(); }
  const idleDuty = duty;

  plant.competitor = 5; // a build kicks off and wants 5 cores
  now += 1000; sc.tick();
  const afterOneTick = duty;
  assert.ok(afterOneTick < idleDuty - 0.1, `backs off hard within ONE tick: ${afterOneTick.toFixed(2)} << ${idleDuty.toFixed(2)}`);

  for (let i = 0; i < 20; i++) { now += 1000; sc.tick(); }
  assert.ok(duty < 0.25, `stays out of the build's way: ${duty.toFixed(2)}`);

  plant.competitor = 0; // build finishes
  for (let i = 0; i < 60; i++) { now += 1000; sc.tick(); }
  assert.ok(duty > 0.7, `recovers when the CPU frees up: ${duty.toFixed(2)}`);
});

test('CL-6 GAIN SWEEP: stable for every plant slope (this is what the old gain of 3 broke)', () => {
  // λ = workers/capacity is what the loop gain must be normalized by. The old fixed
  // BACKOFF_GAIN=3 gave G·λ = 2.6 on a plain desktop (λ=0.875) — past the |1−G·λ|<1
  // stability bound — and up to 24 on an oversubscribed box. It hunted forever.
  for (const [capacity, workers] of [[8, 4], [8, 7], [2, 2], [2, 3], [1, 4], [2, 16]]) {
    const plant: Plant = { capacity, workers, competitor: 0 };
    const tail = settled(run(plant, 120), 25);
    assert.ok(
      peakToPeak(tail) <= 0.08,
      `λ=${(workers / capacity).toFixed(2)} (${workers}w/${capacity}c) must converge, `
      + `peak-to-peak=${peakToPeak(tail).toFixed(3)}`,
    );
  }
});

test('CL-7 deadband: a reading already at the headroom does not dither', () => {
  const flat: DemandSignal = {
    cpuIdleFraction: () => null,
    read: (): CpuReading => ({ idleShare: 0.25, capacityCores: 8, source: 'procstat' }),
  };
  let duty = 0.6;
  const sink = { setThrottle: (t: number) => { duty = t; } };
  let now = 0;
  const sc = new SmartController(sink, { dwellMs: 10_000_000, start: 0.6, step: 0.05 }, () => now,
    { demand: flat, headroom: 0.25, workers: 7 });
  for (let i = 0; i < 30; i++) { now += 1000; sc.tick(); }
  assert.equal(duty, 0.6, 'sitting exactly on the setpoint must produce NO movement');
});

test('CL-8 an unreadable signal never limits (degrades to Max, never to the floor)', () => {
  const dead: DemandSignal = { cpuIdleFraction: () => null, read: () => null };
  let duty = 0;
  const sink = { setThrottle: (t: number) => { duty = t; } };
  let now = 0;
  const sc = new SmartController(sink, { dwellMs: 10_000_000, start: 0.8, step: 0.05 }, () => now,
    { demand: dead, headroom: 0.25, workers: 4 });
  for (let i = 0; i < 10; i++) { now += 1000; sc.tick(); }
  assert.equal(duty, 0.8, 'a null reading must not throttle us — unknown is not "busy"');
});
