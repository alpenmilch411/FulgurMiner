import type { DemandSignal } from './demand.js';

export interface ThrottleSink { setThrottle(t: number): void }
export interface SmartConfig {
  dwellMs?: number; step?: number; improveMargin?: number;
  ewmaAlpha?: number; reprobeEveryMs?: number; start?: number;
}
export interface SmartDemandOptions {
  demand?: DemandSignal;
  headroom?: number;
}
interface ResolvedSmartDemandOptions {
  demand?: DemandSignal;
  headroom: number;
}
const CLAMP = (t: number) => Math.min(1, Math.max(0.05, t));
const BACKOFF_GAIN = 3;

export class SmartController {
  private t: number; private bestT: number; private bestHps = 0;
  private applied: number;
  private ewma = 0; private seeded = false;
  private dir = 1; private holding = false;
  private windowStart: number; private lastReprobe: number;
  private readonly cfg: Required<SmartConfig>;
  private readonly opts: ResolvedSmartDemandOptions;
  private demandAllowed = 1;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private sink: ThrottleSink,
    cfg: SmartConfig = {},
    private now: () => number = Date.now,
    opts: SmartDemandOptions = {},
  ) {
    this.cfg = {
      dwellMs: cfg.dwellMs ?? 25_000, step: cfg.step ?? 0.05,
      improveMargin: cfg.improveMargin ?? 0.01, ewmaAlpha: cfg.ewmaAlpha ?? 0.3,
      reprobeEveryMs: cfg.reprobeEveryMs ?? 240_000, start: cfg.start ?? 0.75,
    };
    this.opts = {
      demand: opts.demand,
      headroom: opts.headroom ?? 0.25,
    };
    this.t = CLAMP(this.cfg.start); this.applied = this.t; this.bestT = this.t;
    this.windowStart = this.now(); this.lastReprobe = this.now();
    this.sink.setThrottle(this.t);
  }

  currentThrottle(): number { return this.t; }
  appliedThrottle(): number { return this.applied; }
  isClamped(): boolean { return this.applied < this.t - 1e-9; }

  /** Coarse live phase for the UI: 'easing' = demand is holding it below the thermal
   *  target (Considerate yielding); 'ramping' = still climbing toward the max;
   *  'holding' = settled at the sustainable max/knee. */
  phase(): 'ramping' | 'holding' | 'easing' {
    if (this.applied < this.t - 1e-9) return 'easing';
    return this.holding ? 'holding' : 'ramping';
  }

  onHashrate(hps: number): void {
    if (!this.seeded) { this.ewma = hps; this.seeded = true; }
    else this.ewma = this.cfg.ewmaAlpha * hps + (1 - this.cfg.ewmaAlpha) * this.ewma;
  }

  tick(): void {
    const now = this.now();

    // ── Fast loop (EVERY tick): demand headroom. ──
    // This must react on the ~1s tick cadence, NOT the slow thermal dwell.
    const idleFrac = this.opts.demand?.cpuIdleFraction() ?? null;
    if (idleFrac === null) this.demandAllowed = 1;                 // unknown -> don't limit (Max)
    else {
      const err = idleFrac - this.opts.headroom;                  // >0 surplus idle, <0 over budget
      if (err >= 0) {
        this.demandAllowed = CLAMP(this.demandAllowed + this.cfg.step);
      } else {
        // Back off fast, proportional to how far idle is below the headroom
        // target, so a sudden CPU spike yields in ~1-2 ticks instead of ~15s.
        this.demandAllowed = CLAMP(this.demandAllowed - Math.max(this.cfg.step, -err * BACKOFF_GAIN));
      }
    }

    // ── Slow loop (every dwell window): thermal hill-climb on smoothed H/s. ──
    // Skip learning when demand held the throttle below the thermal target:
    // that window's hashrate doesn't reflect this.t, so it must not corrupt the climb.
    if (now - this.windowStart >= this.cfg.dwellMs) {
      this.windowStart = now;
      const limited = this.demandAllowed < this.t - 1e-9;
      if (!limited) {
        const hps = this.ewma;
        if (now - this.lastReprobe >= this.cfg.reprobeEveryMs) {
          this.lastReprobe = now; this.holding = false; this.dir = 1; // resume climbing
        }
        if (!this.holding) {
          const improved = hps > this.bestHps * (1 + this.cfg.improveMargin);
          if (improved) {
            this.bestHps = hps; this.bestT = this.t;
            this.t = CLAMP(this.t + this.dir * this.cfg.step);
            if (this.t === this.bestT) this.holding = true; // hit a clamp
          } else {
            // knee: revert to best and hold with hysteresis
            this.t = this.bestT; this.bestHps = hps; this.holding = true;
          }
        }
      }
    }

    const applied = Math.min(this.t, this.demandAllowed);
    this.applied = applied;
    this.sink.setThrottle(applied);
  }

  start(): void { if (!this.timer) this.timer = setInterval(() => this.tick(), 1000); }
  stop(): void { if (this.timer) { clearInterval(this.timer); this.timer = null; } }
}
