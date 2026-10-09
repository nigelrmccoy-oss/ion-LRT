/**
 * Corrected ground heightfield: DEM with a cut/fill corridor along every track so the
 * ground never pokes through rails, ballast or the train. Pure maths (no three.js
 * scene objects) so it can be unit-tested headlessly.
 *
 *  exactHeight(x,z)  – design surface: formation level inside the track bed, 2H:1V cut or
 *                      fill slopes outside it, DEM beyond. Under bridges/viaducts the DEM is
 *                      kept (only trimmed below the deck).
 *  gridHeight(x,z)   – value used for coarse terrain-mesh vertices: a lateral min-filter of
 *                      the design surface minus a margin, so linear interpolation between
 *                      vertices GRID_M apart can never rise above the finer corridor ribbon.
 *  surfaceHeight(x,z)– exact interpolation of the rendered terrain mesh (same triangulation
 *                      as THREE.PlaneGeometry) — used to drape roads and building bases.
 */
import type { Track } from './Track';
import {
  FORMATION_DEPTH_M,
  FORMATION_HALF_WIDTH_M,
  CUT_SLOPE_H_PER_V,
  FILL_SLOPE_H_PER_V,
  BRIDGE_MIN_FILL_M,
  LRT_TRACK_CENTRES_M,
} from './Clearances';

export interface HeightSource {
  heightAtLocal(x: number, z: number): number;
}

export type CorridorSample = {
  x: number; z: number; y: number; s: number;
  fx: number; fz: number; // forward unit
  form: number; // formation (subgrade) level
  street: boolean;
  bridge: boolean;
  /** flat-zone lateral extents (left positive): [-right, +left] */
  left: number; right: number;
};

export type CorridorTrack = {
  track: Track;
  samples: CorridorSample[];
  step: number;
};

export const GRID_M = 5;
/** Extra lowering of terrain-mesh vertices under the corridor ribbon (m). */
export const GRID_SINK_M = 0.3;
/** Lateral reach of slopes rendered by the corridor ribbon beyond the flat zone (m). */
export const SLOPE_REACH_M = 18;
/** Cut/fill slopes may continue onto the coarse terrain this far past the ribbon (m). */
export const SLOPE_EXTRA_M = 12;
const CELL = 25;
/** Terrain-mesh vertices and ribbon slopes under/near a road are lowered this much (m). */
export const ROAD_SINK_M = 0.35;
const ROAD_CELL = 40;

type RoadSeg = { ax: number; az: number; bx: number; bz: number; hw: number };

export class GroundModel {
  dem: HeightSource;
  tracks: CorridorTrack[] = [];
  private hash = new Map<string, { t: number; i: number }[]>();
  private gridCache = new Map<string, number>();
  private roadHash = new Map<string, RoadSeg[]>();

  /** Register OSM road centrelines (local x,z) so the terrain can be sunk under them. */
  setRoads(roads: { coords: number[][]; width: number }[]) {
    this.roadHash.clear();
    for (const r of roads) {
      const hw = r.width / 2;
      for (let i = 0; i + 1 < r.coords.length; i++) {
        const [ax, az] = r.coords[i], [bx, bz] = r.coords[i + 1];
        const seg = { ax, az, bx, bz, hw };
        const pad = hw + GRID_M * 2;
        const x0 = Math.floor((Math.min(ax, bx) - pad) / ROAD_CELL), x1 = Math.floor((Math.max(ax, bx) + pad) / ROAD_CELL);
        const z0 = Math.floor((Math.min(az, bz) - pad) / ROAD_CELL), z1 = Math.floor((Math.max(az, bz) + pad) / ROAD_CELL);
        for (let gx = x0; gx <= x1; gx++) for (let gz = z0; gz <= z1; gz++) {
          const k = `${gx},${gz}`;
          let arr = this.roadHash.get(k);
          if (!arr) { arr = []; this.roadHash.set(k, arr); }
          arr.push(seg);
        }
      }
    }
    this.gridCache.clear();
  }

