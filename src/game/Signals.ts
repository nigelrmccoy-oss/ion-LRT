/**
 * Traffic-signal phase + TSP + red-light violation helpers (pure where possible).
 * ION street sections use traffic-signal TSP, not railroad searchlights.
 */

export type SignalAspect = 'red' | 'amber' | 'green';

export type SignalDef = {
  id: number;
  x: number;
  z: number;
  s_ion: number;
  dist_m: number;
  kind: string;
  phase_offset_s: number;
  lon?: number;
  lat?: number;
};

export type SignalsFile = {
  cycle_s?: number;
  tsp_approach_m?: number;
  tsp_speed_kmh?: number;
  tsp_wait_s?: number;
  signals: SignalDef[];
};

export type CrossingDef = {
  id: number;
  x: number;
  z: number;
  line: string;
  s: number;
  style: string;
  kind: string;
};

/** Fixed cycle lengths (seconds). */
export const DEFAULT_CYCLE_S = 30;
const GREEN_S = 14;
const AMBER_S = 4;
// red = remainder

export function aspectAtTime(
  tSec: number,
  phaseOffsetS: number,
  cycleS = DEFAULT_CYCLE_S,
  greenBiasS = 0,
): SignalAspect {
  const cycle = Math.max(8, cycleS);
  const green = Math.min(cycle - AMBER_S - 2, GREEN_S + Math.max(0, greenBiasS));
  const amber = AMBER_S;
  const u = ((tSec + phaseOffsetS) % cycle + cycle) % cycle;
  if (u < green) return 'green';
  if (u < green + amber) return 'amber';
  return 'red';
}

/**
 * TSP: if approaching under ~25 km/h and close, bias toward green after a short wait.
 * Returns extra green seconds to inject into the cycle.
 */
export function tspGreenBias(opts: {
  distAlongM: number; // signed distance signal.s - train.s in direction of travel
  absDistM: number;
  speedKmh: number;
  approachM: number;
  speedThreshKmh: number;
  waitS: number;
  timeInApproachS: number;
}): number {
  if (opts.absDistM > opts.approachM) return 0;
  if (opts.speedKmh > opts.speedThreshKmh) return 0;
  // must be approaching (ahead in travel direction) or very close
  if (opts.distAlongM < -15) return 0;
  if (opts.timeInApproachS < opts.waitS) return 0;
  return 8; // extend green / shrink red
}

/** Pure red-run check for tests / end-of-run report. */
export function redSignalViolation(opts: {
  aspect: SignalAspect;
  speedKmh: number;
  distToSignalM: number;
  inStreetRow: boolean;
  stopRadiusM?: number;
  speedStopKmh?: number;
}): boolean {
  if (!opts.inStreetRow) return false;
  if (opts.aspect !== 'red') return false;
  const radius = opts.stopRadiusM ?? 18;
  const vmax = opts.speedStopKmh ?? 8;
  if (opts.distToSignalM > radius) return false;
  return opts.speedKmh > vmax;
}

/** Should the train be held (forced brake) at this red? */
export function shouldHoldForRed(opts: {
  aspect: SignalAspect;
  distToSignalM: number;
  inStreetRow: boolean;
  holdRadiusM?: number;
}): boolean {
  if (!opts.inStreetRow) return false;
  if (opts.aspect !== 'red' && opts.aspect !== 'amber') return false;
  const radius = opts.holdRadiusM ?? 22;
  // Hold only when close and on red; amber is caution (no hard hold if already past)
  if (opts.aspect === 'amber') return opts.distToSignalM < 8;
  return opts.distToSignalM < radius;
}

export class SignalSystem {
  signals: SignalDef[] = [];
  crossings: CrossingDef[] = [];
  cycleS = DEFAULT_CYCLE_S;
  tspApproachM = 80;
  tspSpeedKmh = 25;
  tspWaitS = 2.5;
  /** Per-signal time spent in approach zone (for TSP wait). */
  private approachTimers = new Map<number, number>();
  redViolations = 0;
  private violatedIds = new Set<number>();

