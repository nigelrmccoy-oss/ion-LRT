/**
 * v1.4.6 checks (called from stress-test.mjs after v1.4.5):
 *   G. P1 uphill-stop jerk: moving/static boundary is continuous on grades
 *      (Code Critic NO-GO on v1.4.5 f0f1dc4 — 22.98 m/s³ service / 28.73 emergency on 4.5 %)
 */
import { bundleGame } from './drive-sim.mjs';

const near = (a, b, tol) => Math.abs(a - b) <= tol;

export async function v146Tests(assert) {
  const { M, cleanup } = await bundleGame();
  try {
    const DT = 0.02;
    const mk = () => {
      const p = new M.TrainPhysics({ massKg: M.MASS_FLEXITY_KG, weather: 'dry', electric: true });
      p.reverser = 1; p.pantographUp = true; p.lineVoltage = 750; p.resetVigilance();
      return p;
    };
    /** Code Critic repro: stop from 70 km/h on grade, return max |Δa|/dt and the flat-track stop distance helpers. */
    const stopJerk = (grade, emergency, dt = DT) => {
      const p = mk(); p.speed = 70 / 3.6; p.brakeNotch = 8;
      if (emergency) p.emergencyBrake = true;
      let prevA = null, maxJ = 0, aAtBound = null, s = 0, t = 0, aLast = 0;
      const stand = M.STANDSTILL_MS;
      while (t < 120) {
        const v0 = p.speed; const r = p.step(dt, grade, 0); t += dt; s += (v0 + p.speed) / 2 * dt;
        const a = r.a; aLast = a;
        if (prevA !== null) {
          const j = Math.abs(a - prevA) / dt;
          if (j > maxJ) maxJ = j;
          if (v0 >= stand && p.speed < stand && aAtBound === null) aAtBound = { aPrev: prevA, a, j };
        }
        prevA = a;
        if (Math.abs(p.speed) < 1e-6 && t > 10 * dt) break;
      }
      return { maxJ, aAtBound, s, t, aLast };
    };

    // ---- G. grade-continuous jerk limit (Code Critic repro) ------------------------------------
    {
      // Exact Code Critic numbers on v1.4.5: service −0.79330 → −0.33369 (22.98 m/s³), emergency 28.73
      const criticSvc = stopJerk(0.045, false, 0.02);
      const criticEm = stopJerk(0.045, true, 0.02);
      assert('G. Code Critic repro (56.2 t, dry, 70→0, B8, grade +4.5 %, dt 0.02): service |da/dt| ≤ 1.2 m/s³ (v1.4.5: 22.98)',
        criticSvc.maxJ <= M.JERK_SERVICE_BRAKE_MS3 * 1.02 + 0.05, `${criticSvc.maxJ.toFixed(3)} m/s³`);
      assert('G. Code Critic repro: emergency |da/dt| ≤ 5 m/s³ (v1.4.5: 28.73)',
        criticEm.maxJ <= M.JERK_EMERGENCY_BRAKE_MS3 * 1.02 + 0.05, `${criticEm.maxJ.toFixed(3)} m/s³`);

      const cases = [];
      for (const g of [0, 0.01, 0.045, -0.01, -0.045]) {
        for (const em of [false, true]) {
          for (const dt of [0.01, 0.02, 0.05]) {
            const r = stopJerk(g, em, dt);
            const lim = em ? M.JERK_EMERGENCY_BRAKE_MS3 : M.JERK_SERVICE_BRAKE_MS3;
            cases.push({ g, em, dt, maxJ: r.maxJ, lim, ok: r.maxJ <= lim * 1.05 + 0.05 });
          }
        }
      }
      const bad = cases.filter((c) => !c.ok);
      assert('G. service/emergency stops from 70 km/h stay within the claimed jerk on flat, ±1 %, ±4.5 % at dt ∈ {0.01, 0.02, 0.05}',
        bad.length === 0,
        bad.map((c) => `${c.em ? 'em' : 'svc'} g=${c.g} dt=${c.dt}: ${c.maxJ.toFixed(2)}>${c.lim}`).join('; ') || 'ok');

      // Flat distances preserved from v1.4.5
      const flatSvc = stopJerk(0, false), flatEm = stopJerk(0, true);
      assert('G. flat dry service stop from 70 still ≈ 154 m (148–160) and emergency ≈ 73 m (68–78)',
        flatSvc.s > 148 && flatSvc.s < 160 && flatEm.s > 68 && flatEm.s < 78,
        `${flatSvc.s.toFixed(1)} / ${flatEm.s.toFixed(1)} m`);

      // Uphill stop is shorter than flat; downhill longer (grade helps / fights)
      const up = stopJerk(0.045, false), down = stopJerk(-0.045, false);
      assert('G. 4.5 % uphill service stop is shorter than flat; 4.5 % downhill is longer',
        up.s < flatSvc.s - 10 && down.s > flatSvc.s + 10,
        `flat ${flatSvc.s.toFixed(1)} / up ${up.s.toFixed(1)} / down ${down.s.toFixed(1)} m`);

      // Car remains held after the stop on 4.5 %
      const hp = mk(); hp.speed = 70 / 3.6; hp.brakeNotch = 8;
      for (let i = 0; i < 5000 && Math.abs(hp.speed) > 1e-6; i++) hp.step(DT, 0.045, 0);
      hp.brakeNotch = 0; let vmax = 0;
      for (let i = 0; i < 500; i++) { hp.step(DT, 0.045, 0); vmax = Math.max(vmax, Math.abs(hp.speed)); }
      assert('G. after a 4.5 % uphill stop the hold brake keeps the car at rest with B0',
        Math.abs(hp.speed) < 1e-6 && vmax < 1e-4, `v ${hp.speed}, vmax ${vmax}`);
    }
  } finally {
    await cleanup();
  }
}
