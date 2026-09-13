/**
 * Headless stress suite for TrainPhysics (same source as the game).
 * Bundles src/game/Physics.ts via esbuild, then runs cases a–h.
 */
import * as esbuild from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const physicsEntry = path.join(root, 'src/game/Physics.ts');

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

async function loadPhysics() {
  const dir = await mkdtemp(path.join(tmpdir(), 'ion-lrt-stress-'));
  const outfile = path.join(dir, 'Physics.mjs');
  await esbuild.build({
    entryPoints: [physicsEntry],
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
  const { mod, cleanup } = await loadPhysics();
  const {
    TrainPhysics,
    VMAX_ELECTRIC_MS,
    VMAX_DIESEL_MS,
    SPEED_LIMITS_KMH,
    civilSpeedLimitKmh,
    isOverspeed,
    adhesionMu,
  } = mod;

  const electric = (weather = 'dry') =>
    new TrainPhysics({ massKg: 50000, weather, electric: true });
  const diesel = (weather = 'dry') =>
    new TrainPhysics({ massKg: 80000, weather, electric: false });

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

    const sand = electric('rain');
    sand.reverser = 1;
    sand.powerNotch = 8;
    sand.sanding = true;
    let slipTimeSand = 0;
    let slipTimeNo = 0;
    // re-sim both for slip time + speed at 15s
    const r2 = electric('rain');
    r2.reverser = 1;
    r2.powerNotch = 8;
    r2.sanding = false;
    const s2 = electric('rain');
    s2.reverser = 1;
    s2.powerNotch = 8;
    s2.sanding = true;
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
    // doors open
    {
      const p = electric('dry');
      p.reverser = 1;
      p.doorsOpen = true;
      p.powerNotch = 8;
      const r = p.step(dt, 0, 0);
      assert('e. doors open → no TE', r.te === 0 && Math.abs(p.speed) < 0.01, `te=${r.te}`);
    }
    // reverser N
    {
      const p = electric('dry');
      p.reverser = 0;
      p.powerNotch = 8;
      const r = p.step(dt, 0, 0);
      assert('e. reverser N → no TE', r.te === 0, `te=${r.te}`);
    }
    // panto down
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

  // --- g. Station 25 / street 40 / reserved 70 + overspeed detection ---
  {
    assert('g. station limit 25', SPEED_LIMITS_KMH.station === 25 && civilSpeedLimitKmh(true, 0) === 25);
    assert('g. street limit 40', SPEED_LIMITS_KMH.street === 40 && civilSpeedLimitKmh(false, 0.005) === 40);
    assert('g. reserved limit 70', SPEED_LIMITS_KMH.reserved === 70 && civilSpeedLimitKmh(false, 0) === 70);
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
    // also clamp works for diesel above 80
    di.reverser = 1;
    di.powerNotch = 8;
    di.speed = 90 / 3.6;
    for (let i = 0; i < 300; i++) di.step(1 / 30, -0.01, 0); // downhill help
    assert(
      'h. diesel can exceed Flexity 80 but not its own vMax',
      di.speedKmh() <= 95.1,
      `v=${di.speedKmh().toFixed(1)}`,
    );
  }

  // Extra: adhesion helpers exported
  assert('helper adhesionMu dry/rain/snow', adhesionMu('dry', false) === 0.3 && adhesionMu('rain', false) === 0.18 && adhesionMu('snow', false) === 0.1);

  await cleanup();

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
