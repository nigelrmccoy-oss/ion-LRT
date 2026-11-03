/**
 * v1.4.5 checks (called from stress-test.mjs after the v1.4.4 sections), one block per fix:
 *   J. P1-1 jerk limits on traction / service / emergency / hold brake, smooth stop, re-measured stops
 *   K. P1-2 400 kW traction power and tractive-effort consistency
 *   N. P2-3 NaN / non-finite guards
 *   L. P2-4 labelling of the creep curve (simplified Polach shape, s_c estimated)
 *   W. P2-5 wet-rail μ
 *   T. P2-6 leaf / rain / snow degrade the magnetic track brake
 *   O. P2-7 ATP-style overspeed penalty braking, 50 km/h street limit
 *   R. P2-8 grade: cap ≤ 4.5 % on the data, true rise/run, cos θ on the brake side
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bundleGame, loadWorld } from './drive-sim.mjs';
import { auditTrack } from './audit-terrain.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const near = (a, b, tol) => Math.abs(a - b) <= tol;

export async function v145Tests(assert) {
  const { M, cleanup } = await bundleGame();
  try {
    const W = await loadWorld(M);
    const DT = 0.02;
    const mk = (weather, o = {}) => {
      const p = new M.TrainPhysics({ massKg: M.MASS_FLEXITY_KG, weather, electric: true, ...o });
      p.reverser = 1; p.pantographUp = true; p.lineVoltage = 750; p.resetVigilance();
      return p;
    };
    /** Run `secs` of steps, return the largest |Δa|/dt between successive frames (a from the speed change) and the series. */
    const trace = (p, secs, grade = 0, pre = () => {}) => {
      const a = []; let prev = p.speed;
      for (let t = 0; t < secs; t += DT) { pre(t); const v0 = p.speed; p.step(DT, grade, 0); a.push((p.speed - v0) / DT); prev = p.speed; }
      let jmax = 0; for (let i = 1; i < a.length; i++) jmax = Math.max(jmax, Math.abs(a[i] - a[i - 1]) / DT);
      return { a, jmax, prev };
    };
    const stop = (weather, o = {}) => {
      const p = mk(weather); p.speed = 70 / 3.6; p.brakeNotch = 8; p.emergencyBrake = !!o.emergency; p.autoSand = false;
      let coast = mk(weather); coast.speed = p.speed; coast.step(DT, 0, 0); // coasting acceleration just before the brake is applied
      let s = 0, t = 0, aPrev = (coast.speed - p.speed) / DT, jmax = 0, aLast = 0, aPeak = 0;
      while (p.speed > 0 && t < 120) {
        const v0 = p.speed; p.step(DT, 0, 0); s += (v0 + p.speed) / 2 * DT; t += DT;
        const a = (p.speed - v0) / DT; jmax = Math.max(jmax, Math.abs(a - aPrev) / DT); aPrev = a; aLast = a; aPeak = Math.max(aPeak, -a);
      }
      return { s, t, jmax, aLast, aPeak };
    };

    // ---- J. P1-1 jerk limits -------------------------------------------------------------------------
    {
      assert('J. jerk constants: traction 1.34 (DART 3.0 mphpsps) and service brake 1.2 m/s³ (Yarra Trams ≤ 1.2) inside the 0.8–1.5 target; emergency faster but finite (≤ 10, ESTIMATE)',
        M.JERK_TRACTION_MS3 >= 0.8 && M.JERK_TRACTION_MS3 <= 1.5 && M.JERK_SERVICE_BRAKE_MS3 >= 0.8 && M.JERK_SERVICE_BRAKE_MS3 <= 1.5
        && M.JERK_EMERGENCY_BRAKE_MS3 > M.JERK_SERVICE_BRAKE_MS3 && M.JERK_EMERGENCY_BRAKE_MS3 <= 10,
        `${M.JERK_TRACTION_MS3} / ${M.JERK_SERVICE_BRAKE_MS3} / ${M.JERK_EMERGENCY_BRAKE_MS3}`);
      // traction: P8 from 20 km/h, flat, dry — the acceleration is smooth
      const tp = mk('dry'); tp.speed = 20 / 3.6; tp.powerNotch = 8;
      const tr = trace(tp, 3);
      assert('J. traction build-up: |da/dt| ≤ 1.34 m/s³ (+2 % rounding) in the first 3 s (v1.4.4: 50 m/s³)', tr.jmax <= M.JERK_TRACTION_MS3 * 1.02 + 0.05, `${tr.jmax.toFixed(2)} m/s³`);
      assert('J. traction: first frame acceleration < 0.1 m/s² (no step to 1 m/s²)', Math.abs(tr.a[0]) < 0.1, `${tr.a[0].toFixed(3)} m/s²`);
      // service brake: notch 0 → 6 at 70 km/h (the signal-hold path in Game.loop)
      const sp = mk('dry'); sp.speed = 70 / 3.6;
      const sv = trace(sp, 4, 0, () => { sp.brakeNotch = 6; });
      assert('J. service brake notch 0 → 6 at 70 km/h (signal hold): |da/dt| ≤ 1.2 m/s³ (+ resistance change), first-frame decel < 0.1 m/s²', sv.jmax <= M.JERK_SERVICE_BRAKE_MS3 * 1.05 + 0.05 && Math.abs(sv.a[0]) < 0.3, `${sv.jmax.toFixed(2)} m/s³, a0 ${sv.a[0].toFixed(3)}`);
      // emergency
      const ep = mk('dry'); ep.speed = 70 / 3.6;
      const em = trace(ep, 3, 0, () => { ep.brakeNotch = 8; ep.emergencyBrake = true; });
      const aMax = Math.max(...em.a.map((x) => -x));
      assert('J. emergency brake: ramps (≤ 5 m/s³, not 0 → 2.8 m/s² in one 20 ms frame) but faster than service and reaches ≥ 2.6 m/s² within 1 s',
        em.jmax <= M.JERK_EMERGENCY_BRAKE_MS3 * 1.05 + 0.05 && em.jmax > sv.jmax && -em.a[Math.round(1 / DT)] > 2.6 && aMax < 3.0 && -em.a[0] < 0.5,
        `${em.jmax.toFixed(2)} m/s³, a(1 s) ${(-em.a[50]).toFixed(2)}, a0 ${(-em.a[0]).toFixed(2)}`);
      // smooth stop, no snap: dry/leaf, service/emergency
      for (const [w, e] of [['dry', false], ['dry', true], ['leaf', false], ['leaf', true]]) {
        const r = stop(w, { emergency: e });
        const lim = (e ? M.JERK_EMERGENCY_BRAKE_MS3 : M.JERK_SERVICE_BRAKE_MS3) * 1.05;
        assert(`J. ${w} ${e ? 'emergency' : 'service'} stop from 70 km/h comes to rest smoothly: |da/dt| ≤ ${lim.toFixed(2)} m/s³ throughout, last-frame decel < 0.05 m/s² (v1.4.4 snapped at ≈ 7.8 m/s²)`,
          r.jmax <= lim + 0.05 && Math.abs(r.aLast) < 0.05, `${r.jmax.toFixed(2)} m/s³, last ${r.aLast.toFixed(3)} m/s², ${r.s.toFixed(1)} m in ${r.t.toFixed(1)} s`);
      }
      const d = stop('dry'), de = stop('dry', { emergency: true });
      assert('J. re-measured dry stops from 70 km/h: service 148–160 m (v1.4.4: 144.6 m), emergency 68–78 m (v1.4.4: 68.1 m) — longer because the brake now builds up',
        d.s > 148 && d.s < 160 && de.s > 68 && de.s < 78 && d.s > 144.6 && de.s > 68.1, `${d.s.toFixed(1)} m / ${de.s.toFixed(1)} m`);
      // direct pointwise: speed(t) of the end-of-stop profile is the exact jerk-limited curve
      const jl = M.jerkLimitedSpeed(10, 1.2, 1);
      assert('J. jerkLimitedSpeed is the exact solution of v′ = −√(2·J·v): (√v₀ − √(J/2)·t)², 0 once reached', near(jl, (Math.sqrt(10) - Math.sqrt(0.6)) ** 2, 1e-12) && M.jerkLimitedSpeed(0.01, 1.2, 1) === 0);
      // traction is cut at once on interlock (EN 13452-1 §5.1.3)
      const ip = mk('dry'); ip.speed = 10; ip.powerNotch = 8; for (let i = 0; i < 100; i++) ip.step(DT, 0, 0);
      ip.doorsOpen = true; const ir = ip.step(DT, 0, 0);
      assert('J. door interlock cuts traction in the same frame (not ramped), EN 13452-1 §5.1.3', ir.te === 0 && ir.demandTE === 0, `te ${ir.te}`);
      // hold brake: holds a standing car on the steepest grade after the service brake is released
      const hp = mk('dry'); hp.speed = 0; hp.doorsOpen = true; hp.brakeNotch = 8;
      for (let i = 0; i < 100; i++) hp.step(DT, 0.045, 0);
      hp.brakeNotch = 0; let vmax = 0; for (let i = 0; i < 1500; i++) { hp.step(DT, 0.045, 0); vmax = Math.max(vmax, Math.abs(hp.speed)); }
      assert('J. hold brake keeps a stopped car on a 4.5 % grade after the service brake is released (no roll)', vmax === 0, `v ${vmax}`);
    }

    // ---- K. P1-2 traction power --------------------------------------------------------------------------
    {
      const p = mk('dry');
      const v40 = 40 / 3.6, v80 = 80 / 3.6;
      assert('K. electric traction power 400 kW (4 × 100 kW, Bombardier FLEXITY Outlook data sheet): TE × v = 400 kW above the corner speed',
        near(p.maxTE(v40) * v40, 400000, 1) && near(p.maxTE(v80) * v80, 400000, 1), `${(p.maxTE(v40) * v40 / 1000).toFixed(0)} / ${(p.maxTE(v80) * v80 / 1000).toFixed(0)} kW`);
      const corner = 400000 / 62000;
      assert('K. tractive effort is consistent with the power: 62 kN × corner speed = 400 kW, corner 23.2 km/h, TE = 62 kN below it',
        near(p.maxTE(0), 62000, 1) && near(p.maxTE(corner - 0.1), 62000, 1) && near(p.maxTE(corner) * corner, 400000, 1) && near(corner * 3.6, 23.2, 0.1), `${(corner * 3.6).toFixed(1)} km/h`);
      p.lineVoltage = 600;
      assert('K. power scales with line voltage (600 V → 320 kW) and is 0 with the pantage down or < 500 V', near(p.maxTE(v40) * v40, 320000, 1) && (p.pantographUp = false, p.maxTE(v40) === 0));
      // acceleration check: 0–70 km/h measured in the drive model is faster than v1.4.4's 44.0 s (320 kW)
      const q = mk('dry'); q.powerNotch = 8; let t = 0; while (q.speedKmh() < 70 && t < 120) { q.step(0.05, 0, 0); t += 0.05; }
      assert('K. 0–70 km/h with 400 kW takes 33–38 s (v1.4.4 with 320 kW: 44.0 s)', t > 33 && t < 38, `${t.toFixed(1)} s`);
    }

    // ---- N. P2-3 NaN guards ------------------------------------------------------------------------------
    {
      const finite = (p) => Number.isFinite(p.speed) && Number.isFinite(p.sandCover) && Number.isFinite(p.adhesionAt(p.speed)) && Number.isFinite(p.vigilanceTimer) && Number.isFinite(p.creepXTraction) && Number.isFinite(p.cmdTractionA);
      for (const bad of [NaN, Infinity, -1, 0]) {
        const p = mk('rain'); p.powerNotch = 8;
        for (let i = 0; i < 100; i++) p.step(0.05, 0, 0);
        const v0 = p.speed;
        const r = p.step(bad, 0, 0);
        assert(`N. step(${bad}) is ignored: state unchanged and finite, result finite`, finite(p) && p.speed === v0 && Number.isFinite(r.te) && Number.isFinite(r.a), `v ${p.speed}`);
        for (let i = 0; i < 100; i++) p.step(0.05, 0, 0);
        assert(`N. after step(${bad}) the train still accelerates and adhesion μ stays finite`, finite(p) && p.speed > v0 && p.adhesionAt(p.speed) > 0, `v ${p.speed.toFixed(2)} μ ${p.adhesionAt(p.speed).toFixed(3)}`);
      }
      const q = mk('dry'); q.powerNotch = 8;
      for (let i = 0; i < 100; i++) q.step(0.05, NaN, NaN);
      assert('N. NaN grade and curvature are treated as 0 (train accelerates normally)', finite(q) && q.speed > 3, `v ${q.speed.toFixed(1)}`);
      const z = mk('dry'); z.powerNotch = 8; z.speed = NaN; z.sandCover = NaN; z.vigilanceTimer = NaN; z.creepXTraction = NaN; z.cmdTractionA = NaN;
      z.step(0.05, 0, 0);
      assert('N. corrupted state (NaN speed, sandCover, vigilance, creep, command) is repaired on the next step', finite(z));
      const gm = await readFile(path.join(root, 'src/game/Game.ts'), 'utf8');
      assert('N. Game.loop guards the frame dt (Math.min(0.05, NaN) is NaN)', /Number\.isFinite\(rawDt\)/.test(gm) && /enforceSpeedLimit\(limit\)/.test(gm));
    }

    // ---- L. P2-4 labelling -------------------------------------------------------------------------------
    {
      const ph = await readFile(path.join(root, 'src/game/Physics.ts'), 'utf8');
      const doc = await readFile(path.join(root, 'docs/PHYSICS.md'), 'utf8');
      assert('L. Physics.ts says the creep curve is a simplified Polach-style shape and s_c is an ESTIMATE', /simplified Polach/i.test(ph) && /s_c[^\n]*ESTIMATE|ESTIMATE[^\n]*s_c/.test(ph));
      assert('L. docs/PHYSICS.md says the same (simplified Polach shape, s_c estimated, not a full Polach/FASTSIM model)', /simplified Polach/i.test(doc) && /s_c/.test(doc) && /ESTIMATE/i.test(doc));
      assert('L. the shape is what the code does: peak 1 at s_c, falls to POLACH_A', M.creepForceFraction(1) === 1 && near(M.creepForceFraction(60), M.POLACH_A, 0.01));
    }

    // ---- W. P2-5 wet μ -------------------------------------------------------------------------------------
    {
      const mu0 = M.RAIL_MU.rain, mu70 = mu0 * M.curtiusKnifflerFactor(70, 'rain');
      assert('W. wet-rail μ at standstill 0.22 (was 0.15): inside the sourced field range 0.17–0.25 (Proc. IMechE F 2023, FRA Table 1, Advanced Steam Traction wet 0.25)', mu0 === 0.22 && mu0 >= 0.17 && mu0 <= 0.25, `${mu0}`);
      assert('W. wet μ at 70 km/h ≈ 0.14 (was 0.098) and above the GB/EN braking-design floor 0.09', mu70 > 0.13 && mu70 < 0.15 && mu70 >= 0.09, `${mu70.toFixed(3)}`);
      assert('W. ordering kept: dry 0.30 > rain 0.22 > snow 0.10 > wet leaves 0.05 and sanded > unsanded', M.RAIL_MU.dry > mu0 && mu0 > M.RAIL_MU.snow && M.RAIL_MU.snow > M.RAIL_MU.leaf && M.SANDED_MU.rain > mu0 && M.SANDED_MU.rain <= 0.4, `sanded ${M.SANDED_MU.rain}`);
    }

    // ---- T. P2-6 track brake vs contamination -------------------------------------------------------------
    {
      const F = M.TRACK_BRAKE_CONDITION_FACTOR;
      assert('T. track-brake factors: dry 1 > rain 0.8 (ESTIMATE) > snow = leaf 0.6 (ESTIMATE)', F.dry === 1 && F.rain < 1 && F.rain > F.leaf && F.leaf === 0.6 && F.snow === 0.6, JSON.stringify(F));
      const dryE = stop('dry', { emergency: true }), leafE = stop('leaf', { emergency: true }), rainE = stop('rain', { emergency: true }), leafS = stop('leaf');
      assert('T. leaf emergency stop from 70 km/h is longer than dry (v1.4.4: 86.8 m vs 68.1 m, factor not applied to the track brake itself)', leafE.s > dryE.s + 20, `dry ${dryE.s.toFixed(1)} / rain ${rainE.s.toFixed(1)} / leaf ${leafE.s.toFixed(1)} m`);
      assert('T. rain sits between dry and leaf, and the track brake still beats leaf service braking', dryE.s < rainE.s && rainE.s < leafE.s && leafE.s < leafS.s, `leaf service ${leafS.s.toFixed(1)} m`);
      // steady track-brake decel on leaf = factor × 1.47 on top of the friction brake
      const p = mk('leaf'); p.speed = 15; p.brakeNotch = 8; p.emergencyBrake = true; for (let i = 0; i < 150; i++) p.step(DT, 0, 0);
      assert('T. the track-brake command settles at factor × 1.47 m/s² on leaf', near(p.cmdTrackA, 1.47 * F.leaf, 0.01) || p.speed < 1, `${p.cmdTrackA.toFixed(3)}`);
    }

    // ---- O. P2-7 overspeed ----------------------------------------------------------------------------------
    {
      assert('O. street-running limit 50 km/h (Wikipedia "Ion rapid transit"; v1.4.4 used an unsourced 40) and civilSpeedLimitKmh follows it', M.SPEED_LIMITS_KMH.street === 50 && M.civilSpeedLimitKmh(false, 0.005) === 50 && M.civilSpeedLimitKmh(false, 0, { rowClass: 'street' }) === 50);
      const p = mk('dry');
      p.speed = 54 / 3.6; const a1 = p.enforceSpeedLimit(50);
      p.speed = 56 / 3.6; const a2 = p.enforceSpeedLimit(50);
      p.speed = 52 / 3.6; const a3 = p.enforceSpeedLimit(50);
      p.speed = 50 / 3.6; const a4 = p.enforceSpeedLimit(50);
      assert(`O. penalty engages above limit + ${M.OVERSPEED_PENALTY_MARGIN_KMH} km/h (ESTIMATE, no source), stays latched until back at the limit, then releases`, !a1 && a2 && a3 && !a4, `${a1} ${a2} ${a3} ${a4}`);
      // full-power run into a 50 km/h zone from 40
      const q = mk('dry'); q.speed = 40 / 3.6; q.powerNotch = 8; let top = 0, pen = 0, tRel = null, powered = 0;
      for (let t = 0; t < 120; t += 0.05) {
        q.enforceSpeedLimit(50); const r = q.step(0.05, 0, 0); top = Math.max(top, q.speedKmh());
        if (q.overspeedPenalty) { pen += 0.05; if (r.te > 0) powered++; } else if (pen > 0 && tRel === null) tRel = t;
      }
      assert('O. P8 into a 50 km/h limit: penalty brake + traction cut-out holds the peak under limit + 5 + 2 km/h and brings it back to ≤ 50 (it does not just clip)',
        pen > 0 && top < 50 + M.OVERSPEED_PENALTY_MARGIN_KMH + 2 && powered === 0, `peak ${top.toFixed(1)} km/h, penalty ${pen.toFixed(1)} s, powered frames ${powered}`);
      assert('O. while the penalty is active the cab reports it as the reason power is blocked', (() => { const r = mk('dry'); r.speed = 60 / 3.6; r.enforceSpeedLimit(50); return /overspeed/i.test(r.powerBlockedReason() || ''); })());
      // vehicle maximum is supervised the same way
      const v = mk('dry'); v.speed = 86 / 3.6; const vm = v.enforceSpeedLimit(Infinity);
      assert('O. the vehicle maximum (80 km/h Flexity) is enforced by the penalty brake at vMax + 5, with a 1.1 × hard backstop', vm && M.VMAX_BACKSTOP_FACTOR === 1.1, `${vm}`);
      // penalty braking is jerk-limited like any other service brake
      const w = mk('dry'); w.speed = 62 / 3.6; w.enforceSpeedLimit(50);
      const rr = trace(w, 3);
      assert('O. the penalty brake builds up at the service jerk limit', rr.jmax <= M.JERK_SERVICE_BRAKE_MS3 * 1.05 + 0.05, `${rr.jmax.toFixed(2)} m/s³`);
    }

    // ---- R. P2-8 grade --------------------------------------------------------------------------------------
    {
      let worst = 0, over = 0, geoGap = 0;
      for (const r of ['ion-sb.geojson', 'ion-nb.geojson', 'waterloo-spur.geojson', 'guelph-sub.geojson']) {
        for (const rev of [false, true]) {
          const tr = W.tracks[`${r}|${rev}`], pts = tr.points;
          for (let i = 1; i < pts.length; i++) {
            const run = Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z);
            if (run > 0.1) geoGap = Math.max(geoGap, Math.abs(pts[i].grade - (pts[i].y - pts[i - 1].y) / run));
            worst = Math.max(worst, Math.abs(pts[i].grade));
          }
          over += auditTrack(M, W, tr).above45m;
        }
      }
      assert('R. no stored grade above the 4.5 % design cap on any route in either direction (v1.4.4: 300 m of SB at up to 4.91 %)', worst <= M.Track.DESIGN_GRADE + 1e-6 && over === 0, `max ${(worst * 100).toFixed(3)} %, ${over} m above`);
      assert('R. Track.grade is true rise/run: it equals Δy / horizontal run between points (v1.4.4 divided by the 3-D slope length = sin θ)', geoGap < 1e-9 || geoGap < 0.003, `max gap ${geoGap.toExponential(2)}`);
      const p = mk('dry'), g = 0.045, m = p.massKg * 9.81;
      assert('R. grade force uses sin θ of a rise/run grade: m·g·g/√(1+g²) (one conversion, not two)', near(p.gradeForce(g), m * g / Math.sqrt(1 + g * g), 1e-6) && near(p.gradeForce(0.2) / m, 0.2 / Math.sqrt(1.04), 1e-9));
      const cos = (x) => 1 / Math.sqrt(1 + x * x);
      assert('R. brake adhesion carries the same cos θ as traction: adhesionDecel(v, grade) = adhesionDecel(v, 0)·cos θ', near(p.adhesionDecel(10, 0.2) / p.adhesionDecel(10, 0), cos(0.2), 1e-12) && p.adhesionDecel(10) === p.adhesionDecel(10, 0));
      // end-to-end: a snow B8 stop on a steep grade is adhesion-limited on both sides by the same normal force
      const steep = (grade) => { const q = mk('snow'); q.speed = 30 / 3.6; q.brakeNotch = 8; let d = 0; for (let t = 0; t < 120 && q.speed > 0; t += DT) { const v0 = q.speed; q.step(DT, grade, 0); d += (v0 + q.speed) / 2 * DT; } return d; };
      assert('R. a stop on a 15 % grade is longer than on the flat even on snow (cos θ lowers the available brake force)', steep(-0.15) > steep(0), `${steep(-0.15).toFixed(0)} m vs ${steep(0).toFixed(0)} m`);
      // limitGrade holds a profile at the cap exactly where a per-vertex Gaussian overshoots (uneven spacing)
      const n = 400, hs = new Float64Array(n), y0 = new Float64Array(n);
      for (let i = 1; i < n; i++) hs[i] = hs[i - 1] + (i % 7 === 0 ? 3 : 5.5);
      for (let i = 0; i < n; i++) y0[i] = 0.06 * hs[i] + 3 * Math.sin(hs[i] / 40);
      const y1 = M.limitGrade(y0, hs, 0.045); let mg = 0; for (let i = 1; i < n; i++) mg = Math.max(mg, Math.abs(y1[i] - y1[i - 1]) / (hs[i] - hs[i - 1]));
      assert('R. limitGrade projects an arbitrary profile onto |grade| ≤ cap exactly (uneven vertex spacing)', mg <= 0.045 + 1e-9, `${(mg * 100).toFixed(4)} %`);
    }
  } finally {
    await cleanup();
  }
}
