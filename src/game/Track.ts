import * as THREE from 'three';
import { lonLatToLocal } from './coords';
import type { Elevation } from './elevation';
import { SPEED_LIMITS_KMH, civilSpeedLimitKmh, type RowClass } from './Physics';

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


  /** Headless / bake helper: lon/lat rings + ASL profile (metres). Applies smooth+densify. */
  static fromLonLatProfile(
    coords: [number, number][],
    profile: number[],
    name: string,
    baseElev = 330,
    reverse = false,
  ) {
    let ring = coords.slice();
    if (reverse) ring = ring.reverse();
    const t = new Track(name);
    let s = 0;
    for (let i = 0; i < ring.length; i++) {
      const [lon, lat] = ring[i];
      const [x, z] = lonLatToLocal(lon, lat);
      const asl = profile[i] != null ? profile[i]! : baseElev;
      const y = asl - baseElev + 0.35;
      if (i > 0) {
        const p = t.points[i - 1];
        s += Math.hypot(x - p.x, y - p.y, z - p.z);
      }
      t.points.push({ lon, lat, x, y, z, s, grade: 0, curvature: 0 });
    }
    t.length = s;
    t.smoothAndClampElevation();
    t.densify(5);
    t.recomputeDerivatives();
    return t;
  }

  static async fromGeoJSON(url: string, elev: Elevation, profile: number[] | undefined, name: string, reverse = false) {
    const gj = await (await fetch(url)).json();
    let coords: [number, number][] = gj.features[0].geometry.coordinates;
    if (reverse) coords = coords.slice().reverse();
    const t = new Track(name);
    let s = 0;
    for (let i = 0; i < coords.length; i++) {
      const [lon, lat] = coords[i];
      const [x, z] = lonLatToLocal(lon, lat);
      const asl = profile && profile[i] != null ? profile[i]! : elev.elevLonLat(lon, lat);
      const y = asl - elev.baseElev + 0.35; // track bed slightly above DEM
      if (i > 0) {
        const p = t.points[i - 1];
        const dx = x - p.x, dy = y - p.y, dz = z - p.z;
        s += Math.hypot(dx, dy, dz);
      }
      t.points.push({ lon, lat, x, y, z, s, grade: 0, curvature: 0 });
    }
    t.length = s;
    t.smoothAndClampElevation();
    t.densify(5);
    t.recomputeDerivatives();
    return t;
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
    this.recomputeChainage();
    this.recomputeDerivatives();
  }

  recomputeChainage() {
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
    let best = 0, bestD = Infinity;
    for (const p of this.points) {
      const d = (p.x - x) ** 2 + (p.z - z) ** 2;
      if (d < bestD) { bestD = d; best = p.s; }
    }
    return best;
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

  /** Civil speed limit — OSM ROW when available, else curvature heuristic. */
  speedLimitKmh(s: number, nearStation: boolean) {
    if (this.rowLookup) {
      const r = this.rowLookup(s, nearStation);
      return r.limitKmh;
    }
    const p = this.sample(s);
    return civilSpeedLimitKmh(nearStation, p.curvature, {
      ionStreetRunning: this.name.includes('ION'),
    });
  }

  rowClassAt(s: number, nearStation: boolean): RowClass {
    if (this.rowLookup) return this.rowLookup(s, nearStation).row;
    if (nearStation) return 'station';
    const lim = this.speedLimitKmh(s, false);
    if (lim <= SPEED_LIMITS_KMH.street) return 'street';
    return 'reserved';
  }
}
