/**
 * v1.4.4 physics / terrain checks (called from stress-test.mjs after the v1.4.3 sections):
 *   A. adhesion vs speed / weather / sanding (Curtius–Kniffler shape, RAIL_MU, SANDED_MU)
 *   B. creep-force curve: peak at s_c, rising then falling, held below the peak by slip control
 *   C. slip recovery on a wet hill start (with and without slip control)
 *   D. brakes: service / emergency / track-brake rates and stopping distances, WSP
 *   E. resistance: Davis 1926 eq. 15 cross-check, rotating mass, curve resistance magnitude
 *   F. curves: TCRP lateral-acceleration limits, minimum radius
 *   G. terrain: grade profile sanity on every route and direction
 */
import { bundleGame, loadWorld } from './drive-sim.mjs';
import { auditTrack, fwdRevDelta, gradeConsistency } from './audit-terrain.mjs';

const G = 9.81;
const near = (a, b, tol) => Math.abs(a - b) <= tol;

export async function v144Tests(assert) {
  const { M, cleanup } = await bundleGame();
  try {
    const W = await loadWorld(M);
    const mk = (weather, o = {}) => {
      const p = new M.TrainPhysics({ massKg: M.MASS_FLEXITY_KG, weather, electric: true, ...o });
      p.reverser = 1; p.pantographUp = true; p.lineVoltage = 750; p.resetVigilance();
      return p;
    };
    const conds = ['dry', 'rain', 'snow', 'leaf'];

    // ---- A. adhesion --------------------------------------------------------------------------
    {
      const mu0 = conds.map((c) => M.adhesionMu(c, false));
      assert('A. μ(0): dry 0.30 > rain 0.15 > snow 0.10 > wet leaves 0.05', mu0[0] === 0.30 && mu0[1] === 0.15 && mu0[2] === 0.10 && mu0[3] === 0.05, mu0.join(' '));
      let mono = true;
      for (const c of conds) for (let v = 1; v <= 100; v++) if (M.curtiusKnifflerFactor(v, c) >= M.curtiusKnifflerFactor(v - 1, c)) mono = false;
      assert('A. Curtius–Kniffler factor falls monotonically with speed (all conditions), 1 at standstill', mono && M.curtiusKnifflerFactor(0, 'dry') === 1 && M.curtiusKnifflerFactor(0, 'rain') === 1);
      // C&K dry 7.5/(v+44)+0.161: 0.331 at 0, 0.2275 at 70 km/h, 0.2147 at 80 km/h (hand-computed)
      const ckDry70 = 0.30 * M.curtiusKnifflerFactor(70, 'dry'), ckWet80 = 0.15 * M.curtiusKnifflerFactor(80, 'rain');
      assert('A. dry μ at 70 km/h = 0.206 and wet μ at 80 km/h = 0.098 (≥ GB braking design minimum 0.09)',
        near(ckDry70, 0.30 * (7.5 / 114 + 0.161) / (7.5 / 44 + 0.161), 1e-9) && near(ckDry70, 0.206, 0.003) && ckWet80 >= 0.09 && near(ckWet80, 0.098, 0.004), `${ckDry70.toFixed(3)} / ${ckWet80.toFixed(3)}`);
      assert('A. sanding raises μ in every condition and stays inside the sanded laboratory ranges (wet ≤ 0.4, leaf ≤ 0.2, dry ≤ 0.5)',
        conds.every((c) => M.adhesionMu(c, true) > M.adhesionMu(c, false)) && M.adhesionMu('rain', true) <= 0.4 && M.adhesionMu('leaf', true) <= 0.2 && M.adhesionMu('dry', true) <= 0.5,
        conds.map((c) => `${c} ${M.adhesionMu(c, false)}→${M.adhesionMu(c, true)}`).join(', '));
      assert('A. partial sand cover interpolates (cover 0.5 = midpoint)', near(M.adhesionMu('rain', 0.5), (0.15 + M.SANDED_MU.rain) / 2, 1e-9));
      const p = mk('rain'); p.sanding = true; let t = 0;
      while (p.sandCover < 1 && t < 10) { p.step(0.05, 0, 0); t += 0.05; }
      const tUp = t; p.sanding = false; p.autoSand = false; t = 0;
      while (p.sandCover > 0 && t < 20) { p.step(0.05, 0, 0); t += 0.05; }
      assert('A. sand takes ≈ SAND_RAMP_UP_S to take effect and ≈ SAND_FADE_S to fade', near(tUp, M.SAND_RAMP_UP_S, 0.15) && near(t, M.SAND_FADE_S, 0.2), `up ${tUp.toFixed(2)} s, fade ${t.toFixed(2)} s`);
      const lf = mk('rain'); lf.leafFall = true; const sn = mk('snow'); sn.leafFall = true;
      assert('A. leafFall gives the wet-leaf condition (μ 0.05) but never overrides snow', lf.railCondition() === 'leaf' && lf.baseMu() === 0.05 && sn.railCondition() === 'snow');
      const dry = mk('dry'), wet = mk('rain');
      assert('A. adhesionAt(v) ordering: dry > rain > snow at 40 km/h', dry.adhesionAt(40 / 3.6) > wet.adhesionAt(40 / 3.6) && wet.adhesionAt(40 / 3.6) > mk('snow').adhesionAt(40 / 3.6));
    }

    // ---- B. creep-force curve -------------------------------------------------------------------
    {
      let rise = true, fall = true;
      for (let x = 0.01; x <= 1; x += 0.01) if (M.creepForceFraction(x) < M.creepForceFraction(x - 0.01)) rise = false;
      for (let x = 1.01; x <= 12; x += 0.01) if (M.creepForceFraction(x) > M.creepForceFraction(x - 0.01)) fall = false;
      assert('B. creep curve: rises to a peak of exactly 1 at s = s_c, then falls', rise && fall && M.creepForceFraction(1) === 1 && M.creepForceFraction(0) === 0);
      assert('B. large-slip level tends to Polach\'s μ∞/μ0 = 0.40', near(M.creepForceFraction(60), M.POLACH_A, 0.01) && M.UNCONTROLLED_SLIP_FRAC === M.POLACH_A, M.creepForceFraction(60).toFixed(3));
      let inv = true; for (let r = 0.05; r <= 1; r += 0.05) if (!near(M.creepForceFraction(M.creepFromForceFraction(r)), r, 1e-9)) inv = false;
      assert('B. creepFromForceFraction inverts the rising branch', inv && M.creepFromForceFraction(1) === 1 && M.creepFromForceFraction(0) === 0);
      assert('B. critical creep grows as the rail gets slipperier (dry 1.5 % < wet < snow < leaf)', M.CRITICAL_CREEP.dry < M.CRITICAL_CREEP.rain && M.CRITICAL_CREEP.rain < M.CRITICAL_CREEP.snow && M.CRITICAL_CREEP.snow < M.CRITICAL_CREEP.leaf);
      // dry flat start, full power: slip control keeps creep on the rising branch, no slip
      const d = mk('dry'); d.powerNotch = 8; let maxX = 0, slip = false;
      for (let i = 0; i < 400; i++) { d.step(0.05, 0, 0); maxX = Math.max(maxX, d.creepXTraction); slip ||= d.wheelslip; }
      assert('B. dry flat start P8 with slip control: no slip, creep below the adhesion peak', !slip && maxX < 1, `max x=${maxX.toFixed(2)}, creep ${(d.creepTraction() * 100).toFixed(2)} %`);
      // wet hill: demand exceeds the peak; slip control holds x ≤ 1 (≈ 0.72 s_c at 95 % of peak)
      const tr = W.tracks['ion-sb.geojson|false'], gUp = tr.sample(9535).grade;
      const w = mk('rain'); w.powerNotch = 8; w.autoSand = false; maxX = 0; slip = false;
      for (let i = 0; i < 200; i++) { w.step(0.05, gUp, 0); maxX = Math.max(maxX, w.creepXTraction); slip ||= w.wheelslip; }
      assert('B. wet 4.9 % start P8 with slip control: slip flagged, creep held at the 95 % point, never past the peak',
        slip && maxX <= 1 && near(maxX, M.creepFromForceFraction(M.SLIP_CONTROL_TE_FRAC_ELECTRIC), 0.05), `max x=${maxX.toFixed(3)} (${(w.creepTraction() * 100).toFixed(2)} % creep)`);
    }

    // ---- C. slip recovery on a wet hill start --------------------------------------------------------
    {
      const tr = W.tracks['ion-sb.geojson|false'], gUp = tr.sample(9535).grade;
      // with slip control: start, sand arms on its own, reaches 15 km/h without rolling back
      const p = mk('rain'); p.powerNotch = 7; p.holdBrake = true; let minV = 0, slipT = 0, tReach = null;
      for (let i = 0; i < 1200; i++) {
        p.step(0.05, gUp, 0); minV = Math.min(minV, p.speed); if (p.wheelslip) slipT += 0.05;
        if (tReach === null && p.speedKmh() >= 15) tReach = i * 0.05;
      }
      assert('C. wet 4.9 % hill start with slip control + auto sand: reaches 15 km/h, no roll-back', tReach !== null && tReach < 30 && minV > -0.01, `15 km/h at ${tReach?.toFixed(1)} s, slip ${slipT.toFixed(1)} s, min v ${minV.toFixed(3)}`);
      // without slip control: the wheels run away onto the falling branch (x > 1) and the train does not climb
      const q = mk('rain'); q.slipControl = false; q.autoSand = false; q.powerNotch = 8; q.holdBrake = true; let xMax = 0, vTop = 0;
      for (let i = 0; i < 240; i++) { q.step(0.05, gUp, 0); xMax = Math.max(xMax, q.creepXTraction); vTop = Math.max(vTop, q.speedKmh()); }
      assert('C. without slip control the creep runs away past the peak (x > 3) and the start fails', xMax > 3 && vTop < 15, `max x=${xMax.toFixed(1)}, top ${vTop.toFixed(1)} km/h in 12 s`);
      // recovery: cut power, sand → creep returns to the rising branch
      q.powerNotch = 2; q.sanding = true;
      for (let i = 0; i < 300; i++) q.step(0.05, gUp, 0);
      assert('C. cutting power and sanding recovers the slipping axles within 15 s (x ≤ 1, no wheelslip lamp)', q.creepXTraction <= 1 && !q.wheelslip, `x=${q.creepXTraction.toFixed(2)}`);
      // same start sanded from the beginning on snow: slip control holds μ·N, climb impossible only when TE needed > μ·N
      const sn = mk('snow'); sn.powerNotch = 8; sn.sanding = true; sn.holdBrake = true;
      for (let i = 0; i < 400; i++) sn.step(0.05, 0.03, 0);
      assert('C. snow start on a 3 % grade with sand moves off and stays under control (x ≤ 1)', sn.speed > 1 && sn.creepXTraction <= 1, `v=${sn.speedKmh().toFixed(1)} km/h`);
      // traction limited by powered-axle weight only: a trailer-only load must not raise the limit
      const a = mk('rain'), b = mk('rain', { axleFrac: 1 });
      assert('C. adhesive weight = powered-axle share (4/6 of mass), not the whole car', a.axleFrac === M.AXLE_FRAC_FLEXITY && b.axleFrac === 1 && near(a.axleFrac, 4 / 6, 1e-12));
      const L = M.MODULES.reduce((s, m) => s + m.len, 0), pw = (M.MODULES[0].len + M.MODULES[4].len + (M.MODULES[1].len + M.MODULES[3].len) / 2) / L;
      assert('C. 4/6 powered share agrees with the module-length load split (A + E trucks) within 3 %', near(pw, 4 / 6, 0.02), `${pw.toFixed(3)}`);
    }

    // ---- D. brakes ----------------------------------------------------------------------------------
    {
      const stop = (weather, o = {}) => {
        const p = mk(weather); p.speed = 70 / 3.6; p.brakeNotch = o.notch ?? 8; p.emergencyBrake = !!o.emergency; p.slipControl = o.wsp !== false;
        p.autoSand = false; let s = 0, t = 0, tA = null, tB = null;
        while (p.speed > 0 && t < 120) {
          const v0 = p.speed; p.step(0.05, 0, 0); s += (v0 + p.speed) / 2 * 0.05; t += 0.05;
          if (tA === null && p.speedKmh() <= 60) tA = t;
          if (tB === null && p.speedKmh() <= 20) tB = t;
        }
        // mean deceleration between 60 and 20 km/h (excludes the final stop snap)
        return { s, t, aPeak: tA !== null && tB !== null ? (40 / 3.6) / (tB - tA) : NaN };
      };
      assert('D. service decel 1.26 m/s² (Flexity Outlook data sheet; TCRP 13 ≈ 1.3), emergency 2.73, track brake = difference',
        M.SERVICE_BRAKE_DECEL === 1.26 && M.EMERGENCY_BRAKE_DECEL === 2.73 && near(M.TRACK_BRAKE_DECEL, 1.47, 1e-9));
      const svDry = stop('dry'), emDry = stop('dry', { emergency: true });
      const vv = (70 / 3.6) ** 2;
      assert('D. dry B8 stop from 70 km/h on the flat: 125–150 m (v²/2a = 150 m minus running resistance)', svDry.s > 125 && svDry.s < 150, `${svDry.s.toFixed(1)} m in ${svDry.t.toFixed(1)} s`);
      assert('D. dry emergency stop from 70 km/h: 58–72 m (v²/2a = 69 m)', emDry.s > 58 && emDry.s < 72, `${emDry.s.toFixed(1)} m`);
      assert('D. dry emergency decel 60→20 km/h = 2.73 m/s² (+ ≤ 0.2 running resistance)', emDry.aPeak > 2.65 && emDry.aPeak < 2.95, `${emDry.aPeak.toFixed(2)} m/s²`);
      const svRain = stop('rain'), svSnow = stop('snow'), emSnow = stop('snow', { emergency: true }), emRain = stop('rain', { emergency: true });
      assert('D. low adhesion lengthens service braking: dry < rain < snow', svDry.s < svRain.s && svRain.s < svSnow.s, `${svDry.s.toFixed(0)} / ${svRain.s.toFixed(0)} / ${svSnow.s.toFixed(0)} m`);
      assert('D. wet B8 deceleration 60→20 km/h is adhesion-limited by WSP (0.9·μ·g/1.08 ≈ 0.7–0.9 m/s² < 1.26)', svRain.aPeak < M.SERVICE_BRAKE_DECEL - 0.2, `${svRain.aPeak.toFixed(2)} m/s²`);
      assert('D. the magnetic track brake works through low adhesion: emergency on snow still stops shorter than dry service braking, and wet emergency < wet service',
        emSnow.s < svDry.s && emRain.s < svRain.s && emDry.s < emRain.s && emRain.s < emSnow.s, `emerg dry/rain/snow ${emDry.s.toFixed(0)}/${emRain.s.toFixed(0)}/${emSnow.s.toFixed(0)} m`);
      const noWsp = stop('rain', { wsp: false });
      assert('D. wheel-slide protection shortens a wet B8 stop (locked/sliding wheels lose force down the creep curve)', svRain.s < noWsp.s, `WSP ${svRain.s.toFixed(0)} m vs none ${noWsp.s.toFixed(0)} m`);
      const half = stop('dry', { notch: 4 });
      assert('D. half-service (B4) stops in ≈ twice the distance of B8', half.s > 1.7 * svDry.s && half.s < 2.3 * svDry.s, `${half.s.toFixed(0)} m`);
      // vigilance failure = emergency brake application
      const v = mk('dry'); v.speed = 60 / 3.6; v.powerNotch = 0; v.vigilanceTimer = 0.04; v.step(0.05, 0, 0);
      const v0 = v.speed; for (let i = 0; i < 40; i++) v.step(0.05, 0, 0);
      assert('D. a vigilance failure applies the emergency brake (≥ 2.4 m/s² average over 2 s) until reset', !v.deadmanOk && v.emergencyBrake && (v0 - v.speed) / 2 > 2.4, `${((v0 - v.speed) / 2).toFixed(2)} m/s²`);
      v.resetVigilance();
      assert('D. resetVigilance releases the emergency brake', !v.emergencyBrake && v.deadmanOk);
      const lvl = mk('dry'); lvl.powerNotch = 8;
      lvl.step(0.05, 0, 0);
      assert('D. full-power start acceleration ≈ 1.0 m/s² (Flexity family; includes the 1.08 rotating-mass factor)', near(lvl.speed / 0.05, 1.0, 0.1), `${(lvl.speed / 0.05).toFixed(2)} m/s²`);
    }

    // ---- E. resistance ---------------------------------------------------------------------------------
    {
      const p = mk('dry');
      // independent re-implementation of Davis eq. 15, imperial units
      const davisImp = (massKg, vMs, n, b, Cair, areaM2) => {
        const tons = massKg / 907.185, w = tons / n, V = vMs * 2.23694, A = areaM2 * 10.7639;
        const lbPerTon = 1.3 + 29 / w + b * V + (Cair * A * V * V) / (w * n);
        return lbPerTon * tons * 4.44822;
      };
      for (const kmh of [0, 20, 50, 80]) {
        const ref = davisImp(M.MASS_FLEXITY_KG, kmh / 3.6, 6, 0.09, 0.0024, 2.65 * 3.6);
        assert(`E. Flexity Davis resistance at ${kmh} km/h = Davis 1926 eq. 15`, near(p.davisResistance(kmh / 3.6) / ref, 1, 0.003), `${(p.davisResistance(kmh / 3.6) / 1000).toFixed(2)} kN vs ${(ref / 1000).toFixed(2)} kN`);
      }
      const r0 = p.davisResistance(0) / (M.MASS_FLEXITY_KG / 1000), r80 = p.davisResistance(80 / 3.6);
      assert('E. rolling resistance at standstill ≈ 20 N/t (Davis 1.3 + 29/w) and ≈ 5 kN total at 80 km/h', near(r0, 20.2, 0.5) && r80 > 4000 && r80 < 6000, `${r0.toFixed(1)} N/t, ${(r80 / 1000).toFixed(2)} kN`);
      let mono = true; for (let v = 1; v <= 30; v++) if (p.davisResistance(v) <= p.davisResistance(v - 1)) mono = false;
      assert('E. resistance rises monotonically with speed; air-drag coefficient ≈ 5.5 N/(m/s)² for 9.54 m²', mono && near(M.DAVIS_FLEXITY.airNPerMs2, 5.49, 0.05), M.DAVIS_FLEXITY.airNPerMs2.toFixed(2));
      const dsl = new M.TrainPhysics({ massKg: M.MASS_WCR_KG, weather: 'dry', electric: false });
      const rd = dsl.davisResistance(0) / (M.MASS_WCR_KG / 1000);
      assert('E. diesel + coach: rolling ≈ 13 N/t (Davis, 20 t/axle), air ≈ 8 N/(m/s)²', near(rd, 13.3, 1) && near(M.DAVIS_DIESEL.airNPerMs2, 8.1, 0.5), `${rd.toFixed(1)} N/t, ${M.DAVIS_DIESEL.airNPerMs2.toFixed(2)}`);
      // curve resistance
      const rk = (R) => p.curveResistance(1 / R) / (M.MASS_FLEXITY_KG * G / 1000);
      assert('E. curve resistance R=100 m = 7.0 N/kN (AREMA 0.4 N/kN/deg), ≈ 3.9 kN on a 56 t car, < 10 kN', near(rk(100), 6.99, 0.05) && p.curveResistance(0.01) < 10000, `${rk(100).toFixed(2)} N/kN, ${(p.curveResistance(0.01) / 1000).toFixed(2)} kN`);
      let okR = true, worst = 0;
      for (const R of [100, 150, 200, 250, 300]) { const q = M.curveResistanceNPerKn(R) / M.rocklCurveResistanceNPerKn(R); worst = Math.max(worst, Math.abs(q - 1)); if (Math.abs(q - 1) > 0.45) okR = false; }
      assert('E. AREMA curve resistance within 45 % of Röckl for R = 100–300 m', okR, `worst deviation ${(worst * 100).toFixed(0)} %`);
      const tight = p.curveResistance(1 / 25);
      assert('E. tightest curve (R = 25 m) resistance stays ≈ 28 N/kN: < 20 kN, well below the 62 kN starting TE', tight > 12000 && tight < 20000 && near(rk(25), 27.9, 0.3), `${(tight / 1000).toFixed(1)} kN`);
      assert('E. curves tighter than 25 m are clamped; straight track has none', p.curveResistance(1 / 10) === tight && p.curveResistance(0) === 0);
      assert('E. grade force g·m·sinθ: 5 % → 27.5 kN on 56.2 t (within 0.2 % of m·g·0.05)', near(p.gradeForce(0.05) / (M.MASS_FLEXITY_KG * G * 0.05), 1, 0.002), `${(p.gradeForce(0.05) / 1000).toFixed(2)} kN`);
    }

    // ---- F. curves ---------------------------------------------------------------------------------------
    {
      assert('F. curve budget = TCRP 57 absolute unbalance 115 mm (4.5 in): lateral acceleration < 0.1 g on every radius',
        M.CURVE_EQ_BUDGET_MM === 114 && [25, 30, 40, 50, 75, 100, 150, 200, 300, 500, 1000].every((R) => { const v = M.curveSpeedLimitKmh(R) / 3.6; return M.lateralAccel(v, R) <= 0.1 * G; }));
      const ref = [[25, 15], [50, 20], [100, 30], [300, 50]];
      assert('F. TCRP 155 curve speeds: R25→15, R50→20, R100→30, R300→50 km/h', ref.every(([R, v]) => M.curveSpeedLimitKmh(R) === v), ref.map(([R]) => M.curveSpeedLimitKmh(R)).join(','));
      assert('F. minimum curve radius 25 m (Bombardier / Stage 2 EPR Table 4-2) in physics, track and clearances', M.MIN_CURVE_RADIUS_M === 25 && M.LRV_MIN_RADIUS_M === 25 && M.Track.MIN_RADIUS_M === 25);
      // Posted limits use the 60 m-base circumradius (≈ 2 car lengths, Track.curveLimitKmh); lateral acceleration
      // computed with the same radius must stay inside 0.1 g on every route (consistency of the limit table).
      // The ±10 m chord curvature (used for resistance/roll) also sees OSM polyline-vertex wiggles; those
      // are reported, and bounded as a regression guard only (known data limitation, see README/docs).
      const stats = {};
      for (const r of ['ion-sb.geojson', 'ion-nb.geojson', 'waterloo-spur.geojson', 'guelph-sub.geojson']) {
        const tr = W.tracks[`${r}|false`]; let n = 0, over = 0, maxAR = 0, maxA10 = 0;
        for (let s = 10; s < tr.length - 10; s += 2) {
          n++; const v = Math.min(80, tr.speedLimitKmh(s, false)) / 3.6;
          const R = tr.radiusAt(s, M.Track.CURVE_RADIUS_BASE_M); if (Number.isFinite(R)) maxAR = Math.max(maxAR, (v * v) / R);
          const a10 = v * v * tr.sample(s).curvature; maxA10 = Math.max(maxA10, a10); if (a10 > 0.1 * G) over++;
        }
        stats[r] = { maxAR, maxA10, share: over / n };
      }
      const all = Object.values(stats);
      assert('F. posted limits keep lateral acceleration ≤ 0.1 g on every route (60 m-base radius, as posted)', all.every((x) => x.maxAR <= 0.1 * G),
        Object.entries(stats).map(([k, x]) => `${k.slice(0, 6)} ${(x.maxAR / G).toFixed(3)} g`).join(', '));
      assert('F. short-chord (±10 m) OSM-vertex wiggles above 0.1 g stay rare (< 6 % of length, < 0.3 g) — known data limitation', all.every((x) => x.share < 0.06 && x.maxA10 < 0.3 * G),
        Object.entries(stats).map(([k, x]) => `${k.slice(0, 6)} ${(x.share * 100).toFixed(1)} % / max ${(x.maxA10 / G).toFixed(2)} g`).join(', '));
    }

    // ---- G. terrain --------------------------------------------------------------------------------------------
    {
      for (const r of ['ion-sb.geojson', 'ion-nb.geojson', 'waterloo-spur.geojson', 'guelph-sub.geojson']) {
        const fwd = W.tracks[`${r}|false`], rev = W.tracks[`${r}|true`], name = r.replace('.geojson', '');
        for (const [d, tr] of [['fwd', fwd], ['rev', rev]]) {
          const a = auditTrack(M, W, tr), c = gradeConsistency(tr);
          assert(`G. ${name} ${d}: max grade ≤ 6 % (Stage 2 EPR Table 4-2) and ≤ the sim's 5 % cap`, a.maxGrade <= M.LRT_MAX_GRADE && a.maxGrade <= M.Track.MAX_ABS_GRADE + 1e-9, `${(a.maxGrade * 100).toFixed(2)} %`);
          assert(`G. ${name} ${d}: vertical curves ≥ Flexity minimum (crest 122 m, sag 244 m, Transit Toronto)`, a.nCrest === 0 && a.nSag === 0, `min crest ${a.minCrestR.toFixed(0)} m, min sag ${a.minSagR.toFixed(0)} m`);
          assert(`G. ${name} ${d}: no grade spikes (step ≤ 2.05 % per 5 m ⇔ vertical radius ≥ 244 m) and physics grade = rail slope (≤ 0.7 %)`, c.jump <= 5 / 244 && c.slopeGap <= 0.007, `step ${(c.jump * 100).toFixed(2)} %, slope gap ${(c.slopeGap * 100).toFixed(2)} %`);
          assert(`G. ${name} ${d}: rail within 8 m of the SRTM ground (cut/fill = bridge or embankment, not a reversed or offset profile)`, a.cutMax > -8 && a.fillMax < 8, `cut ${a.cutMax.toFixed(1)} m / fill ${a.fillMax.toFixed(1)} m`);
        }
        const fr = fwdRevDelta(fwd, rev);
        assert(`G. ${name}: same ground point has the same rail height in both directions (< 0.25 m, ≥ 90 % matched)`, fr.worst < 0.25 && fr.matched >= 0.9 * fr.total, `Δ ${fr.worst.toFixed(2)} m, ${fr.matched}/${fr.total} matched`);
        assert(`G. ${name}: reversed route starts at the forward route's end height (< 0.5 m)`, Math.abs(rev.points[0].y - fwd.points[fwd.points.length - 1].y) < 0.5 && Math.abs(rev.points[rev.points.length - 1].y - fwd.points[0].y) < 0.5);
      }
    }
  } finally {
    await cleanup();
  }
}
