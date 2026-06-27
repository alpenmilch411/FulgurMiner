import { test } from 'node:test';
import assert from 'node:assert/strict';
import { idleFractionFromCpuDeltas } from './demand.js';

test('idleFractionFromCpuDeltas = idle share of total tick delta', () => {
  const prev = [{ user: 100, nice: 0, sys: 50, idle: 850, irq: 0 }];
  const next = [{ user: 200, nice: 0, sys: 100, idle: 1700, irq: 0 }]; // d: user100 sys50 idle850 => total 1000
  assert.equal(idleFractionFromCpuDeltas(prev as any, next as any), 0.85);
});
test('returns null when no time elapsed', () => {
  const same = [{ user: 1, nice: 0, sys: 1, idle: 1, irq: 0 }];
  assert.equal(idleFractionFromCpuDeltas(same as any, same as any), null);
});
