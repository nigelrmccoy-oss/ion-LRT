/**
 * Terrain / vertical-profile audit (read-only, no game launch). Builds every route exactly
 * like Game.start() and reports, per route and direction:
 *   - rail grade statistics (max, 99th percentile, share of length above the design grade)
 *   - raw SRTM gradient over a 30 m baseline (spikes / noise) vs the rail grade
 *   - rail height vs DEM (cut / fill extremes)
 *   - vertical curve radius over a ±20 m window vs Transit Toronto's Flexity Freedom
 *     minimum vertical radii (convex/crest 122 m, concave/sag 244 m)
 *   - forward vs reverse profile consistency (same ground point, opposite direction)
 * Usage: node scripts/audit-terrain.mjs   (exports auditTerrain(M, W) for the test suite)
 */
import { bundleGame, loadWorld } from './drive-sim.mjs';
import { pathToFileURL } from 'node:url';

const pct = (a, p) => { const b = [...a].sort((x, y) => x - y); return b[Math.min(b.length - 1, Math.floor(p * b.length))]; };

export function auditTrack(M, W, tr) {
  const L = tr.length, step = 5;
  const ss = []; for (let s = 0; s <= L; s += step) ss.push(s);
  const rail = ss.map((s) => tr.sample(s));
  const gr = ss.map((s) => tr.sample(s).grade);
  const absG = gr.map(Math.abs);
  // raw DEM gradient over a 30 m baseline
  const dem = ss.map((_, i) => W.dem.elevLonLat(rail[i].lon, rail[i].lat));
  const k = 3; // 3 × 5 m = ±15 m
  const demG = []; for (let i = k; i < ss.length - k; i++) demG.push(Math.abs((dem[i + k] - dem[i - k]) / (ss[i + k] - ss[i - k])));
  const dRail = rail.map((p, i) => p.y + W.dem.baseElev - dem[i]);
  // vertical radius over ±20 m (4 steps)
  const w = 4; let minCrest = Infinity, minSag = Infinity, nCrest = 0, nSag = 0;
  for (let i = w; i < ss.length - w; i++) {
    const dg = gr[i + w] - gr[i - w]; // + = sag (concave), − = crest (convex)
    if (Math.abs(dg) < 1e-9) continue;
    const R = (ss[i + w] - ss[i - w]) / Math.abs(dg);
    if (dg > 0) { minSag = Math.min(minSag, R); if (R < 244) nSag++; } else { minCrest = Math.min(minCrest, R); if (R < 122) nCrest++; }
  }
  const above = (lim) => absG.filter((g) => g > lim).length * step;
  return {
    length: L, maxGrade: Math.max(...absG), p99Grade: pct(absG, 0.99), above45m: above(0.045), above50m: above(0.0499),
    demMaxGrade: Math.max(...demG), demP99: pct(demG, 0.99), demAbove6: demG.filter((g) => g > 0.06).length * step,
    cutMax: Math.min(...dRail), fillMax: Math.max(...dRail),
    minCrestR: minCrest, minSagR: minSag, nCrest, nSag,
    zmin: Math.min(...rail.map((p) => p.y)), zmax: Math.max(...rail.map((p) => p.y)),
  };
}

/** Max |Δy| between the forward and reverse profile of the same route at the same ground point. */
export function fwdRevDelta(tr, trRev) {
  let worst = 0, matched = 0, total = 0;
  for (let s = 0; s <= tr.length; s += 10) {
    total++;
    const p = tr.sampleRaw(s), q = trRev.sampleRaw(Math.max(0, Math.min(trRev.length, trRev.length - s)));
    if (Math.hypot(p.x - q.x, p.z - q.z) > 15) continue; // reversed chainage drifts a little if lengths differ
    matched++;
    worst = Math.max(worst, Math.abs(p.y - q.y));
  }
  return { worst, matched, total };
}

/** Largest grade step between adjacent 5 m samples (spike detector) and the largest gap between the
 *  stored physics grade and the geometric rail slope over ±5 m. */
export function gradeConsistency(tr) {
  let jump = 0, slopeGap = 0;
  let prev = null;
  for (let s = 5; s < tr.length - 5; s += 5) {
    const g = tr.sample(s).grade;
    if (prev !== null) jump = Math.max(jump, Math.abs(g - prev));
    prev = g;
    const a = tr.sampleRaw(s - 5), b = tr.sampleRaw(s + 5);
    slopeGap = Math.max(slopeGap, Math.abs(g - (b.y - a.y) / Math.hypot(b.x - a.x, b.z - a.z)));
  }
  return { jump, slopeGap };
}

export async function main() {
  const { M, cleanup } = await bundleGame();
  try {
    const W = await loadWorld(M);
    const routes = ['ion-sb.geojson', 'ion-nb.geojson', 'waterloo-spur.geojson', 'guelph-sub.geojson'];
    const f = (x, d = 2) => (Number.isFinite(x) ? x.toFixed(d) : '—');
    console.log('route|dir|len m|max grade %|p99 %|m >4.5%|raw DEM max %|raw DEM p99 %|rail-DEM min/max m|min crest R|min sag R|#crest<122|#sag<244|fwd/rev max Δy m');
    for (const r of routes) for (const rev of [false, true]) {
      const tr = W.tracks[`${r}|${rev}`], a = auditTrack(M, W, tr);
      const d = rev ? '' : f(fwdRevDelta(tr, W.tracks[`${r}|true`]).worst);
      console.log([r.replace('.geojson', ''), rev ? 'rev' : 'fwd', f(a.length, 0), f(a.maxGrade * 100), f(a.p99Grade * 100), f(a.above45m, 0), f(a.demMaxGrade * 100),
        f(a.demP99 * 100), `${f(a.cutMax)}/${f(a.fillMax)}`, f(a.minCrestR, 0), f(a.minSagR, 0), a.nCrest, a.nSag, d].join('|'));
    }
  } finally { await cleanup(); }
}
if (import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((e) => { console.error(e); process.exit(1); });
