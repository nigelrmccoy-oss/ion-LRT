/**
 * Terrain + rail vertical profile checks (HRDEM 1 m lidar bake, tools/terrain/bake-dem.py).
 *  T1 data provenance      T2 accuracy vs independent lidar points      T3 seams
 *  T4 max grade            T5 no steps / vertical curves                T6 level platforms
 *  T7 bridge decks         T8 cut/fill blends into the DTM              T9 station heights
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bundleGame, loadWorld } from './drive-sim.mjs';
import { bundleGround, auditDtm } from './audit-terrain-dtm.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

export async function terrainTests(assert) {
  const { M, cleanup } = await bundleGame();
  const { G, cleanup: cG } = await bundleGround();
  try {
    const W = await loadWorld(M);
    const meta = W.meta;
    // ---- T1 provenance ----------------------------------------------------------------------
    assert('T1. DEM is NRCan HRDEM 1 m lidar DTM in CGVD2013 (not SRTM/DSM)', /HRDEM/.test(meta.source) && /DTM/.test(meta.source) && meta.vertical_datum === 'CGVD2013');
    assert('T1. fine 2 m corridor layer loaded (ION ±300 m + OMSF)', W.dem.hasFine && meta.fine.tiles.length > 100 && meta.fine.corridor_m.ion_and_omsf >= 300, `${meta.fine.tiles.length} tiles`);
    assert('T1. Terrarium gap fill < 1 % of fine cells (logged in elevation.json fine_gaps)', meta.fine_gaps && meta.fine_gaps.fraction < 0.01, `${meta.fine_gaps?.terrarium_cells} cells`);
    const omsf = W.dem.elevLonLat(-80.5402, 43.4951);
    assert('T1. OMSF (518 Dutton Dr) is inside the fine layer', Number.isFinite(omsf) && omsf > 330 && omsf < 345, `${omsf.toFixed(2)} m`);

    // ---- T2 accuracy vs independent check points (1 m DTM straight from the COG) -------------
    const a = await auditDtm(M, W, G);
    assert('T2. baked DEM vs lidar: RMSE < 0.10 m over ≥ 200 corridor points', a.dem_all.n >= 200 && a.dem_all.rmse < 0.10, `n=${a.dem_all.n} RMSE ${a.dem_all.rmse.toFixed(3)} max ${a.dem_all.max.toFixed(2)} m`);
    assert('T2. rendered 5 m terrain mesh vs lidar (incl. cut/fill + roads): RMSE < 0.5 m', a.mesh_all.rmse < 0.5, `RMSE ${a.mesh_all.rmse.toFixed(3)} p95 ${a.mesh_all.p95.toFixed(2)} max ${a.mesh_all.max.toFixed(2)} m`);
    assert('T2. rendered mesh > 25 m from rails: RMSE < 0.3 m, |bias| < 0.1 m', a.mesh_far.rmse < 0.3 && Math.abs(a.mesh_far.bias) < 0.1, `n=${a.mesh_far.n} RMSE ${a.mesh_far.rmse.toFixed(3)} bias ${a.mesh_far.bias.toFixed(3)}`);

    // ---- T3 seams: no step where the fine layer meets the coarse grid -------------------------
    // Probe every outer tile edge (and the fade zone inside it) with point pairs 2 cm apart:
    // a seam shows as a jump; real slopes give ≤ a few cm over 2 cm.
    {
      const fm = meta.fine, T = fm.tileCells, idx = new Set(fm.tiles.map(([i, j]) => `${i},${j}`));
      let worst = 0, n = 0;
      const eps = 0.01; // cells (≈ 2 cm)
      const h = (c, r) => W.dem.elevLonLat(fm.origin.lon + c * fm.lonStep, fm.origin.lat + r * fm.latStep);
      for (const [ti, tj] of fm.tiles) {
        for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          if (idx.has(`${ti + di},${tj + dj}`)) continue;
          for (let k = 3; k < T; k += 13) {
            for (const inset of [0, 0.5, 1, 1.5, 8, 33]) {
              const c = di ? (di > 0 ? (ti + 1) * T - 1 - inset : ti * T + inset) : ti * T + k;
              const r = dj ? (dj > 0 ? (tj + 1) * T - 1 - inset : tj * T + inset) : tj * T + k;
              worst = Math.max(worst, Math.abs(h(c + di * eps, r + dj * eps) - h(c - di * eps, r - dj * eps))); n++;
            }
          }
        }
      }
      assert('T3. no seam where the 2 m lidar layer meets the 25 m grid (|Δh| ≤ 5 cm across 2 cm)', worst <= 0.05, `max ${worst.toFixed(3)} m over ${n} probes`);
    }

    // ---- T4–T7 on every game line, both directions -----------------------------------------
    const lines = [['ion-sb.geojson', 0.06], ['ion-nb.geojson', 0.06], ['waterloo-spur.geojson', 0.02], ['guelph-sub.geojson', 0.02]];
    for (const [f, cap] of lines) {
      for (const rev of [false, true]) {
        const t = W.tracks[`${f}|${rev}`], pts = t.points, tag = `${f.replace('.geojson', '')} ${rev ? 'rev' : 'fwd'}`;
        let gmax = 0, dgmax = 0, stepMax = 0;
        for (let i = 1; i < pts.length; i++) {
          const run = Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z);
          if (run < 0.5) continue;
          const g = (pts[i].y - pts[i - 1].y) / run;
          gmax = Math.max(gmax, Math.abs(g));
          stepMax = Math.max(stepMax, Math.abs(pts[i].y - pts[i - 1].y) - cap * run);
          if (i > 1) {
            const run0 = Math.hypot(pts[i - 1].x - pts[i - 2].x, pts[i - 1].z - pts[i - 2].z);
            if (run0 > 0.5) dgmax = Math.max(dgmax, Math.abs(g - (pts[i - 1].y - pts[i - 2].y) / run0) / ((run + run0) / 2));
          }
        }
        assert(`T4. ${tag}: max grade ≤ ${(cap * 100).toFixed(0)} %${cap === 0.06 ? ' (Stage 2 EPR Table 4-2)' : ' (heavy rail)'}`, t.designed && gmax <= cap + 1e-4, `${(gmax * 100).toFixed(2)} %`);
        assert(`T5. ${tag}: no steps or seams (every 5 m rise within the grade cap) and vertical curves R ≥ 250 m`, stepMax <= 1e-4 && (dgmax === 0 || 1 / dgmax >= 250), `step excess ${stepMax.toFixed(4)} m, min R ${dgmax ? (1 / dgmax).toFixed(0) : '∞'} m`);
        // T6 platforms
        if (f.startsWith('ion')) {
          let spans = 0, worstDev = 0, worstG = 0;
          for (let i = 0; i < pts.length; i++) {
            if (!pts[i].platform || (i > 0 && pts[i - 1].platform)) continue;
            let j = i; while (j + 1 < pts.length && pts[j + 1].platform) j++;
            if (j - i < 3) continue;
            spans++;
            const hs = (k) => Math.hypot(pts[k].x - pts[i].x, pts[k].z - pts[i].z);
            const g = (pts[j].y - pts[i].y) / Math.max(1, hs(j));
            worstG = Math.max(worstG, Math.abs(g));
            for (let k = i; k <= j; k++) worstDev = Math.max(worstDev, Math.abs(pts[i].y + g * hs(k) - pts[k].y));
          }
          assert(`T6. ${tag}: every platform is a straight, near-level span (|grade| ≤ 1 %, no vertical curve: dev ≤ 2 cm)`, spans >= 14 && worstG <= 0.0101 && worstDev <= 0.02,
            `${spans} platforms, max grade ${(worstG * 100).toFixed(2)} %, max dev ${(worstDev * 100).toFixed(1)} cm`);
        }
        // T7 bridges: deck kept above the valley, and the ground model treats it as a bridge
        let decks = 0, minClear = Infinity, notBridge = 0;
        const gm = new G.GroundModel(W.dem); gm.addTrack(t);
        for (let i = 0; i < pts.length; i++) {
          if (!pts[i].bridge || (i > 0 && pts[i - 1].bridge)) continue;
          let j = i; while (j + 1 < pts.length && pts[j + 1].bridge) j++;
          decks++;
          let low = Infinity, rail = 0;
          for (let k = i; k <= j; k++) { const g = W.dem.heightAtLocal(pts[k].x, pts[k].z); if (g < low) { low = g; rail = pts[k].y; } }
          minClear = Math.min(minClear, rail - low);
          for (const c of gm.tracks[0].samples) if (c.s > pts[i].s + 2 && c.s < pts[j].s - 2 && !c.bridge) notBridge++;
        }
        if (decks) {
          assert(`T7. ${tag}: ${decks} bridge deck(s) keep deck height (rail ≥ 2 m over the lowest DTM under the span), never buried in fill`, minClear >= 2 && notBridge === 0,
            `min rail-over-ground ${minClear.toFixed(2)} m, ${notBridge} non-bridge samples on decks`);
        }
      }
    }
    // ION has its 4 OSM bridges on the reference line (Laurel Creek ×2 area, Hwy 8 / Block Line, Mill/Courtland)
    const design = W.design;
    assert('T7. ION reference: 4 bridge decks from OSM bridge=yes, deck vs DSM (OCS-corrected) within 1.7 m', design.ion.bridges.length === 4 && design.ion.bridges.every((b) => b.deck_check_m === null || Math.abs(b.deck_check_m) < 1.7),
      design.ion.bridges.map((b) => `${b.s0}-${b.s1} m clr ${b.clearance_m} chk ${b.deck_check_m}`).join('; '));

    // ---- T8 cut/fill blends back into the DTM -----------------------------------------------
    {
      const gm = new G.GroundModel(W.dem);
      const sb = W.tracks['ion-sb.geojson|false'], nb = W.tracks['ion-nb.geojson|false'];
      gm.addTrack(sb); gm.addTrack(nb);
      let worst = 0, n = 0;
      for (let s = 50; s < sb.length - 50; s += 97) {
        const p = sb.sampleRaw(s), q = sb.sampleRaw(s + 1);
        const fx = q.x - p.x, fz = q.z - p.z, d = Math.hypot(fx, fz) || 1;
        for (const o of [-45, 45]) {
          const x = p.x + (fz / d) * o, z = p.z - (fx / d) * o;
          const sn = nb.sampleRaw(nb.nearestSLocal(x, z));
          if (Math.hypot(sn.x - x, sn.z - z) < 40) continue; // other running line nearby
          worst = Math.max(worst, Math.abs(gm.exactHeight(x, z) - W.dem.heightAtLocal(x, z))); n++;
        }
      }
      assert('T8. cut/fill slopes end inside 45 m: ground 45 m from the rail is the untouched DTM', worst < 1e-6 && n > 100, `max Δ ${worst.toExponential(1)} m over ${n} pts`);
    }

    // ---- T9 station heights vs lidar platform surface ---------------------------------------
    {
      const st = a.stations.filter((s) => s.lidar_platform_m != null && s.dist_m < 6 && s.osm !== 'way/1369817041');
      const worst = Math.max(...st.map((s) => Math.abs(s.diff_m)));
      assert('T9. rail bed at every ION platform within 0.6 m of the lidar platform surface (raised platform ≈ 0.1–0.5 m)', st.length >= 20 && worst < 0.6,
        `${st.length} platforms, worst ${worst.toFixed(2)} m`);
    }
  } finally {
    await cleanup(); await cG();
  }
}
