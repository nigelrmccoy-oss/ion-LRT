import * as THREE from 'three';
import { lonLatToLocal } from './coords';
import type { Elevation } from './elevation';
import { SPEED_LIMITS_KMH, civilSpeedLimitKmh, curveSpeedLimitKmh, type RowClass } from './Physics';

export type TrackPoint = {
  lon: number;
  lat: number;
  x: number;
  y: number;
  z: number;
  s: number; // cumulative metres
  grade: number; // rise/run
  curvature: number; // |1/radius| (chord-smoothed over ±CURV_HALF_WINDOW_M)
  /** Signed curvature: + = curving left (toward -x of heading frame), − = right. */
  curvSigned?: number;
};

export class Track {
  points: TrackPoint[] = [];
  length = 0;
  name: string;
  /** Optional OSM ROW lookup: (s, nearStation) => class */
  rowLookup: ((s: number, nearStation: boolean) => { row: RowClass; limitKmh: number }) | null = null;

  constructor(name: string) {
    this.name = name;
  }


  /**
   * Build from lon/lat vertices + optional ASL profile (one value per vertex, in the
   * geometry's stored order). `reverse` flips BOTH the vertices and the profile — v1.4.0
   * reversed only the vertices, so 301 Conestoga read Fairway's elevations at Conestoga
   * (+20 m / −17.7 m errors). Missing/mismatched profile → `demAt(lon,lat)` per vertex.
   */
  static fromLonLatProfile(
    coords: [number, number][],
    profile: number[] | undefined | null,
    name: string,
    baseElev = 330,
    reverse = false,
    demAt?: (lon: number, lat: number) => number,
  ) {
    let ring = coords.slice();
    let prof = profile && profile.length === coords.length ? profile.slice() : null;
    if (reverse) {
      ring = ring.reverse();
      if (prof) prof = prof.reverse();
    }
    const t = new Track(name);
    for (let i = 0; i < ring.length; i++) {
      const [lon, lat] = ring[i];
      const [x, z] = lonLatToLocal(lon, lat);
      let asl = prof && prof[i] != null && Number.isFinite(prof[i]) ? prof[i] : NaN;
      if (!Number.isFinite(asl)) asl = demAt ? demAt(lon, lat) : baseElev;
      const y = asl - baseElev + Track.BED_ABOVE_DEM_M;
      t.points.push({ lon, lat, x, y, z, s: 0, grade: 0, curvature: 0 });
    }
    t.recomputeChainage();
    t.densify(5);
    t.smoothVertical();
    t.recomputeDerivatives();
    return t;
  }

  static async fromGeoJSON(url: string, elev: Elevation, profile: number[] | undefined, name: string, reverse = false) {
    const gj = await (await fetch(url)).json();
    const coords: [number, number][] = gj.features[0].geometry.coordinates;
    return Track.fromLonLatProfile(coords, profile, name, elev.baseElev, reverse, (lon, lat) => elev.elevLonLat(lon, lat));
  }

  /** Track bed (rail base) sits this far above the DEM before cut/fill smoothing. */
  static readonly BED_ABOVE_DEM_M = 0.35;
  /** Design grade cap used for the vertical profile (a little under MAX_ABS_GRADE). */
  static readonly DESIGN_GRADE = 0.045;

