/**
 * Headless end-to-end drive simulations (no rendering, no WebGL, no game launch).
 *
 * Every route × both directions × dry/rain/snow is driven from the first to the last stop
 * by a simple automatic driver that uses the same game modules (TrainPhysics, Track,
 * RowClassifier, SignalSystem, PlatformLayout) and the same per-frame rules as
 * Game.loop(): civil limit = Track.speedLimitKmh(s, nearStation(s, 60)), street-running
 * traffic-signal enforcement on the ION reference chainage, hold brake, door interlock.
 *
 * The driver: notches up one step per 0.4 s (like key presses), brakes on a planned
 * braking curve for every limit / station stop / red signal ahead, drops a notch and sands
 * on wheelslip, keeps brake demand inside the available adhesion, stops at each platform,
 * opens the doors on the platform side with the brake released (hold brake must hold the
 * car), dwells, closes and departs.
 *
 * Usage:  node scripts/drive-sim.mjs [--write]  → prints the results table (--write: docs/DRIVE-SIM-RESULTS.md)
 *         import { runDriveSims } from './drive-sim.mjs'  (used by stress-test.mjs via stress-drive.mjs)
 * Debug:  TRACE_SIG=<signal id> or TRACE_S0=<m> TRACE_S1=<m> add per-step events to each result.
 */
import * as esbuild from 'esbuild';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const G = 9.81;

