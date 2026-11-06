/**
 * Physics benchmark used for the v1.4.4 → v1.4.5 before/after numbers (Code Critic review).
 * Level track, Flexity at the sim's typical mass, dt = 0.02 s (≈ 50 fps, below the game's 0.05 s cap).
 * Usage: node scripts/measure-physics.mjs [label]  → prints a table + JSON on the last line.
 * Works on any version of Physics.ts that has TrainPhysics.step (uses only the public fields).
 */
import { bundleGame } from './drive-sim.mjs';
import { pathToFileURL } from 'node:url';

const DT = 0.02;
const B = await bundleGame();
const M = B.M;
const mk = (weather, leaf = false, extra = {}) => {
  const p = new M.TrainPhysics({ massKg: M.MASS_FLEXITY_KG, weather, electric: true });
  p.reverser = 1; p.leafFall = leaf; Object.assign(p, extra);
  return p;
};
const KMH = 3.6;

/** Full-power acceleration from rest on the level (dry). */
function accel() {
  const p = mk('dry'); p.powerNotch = 8;
  let t = 0, s = 0, last = 0, aPeak = 0, aSum = 0, aN = 0; const out = {};
  let prevA = 0, jerkMax = 0, t1 = 0;
  while (t < 120 && !(out.t70 && out.t50)) {
    const v0 = p.speed; p.step(DT, 0, 0); t += DT; s += (v0 + p.speed) / 2 * DT;
    const a = (p.speed - v0) / DT; if (t <= 1) { jerkMax = Math.max(jerkMax, Math.abs(a - prevA) / DT); } prevA = a;
    if (t <= 3) { aSum += a; aN++; aPeak = Math.max(aPeak, a); }
    if (!out.t50 && p.speed * KMH >= 50) { out.t50 = t; out.s50 = s; }
    if (!out.t70 && p.speed * KMH >= 70) { out.t70 = t; out.s70 = s; }
  }
  return { a0_3s: aSum / aN, aPeak, t50: out.t50, t70: out.t70, s50: out.s50, s70: out.s70, jerkFirst1s: jerkMax };
}

/** Stop from 70 km/h on the level. kind = 'service' (B8) or 'emergency'. Brake applied at t = 0. */
function stop(weather, leaf, kind) {
  const p = mk(weather, leaf); p.speed = 70 / KMH; p.brakeNotch = 8;
  if (kind === 'emergency') p.emergencyBrake = true;
  let t = 0, s = 0, aMax = 0, jerkMax = 0, a60 = [];
  const vc = p.speed; const bn = p.brakeNotch, em = p.emergencyBrake; p.brakeNotch = 0; p.emergencyBrake = false; p.step(DT, 0, 0);
  let prevA = (p.speed - vc) / DT; p.brakeNotch = bn; p.emergencyBrake = em; // coasting acceleration just before the brake is applied
  let stopSnap = 0;
  while (t < 90 && p.speed > 0) {
    const v0 = p.speed; p.step(DT, 0, 0); t += DT; s += (v0 + p.speed) / 2 * DT;
    const a = (p.speed - v0) / DT; // negative
    jerkMax = Math.max(jerkMax, Math.abs(a - prevA) / DT); prevA = a;
    aMax = Math.max(aMax, -a);
    if (v0 * KMH > 20 && p.speed * KMH <= 20 + 1e-9) {}
    if (v0 * KMH <= 60 && v0 * KMH >= 20) a60.push(-a);
    if (p.speed === 0) stopSnap = -a;
  }
  const meanDec = a60.length ? a60.reduce((x, y) => x + y, 0) / a60.length : 0;
  return { dist: s, time: t, aMax, meanDec60to20: meanDec, maxJerk: jerkMax, finalStepDecel: stopSnap };
}

/** Steepest grade from which a standing, loaded car (full power) starts and reaches 5 km/h within 30 s. */
function hillStart(weather, leaf, sand = true) {
  let lo = 0, hi = 0.2;
  for (let k = 0; k < 20; k++) {
    const g = (lo + hi) / 2; const p = mk(weather, leaf, sand ? {} : { autoSand: false }); p.powerNotch = 8; p.holdBrake = true;
    let ok = false; for (let t = 0; t < 30; t += DT) { p.step(DT, g, 0); if (p.speed * KMH >= 5) { ok = true; break; } }
    if (ok) lo = g; else hi = g;
  }
  return lo;
}

/** Signal-hold style step: brake notch 0 → 6 at 70 km/h; report the largest decel step per frame. */
/** Stop from 70 km/h on a constant grade; report max |Δa|/dt (the Code Critic metric). */
function stopOnGrade(grade, kind, dt = DT) {
  const p = mk('dry'); p.speed = 70 / KMH; p.brakeNotch = 8;
  if (kind === 'emergency') p.emergencyBrake = true;
  let t = 0, s = 0, prevA = null, jerkMax = 0;
  while (t < 120 && Math.abs(p.speed) > 1e-6) {
    const v0 = p.speed; const r = p.step(dt, grade, 0); t += dt; s += (v0 + p.speed) / 2 * dt;
    if (prevA !== null) jerkMax = Math.max(jerkMax, Math.abs(r.a - prevA) / dt);
    prevA = r.a;
  }
  return { dist: s, time: t, maxJerk: jerkMax };
}