  async load(
    signalsUrl = './data/signals.json',
    crossingsUrl = './data/crossings.json',
  ) {
    try {
      const sf = (await (await fetch(signalsUrl)).json()) as SignalsFile;
      this.signals = (sf.signals || []).slice().sort((a, b) => a.s_ion - b.s_ion);
      this.cycleS = sf.cycle_s ?? DEFAULT_CYCLE_S;
      this.tspApproachM = sf.tsp_approach_m ?? 80;
      this.tspSpeedKmh = sf.tsp_speed_kmh ?? 25;
      this.tspWaitS = sf.tsp_wait_s ?? 2.5;
    } catch {
      this.signals = [];
    }
    try {
      const cf = await (await fetch(crossingsUrl)).json();
      this.crossings = cf.crossings || [];
    } catch {
      this.crossings = [];
    }
  }

  nearestAhead(s: number, direction: 1 | -1 | 0, maxM = 120): SignalDef | null {
    if (!this.signals.length || direction === 0) return null;
    let best: SignalDef | null = null;
    let bestD = maxM;
    for (const sig of this.signals) {
      const d = direction > 0 ? sig.s_ion - s : s - sig.s_ion;
      if (d < -5 || d > maxM) continue;
      if (d < bestD) {
        bestD = d;
        best = sig;
      }
    }
    return best;
  }

  aspectFor(
    sig: SignalDef,
    tSec: number,
    trainS: number,
    speedKmh: number,
    direction: 1 | -1 | 0,
    dt: number,
  ): SignalAspect {
    const along = direction >= 0 ? sig.s_ion - trainS : trainS - sig.s_ion;
    const absD = Math.abs(sig.s_ion - trainS);
    let timer = this.approachTimers.get(sig.id) || 0;
    if (absD <= this.tspApproachM && speedKmh <= this.tspSpeedKmh + 5) {
      timer += dt;
    } else {
      timer = 0;
    }
    this.approachTimers.set(sig.id, timer);
    const bias = tspGreenBias({
      distAlongM: along,
      absDistM: absD,
      speedKmh,
      approachM: this.tspApproachM,
      speedThreshKmh: this.tspSpeedKmh,
      waitS: this.tspWaitS,
      timeInApproachS: timer,
    });
    return aspectAtTime(tSec, sig.phase_offset_s, this.cycleS, bias);
  }

  /**
   * Update enforcement for street-running. Returns hold instruction.
   */
  updateEnforcement(opts: {
    tSec: number;
    trainS: number;
    speedKmh: number;
    direction: 1 | -1 | 0;
    inStreetRow: boolean;
    dt: number;
  }): { hold: boolean; aspect: SignalAspect | null; signal: SignalDef | null } {
    const sig = this.nearestAhead(opts.trainS, opts.direction || 1, 50);
    if (!sig || !opts.inStreetRow) {
      return { hold: false, aspect: null, signal: null };
    }
    const aspect = this.aspectFor(
      sig,
      opts.tSec,
      opts.trainS,
      opts.speedKmh,
      opts.direction || 1,
      opts.dt,
    );
    const dist = Math.abs(sig.s_ion - opts.trainS);
    if (
      redSignalViolation({
        aspect,
        speedKmh: opts.speedKmh,
        distToSignalM: dist,
        inStreetRow: opts.inStreetRow,
      })
    ) {
      if (!this.violatedIds.has(sig.id)) {
        this.violatedIds.add(sig.id);
        this.redViolations += 1;
      }
    }
    const hold = shouldHoldForRed({
      aspect,
      distToSignalM: dist,
      inStreetRow: opts.inStreetRow,
    });
    return { hold, aspect, signal: sig };
  }

  /** Crossing active when consist near (heavy-rail gates/flashers). */
  crossingActive(c: CrossingDef, trainS: number, line: string, activateM = 180): boolean {
    if (c.line !== line) return false;
    return Math.abs(c.s - trainS) < activateM;
  }
}