  /**
   * Vertical design profile from noisy DEM samples:
   *  1. Gaussian smooth (σ 20 m, by horizontal distance) — removes DEM/building noise;
   *  2. Lipschitz clamp to DESIGN_GRADE (forward+backward passes until stable — the old
   *     forward-only clamp drifted and produced the ±5 % sawtooth);
   *  3. Gaussian σ 20 m → rounded vertical curves (keeps the grade bound).
   */
  smoothVertical(sigma1 = 20, sigma2 = 20) {
    const pts = this.points;
    const n = pts.length;
    if (n < 3) return;
    const hs = new Float64Array(n);
    for (let i = 1; i < n; i++) hs[i] = hs[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z);
    const gauss = (ys: Float64Array, sigma: number) => {
      const out = new Float64Array(n);
      let lo = 0, hi = 0;
      for (let i = 0; i < n; i++) {
        while (hs[i] - hs[lo] > 3 * sigma) lo++;
        while (hi + 1 < n && hs[hi + 1] - hs[i] <= 3 * sigma) hi++;
        let sw = 0, sy = 0;
        for (let j = lo; j <= hi; j++) {
          const d = (hs[j] - hs[i]) / sigma;
          const w = Math.exp(-0.5 * d * d);
          sw += w; sy += w * ys[j];
        }
        out[i] = sy / sw;
      }
      return out;
    };
    let y = Float64Array.from(pts.map((p) => p.y));
    y = gauss(y, sigma1);
    // Lipschitz projection is order-dependent; average the forward-first and backward-first
    // results so the profile is identical whichever way the line is built (the average of
    // two DESIGN_GRADE-bounded profiles is still bounded).
    const g = Track.DESIGN_GRADE;
    const clamp = (src: Float64Array, fwdFirst: boolean) => {
      const yy = Float64Array.from(src);
      const fwd = () => {
        let ch = false;
        for (let i = 1; i < n; i++) {
          const m = g * (hs[i] - hs[i - 1]);
          const c = Math.min(yy[i - 1] + m, Math.max(yy[i - 1] - m, yy[i]));
          if (Math.abs(c - yy[i]) > 1e-9) { yy[i] = c; ch = true; }
        }
        return ch;
      };
      const bwd = () => {
        let ch = false;
        for (let i = n - 2; i >= 0; i--) {
          const m = g * (hs[i + 1] - hs[i]);
          const c = Math.min(yy[i + 1] + m, Math.max(yy[i + 1] - m, yy[i]));
          if (Math.abs(c - yy[i]) > 1e-9) { yy[i] = c; ch = true; }
        }
        return ch;
      };
      for (let it = 0; it < 50; it++) {
        const a = fwdFirst ? fwd() : bwd();
        const b = fwdFirst ? bwd() : fwd();
        if (!a && !b) break;
      }
      return yy;
    };
    const yf = clamp(y, true), yb = clamp(y, false);
    for (let i = 0; i < n; i++) y[i] = (yf[i] + yb[i]) / 2;
    y = gauss(y, sigma2);
    for (let i = 0; i < n; i++) pts[i].y = y[i];
    this.recomputeChainage();
  }

