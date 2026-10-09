/**
 * Headless stress suite for TrainPhysics + ROW/signal helpers.
 * Bundles src/game/Physics.ts, Row.ts, Signals.ts via esbuild.
 */
import * as esbuild from 'esbuild';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const physicsEntry = path.join(root, 'src/game/Physics.ts');
const rowEntry = path.join(root, 'src/game/Row.ts');
const signalsEntry = path.join(root, 'src/game/Signals.ts');
const reverserEntry = path.join(root, 'src/game/reverser.ts');

const results = [];
function pass(name, detail = '') {
  results.push({ name, ok: true, detail });
  console.log(`  PASS  ${name}${detail ? ' — ' + detail : ''}`);
}
function fail(name, detail = '') {
  results.push({ name, ok: false, detail });
  console.error(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`);
}
function assert(name, cond, detail = '') {
  if (cond) pass(name, detail);
  else fail(name, detail);
}

async function bundleEntry(entry, name) {
  const dir = await mkdtemp(path.join(tmpdir(), `ion-lrt-${name}-`));
  const outfile = path.join(dir, `${name}.mjs`);
  await esbuild.build({
    entryPoints: [entry],
    outfile,
    format: 'esm',
    platform: 'neutral',
    bundle: true,
    logLevel: 'silent',
  });
  const mod = await import(pathToFileURL(outfile).href + `?t=${Date.now()}`);
  return { mod, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

async function main() {
  console.log('ION LRT stress tests\n');
  const { mod, cleanup } = await bundleEntry(physicsEntry, 'Physics');
  const {
    TrainPhysics,
    VMAX_ELECTRIC_MS,
    VMAX_DIESEL_MS,
    SPEED_LIMITS_KMH,
    civilSpeedLimitKmh,
    isOverspeed,
    adhesionMu,
    MASS_FLEXITY_KG,
    MASS_WCR_KG,
    AXLE_FRAC_FLEXITY,
    AXLE_FRAC_WCR,
    curveSpeedLimitKmh,
  } = mod;

  const electric = (weather = 'dry') =>
    new TrainPhysics({ massKg: MASS_FLEXITY_KG, weather, electric: true, axleFrac: AXLE_FRAC_FLEXITY });
  const diesel = (weather = 'dry') =>
    new TrainPhysics({ massKg: MASS_WCR_KG, weather, electric: false, axleFrac: AXLE_FRAC_WCR });

  // --- a. Dry notch 8 from rest reaches >50 km/h within 45s, never exceeds vMax ---
  {
    const p = electric('dry');
    p.reverser = 1;
    p.powerNotch = 8;
    p.brakeNotch = 0;
    let t = 0;
    let maxKmh = 0;
    let reached50 = false;
    const dt = 1 / 30;
    while (t < 45) {
      p.step(dt, 0, 0);
      const k = p.speedKmh();
      if (k > maxKmh) maxKmh = k;
      if (k > 50) reached50 = true;
      t += dt;
    }
    assert(
      'a. dry notch8 >50 km/h in 45s',
      reached50,
      `max=${maxKmh.toFixed(1)} km/h at t=${t.toFixed(1)}s`,
    );
    assert(
      'a. dry never exceeds vMax',
      maxKmh <= 80.05,
      `max=${maxKmh.toFixed(2)} vMax=80`,
    );
  }

  // --- b. Rain notch 8 wheelslips; sanding reduces slip or raises accel ---
  {
    const rain = electric('rain');
    rain.reverser = 1;
    rain.powerNotch = 8;
    rain.sanding = false;
    let slipped = false;
    let distNoSand = 0;
    const dt = 1 / 30;
    for (let t = 0; t < 20; t += dt) {
      rain.step(dt, 0, 0);
      if (rain.wheelslip) slipped = true;
      distNoSand += Math.abs(rain.speed) * dt;
    }
    assert('b. rain notch8 wheelslips', slipped, `dist=${distNoSand.toFixed(1)}m`);

    const r2 = electric('rain');
    r2.reverser = 1;
    r2.powerNotch = 8;
    r2.sanding = false;
    const s2 = electric('rain');
    s2.reverser = 1;
    s2.powerNotch = 8;
    s2.sanding = true;
    let slipTimeSand = 0;
    let slipTimeNo = 0;
    for (let t = 0; t < 15; t += dt) {
      r2.step(dt, 0, 0);
      s2.step(dt, 0, 0);
      if (r2.wheelslip) slipTimeNo += dt;
      if (s2.wheelslip) slipTimeSand += dt;
    }
    const better =
      slipTimeSand < slipTimeNo - 0.05 || s2.speedKmh() > r2.speedKmh() + 0.5;
    assert(
      'b. sanding helps vs unsanded rain',
      better,
      `slipNo=${slipTimeNo.toFixed(2)}s slipSand=${slipTimeSand.toFixed(2)}s ` +
        `vNo=${r2.speedKmh().toFixed(1)} vSand=${s2.speedKmh().toFixed(1)}`,
    );
  }

  // --- c. Snow slips more than rain; accel lower than dry ---
  {
    const dt = 1 / 30;
    const run = (weather) => {
      const p = electric(weather);
      p.reverser = 1;
      p.powerNotch = 8;
      let slip = 0;
      for (let t = 0; t < 15; t += dt) {
        p.step(dt, 0, 0);
        if (p.wheelslip) slip += dt;
      }
      return { slip, v: p.speedKmh() };
    };
    const dry = run('dry');
    const rain = run('rain');
    const snow = run('snow');
    assert(
      'c. snow slips more than rain',
      snow.slip >= rain.slip - 0.01,
      `snowSlip=${snow.slip.toFixed(2)} rainSlip=${rain.slip.toFixed(2)}`,
    );
    assert(
      'c. snow/rain accel lower than dry',
      snow.v < dry.v && rain.v < dry.v,
      `dry=${dry.v.toFixed(1)} rain=${rain.v.toFixed(1)} snow=${snow.v.toFixed(1)}`,
    );
  }

  // --- d. Brake notch 8 from 70 km/h stops; snow/rain stopping distance > dry ---
  {
    const dt = 1 / 30;
    const stopDist = (weather) => {
      const p = electric(weather);
      p.reverser = 1;
      p.speed = 70 / 3.6;
      p.powerNotch = 0;
      p.brakeNotch = 8;
      let dist = 0;
      let t = 0;
      while (Math.abs(p.speed) > 0.05 && t < 120) {
        p.step(dt, 0, 0);
        dist += Math.abs(p.speed) * dt;
        t += dt;
      }
      return { dist, stopped: Math.abs(p.speed) <= 0.15, t };
    };
    const dry = stopDist('dry');
    const rain = stopDist('rain');
    const snow = stopDist('snow');
    assert('d. dry brake8 from 70 stops', dry.stopped, `dist=${dry.dist.toFixed(1)}m t=${dry.t.toFixed(1)}s`);
    assert('d. rain/snow stop distance > dry', rain.dist > dry.dist && snow.dist > dry.dist,
      `dry=${dry.dist.toFixed(1)} rain=${rain.dist.toFixed(1)} snow=${snow.dist.toFixed(1)}`);
  }

  // --- e. Interlocks: doors / reverser N / panto down → no TE ---
  {
    const dt = 0.1;
    {
      const p = electric('dry');
      p.reverser = 1;
      p.doorsOpen = true;
      p.powerNotch = 8;
      const r = p.step(dt, 0, 0);
      assert('e. doors open → no TE', r.te === 0 && Math.abs(p.speed) < 0.01, `te=${r.te}`);
    }
    {
      const p = electric('dry');
      p.reverser = 0;
      p.powerNotch = 8;
      const r = p.step(dt, 0, 0);
      assert('e. reverser N → no TE', r.te === 0, `te=${r.te}`);
    }
    {
      const p = electric('dry');
      p.reverser = 1;
      p.pantographUp = false;
      p.powerNotch = 8;
      const r = p.step(dt, 0, 0);
      assert('e. panto down → no TE', r.te === 0 && p.maxTE(0) === 0, `te=${r.te}`);
    }
  }

  // --- f. Grade +2% reduces accel vs flat; −2% increases ---
  {
    const dt = 1 / 30;
    const speedAfter = (grade) => {
      const p = electric('dry');
      p.reverser = 1;
      p.powerNotch = 8;
      for (let t = 0; t < 20; t += dt) p.step(dt, grade, 0);
      return p.speedKmh();
    };
    const flat = speedAfter(0);
    const up = speedAfter(0.02);
    const down = speedAfter(-0.02);
    assert('f. +2% grade reduces accel vs flat', up < flat, `flat=${flat.toFixed(1)} up=${up.toFixed(1)}`);
    assert('f. −2% grade increases accel vs flat', down > flat, `flat=${flat.toFixed(1)} down=${down.toFixed(1)}`);
  }

  // --- g. Station 25 / street 40 / reserved 70 + overspeed + rowClass ---
  {
    assert('g. station limit 25', SPEED_LIMITS_KMH.station === 25 && civilSpeedLimitKmh(true, 0) === 25);
    assert('g. street limit 40', SPEED_LIMITS_KMH.street === 40 && civilSpeedLimitKmh(false, 0.005) === 40);
    assert('g. reserved limit 70', SPEED_LIMITS_KMH.reserved === 70 && civilSpeedLimitKmh(false, 0) === 70);
    assert(
      'g. rowClass overrides curvature',
      civilSpeedLimitKmh(false, 0.01, { rowClass: 'reserved' }) === 70 &&
        civilSpeedLimitKmh(false, 0, { rowClass: 'street' }) === 40,
    );
    assert('g. overspeed detection', isOverspeed(73, 70) === true && isOverspeed(72, 70) === false && isOverspeed(70, 70) === false);
  }

  // --- h. Diesel vMax > Flexity vMax ---
  {
    const fe = electric('dry');
    const di = diesel('dry');
    assert(
      'h. diesel vMax > Flexity vMax',
      di.vMaxMs() > fe.vMaxMs() && VMAX_DIESEL_MS > VMAX_ELECTRIC_MS,
      `flexity=${(fe.vMaxMs() * 3.6).toFixed(1)} diesel=${(di.vMaxMs() * 3.6).toFixed(1)}`,
    );
    di.reverser = 1;
    di.powerNotch = 8;
    di.speed = 90 / 3.6;
    for (let i = 0; i < 300; i++) di.step(1 / 30, -0.01, 0);
    assert(
      'h. diesel can exceed Flexity 80 but not its own vMax',
      di.speedKmh() <= 95.1,
      `v=${di.speedKmh().toFixed(1)}`,
    );
  }

  assert('helper adhesionMu dry/rain/snow', adhesionMu('dry', false) === 0.3 && adhesionMu('rain', false) === 0.15 && adhesionMu('snow', false) === 0.1);

  // --- e2. powerBlockedReason ---
  {
    const p = electric('dry');
    p.reverser = 0;
    assert('e2. block reason Neutral', (p.powerBlockedReason() || '').includes('Neutral'));
    p.reverser = 1;
    p.doorsOpen = true;
    assert('e2. block reason doors', (p.powerBlockedReason() || '').includes('Doors'));
    p.doorsOpen = false;
    assert('e2. unblocked when F + doors closed', p.powerBlockedReason() === null);
  }

  await cleanup();

  // --- e3. reverser N→F→R→N (P0 fix) ---
  {
    const { mod: revMod, cleanup: cRev } = await bundleEntry(reverserEntry, 'reverser');
    const { nextReverser } = revMod;
    assert('e3. N→F', nextReverser(0) === 1);
    assert('e3. F→R', nextReverser(1) === -1);
    assert('e3. R→N', nextReverser(-1) === 0);
    assert('e3. two R from N is Reverse not stuck', nextReverser(nextReverser(0)) === -1);
    await cRev();
  }


  // --- i. ROW classifier samples: reserved 70 / street 40 / station 25 ---
  {
    const { mod: rowMod, cleanup: c2 } = await bundleEntry(rowEntry, 'Row');
    const { RowClassifier, classifyIonRowSample, isStreetRunningArterialName } = rowMod;
    assert('i. King South is street arterial', isStreetRunningArterialName('King Street South'));
    assert('i. Charles is street arterial', isStreetRunningArterialName('Charles Street East'));
    assert('i. Northfield is NOT street arterial', !isStreetRunningArterialName('Northfield Drive West'));
    const st = classifyIonRowSample({
      s: 7000,
      arterialDistM: 4,
      arterialName: 'King Street South',
      nearStation: false,
    });
    assert('i. classify King → street 40', st.row === 'street' && st.limit_kmh === 40);
    const res = classifyIonRowSample({
      s: 2000,
      arterialDistM: 5,
      arterialName: 'Northfield Drive West',
      nearStation: false,
    });
    assert('i. classify Northfield → reserved 70', res.row === 'reserved' && res.limit_kmh === 70);
    const sta = classifyIonRowSample({
      s: 7000,
      arterialDistM: 4,
      arterialName: 'King Street South',
      nearStation: true,
    });
    assert('i. classify near station → 25', sta.row === 'station' && sta.limit_kmh === 25);

    // Baked samples if present
    try {
      const raw = JSON.parse(await readFile(path.join(root, 'public/data/row-segments.json'), 'utf8'));
      const samples = raw.samples || [];
      const r1 = RowClassifier.classifyAt(samples, 2000, false, 0);
      const r2 = RowClassifier.classifyAt(samples, 7500, false, 0);
      const r3 = RowClassifier.classifyAt(samples, 0, true, 0);
      assert('i. baked reserved ~70', r1.row === 'reserved' && r1.limitKmh === 70, `${r1.row}/${r1.limitKmh}`);
      assert('i. baked street ~40', r2.row === 'street' && r2.limitKmh === 40, `${r2.row}/${r2.limitKmh}`);
      assert('i. baked station ~25', r3.row === 'station' && r3.limitKmh === 25, `${r3.row}/${r3.limitKmh}`);
    } catch (e) {
      fail('i. baked row-segments.json', String(e));
    }
    await c2();
  }

  // --- j. Red-signal stop / violation hook ---
  {
    const { mod: sigMod, cleanup: c3 } = await bundleEntry(signalsEntry, 'Signals');
    const { redSignalViolation, shouldHoldForRed, aspectAtTime, tspGreenBias } = sigMod;
    assert(
      'j. red violation when speeding through red in street',
      redSignalViolation({
        aspect: 'red',
        speedKmh: 30,
        distToSignalM: 10,
        inStreetRow: true,
      }) === true,
    );
    assert(
      'j. no violation when stopped at red',
      redSignalViolation({
        aspect: 'red',
        speedKmh: 2,
        distToSignalM: 10,
        inStreetRow: true,
      }) === false,
    );
    assert(
      'j. no violation on reserved ROW',
      redSignalViolation({
        aspect: 'red',
        speedKmh: 40,
        distToSignalM: 5,
        inStreetRow: false,
      }) === false,
    );
    assert(
      'j. shouldHoldForRed at close red',
      shouldHoldForRed({ aspect: 'red', distToSignalM: 15, inStreetRow: true }) === true,
    );
    assert(
      'j. aspect cycles include red/amber/green',
      aspectAtTime(0, 0) === 'green' &&
        aspectAtTime(15, 0) === 'amber' &&
        aspectAtTime(20, 0) === 'red',
    );
    assert(
      'j. TSP bias after wait when slow+close',
      tspGreenBias({
        distAlongM: 40,
        absDistM: 40,
        speedKmh: 20,
        approachM: 80,
        speedThreshKmh: 25,
        waitS: 2.5,
        timeInApproachS: 3,
      }) === 8 &&
        tspGreenBias({
          distAlongM: 40,
          absDistM: 40,
          speedKmh: 40,
          approachM: 80,
          speedThreshKmh: 25,
          waitS: 2.5,
          timeInApproachS: 3,
        }) === 0,
    );
    await c3();
  }


  // --- k. Conestoga departure: s≈0, F, doors closed, dry, notch 8 → speed > 1 m/s in 5–10 s ---
  {
    const trackEntry = path.join(root, 'src/game/Track.ts');
    const { mod: trackMod, cleanup: cTrack } = await bundleEntry(trackEntry, 'Track');
    const { Track } = trackMod;
    const elevMeta = JSON.parse(await readFile(path.join(root, 'public/data/elevation.json'), 'utf8'));
    const gj = JSON.parse(await readFile(path.join(root, 'public/data/ion-track.geojson'), 'utf8'));
    const coords = gj.features[0].geometry.coordinates;
    const profile = elevMeta.track_profiles.ion;
    const track = Track.fromLonLatProfile(coords, profile, 'ION LRT', 330, false);

    // Grade sanity after smooth/clamp
    let maxAbsG = 0;
    for (const p of track.points) {
      if (Math.abs(p.grade) > maxAbsG) maxAbsG = Math.abs(p.grade);
    }
    assert(
      'k. max |grade| ≤ 5.5% after smooth/clamp',
      maxAbsG <= 0.055,
      `maxGrade=${(maxAbsG * 100).toFixed(2)}% len=${track.length.toFixed(0)}m pts=${track.points.length}`,
    );

    // Simulate Game terminus clamp + physics from Conestoga (s≈0)
    const p = electric('dry');
    p.reverser = 1;
    p.doorsOpen = false;
    p.powerNotch = 8;
    p.brakeNotch = 0;
    let s = 0; // Conestoga terminus
    const dt = 1 / 30;
    let tSim = 0;
    while (tSim < 8) {
      const sample = track.sample(s);
      const grade = Number.isFinite(sample.grade) ? sample.grade : 0;
      const curv = Number.isFinite(sample.curvature) ? sample.curvature : 0;
      p.step(dt, grade, curv);
      const ds = p.speed * dt;
      s = Math.max(0, Math.min(track.length, s + ds));
      // Fixed clamp: only zero when driving into bumper
      if (s <= 0 && p.speed < 0) p.speed = 0;
      if (s >= track.length && p.speed > 0) p.speed = 0;
      if (!Number.isFinite(p.speed)) p.speed = 0;
      tSim += dt;
    }
    assert(
      'k. Conestoga departure speed > 1 m/s after 8s',
      p.speed > 1 && Number.isFinite(p.speed),
      `speed=${p.speed.toFixed(3)} m/s s=${s.toFixed(1)}m grade0=${(track.sample(0).grade * 100).toFixed(2)}%`,
    );

    // NaN harden: absurd non-finite grade must not NaN the consist
    const p2 = electric('dry');
    p2.reverser = 1;
    p2.powerNotch = 8;
    p2.step(1 / 30, Number.NaN, Number.POSITIVE_INFINITY);
    assert('k. non-finite grade/curvature → finite speed', Number.isFinite(p2.speed));

    await cTrack();
  }


  // --- l. v1.4 regression: dry P7 from standstill — realistic accel, never SLIP, no creep ---
  {
    const dt = 1 / 60;
    const run = (grade, curv, secs = 10) => {
      const p = electric('dry');
      p.reverser = 1;
      p.powerNotch = 7;
      let slip = false, v1 = 0, monotone = true, prev = 0;
      for (let t = 0; t < secs; t += dt) {
        p.step(dt, grade, curv);
        if (p.wheelslip) slip = true;
        if (p.speed < prev - 1e-9) monotone = false;
        prev = p.speed;
        if (Math.abs(t - 1) < dt / 2) v1 = p.speed;
      }
      return { slip, a1: v1 / 1, kmh: p.speedKmh(), monotone };
    };
    const flat = run(0, 0);
    assert('l. dry P7 flat: no SLIP flag', !flat.slip);
    assert('l. dry P7 flat: accel 0.7–1.2 m/s² (Flexity ~1.0–1.1)', flat.a1 > 0.7 && flat.a1 < 1.2, `a=${flat.a1.toFixed(2)} m/s²`);
    assert('l. dry P7 flat: >25 km/h after 10 s (no ~1 km/h creep)', flat.kmh > 25, `${flat.kmh.toFixed(1)} km/h`);
    // The Northfield / Block Line failure: tight-ish curve (R≈60–100 m) + grade
    for (const [g, R] of [[0, 100], [0.02, 60], [0.04, 25]]) {
      const r = run(g, 1 / R);
      assert(`l. dry P7 R=${R} m grade ${g * 100}%: no SLIP, departs`, !r.slip && r.kmh > 8 && r.monotone,
        `${r.kmh.toFixed(1)} km/h slip=${r.slip} monotone=${r.monotone}`);
    }
    const p = electric('dry');
    assert('l. curve resistance R=100 m < 10 kN (was 165 kN)', p.curveResistance(0.01) < 10000, `${(p.curveResistance(0.01) / 1000).toFixed(2)} kN`);
    // Standing with zero TE on level track must not drift (static friction, no jitter)
    const q = electric('dry');
    q.reverser = 1; q.powerNotch = 0;
    for (let t = 0; t < 5; t += dt) q.step(dt, 0, 0.02);
    assert('l. standstill P0 on curve: no creep', q.speed === 0, `v=${q.speed}`);
    // Rain P8 must still slip (adhesion model still active)
    const rr = electric('rain'); rr.reverser = 1; rr.powerNotch = 8;
    let rs = false; for (let t = 0; t < 3; t += dt) { rr.step(dt, 0, 0); if (rr.wheelslip) rs = true; }
    assert('l. rain P8 still flags SLIP', rs);
  }

  // --- m. Articulation: 5 modules through an S-curve at the 25 m minimum radius ---
  {
    const { mod: art, cleanup: cArt } = await bundleEntry(path.join(root, 'src/game/Articulation.ts'), 'Articulation');
    const { mod: clr, cleanup: cClr } = await bundleEntry(path.join(root, 'src/game/Clearances.ts'), 'Clearances');
    const { mod: trk, cleanup: cTrk } = await bundleEntry(path.join(root, 'src/game/Track.ts'), 'TrackArt');
    const { Track } = trk;
    // Build S-curve: 60 m straight, R=25 left 90°, R=25 right 90°, 60 m straight
    const pts = [];
    let x = 0, z = 0, h = 0;
    const push = () => pts.push({ lon: 0, lat: 0, x, y: 0.1 * Math.sin(x / 40), z, s: 0, grade: 0, curvature: 0 });
    push();
    const go = (len, k) => {
      const n = Math.ceil(len / 0.5);
      for (let i = 0; i < n; i++) { h += k * (len / n); x += Math.sin(h) * (len / n); z += Math.cos(h) * (len / n); push(); }
    };
    go(60, 0); go(25 * Math.PI / 2, 1 / 25); go(25 * Math.PI / 2, -1 / 25); go(60, 0);
    const t = new Track('S-curve');
    t.points = pts;
    t.recomputeChainage();
    t.recomputeDerivatives();
    const env = clr.envelopeHalfWidth(25);
    let worst = 0, worstTruck = 0, worstGap = 0, worstJoint = 0;
    const nearestLat = (px, pz) => {
      let best = Infinity;
      for (let i = 0; i < t.points.length - 1; i++) {
        const a = t.points[i], b = t.points[i + 1];
        const vx = b.x - a.x, vz = b.z - a.z, L2 = vx * vx + vz * vz || 1;
        const u = Math.max(0, Math.min(1, ((px - a.x) * vx + (pz - a.z) * vz) / L2));
        const d = Math.hypot(px - (a.x + vx * u), pz - (a.z + vz * u));
        if (d < best) best = d;
      }
      return best;
    };
    for (let sC = 20; sC < t.length - 20; sC += 1.5) {
      const pose = art.poseConsist(t, sC, 1);
      for (const tr of pose.trucks) worstTruck = Math.max(worstTruck, nearestLat(tr.pos.x, tr.pos.z));
      for (const m of pose.modules) {
        for (const c of art.moduleCorners(m, clr.LRV_WIDTH_M)) worst = Math.max(worst, nearestLat(c.x, c.z));
      }
      // articulation joints stay together (rear face of k ≈ front face of k+1)
      for (let k = 0; k < 4; k++) {
        const a = pose.modules[k], b = pose.modules[k + 1];
        const ra = { x: a.pos.x - a.fwd.x * a.len / 2, z: a.pos.z - a.fwd.z * a.len / 2 };
        const fb = { x: b.pos.x + b.fwd.x * b.len / 2, z: b.pos.z + b.fwd.z * b.len / 2 };
        worstGap = Math.max(worstGap, Math.hypot(ra.x - fb.x, ra.z - fb.z));
        let dy = b.yaw - a.yaw; while (dy > Math.PI) dy -= 2 * Math.PI; while (dy < -Math.PI) dy += 2 * Math.PI;
        worstJoint = Math.max(worstJoint, Math.abs(dy));
      }
    }
    assert('m. trucks stay on the rail centreline', worstTruck < 0.06, `max=${worstTruck.toFixed(3)} m`);
    assert('m. body corners within dynamic envelope on R=25 S-curve', worst <= env + 0.02,
      `max=${worst.toFixed(3)} m envelope=${env.toFixed(3)} m`);
    assert('m. bodies actually bend (joint yaw > 5° on R=25)', worstJoint > 5 * Math.PI / 180, `max joint=${(worstJoint * 180 / Math.PI).toFixed(1)}°`);
    assert('m. articulation faces meet (gap < 0.9 m incl. bellows)', worstGap < 0.9, `max gap=${worstGap.toFixed(3)} m`);
    const straight = art.poseConsist(t, 30, 1);
    const yaws = straight.modules.map((m) => m.yaw);
    assert('m. straight track: all modules aligned', Math.max(...yaws) - Math.min(...yaws) < 1e-3);
    assert('m. superelevation capped & zero in street', Math.abs(art.superelevationFor(1 / 25, 20, true)) <= clr.MAX_SUPERELEVATION_M + 1e-9 && art.superelevationFor(1 / 25, 20, false) === 0);
    await cArt(); await cClr(); await cTrk();
  }

  // --- n. Ground corridor: cut/fill keeps terrain under rails, bridge over deep valley ---
  {
    const { mod: gm, cleanup: cG } = await bundleEntry(path.join(root, 'src/game/Ground.ts'), 'Ground');
    const { mod: trk, cleanup: cT } = await bundleEntry(path.join(root, 'src/game/Track.ts'), 'TrackGround');
    const { Track } = trk;
    // DEM: hill crossing the line at z≈200 (+8 m), valley at z≈500 (−12 m), bumpy noise
    const dem = {
      heightAtLocal: (x, z) =>
        8 * Math.exp(-(((z - 200) / 40) ** 2)) - 12 * Math.exp(-(((z - 500) / 30) ** 2)) +
        0.6 * Math.sin(x * 0.3) * Math.cos(z * 0.21),
    };
    const pts = [];
    for (let z = 0; z <= 800; z += 5) pts.push({ lon: 0, lat: 0, x: 3 + 0.004 * z * z / 50, y: 0.35, z, s: 0, grade: 0, curvature: 0 });
    const t = new Track('Synthetic');
    t.points = pts; t.recomputeChainage(); t.recomputeDerivatives();
    const g = new gm.GroundModel(dem);
    g.addTrack(t);
    let pokeRibbon = 0, pokeMesh = 0, bridge = false;
    for (let s = 2; s < t.length - 2; s += 1.7) {
      const p = t.sampleRaw(s);
      const c = g.tracks[0].samples[Math.round(s / 2)];
      if (c.bridge) bridge = true;
      for (let o = -1.6; o <= 1.6; o += 0.4) {
        const lx = c.fz, lz = -c.fx;
        const x = p.x + lx * o, z = p.z + lz * o;
        if (!c.bridge) pokeRibbon = Math.max(pokeRibbon, g.exactHeight(x, z) - (p.y - 0.3));
        pokeMesh = Math.max(pokeMesh, g.surfaceHeight(x, z) - (p.y - 0.3));
      }
    }
    assert('n. corridor surface never above ballast bottom under rails', pokeRibbon <= 1e-6, `max=${pokeRibbon.toFixed(3)} m`);
    assert('n. coarse terrain mesh never pokes through rail bed', pokeMesh <= 0, `max=${pokeMesh.toFixed(3)} m`);
    assert('n. deep valley becomes a bridge (no 12 m embankment)', bridge);
    // away from the track the DEM is untouched
    const far = g.exactHeight(200, 200);
    assert('n. DEM untouched 200 m from track', Math.abs(far - dem.heightAtLocal(200, 200)) < 1e-9);
    // real ION alignment: mesh below rail bed at every 5 m
    const elevMeta = JSON.parse(await readFile(path.join(root, 'public/data/elevation.json'), 'utf8'));
    const gj = JSON.parse(await readFile(path.join(root, 'public/data/ion-track.geojson'), 'utf8'));
        // Real SRTM-derived DEM from public/data (same as the game), loaded without fetch
    const { mod: el, cleanup: cEl } = await bundleEntry(path.join(root, 'src/game/elevation.ts'), 'Elevation');
    const dem2 = new el.Elevation();
    dem2.meta = elevMeta;
    const bin = await readFile(path.join(root, 'public/data/elevation.bin'));
    dem2.grid = new Float32Array(bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength));
    const spots = Object.values(elevMeta.spot_checks_m).map((q) => q.elev_m).filter((v) => v != null);
    dem2.baseElev = spots.reduce((a, b) => a + b, 0) / Math.max(1, spots.length);
    await cEl();
    const ion = Track.fromLonLatProfile(gj.features[0].geometry.coordinates, elevMeta.track_profiles.ion, 'ION LRT', dem2.baseElev, false);
    const g2 = new gm.GroundModel(dem2);
    g2.addTrack(ion);
    let poke2 = 0;
    for (let s = 5; s < ion.length - 5; s += 5) {
      const c = g2.tracks[0].samples[Math.round(s / 2)];
      const p = ion.sampleRaw(s);
      for (const o of [-1.2, 0, 1.2]) {
        poke2 = Math.max(poke2, g2.surfaceHeight(p.x + c.fz * o, p.z - c.fx * o) - (p.y - 0.3));
      }
    }
    const nBridge = g2.tracks[0].samples.filter((c) => c.bridge).length * 2;
    assert('n. ION 16 km (real DEM): terrain mesh below rail bed everywhere', poke2 <= 0, `max=${poke2.toFixed(3)} m bridges≈${nBridge} m`);
    await cG(); await cT();
  }

  // ===== v1.4.1 regression tests (QA report 2026-10-08 on 608e890) =====================
  const { mod: T141, cleanup: cT141 } = await bundleEntry(path.join(root, 'src/game/Track.ts'), 'Track141');
  const { mod: E141, cleanup: cE141 } = await bundleEntry(path.join(root, 'src/game/elevation.ts'), 'Elev141');
  const { mod: PL, cleanup: cPL } = await bundleEntry(path.join(root, 'src/game/PlatformLayout.ts'), 'PlatformLayout');
  const { mod: AR, cleanup: cAR } = await bundleEntry(path.join(root, 'src/game/Articulation.ts'), 'Art141');
  const Track141 = T141.Track;
  const meta141 = JSON.parse(await readFile(path.join(root, 'public/data/elevation.json'), 'utf8'));
  const dem141 = new E141.Elevation();
  dem141.meta = meta141;
  {
    const bin = await readFile(path.join(root, 'public/data/elevation.bin'));
    dem141.grid = new Float32Array(bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength));
    const spots = Object.values(meta141.spot_checks_m).map((q) => q.elev_m).filter((v) => v != null);
    dem141.baseElev = spots.reduce((a, b) => a + b, 0) / Math.max(1, spots.length);
  }
  const demAt = (lon, lat) => dem141.elevLonLat(lon, lat);
  const coordsOf = async (f) => JSON.parse(await readFile(path.join(root, 'public/data', f), 'utf8')).features[0].geometry.coordinates;
  const stations141 = JSON.parse(await readFile(path.join(root, 'public/data/stations.json'), 'utf8'));
  const platforms141 = JSON.parse(await readFile(path.join(root, 'public/data/platforms.json'), 'utf8')).platforms;
  const buildRoute = async (file, rev = false) => {
    let prof = null;
    if (file === 'ion-track.geojson') prof = meta141.track_profiles.ion;
    if (file.includes('spur')) prof = meta141.track_profiles.spur;
    if (file.includes('guelph')) prof = meta141.track_profiles.guelph;
    return Track141.fromLonLatProfile(await coordsOf(file), prof, file, dem141.baseElev, rev, demAt);
  };

  // --- o. P0: rail height follows the DEM in BOTH directions on every route -------------
  {
    const files = ['ion-track.geojson', 'ion-sb.geojson', 'ion-nb.geojson', 'waterloo-spur.geojson', 'guelph-sub.geojson'];
    for (const f of files) {
      const fwd = await buildRoute(f, false);
      const rev = await buildRoute(f, true);
      for (const [t, tag] of [[fwd, 'fwd'], [rev, 'rev']]) {
        const d = [];
        for (let s = 0; s <= t.length; s += 10) {
          const p = t.sampleRaw(s);
          d.push(Math.abs(p.y - T141.Track.BED_ABOVE_DEM_M - dem141.heightAtLocal(p.x, p.z)));
        }
        d.sort((a, b) => a - b);
        const med = d[d.length >> 1], p95 = d[Math.floor(d.length * 0.95)], mx = d[d.length - 1];
        assert(`o. ${f} ${tag}: rail bed vs DEM (median < 1 m, p95 < 3 m, max < 9 m)`, med < 1 && p95 < 3 && mx < 9,
          `median=${med.toFixed(2)} p95=${p95.toFixed(2)} max=${mx.toFixed(2)} m`);
      }
      // same place, opposite direction → same rail height (v1.4.0: +20 m / −17.7 m on NB)
      let worst = 0;
      for (let s = 0; s <= fwd.length; s += 25) {
        const p = fwd.sampleRaw(s);
        const q = rev.sampleRaw(rev.nearestSLocal(p.x, p.z));
        worst = Math.max(worst, Math.abs(p.y - q.y));
      }
      assert(`o. ${f}: forward vs reversed rail height agree (< 0.6 m)`, worst < 0.6, `max Δ=${worst.toFixed(3)} m`);
    }
    // the original bug: profile indexed forward on a reversed geometry
    const c = await coordsOf('ion-track.geojson');
    const prof = meta141.track_profiles.ion;
    const rev = Track141.fromLonLatProfile(c, prof, 'NB', dem141.baseElev, true, demAt);
    const startAsl = rev.points[0].y - T141.Track.BED_ABOVE_DEM_M + dem141.baseElev;
    assert('o. reversed ION starts at the Fairway end elevation (profile reversed too)',
      Math.abs(startAsl - prof[prof.length - 1]) < 3, `start=${startAsl.toFixed(1)} Fairway profile=${prof[prof.length - 1].toFixed(1)} Conestoga=${prof[0].toFixed(1)}`);
  }

  // --- p. P1a/P1d: platforms follow the curve, real OSM side, never foul the other line --
  const ionSb = await buildRoute('ion-sb.geojson');
  const ionNb = await buildRoute('ion-nb.geojson');
  {
    const edge = 1.40;
    for (const [key, t, other] of [['ion_southbound', ionSb, ionNb], ['ion_northbound', ionNb, ionSb]]) {
      let worstEdge = 0, worstOther = Infinity, osm = 0, sideOk = 0, n = 0, worstStop = 0;
      const bad = [];
      for (const st of stations141.routes[key].stations) {
        n++;
        const s0 = t.nearestS(st.lon, st.lat);
        const lay = PL.layoutPlatform(t, s0, {
          platforms: platforms141, platformId: st.platform_osm, edgeOffset: edge, width: 3.5, length: 65, otherTracks: [other],
        });
        if (lay.source === 'osm') osm++;
        for (const p of lay.edge) worstEdge = Math.max(worstEdge, Math.abs(PL.lateralOf(t, p.x, p.z).d - edge));
        for (const p of [...lay.edge, ...lay.back]) worstOther = Math.min(worstOther, PL.lateralOf(other, p.x, p.z).d);
        // independent side check: OSM outline centroid lateral sign vs chosen side
        const pl = platforms141.find((q) => q.osm === st.platform_osm);
        if (pl) {
          const ring = PL.localRing(pl);
          const cx = ring.reduce((a, q) => a + q.x, 0) / ring.length, cz = ring.reduce((a, q) => a + q.z, 0) / ring.length;
          const lat = PL.lateralOf(t, cx, cz).lat;
          if ((lat > 0 ? -1 : 1) === lay.side) sideOk++; else bad.push(st.id);
          worstStop = Math.max(worstStop, Math.abs(lay.sCentre - PL.lateralOf(t, cx, cz).s));
        }
      }
      assert(`p. ${key}: every stop matched to a real OSM platform`, osm === n, `${osm}/${n}`);
      assert(`p. ${key}: platform side = OSM platform side`, sideOk === n, bad.length ? `wrong: ${bad.join(',')}` : `${sideOk}/${n}`);
      assert(`p. ${key}: platform edge ${edge} m from track CL along the whole curved length (±0.05)`, worstEdge <= 0.05, `max err=${worstEdge.toFixed(3)} m`);
      assert(`p. ${key}: platforms never reach within ${(edge - 0.05).toFixed(2)} m of the other ION line`, worstOther >= edge - 0.05, `min=${worstOther.toFixed(2)} m`);
      assert(`p. ${key}: stop point at the real platform centre (≤ 40 m)`, worstStop <= 40, `max=${worstStop.toFixed(1)} m`);
    }
    // centre vs side platforms both exist (ION has both)
    const sb = stations141.routes.ion_southbound.stations;
    const sides = sb.map((st) => {
      const lay = PL.layoutPlatform(ionSb, ionSb.nearestS(st.lon, st.lat), { platforms: platforms141, platformId: st.platform_osm, edgeOffset: 1.4, width: 3.5, length: 65, otherTracks: [ionNb] });
      return lay.side;
    });
    assert('p. SB has both left (centre) and right (side) platforms', sides.includes(1) && sides.includes(-1), sides.join(' '));
    // straight-box regression: Allen is curved — a straight 65 m box drifted 14 m
    const allen = sb.find((s) => s.id === 'allen');
    const la = PL.layoutPlatform(ionSb, ionSb.nearestS(allen.lon, allen.lat), { platforms: platforms141, platformId: allen.platform_osm, edgeOffset: 1.4, width: 3.5, length: 65 });
    const e0 = la.edge[0], e1 = la.edge[la.edge.length - 1], em = la.edge[la.edge.length >> 1];
    const chordDev = Math.abs(((e1.x - e0.x) * (em.z - e0.z) - (e1.z - e0.z) * (em.x - e0.x)) / Math.hypot(e1.x - e0.x, e1.z - e0.z));
    assert('p. Allen platform edge is curved with the track (not a straight box)', chordDev > 0.3, `mid-chord offset=${chordDev.toFixed(2)} m`);
  }

  // --- q. P1b: hold brake — no rollback with doors open / interlocked, doors close --------
  {
    const p = electric('dry');
    const up = 0.05; // +5 % upgrade in the direction of travel
    p.reverser = 1;
    p.brakeNotch = 4;
    for (let i = 0; i < 60; i++) p.step(1 / 30, up, 0);
    p.doorsOpen = true; // T at standstill
    p.brakeNotch = 0;   // what v1.4.0's W did while interlocked
    p.powerNotch = 3;
    let minV = 0;
    for (let i = 0; i < 300; i++) { p.step(1 / 30, up, 0); minV = Math.min(minV, p.speed); }
    assert('q. doors open + brake released on +5 %: no rollback (hold brake)', minV >= 0 && p.holdBrake, `min v=${(minV * 3.6).toFixed(2)} km/h hold=${p.holdBrake}`);
    assert('q. doors can be closed (car still at standstill)', Math.abs(p.speed) < 0.3);
    p.doorsOpen = false;
    p.powerNotch = 1; // weak notch: TE < grade force → hold brake must stay on
    minV = 0;
    for (let i = 0; i < 150; i++) { p.step(1 / 30, up, 0); minV = Math.min(minV, p.speed); }
    assert('q. weak notch on +5 %: hold brake keeps the car (no rollback)', minV >= 0, `min v=${(minV * 3.6).toFixed(2)} km/h`);
    p.powerNotch = 8;
    for (let i = 0; i < 300; i++) p.step(1 / 30, up, 0);
    assert('q. P8 on +5 %: hold brake releases and the car departs forward', p.speed > 1 && !p.holdBrake, `v=${(p.speed * 3.6).toFixed(1)} km/h`);
    // neutral at standstill on a grade never rolls
    const n = electric('dry');
    n.reverser = 0;
    let mv = 0;
    for (let i = 0; i < 300; i++) { n.step(1 / 30, -0.05, 0); mv = Math.max(mv, Math.abs(n.speed)); }
    assert('q. reverser N on −5 %: no roll-away', mv < 0.01, `max |v|=${mv.toFixed(3)}`);
  }

  // --- r. P1e: curve speed restrictions ------------------------------------------------
  {
    assert('r. TCRP curve speed: R25 → 15, R50 → 20, R100 → 30, R510 → 70 km/h',
      curveSpeedLimitKmh(25) === 15 && curveSpeedLimitKmh(50) === 20 && curveSpeedLimitKmh(100) === 30 && curveSpeedLimitKmh(510) === 70,
      `${curveSpeedLimitKmh(25)}/${curveSpeedLimitKmh(50)}/${curveSpeedLimitKmh(100)}/${curveSpeedLimitKmh(510)}`);
    // Conestoga S-curves (QA: s≈120–220 and 530–570 posted 70)
    const lim = (a, b) => { let m = 999; for (let s = a; s <= b; s += 2) m = Math.min(m, ionSb.curveLimitKmh(s)); return m; };
    assert('r. SB R≈25 m S-curve after Conestoga restricted ≤ 20 km/h', lim(130, 175) <= 20, `min=${lim(130, 175)}`);
    assert('r. SB second S-curve (s≈530–570) restricted ≤ 20 km/h', lim(530, 570) <= 20, `min=${lim(530, 570)}`);
    ionSb.rowLookup = () => ({ row: 'reserved', limitKmh: 70 });
    assert('r. speedLimitKmh = min(ROW limit, curve limit)', ionSb.speedLimitKmh(150, false) <= 20 && ionSb.speedLimitKmh(150, false) < 70);
    ionSb.rowLookup = null;
    // straight reserved track keeps line speed
    let tangent = 0;
    for (let s = 0; s < ionSb.length; s += 2) if (ionSb.curveLimitKmh(s) >= 70) tangent += 2;
    assert('r. most of the line keeps 70 km/h (restrictions only on real curves)', tangent > ionSb.length * 0.5, `${(tangent / ionSb.length * 100).toFixed(0)} % at ≥ 70`);
    const synth = new Track141('Synthetic');
    const pts = [];
    for (let z = 0; z <= 300; z += 5) pts.push({ lon: 0, lat: 0, x: 0, y: 0.35, z, s: 0, grade: 0, curvature: 0 });
    synth.points = pts; synth.recomputeChainage(); synth.recomputeDerivatives();
    assert('r. straight track: no curve restriction', synth.curveLimitKmh(150) >= 70);
  }

  // --- s. Cant transitions + smooth vertical profile: no module twist / pitch kinks -------
  {
    let worstRoll = 0, worstPitch = 0, maxGrade = 0;
    for (const t of [ionSb, ionNb]) {
      const raw = (s) => AR.superelevationFor(t.sample(Math.max(0, Math.min(t.length, s))).curvSigned ?? 0,
        Math.min(70, t.curveLimitKmh(Math.max(0, Math.min(t.length, s)))) / 3.6, true);
      const cant = AR.buildCantProfile(t.length, raw);
      for (let s = 30; s < t.length - 30; s += 1) {
        const pose = AR.poseConsist(t, s, 1, cant);
        for (let i = 1; i < pose.modules.length; i++) {
          worstRoll = Math.max(worstRoll, Math.abs(pose.modules[i].roll - pose.modules[i - 1].roll));
          worstPitch = Math.max(worstPitch, Math.abs(pose.modules[i].pitch - pose.modules[i - 1].pitch));
        }
      }
      for (let s = 0; s < t.length; s += 5) maxGrade = Math.max(maxGrade, Math.abs(t.sample(s).grade));
    }
    const deg = 180 / Math.PI;
    assert('s. adjacent-module roll difference < 1.5° (cant run-off, no flip at inflections)', worstRoll * deg < 1.5, `max=${(worstRoll * deg).toFixed(2)}°`);
    assert('s. adjacent-module pitch kink < 1.5° (no ±5 % sawtooth)', worstPitch * deg < 1.5, `max=${(worstPitch * deg).toFixed(2)}°`);
    assert('s. design grade ≤ 5 %', maxGrade <= 0.05 + 1e-9, `max=${(maxGrade * 100).toFixed(2)} %`);
    const f = AR.buildCantProfile(200, (s) => (s < 100 ? 0.1 : -0.1));
    let g = 0;
    for (let s = 1; s < 200; s++) g = Math.max(g, Math.abs(f(s) - f(s - 1)));
    assert('s. reverse-curve cant ramps at ≤ 1:400', g <= AR.MAX_CANT_GRADIENT + 1e-9, `max gradient=${g.toFixed(5)} m/m`);
  }

  // --- t. P1c: diesel cab eye is in the cab window, not inside the loco body -------------
  {
    const { mod: V, cleanup: cV } = await bundleEntry(path.join(root, 'src/game/Vehicles.ts'), 'Vehicles141');
    const THREE = await import('three');
    const loco = V.createDieselConsist('wcr');
    loco.updateMatrixWorld(true);
    const eye = new THREE.Vector3(V.DIESEL_CAB_EYE.x, V.DIESEL_CAB_EYE.y, V.DIESEL_CAB_EYE.z);
    const solid = ['longHood', 'shortHood', 'frame', 'coach'];
    const inside = solid.filter((n) => new THREE.Box3().setFromObject(loco.getObjectByName(n)).containsPoint(eye));
    assert('t. diesel cab eye not inside any solid body volume', inside.length === 0, inside.join(',') || 'clear');
    const cabBox = new THREE.Box3().setFromObject(loco.getObjectByName('cab'));
    assert('t. diesel cab eye inside the (hollow) cab', cabBox.containsPoint(eye));
    // forward view: ray from the eye along +z hits only cab glass/front, nothing solid ahead
    const ray = new THREE.Raycaster(eye, new THREE.Vector3(0, 0, 1), 0, 200);
    const hits = ray.intersectObjects(solid.map((n) => loco.getObjectByName(n)), true);
    assert('t. diesel forward view not blocked by hood/body', hits.length === 0, hits.map((h) => h.object.name).join(',') || 'clear');
    const shortTop = new THREE.Box3().setFromObject(loco.getObjectByName('shortHood')).max.y;
    assert('t. eye above the short hood', eye.y > shortTop + 0.3, `eye ${eye.y} hood ${shortTop}`);
    await cV();
  }

  // --- u. P2: key presses are queued, none lost at low frame rate -----------------------
  {
    const listeners = {};
    const fakeDoc = {
      addEventListener: (t, fn) => { (listeners[t] ||= []).push(fn); },
      pointerLockElement: null,
    };
    const prevDoc = globalThis.document;
    globalThis.document = fakeDoc;
    const { mod: IN, cleanup: cIN } = await bundleEntry(path.join(root, 'src/game/Input.ts'), 'Input141');
    const canvas = { addEventListener() {}, tabIndex: 0, focus() {}, requestPointerLock() {} };
    const inp = new IN.Input(canvas);
    const fire = (type, code) => listeners[type].forEach((fn) => fn({ code, repeat: false, preventDefault() {} }));
    // 7 W presses inside one ~200 ms frame (5 fps)
    for (let i = 0; i < 7; i++) { fire('keydown', 'KeyW'); fire('keyup', 'KeyW'); }
    fire('keydown', 'KeyW'); // held…
    listeners.keydown.forEach((fn) => fn({ code: 'KeyW', repeat: true, preventDefault() {} })); // auto-repeat ignored
    const q = inp.drainEdges();
    assert('u. 8 real W presses in one frame → 8 edges (auto-repeat ignored)', q.length === 8 && q.every((c) => c === 'KeyW'), `${q.length}`);
    assert('u. queue drained', inp.drainEdges().length === 0);
    globalThis.document = prevDoc;
    await cIN();
  }

  // --- v. Roads: terrain/ribbon never above draped roads; roads below the rail head -----
  {
    const { mod: GM, cleanup: cGM } = await bundleEntry(path.join(root, 'src/game/Ground.ts'), 'Ground141');
    const dem = {
      heightAtLocal: (x, z) => 3 * Math.sin(x * 0.045) * Math.cos(z * 0.031) + 0.8 * Math.sin(x * 0.21 + z * 0.17),
    };
    const g = new GM.GroundModel(dem);
    // street-running line along z, road crossing it diagonally + a road beside it
    const t = new Track141('ION street');
    const pts = [];
    for (let z = 0; z <= 400; z += 5) pts.push({ lon: 0, lat: 0, x: 0, y: dem.heightAtLocal(0, z) + 0.35, z, s: 0, grade: 0, curvature: 0 });
    t.points = pts; t.recomputeChainage(); t.smoothVertical(); t.recomputeDerivatives();
    g.addTrack(t, { isStreet: () => true });
    const roads = [
      { coords: [[-150, 40], [150, 360]], width: 14 },
      { coords: [[2.5, 0], [2.5, 400]], width: 9 }, // street road over the track (like King St)
      { coords: [[-200, 200], [-40, 120], [60, 300]], width: 10 },
    ];
    g.setRoads(roads);
    let worstMesh = -Infinity, n = 0;
    for (const r of roads) {
      for (let i = 0; i + 1 < r.coords.length; i++) {
        const [ax, az] = r.coords[i], [bx, bz] = r.coords[i + 1];
        const L = Math.hypot(bx - ax, bz - az), ux = (bx - ax) / L, uz = (bz - az) / L;
        for (let a = 0; a <= L; a += 0.7) {
          for (let o = -r.width / 2; o <= r.width / 2; o += 0.6) {
            const x = ax + ux * a - uz * o, z = az + uz * a + ux * o;
            const road = g.roadHeight(x, z);
            if (g.flatZoneLevel(x, z) !== null) continue; // pavement zone checked below
            worstMesh = Math.max(worstMesh, g.surfaceHeight(x, z) - road);
            n++;
          }
        }
      }
    }
    assert('v. terrain mesh never above a draped road (incl. between road vertices)', worstMesh < -0.03, `max=${worstMesh.toFixed(3)} m over ${n} pts`);
    // road on the street-running flat zone stays below the rail head (rails visible)
    let worstRail = -Infinity;
    for (let z = 10; z < 390; z += 1.3) {
      for (const o of [-0.75, 0.75]) {
        const p = t.sampleRaw(z);
        worstRail = Math.max(worstRail, g.roadHeight(p.x + o, p.z) - (p.y + 0.09));
      }
    }
    assert('v. road surface ≥ 5 cm below the rail head in street running', worstRail <= -0.05, `max=${worstRail.toFixed(3)} m`);
    await cGM();
  }

  // --- w. Double track: NB shares the SB formation where the lines run side by side -----
  {
    const nb2 = await buildRoute('ion-nb.geojson');
    nb2.blendHeightsToward(ionSb);
    let worst = 0, cnt = 0, kink = 0;
    for (let s = 0; s < nb2.length; s += 10) {
      const p = nb2.sampleRaw(s);
      const q = ionSb.sampleRaw(ionSb.nearestSLocal(p.x, p.z));
      if (Math.hypot(q.x - p.x, q.z - p.z) < 5) { worst = Math.max(worst, Math.abs(p.y - q.y)); cnt++; }
    }
    for (let s = 30; s < nb2.length - 30; s += 2) {
      const pose = AR.poseConsist(nb2, s, 1);
      for (let i = 1; i < pose.modules.length; i++) kink = Math.max(kink, Math.abs(pose.modules[i].pitch - pose.modules[i - 1].pitch));
    }
    assert('w. NB rail height = SB rail height on shared double track (< 0.25 m)', worst < 0.25, `max Δ=${worst.toFixed(3)} m over ${cnt} pts`);
    assert('w. blended NB still has no pitch kinks (< 1.5°)', kink * 180 / Math.PI < 1.5, `max=${(kink * 180 / Math.PI).toFixed(2)}°`);
  }

  await cT141(); await cE141(); await cPL(); await cAR();

  // ===== v1.4.2: end-to-end drive simulations + regressions (scripts/stress-drive.mjs) ======
  {
    const { driveTests } = await import('./stress-drive.mjs');
    await driveTests(assert);
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  if (failed.length) {
    console.error('FAILED:', failed.map((f) => f.name).join(', '));
    process.exit(1);
  }
  console.log('All stress tests passed.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
