import { lonLatToLocal } from './coords';

export type ElevMeta = {
  bounds: { minLon: number; maxLon: number; minLat: number; maxLat: number };
  latStep: number;
  lonStep: number;
  cols: number;
  rows: number;
  track_profiles: { ion: number[]; spur: number[]; guelph: number[] };
  spot_checks_m: Record<string, { lat: number; lon: number; elev_m: number }>;
  vertical_scale: number;
};

export class Elevation {
  meta!: ElevMeta;
  private grid!: Float32Array;
  /** Reference elevation so terrain sits near y=0 */
  baseElev = 330;

  async load() {
    const meta = (await (await fetch('./data/elevation.json')).json()) as ElevMeta;
    this.meta = meta;
    const bin = await (await fetch('./data/elevation.bin')).arrayBuffer();
    this.grid = new Float32Array(bin);
    const spots = Object.values(meta.spot_checks_m).map((s) => s.elev_m).filter((v) => v != null);
    this.baseElev = spots.reduce((a, b) => a + b, 0) / Math.max(1, spots.length);
  }

  /** Absolute metres ASL from lon/lat (bilinear). */
  elevLonLat(lon: number, lat: number): number {
    const { bounds, lonStep, latStep, cols, rows } = this.meta;
    const c = (lon - bounds.minLon) / lonStep;
    const r = (lat - bounds.minLat) / latStep;
    const c0 = Math.floor(c), r0 = Math.floor(r);
    if (c0 < 0 || r0 < 0 || c0 + 1 >= cols || r0 + 1 >= rows) return this.baseElev;
    const tx = c - c0, ty = r - r0;
    const v = (rr: number, cc: number) => {
      const x = this.grid[rr * cols + cc];
      return x === -9999 ? NaN : x;
    };
    const v00 = v(r0, c0), v10 = v(r0, c0 + 1), v01 = v(r0 + 1, c0), v11 = v(r0 + 1, c0 + 1);
    const vals = [v00, v10, v01, v11].filter((x) => !Number.isNaN(x));
    if (!vals.length) return this.baseElev;
    if (vals.length < 4) return vals.reduce((a, b) => a + b, 0) / vals.length;
    return v00 * (1 - tx) * (1 - ty) + v10 * tx * (1 - ty) + v01 * (1 - tx) * ty + v11 * tx * ty;
  }

  /** Scene Y (metres above arbitrary base), vertical scale 1.0 */
  heightAtLonLat(lon: number, lat: number): number {
    return this.elevLonLat(lon, lat) - this.baseElev;
  }

  heightAtLocal(x: number, z: number): number {
    const [lon, lat] = (() => {
      const R = 6378137;
      const ORIGIN_LAT = 43.45, ORIGIN_LON = -80.5;
      const lat = ORIGIN_LAT - (z / R) * (180 / Math.PI);
      const lon = ORIGIN_LON + (x / (R * Math.cos((ORIGIN_LAT * Math.PI) / 180))) * (180 / Math.PI);
      return [lon, lat] as [number, number];
    })();
    return this.heightAtLonLat(lon, lat);
  }

  localXZ(lon: number, lat: number) {
    return lonLatToLocal(lon, lat);
  }
}
