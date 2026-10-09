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
  /** Intersection group (set by groupSignals): heads of one intersection share a phase. */
  group?: number;
  /** Group extent on the ION reference chainage (stop lines: s0 for +dir, s1 for −dir). */
  group_s0?: number;
  group_s1?: number;
  /** Amber (clearance) interval for this head, s (default AMBER_S). */
  amber_s?: number;
};

/** Heads closer than this along the line belong to the same intersection. */
export const SIGNAL_GROUP_GAP_M = 30;
/** An intersection never spans more than this (long chains of nodes are split). */
export const SIGNAL_GROUP_MAX_SPAN_M = 60;

/**
 * Group signal heads into intersections. OSM tags every traffic-signal node (vehicle heads
 * and the pedestrian `crossing=traffic_signals` nodes) separately; v1.4.1 gave each node its
 * own phase offset, so heads a few metres apart at one intersection showed different
 * aspects — a train that entered on green met red 5–10 m later and was booked for a red
 * violation. All heads of one group now share the first head's phase.
 */
export function groupSignals<T extends SignalDef>(signals: T[], gapM = SIGNAL_GROUP_GAP_M): T[] {
  const sorted = signals.slice().sort((a, b) => a.s_ion - b.s_ion);
  let g = -1, start = 0;
  for (let i = 0; i <= sorted.length; i++) {
    if (i === sorted.length || i === 0 || sorted[i].s_ion - sorted[i - 1].s_ion > gapM || sorted[i].s_ion - sorted[start].s_ion > SIGNAL_GROUP_MAX_SPAN_M) {
      if (i > 0) {
        const s0 = sorted[start].s_ion, s1 = sorted[i - 1].s_ion, ph = sorted[start].phase_offset_s;
        for (let k = start; k < i; k++) {
          sorted[k].group = g; sorted[k].group_s0 = s0; sorted[k].group_s1 = s1; sorted[k].phase_offset_s = ph;
        }
      }
      if (i === sorted.length) break;
      g++; start = i;
    }
  }
  return sorted;
}

/**
 * Red-light violation = the train passes the intersection's stop line while the aspect is
 * red (v1.4.1 booked any red within ±18 m, including a light that turned red after the
 * train was already past the stop line).
 */
/** Minimal line interface (Track) for re-keying signals onto a running line. */
export interface SignalLine {
  nearestSLocal(x: number, z: number): number;
  sampleRaw(s: number): { x: number; z: number; y?: number };
}

/** LRV service-brake rate used to size the amber interval (m/s²) — ESTIMATE. */
export const LRV_AMBER_BRAKE_MS2 = 1.0;
/** Driver reaction time in the amber formula (s). */
export const AMBER_REACTION_S = 1.0;
/** Upper bound for the amber interval (s). */
export const AMBER_MAX_S = 9;

/**
 * Amber (yellow change) interval for an LRV approaching at `approachKmh` on `downGrade`
 * (positive = falling toward the stop line): kinematic ITE form Y = t + v / (2(b − g·G)),
 * with the LRV's service brake instead of a car's 3 m/s². With the old fixed 4 s amber a
 * Flexity at 40 km/h on the −4.5 % King St descent could neither stop (≈ 80 m) nor clear
 * the stop line before red (≈ 43 m), so red bookings were unavoidable at line speed.
 */
export function lrvAmberS(approachKmh: number, downGrade = 0, brake = LRV_AMBER_BRAKE_MS2): number {
  const v = approachKmh / 3.6;
  const b = Math.max(0.3, brake - 9.81 * Math.max(0, downGrade));
  return Math.min(AMBER_MAX_S, Math.max(AMBER_S, AMBER_REACTION_S + v / (2 * b)));
}

/**
 * Copies of the signal heads keyed by chainage on `line` (heads further than `maxLateralM`
 * from it are dropped). Signals are baked on the ION reference centreline; the SB/NB running
 * lines leave it on couplets and curves, where the nearest-point reference chainage stalls
 * and then races (v1.4.1: a train 30 m from a stop line was shown 33 m away for 4 s, then
 * crossed it on red). Enforcement now measures along the line the train runs on.
 */