function notchStep() {
  const p = mk('dry'); p.speed = 70 / KMH; p.brakeNotch = 0; let vp = p.speed; p.step(DT, 0, 0);
  let prev = (p.speed - vp) / DT; vp = p.speed;
  p.brakeNotch = 6; let worst = 0, t = 0;
  for (let i = 0; i < 100; i++) { p.step(DT, 0, 0); const a = (p.speed - vp) / DT; worst = Math.max(worst, Math.abs(a - prev) / DT); prev = a; vp = p.speed; t += DT; }
  return { maxJerk: worst };
}

export function measure() {
  const grades = [0, 0.01, 0.045, -0.01, -0.045];
  const gradeJerk = {};
  for (const g of grades) {
    const key = (g === 0 ? 'flat' : (g > 0 ? `up${(g * 100).toFixed(1)}` : `down${(-g * 100).toFixed(1)}`)).replace('.', 'p');
    gradeJerk[key] = {
      svc: stopOnGrade(g, 'service'),
      em: stopOnGrade(g, 'emergency'),
      svcDt01: stopOnGrade(g, 'service', 0.01),
      emDt05: stopOnGrade(g, 'emergency', 0.05),
    };
  }
  const r = { accel: accel(), svcDry: stop('dry', false, 'service'), emDry: stop('dry', false, 'emergency'),
    svcLeaf: stop('dry', true, 'service'), emLeaf: stop('dry', true, 'emergency'),
    svcRain: stop('rain', false, 'service'), emRain: stop('rain', false, 'emergency'),
    notch6: notchStep(),
    hill: { dry: hillStart('dry', false), rain: hillStart('rain', false), snow: hillStart('snow', false), leaf: hillStart('dry', true) },
    hillNoSand: { dry: hillStart('dry', false, false), rain: hillStart('rain', false, false), snow: hillStart('snow', false, false), leaf: hillStart('dry', true, false) },
    gradeJerk };
  return r;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const r = measure(); const f = (x, d = 2) => (x == null ? '—' : x.toFixed(d));
  console.log(`label: ${process.argv[2] ?? ''}`);
  console.log(`start accel (mean 0–3 s) ${f(r.accel.a0_3s)} m/s², peak ${f(r.accel.aPeak)}, 0–50 km/h ${f(r.accel.t50, 1)} s / ${f(r.accel.s50, 0)} m, 0–70 km/h ${f(r.accel.t70, 1)} s / ${f(r.accel.s70, 0)} m, max jerk in first 1 s ${f(r.accel.jerkFirst1s)} m/s³`);
  for (const k of ['svcDry', 'emDry', 'svcLeaf', 'emLeaf', 'svcRain', 'emRain']) {
    const x = r[k]; console.log(`${k}: stop from 70 km/h ${f(x.dist, 1)} m in ${f(x.time, 1)} s, mean decel 60→20 km/h ${f(x.meanDec60to20)}, peak decel ${f(x.aMax)}, max jerk ${f(x.maxJerk)} m/s³, last-step decel ${f(x.finalStepDecel)} m/s²`);
  }
  console.log(`notch 0→6 at 70 km/h: max jerk ${f(r.notch6.maxJerk)} m/s³`);
  console.log(`max hill start (reach 5 km/h in 30 s, full power, auto sand): dry ${f(r.hill.dry * 100)} %, rain ${f(r.hill.rain * 100)} %, snow ${f(r.hill.snow * 100)} %, leaf ${f(r.hill.leaf * 100)} %`);
  console.log(`max hill start, sanding disabled: dry ${f(r.hillNoSand.dry * 100)} %, rain ${f(r.hillNoSand.rain * 100)} %, snow ${f(r.hillNoSand.snow * 100)} %, leaf ${f(r.hillNoSand.leaf * 100)} %`);
  console.log('grade jerk (max |da/dt| m/s³; service limit 1.2, emergency 5.0):');
  for (const [k, v] of Object.entries(r.gradeJerk)) {
    console.log(`  ${k}: svc ${f(v.svc.maxJerk)} (${f(v.svc.dist, 1)} m), em ${f(v.em.maxJerk)} (${f(v.em.dist, 1)} m), svc@dt0.01 ${f(v.svcDt01.maxJerk)}, em@dt0.05 ${f(v.emDt05.maxJerk)}`);
  }
  console.log('JSON ' + JSON.stringify(r));
  await B.cleanup();
}
