/**
 * Terrain accuracy vs the independent lidar check points (tools/terrain/truth-points.json:
 * 1 m HRDEM DTM read straight from the NRCan COG, not from the game bake).
 *
 *  dem   – Elevation.elevLonLat (the baked game DEM: fine 2 m corridor layer, else 25 m)
 *  mesh  – GroundModel.surfaceHeight: the rendered 5 m terrain mesh, after cut/fill corridors
 *          and road sinks (what the player sees)
 * Stats are split: all points, and points > 25 m from any rail (outside the cut/fill zone,
 * where the game must not change the ground).
 *
 * Usage: node scripts/audit-terrain-dtm.mjs [--json out.json]
 * Also exports auditDtm(M, W, G) for the stress test.
 */
import * as esbuild from 'esbuild';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { bundleGame, loadWorld } from './drive-sim.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

export async function bundleGround() {
  const dir = await mkdtemp(path.join(tmpdir(), 'ion-lrt-ground-'));
  const outfile = path.join(dir, 'ground.mjs');
  await esbuild.build({ entryPoints: [path.join(root, 'src/game/Ground.ts')], outfile, format: 'esm', platform: 'neutral', bundle: true, logLevel: 'silent' });
  const mod = await import(pathToFileURL(outfile).href);
  return { G: mod, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

const stats = (e) => {
  if (!e.length) return { n: 0 };
  const a = e.map(Math.abs).sort((x, y) => x - y);
  return {
    n: e.length,
    rmse: Math.sqrt(e.reduce((s, x) => s + x * x, 0) / e.length),
    bias: e.reduce((s, x) => s + x, 0) / e.length,
    p95: a[Math.floor(a.length * 0.95)],
    max: a[a.length - 1],
  };
};

export async function auditDtm(M, W, G) {
  const truth = JSON.parse(await readFile(path.join(root, 'tools/terrain/truth-points.json'), 'utf8'));
  const ground = new G.GroundModel(W.dem);
  const ion = [W.tracks['ion-sb.geojson|false'], W.tracks['ion-nb.geojson|false']];
  for (const t of ion) ground.addTrack(t, { isStreet: (s) => W.row.isStreetBand(t.refS(s)) });
  ground.addTrack(W.tracks['waterloo-spur.geojson|false']);
  ground.addTrack(W.tracks['guelph-sub.geojson|false']);
  try {
    const gj = JSON.parse(await readFile(path.join(root, 'public/data/roads.geojson'), 'utf8'));
    ground.setRoads((gj.features || []).map((f) => ({ coords: f.geometry.coordinates, width: f.properties?.width || 6 })));
  } catch { /* no roads */ }
  const rows = truth.points.map((p) => {
    const [x, z] = M.lonLatToLocal ? M.lonLatToLocal(p.lon, p.lat) : W.dem.localXZ(p.lon, p.lat);
    const dem = W.dem.elevLonLat(p.lon, p.lat);
    const mesh = ground.surfaceHeight(x, z) + W.dem.baseElev;
    return { ...p, dem, mesh, eDem: dem - p.dtm_m, eMesh: mesh - p.dtm_m };
  });
  const far = rows.filter((r) => r.d_rail_m > 25);
  const worst = rows.slice().sort((a, b) => Math.abs(b.eMesh) - Math.abs(a.eMesh)).slice(0, 8)
    .map((r) => ({ lon: r.lon, lat: r.lat, d_rail_m: r.d_rail_m, dtm: r.dtm_m, mesh: +r.mesh.toFixed(2), err: +r.eMesh.toFixed(2) }));
  // stations: rail height at the platform vs lidar at the platform centroid
  const st = truth.stations.map((s) => {
    let best = null;
    for (const t of ion) {
      const sv = t.nearestS(s.lon, s.lat);
      const p = t.sampleRaw(sv);
      const [x, z] = W.dem.localXZ(s.lon, s.lat);
      const d = Math.hypot(p.x - x, p.z - z);
      if (!best || d < best.d) best = { d, rail: p.y + W.dem.baseElev - M.Track.BED_ABOVE_DEM_M, plat: !!t.points.find((q) => Math.abs(q.s - sv) < 3 && q.platform) };
    }
    return { name: s.name, osm: s.osm, lidar_platform_m: s.dtm_platform_m, rail_bed_minus_035_m: +best.rail.toFixed(2), diff_m: s.dtm_platform_m == null ? null : +(best.rail - s.dtm_platform_m).toFixed(2), on_level_span: best.plat, dist_m: +best.d.toFixed(1) };
  });
  return { source: truth.source, dem_all: stats(rows.map((r) => r.eDem)), dem_far: stats(far.map((r) => r.eDem)),
    mesh_all: stats(rows.map((r) => r.eMesh)), mesh_far: stats(far.map((r) => r.eMesh)), worst, stations: st, rows };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { M, cleanup } = await bundleGame();
  const { G, cleanup: c2 } = await bundleGround();
  const W = await loadWorld(M);
  const r = await auditDtm(M, W, G);
  const f = (s) => (s.n ? `n=${s.n} RMSE ${s.rmse.toFixed(3)} m, bias ${s.bias.toFixed(3)}, p95 ${s.p95.toFixed(2)}, max ${s.max.toFixed(2)} m` : 'n=0');
  console.log('truth:', r.source);
  console.log('baked DEM   all :', f(r.dem_all));
  console.log('baked DEM  >25m :', f(r.dem_far));
  console.log('5 m mesh    all :', f(r.mesh_all));
  console.log('5 m mesh   >25m :', f(r.mesh_far));
  console.log('worst mesh points:', JSON.stringify(r.worst));
  console.log('stations:'); for (const s of r.stations) console.log(' ', JSON.stringify(s));
  const i = process.argv.indexOf('--json');
  if (i > 0) await writeFile(process.argv[i + 1], JSON.stringify(r, null, 1));
  await cleanup(); await c2();
}