export async function bundleGame() {
  const dir = await mkdtemp(path.join(tmpdir(), 'ion-lrt-drive-'));
  const entry = path.join(dir, 'entry.ts');
  const src = (f) => JSON.stringify(path.join(root, 'src/game', f));
  await writeFile(entry, [
    `export * from ${src('Physics.ts')};`,
    `export { Track } from ${src('Track.ts')};`,
    `export { Elevation } from ${src('elevation.ts')};`,
    `export { RowClassifier } from ${src('Row.ts')};`,
    `export * from ${src('Signals.ts')};`,
    `export * from ${src('PlatformLayout.ts')};`,
    `export * from ${src('Clearances.ts')};`,
    `export { DIESEL_DIMS, DIESEL_CONSIST_FRONT_M, DIESEL_CONSIST_REAR_M } from ${src('Vehicles.ts')};`,
  ].join('\n'));
  const outfile = path.join(dir, 'game.mjs');
  await esbuild.build({ entryPoints: [entry], outfile, format: 'esm', platform: 'neutral', bundle: true, logLevel: 'silent',
    mainFields: ['module', 'main'] });
  const mod = await import(pathToFileURL(outfile).href);
  return { M: mod, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

const readJson = async (f) => JSON.parse(await readFile(path.join(root, 'public/data', f), 'utf8'));

/** Load data + build every track exactly like Game.start(). */
export async function loadWorld(M) {
  const meta = await readJson('elevation.json');
  const dem = new M.Elevation();
  dem.meta = meta;
  const bin = await readFile(path.join(root, 'public/data/elevation.bin'));
  dem.grid = new Float32Array(bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength));
  const spots = Object.values(meta.spot_checks_m).map((q) => q.elev_m).filter((v) => v != null);
  dem.baseElev = spots.reduce((a, b) => a + b, 0) / Math.max(1, spots.length);
  const demAt = (lon, lat) => dem.elevLonLat(lon, lat);
  const coords = async (f) => (await readJson(f)).features[0].geometry.coordinates;
  const mk = async (f, prof, name, rev) => M.Track.fromLonLatProfile(await coords(f), prof, name, dem.baseElev, rev, demAt);

  const row = new M.RowClassifier();
  row.samples = ((await readJson('row-segments.json')).samples || []).slice().sort((a, b) => a.s - b.s);
  row.loaded = row.samples.length > 0;
  const sigFile = await readJson('signals.json');
  const stations = await readJson('stations.json');
  const platforms = (await readJson('platforms.json')).platforms;

  const ion = await mk('ion-track.geojson', meta.track_profiles.ion, 'ION reference', false);
  const tracks = {};
  for (const rev of [false, true]) {
    const sb = await mk('ion-sb.geojson', undefined, 'ION LRT southbound', rev);
    const nb = await mk('ion-nb.geojson', undefined, 'ION LRT northbound', rev);
    // Game: ionNb.blendHeightsToward(ionSb). Blend is position-based, so the reversed NB
    // is blended toward the (same-direction) reversed SB.
    nb.blendHeightsToward(sb);
    for (const t of [sb, nb]) {
      t.buildRefMap(ion);
      t.rowLookup = (s, near) => row.at(t.refS(s), near, 0);
    }
    tracks[`ion-sb.geojson|${rev}`] = sb;
    tracks[`ion-nb.geojson|${rev}`] = nb;
    tracks[`waterloo-spur.geojson|${rev}`] = await mk('waterloo-spur.geojson', meta.track_profiles.spur, 'Waterloo Spur', rev);
    tracks[`guelph-sub.geojson|${rev}`] = await mk('guelph-sub.geojson', meta.track_profiles.guelph, 'Guelph Sub', rev);
  }
  return { meta, dem, row, sigFile, stations, platforms, ion, tracks };
}

/** Stations for a run, laid out like StationSystem.build() (pure part). */
export function layoutStations(M, W, routeKey, track, otherTracks) {
  const route = W.stations.routes[routeKey];
  const heavy = !route.track.includes('ion');
  const edge = heavy ? M.GO_PLATFORM_EDGE_OFFSET_M : M.PLATFORM_EDGE_OFFSET_M;
  const len = heavy ? 90 : M.PLATFORM_LENGTH_M;
  const out = route.stations.map((st0) => {
    const st = { ...st0 };
    const s0 = track.nearestS(st.lon, st.lat); // Game.start: distance_m = nearestS(lon, lat)
    const p = track.sampleRaw(s0);
    st.distance_m = Math.round(s0);
    const lay = M.layoutPlatform(track, Math.min(track.length, st.distance_m), {
      platforms: W.platforms, platformId: st.platform_osm, edgeOffset: edge, width: M.PLATFORM_WIDTH_M, length: len,
      otherTracks, defaultSide: 1,
    });
    st.lay = lay;
    st.platformSide = lay.side;
    st.platformSource = lay.source;
    st.distance_m = Math.round(lay.sCentre);
    st.railY = p.y;
    return st;
  });
  out.sort((a, b) => a.distance_m - b.distance_m);
  return out;
}

const ck = (v) => (7.5 / (Math.abs(v) * 3.6 + 44) + 0.161) / (7.5 / 44 + 0.161);

/**
 * Drive one run. Returns a summary + per-run problems list (empty = all good).
 */
export function driveRun(M, W, cfg) {
  const { track, stations, electric, weather, routeKey, label } = cfg;
  const dt = 0.05;
  const P = new M.TrainPhysics({ massKg: cfg.massKg, weather, electric, axleFrac: cfg.axleFrac });
  P.reverser = 1; P.doorsOpen = false; P.pantographUp = electric; P.lineVoltage = 750; P.resetVigilance();
  // consist extent around s (front / rear of the chainage reference point)
  const front = cfg.front, rear = cfg.rear;
  const L = track.length;
  const sLo = cfg.sLimits[0], sHi = cfg.sLimits[1];
  const nearStation = (s, r) => stations.find((st) => Math.abs(st.distance_m - s) < r) || null;
  // civil limit table every metre (exactly Game.loop: speedLimitKmh(s, !!nearStation(s, 60)))
  const N = Math.ceil(L) + 1;
  const lim = new Float32Array(N), grd = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const s = Math.min(L, i);
    lim[i] = track.speedLimitKmh(s, !!nearStation(s, 60));
    grd[i] = track.sample(s).grade;
  }
  const limAt = (s) => lim[Math.max(0, Math.min(N - 1, Math.round(s)))];
  const isIon = cfg.isIon;
  const sig = cfg.signals;

  let s = Math.max(sLo, Math.min(sHi, stations[0].distance_m));
  let t = 0, moving = 0, dwellT = 0, stoppedT = 0, nextIdx = 1;
  let dwellUntil = -1, phase = 'run';
  let notchTimer = 0, sandUntil = -1, slipEv = 0, slipT = 0, wasSlip = false;
  let maxExcess = -99, overT = 0, maxGrade = 0, minMu = 9, nanSeen = false, vigPen = 0, vigAck = 0;
  let maxStall = 0, stallRun = 0, heldRedT = 0, holdBrakeRoll = 0;
  const stops = [];
  const problems = [];
  const events = [];
  const ev = (k, o) => { if (events.length < (process.env.TRACE_SIG || process.env.TRACE_S0 ? 200000 : 400)) events.push({ k, t: +t.toFixed(2), s: +s.toFixed(1), v: +P.speedKmh().toFixed(1), ...o }); };
  let lastViol = 0;
  let amberDecision = { k: null, stop: false };
  const minLimitTime = (() => { let x = 0; for (let i = Math.ceil(s); i < Math.floor(sHi); i++) x += 1 / (lim[i] / 3.6); return x; })();
  const maxBrakeNotch = (v) => Math.max(1, Math.min(8, Math.floor((8 * 0.92 * P.adhesionAt(v) * G) / 1.15)));
  // first stop already served (start there)
  stops.push({ id: stations[0].id, start: true });
  const T_MAX = 6 * 3600;

  while (t < T_MAX) {
    const v = P.speed;
    const near = nearStation(s, 60);
    const limit = track.speedLimitKmh(s, !!near);
    const sample = track.sample(s);
    // ---- signal enforcement (Game.loop, ION only) ----
    let enfHold = false, sigStop = Infinity, sigCap = null;
    if (isIon) {
      // Game.loop: signals enforced along the driven line (signals.setLine(track)), ROW by reference chainage
      const enforceS = s;
      const enforceDir = 1; // reverser forward → direction of increasing s
      const rowInfo = track.rowClassAt(s, !!near);
      const inStreet = rowInfo === 'street' || (rowInfo === 'station' && W.row.isStreetBand(track.refS(s)));
      const enf = sig.updateEnforcement({ tSec: t, trainS: enforceS, speedKmh: P.speedKmh(), direction: enforceDir, inStreetRow: inStreet, dt });
      if (enf.hold && inStreet) { P.powerNotch = 0; P.brakeNotch = Math.max(P.brakeNotch, 6); enfHold = true; }
      if (process.env.TRACE_SIG && enf.signal && String(enf.signal.id) === process.env.TRACE_SIG) ev('asp', { a: enf.aspect, along: +(enforceDir > 0 ? enf.signal.s_ion - enforceS : enforceS - enf.signal.s_ion).toFixed(1), u: +(((t + enf.signal.phase_offset_s) % 30)).toFixed(2) });
      if (sig.redViolations > lastViol) { lastViol = sig.redViolations; ev('viol', { last: sig.lastViolation, sig: enf.signal?.id, sigS: enf.signal?.s_ion, refS: +enforceS.toFixed(1), asp: enf.aspect, row: rowInfo, lim: limit }); }
      // driver looks ahead at street-running signals (like reading the aspect through the windscreen)
      const ahead = sig.nearestAhead(enforceS, enforceDir, 160);
      if (ahead && (W.row.isStreetBand(track.refS(ahead.s_ion)) || inStreet)) {
        const asp = sig.aspectFor(ahead, t, enforceS, P.speedKmh(), enforceDir, 0);
        if (process.env.TRACE_SIG && String(ahead.id) === process.env.TRACE_SIG) ev('drv', { asp, d: +(enforceDir > 0 ? ahead.s_ion - enforceS : enforceS - ahead.s_ion).toFixed(1), u: +((t + ahead.phase_offset_s) % 30).toFixed(2) });
        // distance to the stop line; normal stop 25 m before it (outside the 22 m hold radius),
        // otherwise as close to the line as the brakes allow. Amber: stop if the stop line can
        // still be made with full service braking, else clear the intersection.
        const dLine = enforceDir > 0 ? ahead.s_ion - enforceS : enforceS - ahead.s_ion;
        const vv = Math.abs(v);
        const bMax = Math.max(0.1, Math.min(1.15, 0.92 * P.adhesionAt(vv) * G) - G * Math.max(0, -sample.grade));
        const canMake = (vv * vv) / (2 * bMax) <= dLine - 2;
        const soft = (vv * vv) / (2 * 0.6) <= dLine - 25;
        // decision at amber onset is kept until the aspect changes (no flip-flop when μ changes)
        const k = `${ahead.id}`;
        if (asp === 'amber' && amberDecision.k !== k) amberDecision = { k, stop: canMake };
        if (asp !== 'amber') amberDecision = { k: null, stop: false };
        if (asp === 'red' || (asp === 'amber' && amberDecision.stop)) sigStop = Math.max(0, soft ? dLine - 25 : dLine - 2);
        // weather-adapted approach: never faster than a speed that can still stop within the
        // amber interval (v ≤ 2·b·(Y − reaction)); only bites on slippery rail / steep falls
        const Y = ahead.amber_s ?? 4;
        sigCap = { v: Math.max(3, 2 * 0.85 * bMax * (Y - 1)), d: Math.max(0, dLine - 60) };
      }
    }
    // ---- driver ----
    const vNow = Math.abs(v);
    const muB = Math.min(1.15, 0.92 * P.adhesionAt(vNow) * G);
    let down = 0;
    const horizon = Math.min(1500, (vNow * vNow) / 0.3 + 80);
    for (let d = 0; d <= Math.min(horizon, 400); d += 10) down = Math.max(down, -grd[Math.min(N - 1, Math.round(s + d))]);
    const bPlan = Math.max(0.12, Math.min(0.85, 0.8 * muB) - G * down);
    let aReq = 0, vAllow = Infinity;
    const cons = (Lms, d) => {
      vAllow = Math.min(vAllow, Math.sqrt(Lms * Lms + 2 * bPlan * Math.max(0, d)));
      if (vNow > Lms && d > 0.3) aReq = Math.max(aReq, (vNow * vNow - Lms * Lms) / (2 * d));
      else if (vNow > Lms + 0.2) aReq = Math.max(aReq, 9);
    };
    for (let d = 0; d <= horizon; d += 2) {
      const Lk = (limAt(s + d) - 1.2) / 3.6;
      if (Lk < vNow + 3) cons(Lk, d);
    }
    let stopTarget = null;
    if (phase === 'run') {
      const st = stations[nextIdx];
      if (st) stopTarget = Math.min(st.distance_m, sHi - 1);
      else stopTarget = sHi - 4;
    }
    if (stopTarget != null) cons(0, stopTarget - s);
    if (Number.isFinite(sigStop)) cons(0, sigStop);
    if (sigCap) cons(sigCap.v, sigCap.d);
    const vTarget = vAllow - 0.25;

    if (phase === 'dwell') {
      P.powerNotch = 0; P.brakeNotch = 0; // hold brake alone must keep the car
      if (t >= dwellUntil) { P.doorsOpen = false; P.resetVigilance(); phase = 'run'; }
    } else if (phase === 'run') {
      const dStop = stopTarget - s;
      if (vNow < 0.05 && dStop < 3) {
        // arrived
        P.powerNotch = 0; P.brakeNotch = 3;
        const st = stations[nextIdx];
        if (st) {
          const c0 = s - rear, c1 = s + front;
          const inPlat = c0 >= st.lay.s0 - 0.01 && c1 <= st.lay.s1 + 0.01;
          if (!(c0 >= st.lay.s0 - 0.01 && c1 <= st.lay.s1 + 0.01)) ev('offplat', { id: st.id });
          stops.push({ id: st.id, err: s - st.distance_m, inPlat, side: st.platformSide, ext: [c0, c1], plat: [st.lay.s0, st.lay.s1] });
          // T key: doors open (only < 0.3 m/s), power off, hold brake on; driver releases the brake
          P.doorsOpen = true; P.powerNotch = 0; P.holdBrake = true; P.brakeNotch = 0; P.resetVigilance();
          dwellUntil = t + cfg.dwellS; phase = 'dwell'; nextIdx++;
        } else {
          phase = 'done';
        }
      } else {
        const finalStop = dStop < 0.5 || (Number.isFinite(sigStop) && sigStop < 0.5);
        const braking = finalStop || aReq > 0.55 * bPlan || vNow > vTarget + 0.4;
        if (braking) {
          const resist = (P.davisResistance(vNow) + P.curveResistance(sample.curvature)) / P.massKg;
          const need = Math.max(0.05, aReq - G * sample.grade - resist + 0.05);
          let n = Math.ceil((8 * need) / 1.15);
          if (finalStop) n = 8; // stopping brake at the mark (capped to the adhesion-safe notch below)
          P.powerNotch = 0;
          P.brakeNotch = Math.max(1, Math.min(maxBrakeNotch(vNow), n));
          if (P.brakeNotch >= 1) P.resetVigilance();
        } else if (vNow < vTarget - 0.6 && !enfHold) {
          P.brakeNotch = 0;
          notchTimer -= dt;
          if (notchTimer <= 0) {
            if (P.wheelslip) { P.powerNotch = Math.max(1, P.powerNotch - 1); sandUntil = t + 6; }
            else if (P.powerNotch < 8) P.powerNotch++;
            notchTimer = 0.4;
            P.resetVigilance();
          }
        } else {
          // cruise: hold speed with a low notch, coast if slightly fast
          P.brakeNotch = 0;
          if (vNow > vTarget) P.powerNotch = 0;
          else if (P.powerNotch === 0) { P.powerNotch = 2; P.resetVigilance(); }
        }
        // anti-slip: sand while slipping and for a few seconds after (rain/snow procedure)
        if (P.wheelslip) sandUntil = Math.max(sandUntil, t + 4);
        // rail-head sanding while braking on wet/snowy rail (standard LRV/loco practice)
        if (weather !== 'dry' && P.brakeNotch > 0) sandUntil = Math.max(sandUntil, t + 1);
        P.sanding = t < sandUntil;
        // vigilance: driver acknowledges before the penalty (any notch key resets it in the game)
        if (P.vigilanceTimer < 8) { P.resetVigilance(); vigAck++; }
      }
    } else break;

    if (process.env.TRACE_S0 && s > +process.env.TRACE_S0 && s < +process.env.TRACE_S1 && (Math.round(t / dt) % 10 === 0)) ev('tr', { pn: P.powerNotch, bn: P.brakeNotch, slip: P.wheelslip, sand: P.sanding, aReq: +aReq.toFixed(2), bPlan: +bPlan.toFixed(2), vAllow: +(vAllow * 3.6).toFixed(1), dStop: stopTarget != null ? +(stopTarget - s).toFixed(1) : null, mu: +P.adhesionAt(vNow).toFixed(3), g: +sample.grade.toFixed(3) });
    // ---- physics step (Game.loop order) ----
    const out = P.step(dt, sample.grade, sample.curvature);
    if (phase === 'dwell' && Math.abs(P.speed) > 0) holdBrakeRoll = Math.max(holdBrakeRoll, Math.abs(P.speed));
    s = Math.max(sLo, Math.min(sHi, s + P.speed * dt));
    if (s <= sLo && P.speed < 0) P.speed = 0;
    if (s >= sHi && P.speed > 0) P.speed = 0;
    if (!Number.isFinite(P.speed) || !Number.isFinite(s) || !Number.isFinite(out.te) || !Number.isFinite(out.a)) nanSeen = true;
    if (!P.deadmanOk) vigPen++;
    t += dt;
    if (phase === 'dwell') dwellT += dt;
    const kmh = P.speedKmh();
    const lim2 = track.speedLimitKmh(s, !!nearStation(s, 60));
    if (kmh - lim2 > 2 && kmh - lim2 > maxExcess) ev('over', { tab: Array.from({ length: 12 }, (_, k) => limAt(s - 6 + k)).join(','), sPrev: +(s - P.speed * dt).toFixed(2), limPrev: limit, vTarget: +(vTarget * 3.6).toFixed(1), aReq: +aReq.toFixed(2), lim: lim2, bn: P.brakeNotch, pn: P.powerNotch, slip: P.wheelslip, g: +sample.grade.toFixed(3) });
    maxExcess = Math.max(maxExcess, kmh - lim2);
    if (kmh > lim2 + 2) overT += dt;
    maxGrade = Math.max(maxGrade, Math.abs(sample.grade));
    if (P.powerNotch > 0 || P.brakeNotch > 0) minMu = Math.min(minMu, P.adhesionAt(P.speed));
    if (P.wheelslip && !wasSlip) slipEv++;
    if (P.wheelslip) slipT += dt;
    wasSlip = P.wheelslip;
    if (kmh > 0.5) { moving += dt; stallRun = 0; }
    else if (phase === 'run') {
      const heldBySignal = Number.isFinite(sigStop) || enfHold;
      if (heldBySignal) { heldRedT += dt; stallRun = 0; } else { stallRun += dt; if (stallRun > maxStall && Math.abs(stallRun - 10) < dt / 2) ev('stall10', { pn: P.powerNotch, bn: P.brakeNotch, hold: P.holdBrake, slip: P.wheelslip, g: +sample.grade.toFixed(3), sand: P.sanding, dStop: stopTarget - s }); maxStall = Math.max(maxStall, stallRun); }
    }
    if (phase === 'done') break;
    if (phase === 'run' && nextIdx >= stations.length && s > sHi - 8 && Math.abs(P.speed) < 0.5) { phase = 'done'; break; }
  }

  const finished = phase === 'done' && s > sHi - 8;
  const served = stops.filter((x) => !x.start);
  const badPlat = served.filter((x) => !x.inPlat);
  const maxStopErr = served.reduce((m, x) => Math.max(m, Math.abs(x.err)), 0);
  // rail height vs DEM along this run's track
  const d = [];
  for (let q = 0; q <= L; q += 10) {
    const p = track.sampleRaw(q);
    d.push(Math.abs(p.y - M.Track.BED_ABOVE_DEM_M - W.dem.heightAtLocal(p.x, p.z)));
  }
  d.sort((a, b) => a - b);
  const railMed = d[d.length >> 1], railP95 = d[Math.floor(d.length * 0.95)];
  const runtime = t;
  const avgKmh = (sHi - stations[0].distance_m) / Math.max(1, moving) * 3.6;
  const tolKmh = 2; // Game counts overspeed above limit + 2 km/h
  if (!finished) problems.push(`did not reach terminus (s=${s.toFixed(0)}/${sHi.toFixed(0)} m, phase=${phase}, t=${t.toFixed(0)} s)`);
  if (nanSeen) problems.push('NaN/∞ in speed, chainage, TE or acceleration');
  if (maxStall > 20) problems.push(`stalled ${maxStall.toFixed(1)} s outside dwell/signal`);
  if (maxExcess > tolKmh) problems.push(`overspeed ${maxExcess.toFixed(2)} km/h over limit (${overT.toFixed(1)} s > limit+2)`);
  if (badPlat.length) problems.push(`stopped off platform at ${badPlat.map((x) => `${x.id} (${x.ext.map((v) => v.toFixed(0)).join('–')} vs ${x.plat.map((v) => v.toFixed(0)).join('–')})`).join(', ')}`);
  if (served.length !== stations.length - 1) problems.push(`served ${served.length}/${stations.length - 1} stops`);
  if (holdBrakeRoll > 0) problems.push(`rolled ${(holdBrakeRoll * 3.6).toFixed(2)} km/h with doors open`);
  if (vigPen) problems.push('vigilance penalty');
  if (isIon && sig.redViolations) problems.push(`${sig.redViolations} red-signal violations`);
  if (runtime > 2.5 * minLimitTime + cfg.dwellS * stations.length + heldRedT + 300) problems.push(`runtime ${runtime.toFixed(0)} s unreasonable (min at limits ${minLimitTime.toFixed(0)} s)`);
  if (!(railMed < 1 && railP95 < 3)) problems.push(`rail vs DEM median ${railMed.toFixed(2)} p95 ${railP95.toFixed(2)} m`);
  return {
    label, routeKey, dir: cfg.dirLabel, weather, vehicle: cfg.vehicle, lengthM: Math.round(sHi - stations[0].distance_m),
    runtimeS: runtime, movingS: moving, dwellS: dwellT, heldRedS: heldRedT, minLimitTimeS: minLimitTime, avgKmh,
    maxGradePct: maxGrade * 100, slipEvents: slipEv, slipS: slipT, minMu, maxExcessKmh: maxExcess, overT,
    stops: served.length, stopsExpected: stations.length - 1, maxStopErrM: maxStopErr, maxStallS: maxStall,
    events, redViolations: isIon ? sig.redViolations : 0, vigAcks: vigAck, railMed, railP95, finished, problems,
  };
}