  /**
   * How far the coarse terrain / ribbon slopes are lowered at (x,z): full ROAD_SINK_M within
   * road half-width + one grid diagonal (so no mesh triangle touching the road can rise
   * above it), fading to 0 over the next 2 m.
   */
  roadSink(x: number, z: number): number {
    const arr = this.roadHash.get(`${Math.floor(x / ROAD_CELL)},${Math.floor(z / ROAD_CELL)}`);
    if (!arr) return 0;
    let best = 0;
    for (const r of arr) {
      const dx = r.bx - r.ax, dz = r.bz - r.az;
      const L2 = dx * dx + dz * dz || 1e-9;
      const t = Math.max(0, Math.min(1, ((x - r.ax) * dx + (z - r.az) * dz) / L2));
      const d = Math.hypot(r.ax + dx * t - x, r.az + dz * t - z);
      const inner = r.hw + GRID_M * Math.SQRT2;
      const f = d <= inner ? 1 : Math.max(0, 1 - (d - inner) / 2);
      if (f > best) best = f;
      if (best >= 1) break;
    }
    return best * ROAD_SINK_M;
  }

  /**
   * Road level where (x,z) lies on a track's flat zone (null elsewhere): street running →
   * pavement (formation level, just under the rail head); ballasted level crossing → 4 cm
   * above the ties so the rail heads still show.
   */
  flatZoneLevel(x: number, z: number): number | null {
    let out: number | null = null;
    for (const [t, n] of this.nearby(x, z, FORMATION_HALF_WIDTH_M + 2)) {
      const f = this.frame(t, n.idx, x, z);
      if (f.beyondEnd || f.c.bridge) continue;
      if (f.lat > f.c.left || -f.lat > f.c.right) continue;
      const lvl = f.c.street ? f.form - 0.01 : f.form + FORMATION_DEPTH_M + 0.04;
      out = out === null ? lvl : Math.max(out, lvl);
    }
    return out;
  }

  /**
   * Draped road surface height: smooth design surface + 4 cm (terrain mesh and ribbon
   * slopes are sunk ROAD_SINK_M under roads, so they stay below between road vertices);
   * on a track's flat zone the road takes the pavement / crossing level instead.
   */
  roadHeight(x: number, z: number): number {
    const flat = this.flatZoneLevel(x, z);
    if (flat !== null) return flat;
    return Math.max(this.exactHeight(x, z), this.surfaceHeight(x, z) + ROAD_SINK_M * 0.5) + 0.04;
  }

  /** Distance from (x,z) to the nearest centreline sample of any track other than `track`. */
  nearestOtherTrackDist(x: number, z: number, track: Track, reach = 12): number {
    let best = Infinity;
    for (const [t, n] of this.nearby(x, z, reach)) {
      if (this.tracks[t].track === track) continue;
      best = Math.min(best, Math.sqrt(n.d2));
    }
    return best;
  }

  constructor(dem: HeightSource) {
    this.dem = dem;
  }

  /**
   * Register a track corridor. `isStreet(s)` marks embedded street running (road surface
   * at rail level, gentle 4H:1V cross-fall instead of cut/fill slopes).
   * `parallelLeftM` widens the flat zone for a second (visual) track on the left.
   */
  addTrack(
    track: Track,
    opts: { isStreet?: (s: number) => boolean; parallelLeftM?: (s: number) => number; step?: number } = {},
  ) {
    const step = opts.step ?? 2;
    const samples: CorridorSample[] = [];
    for (let s = 0; s <= track.length + 1e-6; s += step) {
      const ss = Math.min(s, track.length);
      const p = track.sampleRaw(ss);
      const q = track.sampleRaw(Math.min(track.length, ss + 1));
      const r = track.sampleRaw(Math.max(0, ss - 1));
      const dx = q.x - r.x, dz = q.z - r.z;
      const d = Math.hypot(dx, dz) || 1;
      const street = opts.isStreet ? opts.isStreet(ss) : false;
      const par = opts.parallelLeftM ? opts.parallelLeftM(ss) : 0;
      // street: road surface ≈ 5 cm below rail head; ballasted: subgrade under ballast
      const form = street ? p.y + 0.04 : p.y - FORMATION_DEPTH_M;
      const hw = street ? FORMATION_HALF_WIDTH_M + 1.3 : FORMATION_HALF_WIDTH_M;
      samples.push({
        x: p.x, z: p.z, y: p.y, s: ss, fx: dx / d, fz: dz / d, form,
        street, bridge: false, left: hw + par, right: hw,
      });
    }
    // Bridge detection: long runs where formation is far above DEM
    const high = samples.map((c) => c.form - this.dem.heightAtLocal(c.x, c.z) > BRIDGE_MIN_FILL_M);
    let i = 0;
    while (i < samples.length) {
      if (!high[i]) { i++; continue; }
      let j = i;
      while (j < samples.length && high[j]) j++;
      if ((j - i) * step >= 16) {
        const pad = Math.ceil(10 / step);
        for (let k = Math.max(0, i - pad); k < Math.min(samples.length, j + pad); k++) samples[k].bridge = true;
      }
      i = j;
    }
    const ti = this.tracks.length;
    this.tracks.push({ track, samples, step });
    samples.forEach((c, idx) => {
      const key = `${Math.floor(c.x / CELL)},${Math.floor(c.z / CELL)}`;
      let arr = this.hash.get(key);
      if (!arr) { arr = []; this.hash.set(key, arr); }
      arr.push({ t: ti, i: idx });
    });
    this.gridCache.clear();
  }

