import { lonLatToLocal, localToLonLat } from './coords';

/** Fine corridor layer: ~2 m lon/lat grid of uint16 tiles (HRDEM 1 m DTM, area-averaged). */
export type FineMeta = {
  binary: string;
  origin: { lon: number; lat: number };
  lonStep: number;
  latStep: number;
  tileCells: number;
  encOffset: number;
  encScale: number;
  tiles: [number, number][];
};

/** 2 m rail design profile along one geojson line (see tools/terrain/bake-dem.py). */
export type LineDesign = {
  step_m: number;
  /** Rail bed − BED_ABOVE_DEM_M, ASL, at horizontal chainage i*step_m (geojson stored order). */
  y: number[];
  bridges: { s0: number; s1: number }[];
  platforms: { name: string | null; s0: number; s1: number; level_asl: number }[];
  stats?: Record<string, number>;
};
export type TrackDesignFile = { lines: Record<string, LineDesign> };

export type ElevMeta = {
  bounds: { minLon: number; maxLon: number; minLat: number; maxLat: number };
  latStep: number;
  lonStep: number;
  cols: number;
  rows: number;
  track_profiles: { ion: number[]; spur: number[]; guelph: number[]; sb?: number[]; nb?: number[] };
  spot_checks_m: Record<string, { lat: number; lon: number; elev_m: number }>;
  vertical_scale: number;
  fine?: FineMeta;
};

export class Elevation {
  meta!: ElevMeta;
  private grid!: Float32Array;
  /** Fine corridor tiles (null until attached; the coarse grid is used everywhere else). */
  private fine: { meta: FineMeta; data: Uint16Array; index: Map<number, number> } | null = null;
  /** Reference elevation so terrain sits near y=0 */
  baseElev = 330;

  async load() {
    const meta = (await (await fetch('./data/elevation.json')).json()) as ElevMeta;
    const bin = await (await fetch('./data/elevation.bin')).arrayBuffer();
    let fine: ArrayBuffer | null = null;
    if (meta.fine) {
      try {
        const r = await fetch(`./data/${meta.fine.binary}`);
        if (r.ok) fine = await r.arrayBuffer();
      } catch { fine = null; }
    }
    this.init(meta, bin, fine);
  }

  /** Synchronous set-up from already-loaded buffers (game + headless tests share this). */
  init(meta: ElevMeta, coarse: ArrayBuffer | ArrayBufferView, fine: ArrayBuffer | ArrayBufferView | null = null) {
    this.meta = meta;
    this.grid = Elevation.f32(coarse);
    const spots = Object.values(meta.spot_checks_m).map((s) => s.elev_m).filter((v) => v != null);
    this.baseElev = spots.reduce((a, b) => a + b, 0) / Math.max(1, spots.length);
    this.fine = null;
    if (fine && meta.fine) this.attachFine(fine);
    return this;
  }

  attachFine(buf: ArrayBuffer | ArrayBufferView) {
    const fm = this.meta.fine;
    if (!fm) return;
    const u8 = buf instanceof ArrayBuffer ? new Uint8Array(buf) : new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    const copy = new Uint8Array(u8.length);
    copy.set(u8);
    const data = new Uint16Array(copy.buffer);
    const per = fm.tileCells * fm.tileCells;
    if (data.length < per * fm.tiles.length) return;
    const index = new Map<number, number>();
    fm.tiles.forEach(([ti, tj], k) => index.set(ti * 100000 + tj, k * per));
    this.fine = { meta: fm, data, index };
  }

  get hasFine() { return this.fine !== null; }

  private static f32(b: ArrayBuffer | ArrayBufferView): Float32Array {
    if (b instanceof ArrayBuffer) return new Float32Array(b);
    const copy = new Uint8Array(b.byteLength);
    copy.set(new Uint8Array(b.buffer, b.byteOffset, b.byteLength));
    return new Float32Array(copy.buffer);
  }

  /** Fine-layer cell value (m ASL) or NaN outside the corridor tiles / no data. */
  private fineCell(r: number, c: number): number {
    const f = this.fine!;
    const T = f.meta.tileCells;
    const off = f.index.get(Math.floor(c / T) * 100000 + Math.floor(r / T));
    if (off === undefined) return NaN;
    const v = f.data[off + (r % T) * T + (c % T)];
    return v === 0 ? NaN : f.meta.encOffset + v * f.meta.encScale;
  }