export const ROUTES = [
  { key: 'ion_southbound', file: 'ion-sb.geojson', other: 'ion-nb.geojson', vehicle: 'flexity' },
  { key: 'ion_northbound', file: 'ion-nb.geojson', other: 'ion-sb.geojson', vehicle: 'flexity' },
  { key: 'elmira', file: 'waterloo-spur.geojson', vehicle: 'diesel-wcr' },
  { key: 'guelph', file: 'guelph-sub.geojson', vehicle: 'diesel-cn' },
];

/** Consist geometry relative to the chainage reference point (Game: s). */
export function consistOf(M, vehicle) {
  if (vehicle === 'flexity') {
    const ahead = M.TRUCK_FROM_NOSE_M[1];
    return { front: ahead, rear: M.LRV_LENGTH_M - ahead };
  }
  return { front: M.DIESEL_CONSIST_FRONT_M, rear: M.DIESEL_CONSIST_REAR_M };
}

/** Same as Game.sLimits(). */
export function sLimitsFor(M, track, vehicle) {
  const c = consistOf(M, vehicle);
  return [Math.min(c.rear + 0.5, track.length / 2), Math.max(track.length / 2, track.length - c.front - 0.5)];
}

export async function runDriveSims({ weathers = ['dry', 'rain', 'snow'], log = () => {} } = {}) {
  const { M, cleanup } = await bundleGame();
  try {
    const W = await loadWorld(M);
    const results = [];
    for (const r of ROUTES) {
      for (const rev of [false, true]) {
        const track = W.tracks[`${r.file}|${rev}`];
        const others = r.other ? [W.tracks[`${r.other}|${rev}`]] : [];
        for (const weather of weathers) {
          const stations = layoutStations(M, W, r.key, track, others);
          const signals = new M.SignalSystem();
          signals.setSignals((W.sigFile.signals || []).map((x) => ({ ...x })));
          if (r.vehicle === 'flexity') signals.setLine(track, 40, (q) => track.speedLimitKmh(Math.max(0, Math.min(track.length, q)), false));
          signals.cycleS = W.sigFile.cycle_s ?? 30;
          const electric = r.vehicle === 'flexity';
          const res = driveRun(M, W, {
            track, stations, weather, electric, routeKey: r.key, isIon: electric, signals,
            massKg: electric ? M.MASS_FLEXITY_KG : r.vehicle === 'diesel-wcr' ? M.MASS_WCR_KG : M.MASS_CN_KG,
            axleFrac: electric ? M.AXLE_FRAC_FLEXITY : r.vehicle === 'diesel-wcr' ? M.AXLE_FRAC_WCR : M.AXLE_FRAC_CN,
            ...consistOf(M, r.vehicle), sLimits: sLimitsFor(M, track, r.vehicle),
            dwellS: electric ? 20 : 45, vehicle: r.vehicle, dirLabel: rev ? 'reverse' : 'forward',
            label: `${r.key} ${rev ? 'rev' : 'fwd'} ${weather}`,
          });
          results.push(res);
          log(res);
        }
      }
    }
    return { results, M, W };
  } finally {
    await cleanup();
  }
}