  /** Nearest corridor sample per track within `reach` metres. */
  private nearby(x: number, z: number, reach: number) {
    const out = new Map<number, { c: CorridorSample; d2: number; idx: number }>();
    const r = Math.ceil(reach / CELL);
    const cx = Math.floor(x / CELL), cz = Math.floor(z / CELL);
    for (let a = -r; a <= r; a++) {
      for (let b = -r; b <= r; b++) {
        const arr = this.hash.get(`${cx + a},${cz + b}`);
        if (!arr) continue;
        for (const { t, i } of arr) {
          const c = this.tracks[t].samples[i];
          const d2 = (c.x - x) ** 2 + (c.z - z) ** 2;
          if (d2 > reach * reach) continue;
          const cur = out.get(t);
          if (!cur || d2 < cur.d2) out.set(t, { c, d2, idx: i });
        }
      }
    }
    return out;
  }

  /** Lateral frame at (x,z) relative to the nearest sample of a track. */
  private frame(t: number, idx: number, x: number, z: number) {
    const smp = this.tracks[t].samples;
    const c = smp[idx];
    const along = (x - c.x) * c.fx + (z - c.z) * c.fz;
    // left unit = rotate forward +90° (see Articulation.moduleCorners)
    const lat = (x - c.x) * c.fz + (z - c.z) * -c.fx;
    // interpolate formation along track
    const nIdx = along >= 0 ? Math.min(smp.length - 1, idx + 1) : Math.max(0, idx - 1);
    const n = smp[nIdx];
    const span = Math.hypot(n.x - c.x, n.z - c.z) || 1;
    const t01 = Math.min(1, Math.abs(along) / span);
    const form = c.form + (n.form - c.form) * t01;
    const beyondEnd = (idx === 0 && along < -1) || (idx === smp.length - 1 && along > 1);
    return { c, lat, form, beyondEnd, along };
  }

  /** Design surface of one corridor at lateral offset `lat` given DEM value. */
  private static corridorClamp(c: CorridorSample, form: number, lat: number, dem: number): number {
    const off = lat >= 0 ? Math.max(0, lat - c.left) : Math.max(0, -lat - c.right);
    if (c.bridge) {
      // keep valley under the deck; just make sure nothing reaches the deck soffit
      if (off < 2) return Math.min(dem, form - 1.2);
      return dem;
    }
    if (off > SLOPE_REACH_M + SLOPE_EXTRA_M) return dem;
    const cut = c.street ? 4 : CUT_SLOPE_H_PER_V;
    const fill = c.street ? 4 : FILL_SLOPE_H_PER_V;
    const hi = form + off / cut;
    const lo = form - off / fill;
    return Math.min(hi, Math.max(lo, dem));
  }

  private reach() { return FORMATION_HALF_WIDTH_M + 1.3 + LRT_TRACK_CENTRES_M + SLOPE_REACH_M + SLOPE_EXTRA_M; }