  private fineLonLat(lon: number, lat: number): number {
    const fm = this.fine!.meta;
    const c = (lon - fm.origin.lon) / fm.lonStep;
    const r = (lat - fm.origin.lat) / fm.latStep;
    const c0 = Math.floor(c), r0 = Math.floor(r);
    if (c0 < 0 || r0 < 0) return NaN;
    const v00 = this.fineCell(r0, c0), v10 = this.fineCell(r0, c0 + 1);
    const v01 = this.fineCell(r0 + 1, c0), v11 = this.fineCell(r0 + 1, c0 + 1);
    if (Number.isNaN(v00) || Number.isNaN(v10) || Number.isNaN(v01) || Number.isNaN(v11)) return NaN;
    const tx = c - c0, ty = r - r0;
    return v00 * (1 - tx) * (1 - ty) + v10 * tx * (1 - ty) + v01 * (1 - tx) * ty + v11 * tx * ty;
  }

  /** Width of the fine→coarse cross-fade at the outer edge of the corridor tiles (cells ≈ 2 m). */
  static readonly FINE_BLEND_CELLS = 32;

  /**
   * 0..1 weight of the fine layer: 1 inside the corridor, fading to 0 over FINE_BLEND_CELLS
   * toward any edge or corner that borders a tile with no fine data — so there is no seam
   * (step) where the 2 m lidar layer meets the 25 m grid.
   */
  private fineWeight(lon: number, lat: number): number {
    const f = this.fine!;
    const fm = f.meta, T = fm.tileCells;
    const c = (lon - fm.origin.lon) / fm.lonStep, r = (lat - fm.origin.lat) / fm.latStep;
    const ti = Math.floor(c / T), tj = Math.floor(r / T);
    const u = c - ti * T, v = r - tj * T; // 0..T within the tile
    const has = (di: number, dj: number) => f.index.has((ti + di) * 100000 + (tj + dj));
    let d = Infinity;
    if (!has(-1, 0)) d = Math.min(d, u);
    if (!has(1, 0)) d = Math.min(d, T - 1 - u);
    if (!has(0, -1)) d = Math.min(d, v);
    if (!has(0, 1)) d = Math.min(d, T - 1 - v);
    if (!has(-1, -1)) d = Math.min(d, Math.max(u, v));
    if (!has(1, -1)) d = Math.min(d, Math.max(T - 1 - u, v));
    if (!has(-1, 1)) d = Math.min(d, Math.max(u, T - 1 - v));
    if (!has(1, 1)) d = Math.min(d, Math.max(T - 1 - u, T - 1 - v));
    const w = Math.max(0, Math.min(1, (d - 1) / Elevation.FINE_BLEND_CELLS));
    return w * w * (3 - 2 * w); // smoothstep: no slope kink at either end of the fade
  }

  /** Absolute metres ASL (CGVD2013) from lon/lat: fine corridor layer, else coarse (bilinear). */
  elevLonLat(lon: number, lat: number): number {
    if (this.fine) {
      const f = this.fineLonLat(lon, lat);
      if (!Number.isNaN(f)) {
        const w = this.fineWeight(lon, lat);
        return w >= 1 ? f : w * f + (1 - w) * this.coarseLonLat(lon, lat);
      }
    }
    return this.coarseLonLat(lon, lat);
  }

  coarseLonLat(lon: number, lat: number): number {
    const { bounds, lonStep, latStep, cols, rows } = this.meta;
    const c = (lon - bounds.minLon) / lonStep;
    const r = (lat - bounds.minLat) / latStep;
    const c0 = Math.floor(c), r0 = Math.floor(r);
    if (c0 < 0 || r0 < 0 || c0 + 1 >= cols || r0 + 1 >= rows) return this.baseElev;
    const tx = c - c0, ty = r - r0;
    const v = (rr: number, cc: number) => {
      const x = this.grid[rr * cols + cc];
      return x === -9999 || !Number.isFinite(x) ? NaN : x;
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
    const [lon, lat] = localToLonLat(x, z);
    return this.heightAtLonLat(lon, lat);
  }

  localXZ(lon: number, lat: number) {
    return lonLatToLocal(lon, lat);
  }
}
