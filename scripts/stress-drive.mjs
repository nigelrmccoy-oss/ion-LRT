/**
 * v1.4.2 stress sections (called from stress-test.mjs):
 *   x. end-to-end drive simulations — 4 routes × 2 directions × dry/rain/snow (drive-sim.mjs)
 *   y. regressions for the bugs the drive sims exposed (signals, limits, vigilance, diesel)
 *   z. heavy-rail checks: stations/platforms, limits, diesel physics in rain/snow on real grades
 */
import { runDriveSims, resultsTable, layoutStations, consistOf, sLimitsFor } from './drive-sim.mjs';

export async function driveTests(assert, log = console.log) {
  const t0 = Date.now();
  const { results, M, W } = await runDriveSims();
  const wall = (Date.now() - t0) / 1000;

  // ---- x. drive sims -------------------------------------------------------------------
  for (const r of results) {
    assert(`x. drive ${r.label}: terminus, no NaN/stall/overspeed, all stops on platform, hold brake, no red violations, rail≈DEM`,
      r.problems.length === 0,
      r.problems.length ? r.problems.join('; ')
        : `${(r.runtimeS / 60).toFixed(1)} min, avg ${r.avgKmh.toFixed(1)} km/h, ${r.stops}/${r.stopsExpected} stops (max err ${r.maxStopErrM.toFixed(2)} m), slips ${r.slipEvents}, min μ ${r.minMu.toFixed(3)}, max ${r.maxExcessKmh.toFixed(1)} km/h vs limit`);
  }
  assert('x. 24 drive runs (4 routes × 2 dirs × 3 weathers)', results.length === 24, `${results.length} runs in ${wall.toFixed(1)} s wall`);
  const snowVsDry = ['ion_southbound', 'ion_northbound', 'elmira', 'guelph'].every((k) => {
    const d = results.find((r) => r.routeKey === k && r.dir === 'forward' && r.weather === 'dry');
    const s = results.find((r) => r.routeKey === k && r.dir === 'forward' && r.weather === 'snow');
    return s.runtimeS >= d.runtimeS && s.slipEvents > d.slipEvents && s.minMu < d.minMu;
  });
  assert('x. snow is slower and slips more than dry on every route (sanding keeps it moving)', snowVsDry);
  log('\n' + resultsTable(results) + '\n');

  // ---- y. regressions ------------------------------------------------------------------
  const sigAll = (W.sigFile.signals || []).map((x) => ({ ...x }));
  // y1 intersection grouping
  {
    const sys = new M.SignalSystem();
    sys.setSignals(sigAll.map((x) => ({ ...x })));
    const L = sys.signals;
    let mixed = 0, span = 0;
    for (let i = 0; i < L.length; i++) {
      for (let j = i + 1; j < L.length && L[j].s_ion - L[i].s_ion <= 30; j++) if (L[i].phase_offset_s !== L[j].phase_offset_s) mixed++;
      span = Math.max(span, L[i].group_s1 - L[i].group_s0);
    }
    assert('y. signal heads ≤ 30 m apart share one phase (one intersection)', mixed === 0, `${new Set(L.map((x) => x.group)).size} intersections from ${L.length} heads, max span ${span.toFixed(0)} m, mixed pairs ${mixed}`);
  }
  // y2–y4 enforcement semantics on a synthetic street
  {
    const mk = (id, s, ph = 0) => ({ id, x: 0, z: s, s_ion: s, dist_m: 0, kind: 'traffic_signals', phase_offset_s: ph });
    const sys = new M.SignalSystem();
    sys.setSignals([mk(1, 100, 0), mk(2, 110, 7), mk(3, 200, 0)]);
    assert('y. passed stop line never masks the next intersection', sys.nearestAhead(101, 1, 150)?.id === 3, `got ${sys.nearestAhead(101, 1, 150)?.id}`);
    // light turns red while the train is already past the stop line: no booking
    const run = (startT, v) => {
      const q = new M.SignalSystem();
      q.setSignals([mk(1, 100, 0)]);
      let s = 60, t = startT;
      while (s < 140) { q.updateEnforcement({ tSec: t, trainS: s, speedKmh: v * 3.6, direction: 1, inStreetRow: true, dt: 0.05 }); s += v * 0.05; t += 0.05; }
      return q.redViolations;
    };
    // green 0–14 s, amber 14–18, red 18–30. Crossing at t≈13.5 (green), light red at 18 while 30 m past
    assert('y. red after the train cleared the stop line is not a violation', run(13.5 - 40 / 8, 8) === 0);
    assert('y. crossing the stop line on red is a violation', run(20 - 40 / 8, 8) === 1);
    // TSP latch: train waits slow in the approach (bias granted), then accelerates > 25 km/h
    const q = new M.SignalSystem();
    q.setSignals([mk(1, 100, 0)]);
    let s = 55, t = 9, cut = false; // waits inside the 50 m enforcement window, then leaves at 32 km/h
    for (; t < 30 && s < 100; t += 0.05) {
      const v = t < 13 ? 1 : 9; // 3.6 km/h, then 32 km/h
      const enf = q.updateEnforcement({ tSec: t, trainS: s, speedKmh: v * 3.6, direction: 1, inStreetRow: true, dt: 0.05 });
      if (t > 13 && enf.aspect && enf.aspect !== 'green') cut = true;
      s += v * 0.05;
    }
    assert('y. TSP green extension stays latched until the train clears the stop line', !cut && q.redViolations === 0, `cut=${cut}`);
    // TSP can't be granted after green has ended (no amber → green flip in front of the train)
    {
      const r = new M.SignalSystem();
      r.setSignals([mk(1, 100, 0)]);
      let seen = [], tt = 13;
      for (; tt < 24; tt += 0.05) {
        const enf = r.updateEnforcement({ tSec: tt, trainS: 80, speedKmh: 3, direction: 1, inStreetRow: true, dt: 0.05 });
        if (enf.aspect && seen[seen.length - 1] !== enf.aspect) seen.push(enf.aspect);
      }
      assert('y. TSP never turns an amber back to green', !seen.join(',').includes('amber,green'), seen.join(' → '));
    }
    const y40 = M.lrvAmberS(40, 0), y40d = M.lrvAmberS(40, 0.045);
    const stopFlat = (40 / 3.6) ** 2 / (2 * 1.0), stopDown = (40 / 3.6) ** 2 / (2 * (1.0 - 9.81 * 0.045));
    assert('y. amber lets an LRV at 40 km/h either stop or clear (flat and −4.5 %)',
      y40 * 40 / 3.6 >= stopFlat - 1e-6 && Math.min(9, y40d) * 40 / 3.6 >= Math.min(stopDown, 9 * 40 / 3.6) - 1e-6 && y40 >= 4,
      `flat ${y40.toFixed(1)} s, −4.5 % ${y40d.toFixed(1)} s`);
  }
  // y5 signals keyed on the driven line (no ref-chainage stall)
  {
    let worst = 0, n = 0, stall = 0;
    for (const key of ['ion-sb.geojson|false', 'ion-nb.geojson|false', 'ion-sb.geojson|true', 'ion-nb.geojson|true']) {
      const tr = W.tracks[key];
      const ls = M.signalsForLine(sigAll.map((x) => ({ ...x })), tr, 40);
      for (const sg of ls) { const p = tr.sampleRaw(sg.s_ion); worst = Math.max(worst, Math.hypot(p.x - sg.x, p.z - sg.z)); n++; }
      // reference chainage stall that broke v1.4.1 enforcement (documented, not asserted 0)
      for (let q = 0; q + 40 < tr.length; q += 10) if (Math.abs(tr.refS(q + 40) - tr.refS(q)) < 10) stall++;
    }
    assert('y. enforcement signals sit on the driven line (≤ 40 m lateral)', worst <= 40 && n > 0, `${n} heads on 4 lines; ref-chainage stalls (<10 m per 40 m) avoided: ${stall}`);
  }
  // y6 no 1 m speed-limit islands
  {
    const bad = [];
    for (const [key, tr] of Object.entries(W.tracks)) {
      let i0 = 0, prev = tr.speedLimitKmh(0, false), minRun = Infinity;
      for (let s = 1; s <= tr.length; s += 1) {
        const l = tr.speedLimitKmh(s, false);
        if (l !== prev) { if (i0 > 0) minRun = Math.min(minRun, s - i0); i0 = s; prev = l; }
      }
      if (minRun < 20) bad.push(`${key} ${minRun} m`);
    }
    assert('y. no posted limit shorter than 20 m on any line (no 1 m 40 km/h islands)', bad.length === 0, bad.join(', ') || '8 lines');
  }
  // y7 vigilance is speed-dependent
  {
    const p = new M.TrainPhysics({ massKg: M.MASS_WCR_KG, weather: 'dry', electric: false, axleFrac: M.AXLE_FRAC_WCR });
    p.reverser = 1; p.doorsOpen = true; p.holdBrake = true;
    for (let i = 0; i < 120 / 0.05; i++) p.step(0.05, 0, 0);
    const okStand = p.deadmanOk && p.brakeNotch === 0;
    const m = new M.TrainPhysics({ massKg: M.MASS_WCR_KG, weather: 'dry', electric: false, axleFrac: M.AXLE_FRAC_WCR });
    m.reverser = 1; m.speed = 15;
    let tPen = null;
    for (let i = 0; i < 60 / 0.05; i++) { m.step(0.05, -0.01, 0); if (!m.deadmanOk && tPen === null) tPen = i * 0.05; }
    assert('y. vigilance does not trip during a 120 s standstill dwell', okStand, `deadman=${p.deadmanOk}`);
    assert('y. vigilance still trips after ~45 s moving without input', tPen !== null && Math.abs(tPen - 45) < 1, `penalty at ${tPen?.toFixed(1)} s`);
  }
  // y8 diesel consist stays between the bumpers
  {
    let ok = true;
    for (const key of ['waterloo-spur.geojson|false', 'guelph-sub.geojson|false', 'waterloo-spur.geojson|true', 'guelph-sub.geojson|true']) {
      const tr = W.tracks[key];
      const c = consistOf(M, 'diesel-wcr');
      const [lo, hi] = sLimitsFor(M, tr, 'diesel-wcr');
      if (lo - c.rear < -1e-6 || hi + c.front > tr.length + 1e-6) ok = false;
    }
    assert('y. diesel consist (loco + coach) never hangs past the end of the line', ok, `front ${M.DIESEL_CONSIST_FRONT_M} m, rear ${M.DIESEL_CONSIST_REAR_M.toFixed(1)} m`);
  }

  // ---- z. heavy rail: stations, limits, diesel physics ------------------------------------
  for (const key of ['elmira', 'guelph']) {
    const route = W.stations.routes[key];
    const tr = W.tracks[`${route.track}|false`];
    const st = layoutStations(M, W, key, tr, []);
    const osmBacked = route.stations.filter((x) => x.platform_osm || x.osm_station);
    const snapBad = osmBacked.filter((x) => !(x.snap_err_m <= 60));
    assert(`z. ${key}: OSM-backed stops lie on the line (≤ 60 m)`, snapBad.length === 0 && osmBacked.length >= 1,
      `${osmBacked.map((x) => `${x.id} ${x.snap_err_m} m`).join(', ')}${snapBad.length ? ' BAD ' + snapBad.map((x) => x.id) : ''}`);
    const platMiss = st.filter((x) => x.platform_osm && x.platformSource !== 'osm');
    assert(`z. ${key}: stops with an OSM platform use it`, platMiss.length === 0, platMiss.map((x) => x.id).join(',') || st.filter((x) => x.platformSource === 'osm').map((x) => x.id).join(', '));
    const flagged = route.stations.filter((x) => !x.platform_osm && !x.osm_station);
    assert(`z. ${key}: stops without OSM data are flagged with a note`, flagged.every((x) => typeof x.note === 'string'), flagged.map((x) => x.id).join(', ') || 'none');
    let bad = 0, lmin = 999, lmax = 0;
    for (let s = 0; s <= tr.length; s += 2) {
      const l = tr.speedLimitKmh(s, false);
      lmin = Math.min(lmin, l); lmax = Math.max(lmax, l);
      if (!(l >= 10 && l <= 70)) bad++;
    }
    const nearOk = st.every((x) => tr.speedLimitKmh(x.distance_m, true) <= 25);
    assert(`z. ${key}: limits within 10–70 km/h (≤ diesel vMax 95) and 25 km/h at stations`, bad === 0 && nearOk, `range ${lmin}–${lmax} km/h`);
  }
  {
    const elm = W.stations.routes.elmira.stations;
    const e = elm.find((x) => x.id === 'elmira'), trk = W.tracks['waterloo-spur.geojson|false'];
    assert('z. elmira: Elmira stop is at the OSM station, not the end of the line', trk.length - e.distance_m > 500 && elm.some((x) => x.id === 'farmersmarket'),
      `Elmira at ${e.distance_m} m of ${trk.length.toFixed(0)} m; stops ${elm.map((x) => x.id).join(', ')}`);
    const k = W.stations.routes.guelph.stations.find((x) => x.id === 'kitchener');
    assert('z. guelph: Kitchener stop on the Kitchener GO platform (was 353 m off)', k.snap_err_m <= 20 && k.platform_osm === 'way/137366391', `${k.snap_err_m} m`);
  }
  // diesel physics on the steepest real grades, rain & snow
  for (const [key, file, mass, ax] of [['elmira', 'waterloo-spur.geojson', M.MASS_WCR_KG, M.AXLE_FRAC_WCR], ['guelph', 'guelph-sub.geojson', M.MASS_CN_KG, M.AXLE_FRAC_CN]]) {
    for (const rev of [false, true]) {
      const tr = W.tracks[`${file}|${rev}`];
      let sUp = 0, gUp = -1, sDn = 0, gDn = 1;
      for (let s = 100; s < tr.length - 300; s += 10) {
        const g = (tr.sampleRaw(s + 100).y - tr.sampleRaw(s).y) / 100;
        if (g > gUp) { gUp = g; sUp = s; }
        if (g < gDn) { gDn = g; sDn = s; }
      }
      for (const weather of ['rain', 'snow']) {
        // start on the steepest climb: naive notch 8 slips; driver handling (notch down + sand) departs, no rollback
        const naive = new M.TrainPhysics({ massKg: mass, weather, electric: false, axleFrac: ax });
        naive.reverser = 1; naive.powerNotch = 8;
        let slipped = false;
        for (let i = 0; i < 100; i++) { naive.step(0.05, tr.sample(sUp).grade, 0); if (naive.wheelslip) slipped = true; }
        const p = new M.TrainPhysics({ massKg: mass, weather, electric: false, axleFrac: ax });
        p.reverser = 1;
        let s = sUp, minV = 0, tReach = null, nt = 0;
        for (let i = 0; i < 180 / 0.05; i++) {
          const t = i * 0.05;
          nt -= 0.05;
          if (nt <= 0) { if (p.wheelslip) { p.powerNotch = Math.max(1, p.powerNotch - 1); } else if (p.powerNotch < 8) p.powerNotch++; nt = 0.4; }
          p.sanding = p.wheelslip || p.sanding;
          const smp = tr.sample(s);
          p.step(0.05, smp.grade, smp.curvature);
          s += p.speed * 0.05;
          minV = Math.min(minV, p.speed);
          if (tReach === null && p.speedKmh() >= 15) tReach = t;
        }
        assert(`z. ${key} ${rev ? 'rev' : 'fwd'} ${weather}: diesel starts on the steepest climb (${(gUp * 100).toFixed(2)} %) — sanding, no rollback, 15 km/h`,
          tReach !== null && tReach < 90 && minV > -0.01, `naive notch 8 slips=${slipped}, 15 km/h after ${tReach?.toFixed(1)} s, min v ${minV.toFixed(3)}`);
        // stop from 40 km/h on the steepest fall with an adhesion-safe notch
        const b = new M.TrainPhysics({ massKg: mass, weather, electric: false, axleFrac: ax });
        b.reverser = 1; b.speed = 40 / 3.6;
        let sb = sDn, slide = false, tt = 0;
        while (b.speed > 0 && tt < 300) {
          b.sanding = true;
          b.brakeNotch = Math.max(1, Math.min(8, Math.floor((8 * 0.92 * b.adhesionAt(b.speed) * 9.81) / 1.15)));
          const smp = tr.sample(sb);
          b.step(0.05, smp.grade, smp.curvature);
          if (b.wheelslip) slide = true;
          sb += b.speed * 0.05; tt += 0.05;
        }
        assert(`z. ${key} ${rev ? 'rev' : 'fwd'} ${weather}: stops from 40 km/h on the steepest fall (${(gDn * 100).toFixed(2)} %) without sliding`,
          b.speed === 0 && !slide && sb - sDn < 400, `${(sb - sDn).toFixed(0)} m in ${tt.toFixed(1)} s`);
      }
    }
  }
  return results;
}