  /**
   * Where another running line is within `near` m laterally (double track, shared bed),
   * take its rail height (blend out to `far`), so both tracks share one formation.
   */
  blendHeightsToward(other: Track, near = 6, far = 14, sigma = 15) {
    const pts = this.points;
    const n = pts.length;
    const hs = new Float64Array(n);
    for (let i = 1; i < n; i++) hs[i] = hs[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z);
    // correction toward the other line, weighted by proximity, then smoothed along the
    // line so diverging turnouts/couplets don't introduce vertical kinks
    const delta = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const p = pts[i];
      const q = other.sampleRaw(other.nearestSLocal(p.x, p.z));
      const d = Math.hypot(q.x - p.x, q.z - p.z);
      const w = Math.max(0, Math.min(1, (far - d) / (far - near)));
      delta[i] = w * (q.y - p.y);
    }
    let lo = 0, hi = 0;
    for (let i = 0; i < n; i++) {
      while (hs[i] - hs[lo] > 3 * sigma) lo++;
      while (hi + 1 < n && hs[hi + 1] - hs[i] <= 3 * sigma) hi++;
      let sw = 0, sv = 0;
      for (let j = lo; j <= hi; j++) {
        const t = (hs[j] - hs[i]) / sigma;
        const wt = Math.exp(-0.5 * t * t);
        sw += wt; sv += wt * delta[j];
      }
      pts[i].y += sv / sw;
    }
    this.recomputeChainage();
    this.recomputeDerivatives();
  }

  /** Realistic LRV max |grade| (~5%). DEM noise often invents 20%+ cliffs. */
  static readonly MAX_ABS_GRADE = 0.05;
  /** Half-window for chord curvature (m). */
  static readonly CURV_HALF_WINDOW_M = 10;
  /** Flexity Freedom min horizontal radius 25 m (Bombardier spec; Stage 2 ION EPR Table 4-2). */
  static readonly MIN_RADIUS_M = 25;

  /** Moving-average Y, then clamp consecutive rises to MAX_ABS_GRADE; recompute s. */
  smoothAndClampElevation(window = 7) {
    const pts = this.points;
    if (pts.length < 3) return;
    const half = Math.max(1, Math.floor(window / 2));
    const rawY = pts.map((p) => p.y);
    const smoothY = rawY.map((_, i) => {
      let sum = 0, n = 0;
      for (let j = i - half; j <= i + half; j++) {
        if (j < 0 || j >= rawY.length) continue;
        sum += rawY[j];
        n++;
      }
      return sum / Math.max(1, n);
    });
    // Anchor endpoints so termini stay put
    smoothY[0] = rawY[0];
    smoothY[smoothY.length - 1] = rawY[rawY.length - 1];
    pts[0].y = smoothY[0];
    const maxG = Track.MAX_ABS_GRADE;
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1];
      const horiz = Math.hypot(pts[i].x - a.x, pts[i].z - a.z);
      const maxDy = maxG * Math.max(horiz, 0.5);
      let dy = smoothY[i] - a.y;
      if (dy > maxDy) dy = maxDy;
      if (dy < -maxDy) dy = -maxDy;
      pts[i].y = a.y + dy;
    }
    this.recomputeChainage();
  }

  /** Insert vertices so no segment exceeds maxStepM (smoother rails + physics). */
  densify(maxStepM = 5) {
    const src = this.points;
    if (src.length < 2) return;
    const out: TrackPoint[] = [src[0]];
    for (let i = 1; i < src.length; i++) {
      const a = out[out.length - 1];
      const b = src[i];
      const dist = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
      const n = Math.max(1, Math.ceil(dist / maxStepM));
      for (let k = 1; k <= n; k++) {
        const t = k / n;
        out.push({
          lon: a.lon + (b.lon - a.lon) * t,
          lat: a.lat + (b.lat - a.lat) * t,
          x: a.x + (b.x - a.x) * t,
          y: a.y + (b.y - a.y) * t,
          z: a.z + (b.z - a.z) * t,
          s: 0,
          grade: 0,
          curvature: 0,
        });
      }
    }
    this.points = out;
    this.segHash = null;
    this.recomputeChainage();
    this.recomputeDerivatives();
  }

  recomputeChainage() {
    this.segHash = null;
    this.curveLimitTab = null;
    let s = 0;
    this.points[0].s = 0;
    for (let i = 1; i < this.points.length; i++) {
      const a = this.points[i - 1], b = this.points[i];
      s += Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
      b.s = s;
    }
    this.length = s;
  }

  recomputeDerivatives() {
    const pts = this.points;
    const maxG = Track.MAX_ABS_GRADE;
    pts[0].grade = 0;
    pts[0].curvature = 0;
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i];
      const ds = Math.max(0.1, b.s - a.s);
      let g = (b.y - a.y) / ds;
      if (!Number.isFinite(g)) g = 0;
      b.grade = Math.max(-maxG, Math.min(maxG, g));
      b.curvature = 0;
    }
    // Curvature from chord headings over ±L. The old per-vertex angle/ds estimate put the
    // whole OSM vertex bend into one 5 m densified segment (R≈30 m spikes on gentle
    // curves), which fed absurd curve resistance and roll.
    const L = Track.CURV_HALF_WINDOW_M;
    for (let i = 0; i < pts.length; i++) {
      const s0 = pts[i].s;
      if (s0 < L || s0 > this.length - L) { pts[i].curvature = 0; pts[i].curvSigned = 0; continue; }
      const pa = this.sampleRaw(s0 - L), pb = pts[i], pc = this.sampleRaw(s0 + L);
      const h1 = Math.atan2(pb.x - pa.x, pb.z - pa.z);
      const h2 = Math.atan2(pc.x - pb.x, pc.z - pb.z);
      let dh = h2 - h1;
      while (dh > Math.PI) dh -= 2 * Math.PI;
      while (dh < -Math.PI) dh += 2 * Math.PI;
      let k = dh / L;
      if (!Number.isFinite(k)) k = 0;
      const kMax = 1 / Track.MIN_RADIUS_M;
      k = Math.max(-kMax, Math.min(kMax, k));
      pts[i].curvSigned = k;
      pts[i].curvature = Math.abs(k);
    }
    if (pts.length > 1) {
      pts[pts.length - 1].curvature = 0;
      pts[pts.length - 1].grade = pts[pts.length - 2].grade;
    }
  }

  /** Nearest chainage for a lat/lon (station distance refresh after remesh). */
  nearestS(lon: number, lat: number): number {
    const [x, z] = lonLatToLocal(lon, lat);
    return this.nearestSLocal(x, z);
  }

  private segHash: Map<string, number[]> | null = null;
  private static readonly HASH_CELL = 50;

  /** Exact projection of local (x,z) onto the polyline → chainage (segment-accurate). */
  nearestSLocal(x: number, z: number): number {
    const pts = this.points;
    const C = Track.HASH_CELL;
    if (!this.segHash) {
      this.segHash = new Map();
      for (let i = 0; i + 1 < pts.length; i++) {
        const a = pts[i], b = pts[i + 1];
        const x0 = Math.floor(Math.min(a.x, b.x) / C), x1 = Math.floor(Math.max(a.x, b.x) / C);
        const z0 = Math.floor(Math.min(a.z, b.z) / C), z1 = Math.floor(Math.max(a.z, b.z) / C);
        for (let gx = x0; gx <= x1; gx++) for (let gz = z0; gz <= z1; gz++) {
          const k = `${gx},${gz}`;
          let arr = this.segHash.get(k);
          if (!arr) { arr = []; this.segHash.set(k, arr); }
          arr.push(i);
        }
      }
    }
    let best = 0, bestD = Infinity;
    const test = (i: number) => {
      const a = pts[i], b = pts[i + 1];
      const dx = b.x - a.x, dz = b.z - a.z;
      const L2 = dx * dx + dz * dz || 1e-9;
      const t = Math.max(0, Math.min(1, ((x - a.x) * dx + (z - a.z) * dz) / L2));
      const d = (a.x + dx * t - x) ** 2 + (a.z + dz * t - z) ** 2;
      if (d < bestD) { bestD = d; best = a.s + (b.s - a.s) * t; }
    };
    const gx = Math.floor(x / C), gz = Math.floor(z / C);
    for (let r = 0; r < 400; r++) {
      for (let a = -r; a <= r; a++) for (let b = -r; b <= r; b++) {
        if (Math.max(Math.abs(a), Math.abs(b)) !== r) continue;
        const arr = this.segHash.get(`${gx + a},${gz + b}`);
        if (arr) for (const i of arr) test(i);
      }
      // anything in ring r+1 is at least r*C away
      if (bestD < (r * C) ** 2) break;
    }
    if (!Number.isFinite(bestD)) for (let i = 0; i + 1 < pts.length; i++) test(i);
    return best;
  }

  /** Optional chainage on the reference ION line (ROW/signals/OCS data are keyed to it). */
  private refTable: Float32Array | null = null;
  private static readonly REF_STEP = 5;
  buildRefMap(ref: Track) {
    const n = Math.ceil(this.length / Track.REF_STEP) + 1;
    const tab = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const p = this.sampleRaw(Math.min(this.length, i * Track.REF_STEP));
      tab[i] = ref.nearestSLocal(p.x, p.z);
    }
    this.refTable = tab;
  }
  /** Reference-line chainage for s (identity when no map). */
  refS(s: number): number {
    const tab = this.refTable;
    if (!tab) return s;
    const f = Math.max(0, Math.min(tab.length - 1, s / Track.REF_STEP));
    const i = Math.floor(f), j = Math.min(tab.length - 1, i + 1);
    return tab[i] + (tab[j] - tab[i]) * (f - i);
  }

  sample(s: number) {
    const pts = this.points;
    if (s <= 0) {
      const g0 = Number.isFinite(pts[0].grade) ? pts[0].grade : 0;
      return { ...pts[0], heading: this.headingAt(0), grade: g0, curvature: 0, curvSigned: 0 };
    }
    if (s >= this.length) {
      const n = pts.length - 1;
      return { ...pts[n], heading: this.headingAt(this.length), grade: pts[n].grade, curvature: 0, curvSigned: 0 };
    }
    let lo = 0, hi = pts.length - 1;
    while (lo + 1 < hi) {
      const m = (lo + hi) >> 1;
      if (pts[m].s < s) lo = m; else hi = m;
    }
    const a = pts[lo], b = pts[hi];
    const t = (s - a.s) / Math.max(1e-3, b.s - a.s);
    let grade = a.grade + (b.grade - a.grade) * t;
    let curvature = a.curvature + (b.curvature - a.curvature) * t;
    let curvSigned = (a.curvSigned ?? 0) + ((b.curvSigned ?? 0) - (a.curvSigned ?? 0)) * t;
    if (!Number.isFinite(curvSigned)) curvSigned = 0;
    if (!Number.isFinite(grade)) grade = 0;
    if (!Number.isFinite(curvature)) curvature = 0;
    grade = Math.max(-Track.MAX_ABS_GRADE, Math.min(Track.MAX_ABS_GRADE, grade));
    return {
      lon: a.lon + (b.lon - a.lon) * t,
      lat: a.lat + (b.lat - a.lat) * t,
      x: a.x + (b.x - a.x) * t,
      y: a.y + (b.y - a.y) * t,
      z: a.z + (b.z - a.z) * t,
      s,
      heading: this.headingAt(s),
      grade,
      curvature,
      curvSigned,
    };
  }

  /**
   * Position/height on the rail centreline at any chainage; beyond the ends the
   * line is extrapolated straight (so articulated modules near a terminus stay on a line).
   */
  pointAt(s: number): { x: number; y: number; z: number } {
    if (s >= 0 && s <= this.length) {
      const r = this.sampleRaw(s);
      return { x: r.x, y: r.y, z: r.z };
    }
    const atStart = s < 0;
    const s0 = atStart ? 0 : this.length;
    const s1 = atStart ? Math.min(this.length, 2) : Math.max(0, this.length - 2);
    const p0 = this.sampleRaw(s0), p1 = this.sampleRaw(s1);
    const d = Math.hypot(p1.x - p0.x, p1.z - p0.z) || 1;
    const ux = (p0.x - p1.x) / d, uz = (p0.z - p1.z) / d; // pointing outward
    const over = atStart ? -s : s - this.length;
    return { x: p0.x + ux * over, y: p0.y, z: p0.z + uz * over };
  }

  headingAt(s: number) {
    const look = this.sampleRaw(Math.min(this.length, s + 2));
    const here = this.sampleRaw(Math.max(0, s));
    return Math.atan2(look.x - here.x, look.z - here.z);
  }

  sampleRaw(s: number) {
    const pts = this.points;
    if (s <= 0) return pts[0];
    if (s >= this.length) return pts[pts.length - 1];
    let lo = 0, hi = pts.length - 1;
    while (lo + 1 < hi) {
      const m = (lo + hi) >> 1;
      if (pts[m].s < s) lo = m; else hi = m;
    }
    const a = pts[lo], b = pts[hi];
    const t = (s - a.s) / Math.max(1e-3, b.s - a.s);
    return {
      x: a.x + (b.x - a.x) * t,
      y: a.y + (b.y - a.y) * t,
      z: a.z + (b.z - a.z) * t,
      s,
    };
  }

  private curveLimitTab: Float32Array | null = null;
  private static readonly CURVE_TAB_STEP = 2;
  /** Half-window (m) over which a curve restriction applies around s (≈ half an LRV + margin). */
  static readonly CURVE_LIMIT_HALF_WINDOW_M = 18;
  /** Half-base of the three-point radius estimate used for curve speed limits (m). */
  static readonly CURVE_RADIUS_BASE_M = 30;

  /**
   * Curve speed restriction at s (km/h): TCRP Report 155 curve-speed formula
   * (see Physics.curveSpeedLimitKmh), using the tightest radius within ±18 m so the whole
   * consist is slowed before the nose enters and until the tail leaves the curve.
   */
  curveLimitKmh(s: number): number {
    const st = Track.CURVE_TAB_STEP;
    if (!this.curveLimitTab) {
      const n = Math.ceil(this.length / st) + 1;
      const raw = new Float32Array(n);
      // Radius for speed purposes: circumradius through s−W, s, s+W (W 30 m). The ±10 m
      // chord curvature reads every OSM vertex kink as R≈100 m; a 60 m base averages
      // vertex noise yet still resolves ION's R 25 m street curves (≈ 90° over ~40 m).
      const W = Track.CURVE_RADIUS_BASE_M;
      for (let i = 0; i < n; i++) {
        const s0 = Math.min(this.length, i * st);
        const a = this.sampleRaw(Math.max(0, s0 - W)), b = this.sampleRaw(s0), c = this.sampleRaw(Math.min(this.length, s0 + W));
        const ab = Math.hypot(b.x - a.x, b.z - a.z), bc = Math.hypot(c.x - b.x, c.z - b.z), ca = Math.hypot(a.x - c.x, a.z - c.z);
        const area2 = Math.abs((b.x - a.x) * (c.z - a.z) - (b.z - a.z) * (c.x - a.x)); // 2·area
        const R = area2 > 1e-6 ? (ab * bc * ca) / (2 * area2) : Infinity;
        raw[i] = curveSpeedLimitKmh(R);
      }
      const w = Math.ceil(Track.CURVE_LIMIT_HALF_WINDOW_M / st);
      const tab = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        let m = 999;
        for (let j = Math.max(0, i - w); j <= Math.min(n - 1, i + w); j++) m = Math.min(m, raw[j]);
        tab[i] = m;
      }
      this.curveLimitTab = tab;
    }
    const i = Math.max(0, Math.min(this.curveLimitTab.length - 1, Math.round(s / st)));
    return this.curveLimitTab[i];
  }

  /** Civil speed limit — OSM ROW (else curvature heuristic), capped by the curve restriction. */
  speedLimitKmh(s: number, nearStation: boolean) {
    let lim: number;
    if (this.rowLookup) {
      lim = this.rowLookup(s, nearStation).limitKmh;
    } else {
      const p = this.sample(s);
      lim = civilSpeedLimitKmh(nearStation, p.curvature, { ionStreetRunning: this.name.includes('ION') });
    }
    return Math.min(lim, this.curveLimitKmh(s));
  }

  rowClassAt(s: number, nearStation: boolean): RowClass {
    if (this.rowLookup) return this.rowLookup(s, nearStation).row;
    if (nearStation) return 'station';
    const lim = this.speedLimitKmh(s, false);
    if (lim <= SPEED_LIMITS_KMH.street) return 'street';
    return 'reserved';
  }
}
