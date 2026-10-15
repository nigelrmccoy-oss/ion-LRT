/**
 * v1.4.3 stress sections (called from stress-test.mjs after the drive sims):
 *   L. train lights (Flexity + diesel), auto at dusk/night, H toggle, ≤ 1 real-time light, no shadows
 *   G. ION minimum curve radius ≥ 25 m after the OSM refit (SB s≈8790 was R≈19 m)
 *   W. wheel-slip control + automatic sanding: wet P7 start on the real 4.9 % SB grade
 *   P. every ION stop mark on its OSM platform (NB Fairway was 43 m off)
 *   N. station name signs readable from both sides (were mirrored from the platform)
 *   C. side camera on the platform side (left-side platforms)
 *   S. signal-head association: distance + facing (other-street) filter, no real intersection lost
 *   F. snow overdraw: no flakes in the clear zone around the camera
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bundleGame, loadWorld, layoutStations } from './drive-sim.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Minimal DOM canvas stub so the three.js vehicle builders run headless (no WebGL). */
function stubDocument() {
  if (globalThis.document) return () => {};
  const grad = { addColorStop() {} };
  const ctx = new Proxy({}, {
    get: (_t, k) => (k === 'createRadialGradient' || k === 'createLinearGradient' ? () => grad : () => {}),
    set: () => true,
  });
  globalThis.document = { createElement: () => ({ width: 0, height: 0, getContext: () => ctx, style: {} }) };
  return () => { delete globalThis.document; };
}

