import * as THREE from 'three';
import { lonLatToLocal } from './coords';
import type { Elevation } from './elevation';
import { SPEED_LIMITS_KMH } from './Physics';

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

  constructor(name: string) {
    this.name = name;
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
    for (let i = 1; i < t.points.length; i++) {
      const a = t.points[i - 1], b = t.points[i];
      const ds = Math.max(0.1, b.s - a.s);
      b.grade = (b.y - a.y) / ds;
    }
    for (let i = 1; i < t.points.length - 1; i++) {
      const a = t.points[i - 1], b = t.points[i], c = t.points[i + 1];
      const v1 = new THREE.Vector2(b.x - a.x, b.z - a.z).normalize();
      const v2 = new THREE.Vector2(c.x - b.x, c.z - b.z).normalize();
      const cross = v1.x * v2.y - v1.y * v2.x;
      const dot = THREE.MathUtils.clamp(v1.x * v2.x + v1.y * v2.y, -1, 1);
      const ang = Math.acos(dot);
      const ds = Math.max(1, (c.s - a.s) / 2);
      b.curvature = ang / ds; // rough 1/R
      if (Math.abs(cross) < 1e-6) b.curvature = 0;
    }
    return t;
  }

  sample(s: number) {
    const pts = this.points;
    if (s <= 0) return { ...pts[0], heading: this.headingAt(0), grade: pts[0].grade, curvature: 0 };
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
    return {
      lon: a.lon + (b.lon - a.lon) * t,
      lat: a.lat + (b.lat - a.lat) * t,
      x: a.x + (b.x - a.x) * t,
      y: a.y + (b.y - a.y) * t,
      z: a.z + (b.z - a.z) * t,
      s,
      heading: this.headingAt(s),
      grade: a.grade + (b.grade - a.grade) * t,
      curvature: a.curvature + (b.curvature - a.curvature) * t,
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

  /** Civil speed limit heuristic km/h */
  speedLimitKmh(s: number, nearStation: boolean) {
    if (nearStation) return SPEED_LIMITS_KMH.station;
    const p = this.sample(s);
    if (Math.abs(p.curvature) > 0.004) return SPEED_LIMITS_KMH.street; // street / tight curve
    // downtown / street-running proxy: low grade + mid route for ION
    if (this.name.includes('ION') && s > 6000 && s < 13000 && Math.abs(p.curvature) > 0.0015) {
      return SPEED_LIMITS_KMH.street;
    }
    return SPEED_LIMITS_KMH.reserved;
  }
}
