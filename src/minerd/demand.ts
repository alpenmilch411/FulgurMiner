import os from 'node:os';
export interface DemandSignal { cpuIdleFraction(): number | null }
type CpuTimes = os.CpuInfo['times'];

export function idleFractionFromCpuDeltas(prev: CpuTimes[], next: CpuTimes[]): number | null {
  let idle = 0, total = 0;
  for (let i = 0; i < next.length; i++) {
    const p = prev[i], n = next[i];
    if (!p || !n) continue;
    idle += n.idle - p.idle;
    total += (n.user - p.user) + (n.nice - p.nice) + (n.sys - p.sys) + (n.idle - p.idle) + (n.irq - p.irq);
  }
  return total > 0 ? idle / total : null;
}

export function createDemandSignal(): DemandSignal {
  let prev = os.cpus().map((c) => c.times);
  return {
    cpuIdleFraction(): number | null {
      const next = os.cpus().map((c) => c.times);
      const f = idleFractionFromCpuDeltas(prev, next);
      prev = next;
      return f;
    },
  };
}