const fmt = (x, d = 1) => (Number.isFinite(x) ? x.toFixed(d) : String(x));
export function resultsTable(results) {
  const hdr = '| Route | Dir | Weather | Vehicle | Length (m) | Run time | Moving | Avg km/h (moving) | Stops | Max stop err (m) | Max grade % | Slip events | Slip s | Min μ | Max over limit (km/h) | Red viol. | Rail–DEM med/p95 (m) | Result |';
  const sep = '|' + '---|'.repeat(18);
  const mmss = (s) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;
  const rows = results.map((r) => `| ${r.routeKey} | ${r.dir} | ${r.weather} | ${r.vehicle} | ${r.lengthM} | ${mmss(r.runtimeS)} | ${mmss(r.movingS)} | ${fmt(r.avgKmh)} | ${r.stops}/${r.stopsExpected} | ${fmt(r.maxStopErrM, 2)} | ${fmt(r.maxGradePct, 2)} | ${r.slipEvents} | ${fmt(r.slipS)} | ${fmt(r.minMu, 3)} | ${fmt(r.maxExcessKmh, 2)} | ${r.redViolations} | ${fmt(r.railMed, 2)}/${fmt(r.railP95, 2)} | ${r.problems.length ? 'FAIL: ' + r.problems.join('; ') : 'PASS'} |`);
  return [hdr, sep, ...rows].join('\n');
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const t0 = Date.now();
  const { results } = await runDriveSims({ log: (r) => console.log(`${r.problems.length ? 'FAIL' : 'PASS'}  ${r.label.padEnd(30)} ${(r.runtimeS / 60).toFixed(1)} min  avg ${r.avgKmh.toFixed(1)} km/h  slips ${r.slipEvents}  ${r.problems.join('; ')}`) });
  const wall = ((Date.now() - t0) / 1000).toFixed(1);
  const table = resultsTable(results);
  console.log('\n' + table + `\n\nwall ${wall} s`);
  if (process.argv.includes('--write')) {
    await writeFile(path.join(root, 'docs/DRIVE-SIM-RESULTS.md'), `# Headless drive-simulation results\n\nGenerated by \`node scripts/drive-sim.mjs --write\` (also run inside \`npm test\`). Simulated time, not wall time; dt = 0.05 s like the game loop. Dwell: 20 s ION, 45 s heavy rail.\n\n${table}\n\n## Notes\n\n- **Driver**: one notch per 0.4 s; brakes on a planned curve for every limit, platform stop and red/amber signal ahead; keeps brake demand inside available adhesion; on wheelslip drops a notch and sands (rain/snow: also sands while braking); in street running never approaches a signal faster than it could stop within the amber.\n- **Stops**: every platform; doors open on the platform side with the brake released (hold brake alone must hold the car), dwell, close, depart. *Max stop err* = distance from the platform-centre stop mark; every stop also has the whole consist inside the platform.\n- **Min μ**: lowest effective adhesion used for traction/braking (weather μ × Curtius–Kniffler speed factor, incl. sand). **Max over limit**: highest speed minus the posted limit at the train (negative = always below; the game books overspeed above +2 km/h).\n- **Rail–DEM**: |rail bed − SRTM| median / p95 along the line actually driven.\n- ION *reverse* runs drive each directional line against its normal direction (wrong-line working); heavy-rail *reverse* = Elmira→Waterloo and Guelph→Kitchener.\n`);
  }
  process.exit(results.some((r) => r.problems.length) ? 1 : 0);
}