export function signalsForLine(
  all: SignalDef[],
  line: SignalLine,
  maxLateralM = 40,
  approachKmh: (s: number) => number = () => 40,
): SignalDef[] {
  const out: SignalDef[] = [];
  for (const sig of all) {
    const s = line.nearestSLocal(sig.x, sig.z);
    const p = line.sampleRaw(s);
    if (Math.hypot(p.x - sig.x, p.z - sig.z) > maxLateralM) continue;
    out.push({ ...sig, s_ion: s, group: undefined, group_s0: undefined, group_s1: undefined });
  }
  const grouped = groupSignals(out);
  // amber per intersection from the approach speed and the steepest fall over the 100 m
  // before the stop line (either direction of travel)
  const yAt = (s: number) => line.sampleRaw(Math.max(0, s)).y ?? 0;
  for (const sig of grouped) {
    const s0 = sig.group_s0 ?? sig.s_ion, s1 = sig.group_s1 ?? sig.s_ion;
    const fallFwd = (yAt(s0 - 100) - yAt(s0)) / 100;
    const fallRev = (yAt(s1 + 100) - yAt(s1)) / 100;
    const v = Math.max(approachKmh(s0 - 50), approachKmh(s1 + 50));
    sig.amber_s = +lrvAmberS(v, Math.max(fallFwd, fallRev)).toFixed(1);
  }
  return grouped;
}

export function crossedOnRed(opts: { prevAlongM: number | undefined; alongM: number; aspect: SignalAspect; inStreetRow: boolean }): boolean {
  if (!opts.inStreetRow || opts.aspect !== 'red') return false;
  return opts.prevAlongM !== undefined && opts.prevAlongM > 0 && opts.alongM <= 0;
}

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

