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

  await cleanup();

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