  exactHeight(x: number, z: number): number {
    let h = this.dem.heightAtLocal(x, z);
    if (!this.tracks.length) return h;
    for (const [t, n] of this.nearby(x, z, this.reach())) {
      const f = this.frame(t, n.idx, x, z);
      if (f.beyondEnd) continue;
      h = GroundModel.corridorClamp(f.c, f.form, f.lat, h);
    }
    return h;
  }

  /** Whether (x,z) lies under a rendered corridor ribbon (flat zone + slope reach). */
  inRibbon(x: number, z: number): boolean {
    for (const [t, n] of this.nearby(x, z, this.reach())) {
      const f = this.frame(t, n.idx, x, z);
      if (f.beyondEnd || f.c.bridge) continue;
      const off = f.lat >= 0 ? f.lat - f.c.left : -f.lat - f.c.right;
      if (off < SLOPE_REACH_M) return true;
    }
    return false;
  }

  /** Terrain-mesh vertex value (see header). */
  gridHeight(x: number, z: number): number {
    const key = `${Math.round(x * 10)},${Math.round(z * 10)}`;
    const hit = this.gridCache.get(key);
    if (hit !== undefined) return hit;
    let h = this.dem.heightAtLocal(x, z);
    const near = this.nearby(x, z, this.reach());
    if (near.size) {
      let hExact = h;
      let lowest = Infinity;
      const ribbonFrames: { c: CorridorSample; form: number; lat: number; off: number }[] = [];
      for (const [t, n] of near) {
        const f = this.frame(t, n.idx, x, z);
        if (f.beyondEnd) continue;
        hExact = GroundModel.corridorClamp(f.c, f.form, f.lat, hExact);
        if (f.c.bridge) continue;
        const off = f.lat >= 0 ? f.lat - f.c.left : -f.lat - f.c.right;
        if (off > SLOPE_REACH_M + GRID_M * 1.5) continue;
        ribbonFrames.push({ c: f.c, form: f.form, lat: f.lat, off });
      }
      for (const rf of ribbonFrames) {
        // lateral min-filter over ±grid diagonal so mesh interpolation stays under the ribbon
        const lx = rf.c.fz, lz = -rf.c.fx;
        const D = GRID_M * Math.SQRT2;
        let m = hExact;
        for (const dl of [-D, D]) {
          const dem = this.dem.heightAtLocal(x + lx * dl, z + lz * dl);
          m = Math.min(m, GroundModel.corridorClamp(rf.c, rf.form, rf.lat + dl, dem));
        }
        const fade = Math.max(0, Math.min(1, (SLOPE_REACH_M + GRID_M * 1.5 - rf.off) / (GRID_M * 1.5)));
        lowest = Math.min(lowest, m - GRID_SINK_M * fade);
      }
      h = Math.min(hExact, lowest);
    }
    h -= this.roadSink(x, z);
    this.gridCache.set(key, h);
    if (this.gridCache.size > 400000) this.gridCache.clear();
    return h;
  }

  /** Height of the rendered terrain mesh at (x,z) — PlaneGeometry triangulation. */
  surfaceHeight(x: number, z: number): number {
    const gx = Math.floor(x / GRID_M), gz = Math.floor(z / GRID_M);
    const u = x / GRID_M - gx, v = z / GRID_M - gz;
    const x0 = gx * GRID_M, z0 = gz * GRID_M, x1 = x0 + GRID_M, z1 = z0 + GRID_M;
    const ha = this.gridHeight(x0, z0); // (0,0)
    const hb = this.gridHeight(x0, z1); // (0,1)
    const hc = this.gridHeight(x1, z1); // (1,1)
    const hd = this.gridHeight(x1, z0); // (1,0)
    // PlaneGeometry (rotated -90° about X) splits each quad along the (0,0)-(1,1)… use the
    // diagonal a–c; both triangles share it. Terrain chunk builder uses the same split.
    if (u >= v) return ha + (hd - ha) * u + (hc - hd) * v;
    return ha + (hc - hb) * u + (hb - ha) * v;
  }
}
