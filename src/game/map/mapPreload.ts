/**
 * Preload cacheable map tiles around the train and along the route ahead.
 * Sources: AWS Terrarium DEM, Ontario OIWMS (SWOOP) imagery, OSM Overpass.
 * Fail-soft: a missed tile is skipped; Bing / Google URLs are never queued.
 */
import { localToLonLat } from '../coords';
import { cachedDem, cachedOiwms, cachedOverpass, isForbiddenToDiskCache } from './mapFetch';

export const TERRARIUM_URL =
  'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';

/** Ontario Imagery Web Map Service (SWOOP 2025 / SCOOP), Open Government Licence – Ontario. */
export const OIWMS_TILE_URL =
  'https://ws.lioservices.lrc.gov.on.ca/arcgis2/rest/services/LIO_Imagery/Ontario_Imagery_Web_Map_Service/MapServer/tile/{z}/{y}/{x}';

export type LonLat = { lon: number; lat: number };

export type TileXYZ = { z: number; x: number; y: number };

export function lonLatToTile(lon: number, lat: number, z: number): TileXYZ {
  const n = 2 ** z;
  const x = Math.floor(((lon + 180) / 360) * n);
  const latRad = (lat * Math.PI) / 180;
  const y = Math.floor((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * n);
  return { z, x: clampTile(x, n), y: clampTile(y, n) };
}

function clampTile(v: number, n: number): number {
  if (v < 0) return 0;
  if (v > n - 1) return n - 1;
  return v;
}

/** Tiles covering a radius (metres) around a lon/lat at a zoom level. */
export function tilesAround(lon: number, lat: number, z: number, radiusM: number): TileXYZ[] {
  const { x, y } = lonLatToTile(lon, lat, z);
  const mPerTile = (40075016.686 * Math.cos((lat * Math.PI) / 180)) / 2 ** z;
  const r = Math.max(0, Math.ceil(radiusM / Math.max(1, mPerTile)));
  const out: TileXYZ[] = [];
  const n = 2 ** z;
  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      const xx = x + dx;
      const yy = y + dy;
      if (xx < 0 || yy < 0 || xx >= n || yy >= n) continue;
      out.push({ z, x: xx, y: yy });
    }
  }
  return out;
}

export function tilesAlongRoute(points: LonLat[], z: number, radiusM: number): TileXYZ[] {
  const seen = new Set<string>();
  const out: TileXYZ[] = [];
  for (const p of points) {
    for (const t of tilesAround(p.lon, p.lat, z, radiusM)) {
      const k = `${t.z}/${t.x}/${t.y}`;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(t);
    }
  }
  return out;
}

function tileUrl(template: string, t: TileXYZ): string {
  return template.replace('{z}', String(t.z)).replace('{x}', String(t.x)).replace('{y}', String(t.y));
}

export type PreloadRequest = {
  lon: number;
  lat: number;
  ahead?: LonLat[];
  /** When false, skip the network (tests / unit planning). Default true. */
  fetch?: boolean;
};

export type PreloadPlan = {
  dem: string[];
  oiwms: string[];
  overpassQueries: string[];
};

/** Modest zooms: Terrarium z14 near / z12 ahead; OIWMS z16 near / z15 ahead. */
export function planPreload(req: PreloadRequest): PreloadPlan {
  const near = { lon: req.lon, lat: req.lat };
  const ahead = req.ahead ?? [];
  const demTiles = [
    ...tilesAround(near.lon, near.lat, 14, 1200),
    ...tilesAlongRoute(ahead, 12, 800),
  ];
  const imgTiles = [
    ...tilesAround(near.lon, near.lat, 16, 600),
    ...tilesAlongRoute(ahead, 15, 400),
  ];
  const uniq = (urls: string[]) => [...new Set(urls)].filter((u) => !isForbiddenToDiskCache(u));
  const boxes = overpassBboxes(near, ahead);
  return {
    dem: uniq(demTiles.map((t) => tileUrl(TERRARIUM_URL, t))),
    oiwms: uniq(imgTiles.map((t) => tileUrl(OIWMS_TILE_URL, t))),
    overpassQueries: boxes.map(bboxQuery),
  };
}

function overpassBboxes(near: LonLat, ahead: LonLat[]): [number, number, number, number][] {
  const pts = [near, ...ahead];
  const pad = 0.008;
  const cells = new Map<string, [number, number, number, number]>();
  const step = 0.02;
  for (const p of pts) {
    const s = Math.floor((p.lat - pad) / step) * step;
    const w = Math.floor((p.lon - pad) / step) * step;
    const key = `${s.toFixed(3)},${w.toFixed(3)}`;
    if (!cells.has(key)) cells.set(key, [s, w, s + step + 2 * pad, w + step + 2 * pad]);
  }
  return [...cells.values()];
}

function bboxQuery([s, w, n, e]: [number, number, number, number]): string {
  return `[out:json][timeout:25];(way["railway"~"light_rail|tram|rail"](${s},${w},${n},${e});node["railway"="signal"](${s},${w},${n},${e});way["highway"](${s},${w},${n},${e}););out body;>;out skel qt;`;
}

let preloadGen = 0;

export async function preloadAroundTrain(req: PreloadRequest): Promise<PreloadPlan> {
  const plan = planPreload(req);
  if (req.fetch === false) return plan;
  const gen = ++preloadGen;
  const jobs: Promise<unknown>[] = [];
  for (const url of plan.dem) {
    jobs.push(cachedDem(url).catch(() => undefined));
  }
  for (const url of plan.oiwms) {
    jobs.push(cachedOiwms(url).catch(() => undefined));
  }
  for (const q of plan.overpassQueries) {
    jobs.push(cachedOverpass(q).catch(() => undefined));
  }
  await Promise.all(jobs);
  void gen;
  return plan;
}

export type PreloadGame = {
  running: boolean;
  s: number;
  track?: { length: number; sample(s: number): { x: number; z: number } };
};

let timer: ReturnType<typeof setInterval> | null = null;
let lastCell = '';

/**
 * Poll the running game and warm the cache around the train + 4 km ahead.
 * Safe to call from main.ts; does not edit Game.ts (keeps this rebase-friendly).
 */
export function attachMapPreload(game: PreloadGame, intervalMs = 4000): void {
  detachMapPreload();
  if (typeof window === 'undefined') return;
  const tick = () => {
    if (!game.running || !game.track) return;
    const pose = game.track.sample(game.s);
    const [lon, lat] = localToLonLat(pose.x, pose.z);
    const cell = `${lon.toFixed(3)},${lat.toFixed(3)}`;
    if (cell === lastCell) return;
    lastCell = cell;
    const ahead: LonLat[] = [];
    for (let d = 250; d <= 4000; d += 250) {
      const s = Math.min(game.track.length, game.s + d);
      const p = game.track.sample(s);
      const ll = localToLonLat(p.x, p.z);
      ahead.push({ lon: ll[0], lat: ll[1] });
    }
    void preloadAroundTrain({ lon, lat, ahead }).catch(() => undefined);
  };
  tick();
  timer = setInterval(tick, intervalMs);
}

export function detachMapPreload(): void {
  if (timer !== null) {
    clearInterval(timer);
    timer = null;
  }
  lastCell = '';
}
