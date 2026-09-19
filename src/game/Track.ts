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
  curvature: number; // 1/radius approx
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
    for (let i = 1; i < pts.length - 1; i++) {
      const a = pts[i - 1], b = pts[i], c = pts[i + 1];
      const v1 = new THREE.Vector2(b.x - a.x, b.z - a.z).normalize();
      const v2 = new THREE.Vector2(c.x - b.x, c.z - b.z).normalize();
      const cross = v1.x * v2.y - v1.y * v2.x;
      const dot = THREE.MathUtils.clamp(v1.x * v2.x + v1.y * v2.y, -1, 1);
      const ang = Math.acos(dot);
      const ds = Math.max(1, (c.s - a.s) / 2);
      let curv = ang / ds;
      if (!Number.isFinite(curv) || Math.abs(cross) < 1e-6) curv = 0;
      b.curvature = curv;
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
      return { ...pts[0], heading: this.headingAt(0), grade: g0, curvature: 0 };
    }
    if (s >= this.length) {
      const n = pts.length - 1;
      return { ...pts[n], heading: this.headingAt(this.length), grade: pts[n].grade, curvature: 0 };
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
    };
  }

  headingAt(s: number) {
    const look = this.sampleRaw(Math.min(this.length, s + 2));
    const here = this.sampleRaw(Math.max(0, s));
    return Math.atan2(look.x - here.x, look.z - here.z);
  }

  private sampleRaw(s: number) {
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