export async function v143Tests(assert) {
  const { M, cleanup } = await bundleGame();
  const unstub = stubDocument();
  try {
    const W = await loadWorld(M);
    const sb = W.tracks['ion-sb.geojson|false'], nb = W.tracks['ion-nb.geojson|false'];

    // ---- L. lights ---------------------------------------------------------------------
    {
      const lrv = M.createFlexityArticulated();
      const L = M.TrainLights.forFlexity(lrv, '301 FAIRWAY');
      const lights = []; lrv.group.traverse((o) => { if (o.isLight) lights.push(o); });
      assert('L. Flexity adds ≤ 1 real-time light and none casts shadows', lights.length <= M.TRAIN_MAX_REALTIME_LIGHTS && lights.every((l) => !l.castShadow),
        `${lights.length} light(s): ${lights.map((l) => l.type).join(',')}`);
      const a = lrv.modules[0], e = lrv.modules[lrv.modules.length - 1];
      const lenA = M.MODULES[0].len, lenE = M.MODULES[M.MODULES.length - 1].len;
      const headOk = L.head.length === 2 && L.head.every((l) => l.mesh.parent === a && l.mesh.position.z > lenA / 2 - 0.4 && l.mesh.position.z <= lenA / 2 + 0.05)
        && Math.abs(L.head[0].mesh.position.x + L.head[1].mesh.position.x) < 1e-6 && Math.abs(L.head[0].mesh.position.x) > 0.5;
      assert('L. dual white headlights on the lead cab nose (A, symmetric)', headOk && L.head.every((l) => l.on.r > 0.9 && l.on.g > 0.85 && l.on.b > 0.7),
        L.head.map((l) => `${l.mesh.position.x.toFixed(2)},${l.mesh.position.z.toFixed(2)}`).join(' '));
      const tailOk = L.tail.length === 2 && L.tail.every((l) => l.mesh.parent === e && l.mesh.position.z < -(lenE / 2 - 0.4) && l.on.r > 0.9 && l.on.g < 0.2);
      assert('L. red tail lights on the trailing cab (E rear)', tailOk);
      assert('L. destination signs lit on both cabs, children of the sign (hidden in cab view)', L.destFaces.length === 2 && L.destFaces.every((f) => f.parent?.name === 'destSign'));
      assert('L. interior lighting through the window band (lrvGlass)', L.interior.length === 1 && L.interior[0].name === 'lrvGlass');
      L.update(true, 0);
      const onOk = L.spot.intensity > 0 && L.pool.visible && L.head.every((l) => l.glow.visible) && L.interior[0].emissiveIntensity > 0;
      L.update(false, 0);
      const offOk = L.spot.intensity === 0 && !L.pool.visible && L.head.every((l) => !l.glow.visible) && L.interior[0].emissiveIntensity === 0
        && L.spot.parent === a; // stays in the scene: constant light count, no shader recompile
      assert('L. on: beam + pool + glow + interior; off: dimmed to 0 but the light stays in the scene', onOk && offOk);
      const spotAim = L.spot.target.position.z - L.spot.position.z;
      assert('L. headlight beam aims ahead of the nose (≥ 25 m)', spotAim >= 25 && L.spot.angle < 0.6 && L.spot.distance >= 100, `aim ${spotAim.toFixed(1)} m, angle ${L.spot.angle}`);
    }
    {
      const g = M.createDieselConsist('wcr');
      const L = M.TrainLights.forDiesel(g);
      const lights = []; g.traverse((o) => { if (o.isLight) lights.push(o); });
      assert('L. diesel adds ≤ 1 real-time light, no shadows', lights.length <= M.TRAIN_MAX_REALTIME_LIGHTS && lights.every((l) => !l.castShadow));
      const D = M.DIESEL_DIMS;
      assert('L. diesel headlight + 2 ditch lights at the front, red rear marker at the coach end',
        L.head.length >= 1 && L.head.every((l) => l.mesh.position.z >= D.noseZ1) && L.ditch.length === 2
        && L.ditch.every((l) => l.mesh.position.z >= D.noseZ1 && l.mesh.position.y < D.frameTop)
        && L.marker.length === 1 && Math.abs(L.marker[0].mesh.position.z + M.DIESEL_CONSIST_REAR_M) < 0.1 && L.marker[0].on.r > 0.9 && L.marker[0].on.g < 0.2,
        `marker z ${L.marker[0]?.mesh.position.z.toFixed(2)} vs −${M.DIESEL_CONSIST_REAR_M}`);
      const lit = (l) => l.glow.visible;
      L.update(true, 0, true); const f0 = L.ditch.map(lit);
      L.update(true, 1 / (2 * M.DITCH_FLASH_HZ) + 0.01, true); const f1 = L.ditch.map(lit);
      L.update(true, 0, false); const steady = L.ditch.map(lit);
      assert('L. ditch lights alternate when flashing (horn / crossing), steady otherwise',
        f0[0] !== f0[1] && f1[0] === f0[1] && f1[1] === f0[0] && steady.every(Boolean), JSON.stringify({ f0, f1, steady }));
      L.update(true, 0); const m0 = lit(L.marker[0]);
      L.update(true, 0.5 / M.MARKER_FLASH_HZ + 0.01); const m1 = lit(L.marker[0]);
      assert('L. rear marker flashes', m0 !== m1);
    }
    {
      const ok = !M.lightsOn('auto', 'day') && M.lightsOn('auto', 'dusk') && M.lightsOn('auto', 'night')
        && M.lightsOn('on', 'day') && !M.lightsOn('off', 'night')
        && M.toggleLightsMode('auto', 'night') === 'off' && M.toggleLightsMode('auto', 'day') === 'on'
        && M.toggleLightsMode('off', 'night') === 'on' && M.toggleLightsMode('on', 'day') === 'off';
      assert('L. lights auto-on at dusk/night; H flips what is showing', ok);
      const game = await readFile(path.join(root, 'src/game/Game.ts'), 'utf8');
      const tut = await readFile(path.join(root, 'src/game/Tutorial.ts'), 'utf8');
      const readme = await readFile(path.join(root, 'README.md'), 'utf8');
      assert('L. H key wired in Game and documented (tutorial + README)',
        /'KeyH'/.test(game) && /toggleLightsMode/.test(game) && /\bH\b[^.\n]*headlights/i.test(tut) && /\*\*H\*\*|`H`/.test(readme));
    }

    // ---- G. minimum radius ---------------------------------------------------------------
    {
      const h = 12;
      const rows = [];
      let worst = Infinity;
      for (const key of ['ion-sb.geojson|false', 'ion-nb.geojson|false', 'ion-sb.geojson|true', 'ion-nb.geojson|true']) {
        const t = W.tracks[key];
        let min = Infinity, at = 0;
        for (let s = h; s <= t.length - h; s += 1) { const r = t.radiusAt(s, h); if (r < min) { min = r; at = s; } }
        rows.push(`${key.replace('.geojson', '')} R${min.toFixed(1)}@${Math.round(at)} off ${t.refitMaxOffsetM.toFixed(2)} m`);
        worst = Math.min(worst, min);
      }
      assert('G. ION SB/NB (both build directions): min radius (±12 m three-point) ≥ 25 m', worst >= M.MIN_CURVE_RADIUS_M, rows.join('; '));
      const offs = ['ion-sb.geojson|false', 'ion-nb.geojson|false'].map((k) => W.tracks[k].refitMaxOffsetM);
      assert('G. refit stays within 2 m of the OSM line (consistent with the real alignment)', offs.every((o) => o <= 2), offs.map((o) => o.toFixed(2)).join(' / ') + ' m');
      const heavy = ['waterloo-spur.geojson|false', 'guelph-sub.geojson|false'].map((k) => W.tracks[k].refitMaxOffsetM);
      assert('G. heavy-rail lines (R ≥ 84 m) are not moved by the refit', heavy.every((o) => o < 0.05), heavy.map((o) => o.toFixed(3)).join(' / '));
      assert('G. ION reference chainage line is not refit (ROW/OCS keys unchanged)', W.ion.refitMaxOffsetM === 0);
      // articulated swept path: module-end centreline offset from the track centreline
      const endOff = (t) => {
        let max = 0, at = 0;
        for (let s = 20; s < t.length - 20; s += 2) {
          const pose = M.poseConsist(t, s, 1);
          for (const m of pose.modules) for (const sg of [-1, 1]) {
            const x = m.pos.x + m.fwd.x * sg * m.len / 2, z = m.pos.z + m.fwd.z * sg * m.len / 2;
            const q = t.sampleRaw(t.nearestSLocal(x, z));
            const d = Math.hypot(q.x - x, q.z - z);
            if (d > max) { max = d; at = s; }
          }
        }
        return { max, at };
      };
      const eS = endOff(sb), eN = endOff(nb);
      const near8790 = (() => { let m = 0; for (let s = 8740; s <= 8840; s += 1) { const p = M.poseConsist(sb, s, 1); for (const md of p.modules) for (const sg of [-1, 1]) { const x = md.pos.x + md.fwd.x * sg * md.len / 2, z = md.pos.z + md.fwd.z * sg * md.len / 2; const q = sb.sampleRaw(sb.nearestSLocal(x, z)); m = Math.max(m, Math.hypot(q.x - x, q.z - z)); } } return m; })();
      assert('G. articulated module ends stay ≤ 1.5 m off the centreline everywhere (SB s≈8790 was 1.84 m)',
        eS.max <= 1.5 && eN.max <= 1.5, `SB max ${eS.max.toFixed(2)} m @${eS.at}, NB ${eN.max.toFixed(2)} m @${eN.at}, SB 8740–8840 ${near8790.toFixed(2)} m`);
    }

    // ---- W. wheel-slip control + automatic sanding ----------------------------------------
    {
      // the QA repro: SB s = 9535 (+4.9 %), rain, P7 from standstill
      const run = (cfg) => {
        const p = new M.TrainPhysics({ massKg: M.MASS_FLEXITY_KG, weather: 'rain', electric: true, axleFrac: M.AXLE_FRAC_FLEXITY });
        p.reverser = 1; p.pantographUp = true; p.lineVoltage = 750; p.resetVigilance();
        p.slipControl = cfg.slipControl; p.autoSand = cfg.autoSand; p.sanding = !!cfg.manualSand;
        p.powerNotch = 7;
        let s = 9535, minV = 0, slip = 0, sandSeen = false, v12 = 0, maxG = 0;
        const dt = 0.05;
        for (let t = 0; t < 40; t += dt) {
          const q = sb.sample(s);
          maxG = Math.max(maxG, q.grade);
          p.resetVigilance();
          p.step(dt, q.grade, q.curvature);
          s += p.speed * dt;
          minV = Math.min(minV, p.speed);
          if (p.wheelslip) slip += dt;
          if (p.sandActive()) sandSeen = true;
          if (Math.abs(t - 12) < dt / 2) v12 = p.speedKmh();
        }
        return { dist: s - 9535, v12, vEnd: p.speedKmh(), minV, slip, sandSeen, maxG };
      };
      const g0 = sb.sample(9535).grade;
      const legacy = run({ slipControl: false, autoSand: false });
      const ctrl = run({ slipControl: true, autoSand: false });
      const auto = run({ slipControl: true, autoSand: true });
      const manual = run({ slipControl: true, autoSand: false, manualSand: true });
      const fmt = (r) => `${r.dist.toFixed(0)} m, ${r.v12.toFixed(1)} km/h @12 s, slip ${r.slip.toFixed(1)} s`;
      assert('W. repro: SB s=9535 is the ~4.9 % climb', g0 > 0.045, `grade ${(g0 * 100).toFixed(2)} %`);
      assert('W. v1.4.2 behaviour (no slip control, no sand) still stalls there — the bug', legacy.v12 < 6, fmt(legacy));
      assert('W. creep-controlled traction, no sand at all: rain P7 start succeeds (≥ 15 km/h in 12 s, no rollback)',
        ctrl.v12 >= 15 && ctrl.minV > -0.01 && ctrl.dist > 150, fmt(ctrl));
      assert('W. + automatic sanding: succeeds, sand applied on slip, at least as fast',
        auto.v12 >= 15 && auto.minV > -0.01 && auto.sandSeen && auto.dist >= ctrl.dist - 1, fmt(auto));
      assert('W. + manual sand (Shift): succeeds, less slip than without sand',
        manual.v12 >= 15 && manual.minV > -0.01 && manual.slip <= ctrl.slip, fmt(manual));
      // auto sand switches itself off AUTO_SAND_HOLD_S after the slip ends
      const p = new M.TrainPhysics({ massKg: M.MASS_FLEXITY_KG, weather: 'rain', electric: true, axleFrac: M.AXLE_FRAC_FLEXITY });
      p.reverser = 1; p.powerNotch = 8; p.resetVigilance();
      for (let t = 0; t < 2; t += 0.05) p.step(0.05, 0.049, 0);
      const armed = p.sandActive();
      p.powerNotch = 0;
      for (let t = 0; t < M.AUTO_SAND_HOLD_S + 0.2; t += 0.05) p.step(0.05, 0, 0);
      assert('W. automatic sanding arms on slip and stops AUTO_SAND_HOLD_S after it', armed && !p.sandActive());
      // wheel-slide protection: wet emergency-ish stop from 40 km/h on the 4.9 % fall
      const stop = (slipControl) => {
        const q = new M.TrainPhysics({ massKg: M.MASS_FLEXITY_KG, weather: 'rain', electric: true, axleFrac: M.AXLE_FRAC_FLEXITY });
        q.reverser = 1; q.speed = 40 / 3.6; q.brakeNotch = 8; q.slipControl = slipControl; q.autoSand = slipControl; q.resetVigilance();
        let d = 0; for (let t = 0; t < 60 && q.speed > 0; t += 0.05) { q.step(0.05, -0.049, 0); d += q.speed * 0.05; }
        return d;
      };
      const dW = stop(true), dL = stop(false);
      assert('W. wheel-slide protection: wet B8 stop on −4.9 % no longer than without it', dW <= dL + 0.5, `${dW.toFixed(1)} m vs ${dL.toFixed(1)} m`);
    }

    // ---- P. stop marks vs OSM platforms ----------------------------------------------------
    {
      const bad = [], rows = [];
      let n = 0;
      for (const [rk, t, o] of [['ion_southbound', sb, nb], ['ion_northbound', nb, sb]]) {
        const st = layoutStations(M, W, rk, t, [o]);
        for (const s of st) {
          const pl = W.platforms.find((q) => q.osm === s.platform_osm);
          if (!pl) { bad.push(`${rk}/${s.id}: no OSM platform`); continue; }
          n++;
          const ring = M.localRing(pl);
          const ss = ring.map((v) => M.lateralOf(t, v.x, v.z).s);
          const mid = (Math.min(...ss) + Math.max(...ss)) / 2;
          const cx = ring.reduce((a, v) => a + v.x, 0) / ring.length, cz = ring.reduce((a, v) => a + v.z, 0) / ring.length;
          const sc = t.nearestSLocal(cx, cz);
          const err = Math.max(Math.abs(s.distance_m - mid), Math.abs(s.distance_m - sc));
          if (rk === 'ion_northbound' && s.id === 'fairway') rows.push(`NB Fairway stop ${s.distance_m} vs OSM ${mid.toFixed(0)} (centroid ${sc.toFixed(0)})`);
          if (err > 10) bad.push(`${rk}/${s.id} ${err.toFixed(1)} m`);
          if (s.lay.source !== 'osm') bad.push(`${rk}/${s.id} not on its OSM platform`);
        }
      }
      assert('P. every ION stop mark within 10 m of its OSM platform centre (NB Fairway was 43 m off)', bad.length === 0 && n >= 30,
        bad.length ? bad.join('; ') : `${n} stops; ${rows.join('')}`);
      const nbF = layoutStations(M, W, 'ion_northbound', nb, [sb]).find((s) => s.id === 'fairway');
      const lo = M.LRV_LENGTH_M - M.TRUCK_FROM_NOSE_M[1] + 0.5;
      assert('P. NB Fairway: line now reaches the stub end; the stop is reachable by the whole car', nbF.distance_m >= lo && nb.length > 16200,
        `stop ${nbF.distance_m} m, consist needs ≥ ${lo.toFixed(1)} m, NB length ${nb.length.toFixed(0)} m`);
    }

    // ---- N. station name signs -------------------------------------------------------------
    {
      let worst = 1;
      for (let k = 0; k < 72; k++) {
        const a = (k / 72) * Math.PI * 2, ox = Math.sin(a), oz = Math.cos(a);
        const y = M.nameSignYaws(ox, oz);
        const t = M.faceNormal(y.trackFace), p = M.faceNormal(y.platformFace);
        worst = Math.min(worst, -(t.x * ox + t.z * oz), p.x * ox + p.z * oz);
      }
      const src = await readFile(path.join(root, 'src/game/Stations.ts'), 'utf8');
      const signBlock = src.slice(src.indexOf('nameSignYaws(ox, oz)'), src.indexOf("face.name = 'stationNameSign'"));
      assert('N. name signs: a single-sided readable face toward the track and one toward the platform (no mirrored DoubleSide)',
        worst > 0.999 && /FrontSide/.test(signBlock) && !/DoubleSide/.test(signBlock), `min facing cos ${worst.toFixed(4)}`);
    }

    // ---- C. side camera ---------------------------------------------------------------------
    {
      let ok = true;
      for (let k = 0; k < 36; k++) {
        const h = (k / 36) * Math.PI * 2, fx = Math.sin(h), fz = Math.cos(h);
        const L = M.leftOf(h), l = M.sideUnit(fx, fz, -1), r = M.sideUnit(fx, fz, 1);
        if (Math.abs(l.x - L.x) > 1e-9 || Math.abs(l.z - L.z) > 1e-9 || Math.abs(r.x + L.x) > 1e-9) ok = false;
      }
      const cyc = ['auto', 'left', 'right'].map((m) => M.nextSideCamMode(m)).join(',');
      ok = ok && M.sideCamSide('auto', -1) === -1 && M.sideCamSide('auto', 1) === 1 && M.sideCamSide('auto', null) === 1
        && M.sideCamSide('left', 1) === -1 && M.sideCamSide('right', -1) === 1 && cyc === 'left,right,auto';
      const lefts = [['ion_southbound', sb, nb], ['ion_northbound', nb, sb]].flatMap(([rk, t, o]) =>
        layoutStations(M, W, rk, t, [o]).filter((s) => s.platformSide === -1).map((s) => `${rk.slice(4, 6).toUpperCase()} ${s.id}`));
      assert('C. side camera follows the platform side (auto) incl. left-side platforms; V cycles auto/left/right',
        ok && lefts.length > 0, `left-side stops: ${lefts.join(', ')}`);
    }

    // ---- S. signal association --------------------------------------------------------------
    {
      const unit = !M.signalAppliesToLine(39.6, 32.6, 7) && M.signalAppliesToLine(10, 2, 40)
        && M.signalAppliesToLine(22, 17, 7) && !M.signalAppliesToLine(20, 8, 40) && M.signalAppliesToLine(20, 100, 100);
      const rows = [];
      let ok = unit;
      for (const [name, t, o] of [['SB', sb, nb], ['NB', nb, sb]]) {
        const all = W.sigFile.signals;
        const old = M.signalsForLine(all.map((x) => ({ ...x })), t, 40);
        const neu = M.signalsForLine(all.map((x) => ({ ...x })), t, M.SIGNAL_MAX_LATERAL_M, undefined, [o]);
        const d = (h) => { const p = t.sampleRaw(h.s_ion); return Math.hypot(p.x - h.x, p.z - h.z); };
        const maxD = Math.max(...neu.map(d));
        const ids = new Set(neu.map((h) => h.id));
        const groups = new Map();
        for (const h of old) { if (!groups.has(h.group)) groups.set(h.group, []); groups.get(h.group).push(h); }
        let real = 0, lost = 0;
        for (const hs of groups.values()) if (Math.min(...hs.map(d)) <= M.SIGNAL_NEAR_M) { real++; if (!hs.some((h) => ids.has(h.id))) lost++; }
        const otherStreet = neu.filter((h) => {
          const q = o.sampleRaw(o.nearestSLocal(h.x, h.z)), p = t.sampleRaw(h.s_ion), r = o.sampleRaw(o.nearestSLocal(p.x, p.z));
          return d(h) > M.SIGNAL_NEAR_M && Math.hypot(r.x - p.x, r.z - p.z) > M.SIGNAL_SHARED_CORRIDOR_M && Math.hypot(q.x - h.x, q.z - h.z) < d(h) - M.SIGNAL_OTHER_LINE_MARGIN_M;
        }).length;
        rows.push(`${name}: heads ${old.length}→${neu.length}, max ${maxD.toFixed(1)} m, real intersections ${real} lost ${lost}, other-street heads ${otherStreet}`);
        ok = ok && maxD <= M.SIGNAL_MAX_LATERAL_M && lost === 0 && otherStreet === 0 && neu.length < old.length;
      }
      assert('S. signal heads: ≤ 30 m, none from the parallel couplet street, no real intersection lost', ok, rows.join('; '));
    }

    // ---- F. snow -------------------------------------------------------------------------------
    {
      let ok = true;
      for (let k = 0; k < 500; k++) {
        const [x, z] = M.outsideRadius((Math.random() - 0.5) * 6, (Math.random() - 0.5) * 6, M.SNOW_CLEAR_RADIUS_M);
        if (Math.hypot(x, z) < M.SNOW_CLEAR_RADIUS_M - 1e-9) ok = false;
      }
      const [fx, fz] = M.outsideRadius(10, 0, M.SNOW_CLEAR_RADIUS_M);
      assert('F. snow: flakes kept out of the 2.5 m clear zone around the camera (overdraw)', ok && fx === 10 && fz === 0);
    }
  } finally {
    unstub();
    await cleanup();
  }
}