/** TSP green extension (s). */
export const TSP_EXTENSION_S = 8;

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
  amberS = AMBER_S,
): SignalAspect {
  const cycle = Math.max(8, cycleS);
  const amber = Math.max(AMBER_S, amberS);
  const green = Math.min(cycle - amber - 2, GREEN_S + Math.max(0, greenBiasS));
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
  return TSP_EXTENSION_S; // extend green / shrink red
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
  /** Most recent booked red-light violation (HUD / end-of-run report). */
  lastViolation: { id: number; s_ion: number; tSec: number; speedKmh: number } | null = null;
  private violatedIds = new Set<number>();

  async load(
    signalsUrl = './data/signals.json',
    crossingsUrl = './data/crossings.json',
  ) {
    try {
      const sf = (await (await fetch(signalsUrl)).json()) as SignalsFile;
      this.setSignals(sf.signals || []);
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

  /** Signals used for enforcement / aspects, keyed by the active line's chainage. */
  lineSignals: SignalDef[] = [];

  /** Replace the signal list (grouped into intersections). */
  setSignals(list: SignalDef[]) {
    this.signals = groupSignals(list);
    this.lineSignals = this.signals;
    this.approachTimers.clear();
    this.prevAlong.clear();
    this.tspLatch.clear();
  }

  /**
   * Enforce along `line` (the track the train runs on); null = reference chainage. Trains
   * on a line then use their own chainage and travel direction (reverser) for trainS.
   */
  setLine(line: SignalLine | null, maxLateralM = 40, approachKmh?: (s: number) => number) {
    this.lineSignals = line ? signalsForLine(this.signals, line, maxLateralM, approachKmh) : this.signals;
    this.approachTimers.clear();
    this.prevAlong.clear();
    this.tspLatch.clear();
  }

  private prevAlong = new Map<number, number>();
  private tspLatch = new Map<number, number>();
  private groupKey(sig: SignalDef) { return sig.group ?? sig.id; }

  /** Stop-line head of the next intersection ahead (first head in the travel direction). */
  nearestAhead(s: number, direction: 1 | -1 | 0, maxM = 120): SignalDef | null {
    if (!this.lineSignals.length || direction === 0) return null;
    let best: SignalDef | null = null;
    let bestD = maxM;
    for (const sig of this.lineSignals) {
      if (sig.group !== undefined && sig.s_ion !== (direction > 0 ? sig.group_s0 : sig.group_s1)) continue;
      const d = direction > 0 ? sig.s_ion - s : s - sig.s_ion;
      // strictly ahead: a stop line already passed must not mask the next intersection
      if (d < 0 || d > maxM) continue;
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
    // TSP works per intersection: distance to the group's stop line in the travel direction
    const line = sig.group !== undefined ? (direction >= 0 ? sig.group_s0! : sig.group_s1!) : sig.s_ion;
    const along = direction >= 0 ? line - trainS : trainS - line;
    const absD = Math.abs(line - trainS);
    const key = this.groupKey(sig);
    let timer = this.approachTimers.get(key) || 0;
    if (absD <= this.tspApproachM && speedKmh <= this.tspSpeedKmh + 5) {
      timer += dt;
    } else {
      timer = 0;
    }
    this.approachTimers.set(key, timer);
    let bias = tspGreenBias({
      distAlongM: along,
      absDistM: absD,
      speedKmh,
      approachM: this.tspApproachM,
      speedThreshKmh: this.tspSpeedKmh,
      waitS: this.tspWaitS,
      timeInApproachS: timer,
    });
    // A granted TSP extension is latched for this cycle until the train has cleared the
    // stop line (check-out). v1.4.1 revoked it as soon as the train accelerated above
    // 25 km/h, so the light cut from green to amber/red with the train a few metres out.
    const cyc = Math.max(8, this.cycleS);
    const cycleIdx = Math.floor((tSec + sig.phase_offset_s) / cyc);
    const u = (((tSec + sig.phase_offset_s) % cyc) + cyc) % cyc;
    // an extension can only be granted while the light is still green (v1.4.1 could grant it
    // during amber, so the aspect jumped amber → green → amber in front of the train)
    if (bias > 0 && this.tspLatch.get(key) !== cycleIdx && u >= GREEN_S) bias = 0;
    if (bias > 0) this.tspLatch.set(key, cycleIdx);
    else if (this.tspLatch.get(key) === cycleIdx && along >= -15) bias = TSP_EXTENSION_S;
    return aspectAtTime(tSec, sig.phase_offset_s, this.cycleS, bias, sig.amber_s);
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
    const dir = opts.direction || 1;
    // red-light check: every intersection stop line crossed during this step
    for (const h of this.lineSignals) {
      if (h.group !== undefined && h.s_ion !== (dir > 0 ? h.group_s0 : h.group_s1)) continue;
      const al = dir > 0 ? h.s_ion - opts.trainS : opts.trainS - h.s_ion;
      const key = this.groupKey(h);
      if (Math.abs(al) > 60) { this.prevAlong.delete(key); continue; }
      const prev = this.prevAlong.get(key);
      this.prevAlong.set(key, al);
      if (prev === undefined || !(prev > 0 && al <= 0)) continue;
      const asp = this.aspectFor(h, opts.tSec, opts.trainS, opts.speedKmh, dir, 0);
      if (crossedOnRed({ prevAlongM: prev, alongM: al, aspect: asp, inStreetRow: opts.inStreetRow }) && !this.violatedIds.has(key)) {
        this.violatedIds.add(key);
        this.redViolations += 1;
        this.lastViolation = { id: h.id, s_ion: h.s_ion, tSec: opts.tSec, speedKmh: opts.speedKmh };
      }
    }
    const sig = this.nearestAhead(opts.trainS, dir, 50);
    if (!sig || !opts.inStreetRow) {
      return { hold: false, aspect: null, signal: null };
    }
    const aspect = this.aspectFor(
      sig,
      opts.tSec,
      opts.trainS,
      opts.speedKmh,
      dir,
      opts.dt,
    );
    const along = dir > 0 ? sig.s_ion - opts.trainS : opts.trainS - sig.s_ion;
    // hold only while approaching the stop line (not after the train is past it)
    const hold = along > 0 && shouldHoldForRed({
      aspect,
      distToSignalM: along,
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
