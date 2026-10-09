export type Weather = 'dry' | 'rain' | 'snow';

export type PhysicsConfig = {
  massKg: number;
  weather: Weather;
  electric: boolean; // Flexity vs diesel
  axleFrac?: number; // adhesive weight / total mass
};

/** Flexity Freedom (ION): 48,200 kg empty — Transit Toronto / Metrolinx. */
export const MASS_FLEXITY_TARE_KG = 48200;
/** Typical load ~114 pax at 70 kg (seated + light standees). */
export const MASS_PAX_TYPICAL_KG = 8000;
export const MASS_FLEXITY_KG = MASS_FLEXITY_TARE_KG + MASS_PAX_TYPICAL_KG;
/** WCR: RS-18 ~112 t + one coach ~36 t. */
export const MASS_WCR_KG = 148000;
/** CN/GO-ish short consist. */
export const MASS_CN_KG = 160000;
/** Bo'2Bo' = 4 powered of 6 axles. */
export const AXLE_FRAC_FLEXITY = 4 / 6;
/** Loco adhesive weight / consist (RS-18 on WCR). */
export const AXLE_FRAC_WCR = 112000 / MASS_WCR_KG;
export const AXLE_FRAC_CN = 120000 / MASS_CN_KG;

/** Flexity Freedom ~80 km/h; Guelph Sub diesel ~95 km/h */
export const VMAX_ELECTRIC_MS = 80 / 3.6;
export const VMAX_DIESEL_MS = 95 / 3.6;

/** Civil speed-limit by ROW class (km/h) */
export const SPEED_LIMITS_KMH = {
  station: 25,
  street: 40,
  reserved: 70,
} as const;

export type RowClass = keyof typeof SPEED_LIMITS_KMH;

/** Below this |v| (m/s) the car is treated as standing (static friction logic). */
export const STANDSTILL_MS = 0.05;
/** Hold brake engages below this speed when doors are open / traction interlocked (m/s ≈ 1 km/h). */
export const HOLD_BRAKE_MS = 0.3;
/** Hold-brake retarding capacity (m/s²) — holds the car on > 12 % grades. */
export const HOLD_BRAKE_DECEL = 1.5;
/** Flexity Freedom minimum horizontal curve radius (Bombardier spec / Stage 2 ION EPR Table 4-2). */
export const MIN_CURVE_RADIUS_M = 25;

export function adhesionMu(weather: Weather, sanding: boolean): number {
  let mu = weather === 'dry' ? 0.30 : weather === 'rain' ? 0.15 : 0.10;
  if (sanding) mu = Math.min(0.35, mu + 0.08);
  return mu;
}

/**
 * Standalone speed-limit helper for tests / HUD logic.
 * Prefer explicit rowClass (OSM-derived). Curvature is fallback only when rowClass omitted.
 */
export function civilSpeedLimitKmh(
  nearStation: boolean,
  curvature: number,
  opts?: { ionStreetRunning?: boolean; rowClass?: RowClass },
): number {
  if (nearStation || opts?.rowClass === 'station') return SPEED_LIMITS_KMH.station;
  if (opts?.rowClass === 'street') return SPEED_LIMITS_KMH.street;
  if (opts?.rowClass === 'reserved') return SPEED_LIMITS_KMH.reserved;
  // fallback: curvature heuristic
  if (Math.abs(curvature) > 0.004) return SPEED_LIMITS_KMH.street;
  if (opts?.ionStreetRunning && Math.abs(curvature) > 0.0015) return SPEED_LIMITS_KMH.street;
  return SPEED_LIMITS_KMH.reserved;
}

/**
 * Curve equilibrium + unbalance budget for the curve-speed formula (mm). TCRP Report 155
 * (Track Design Handbook for LRT, 2nd ed., §3.2.4/3.2.6) recommends Ea + Eu of 3–4.5 in
 * (76–114 mm) for light rail; the sim uses the upper 114 mm.
 */
export const CURVE_EQ_BUDGET_MM = 114;
/** Lowest posted curve restriction (km/h). */
export const CURVE_LIMIT_MIN_KMH = 10;

/**
 * Curve speed limit (km/h) for radius R (m): TCRP 155 V = sqrt((Ea+Eu)·R / 3.96) in
 * mph/in/ft, i.e. metric V[km/h] = sqrt((Ea+Eu)[mm] · R[m] / 11.8). Rounded down to 5 km/h.
 * R 25 m → 15 km/h, R 50 m → 20 km/h, R 100 m → 30 km/h, R 300 m → 50 km/h, R ≥ 510 m → 70.
 */
export function curveSpeedLimitKmh(radiusM: number, budgetMm = CURVE_EQ_BUDGET_MM): number {
  if (!Number.isFinite(radiusM) || radiusM <= 0) return 999;
  const v = Math.sqrt((budgetMm * Math.max(MIN_CURVE_RADIUS_M, radiusM)) / 11.8);
  // posted in 5 km/h steps below 30, 10 km/h steps above (fewer board changes)
  const q = v < 30 ? Math.floor(v / 5) * 5 : Math.floor(v / 10) * 10;
  return Math.max(CURVE_LIMIT_MIN_KMH, q);
}

export function isOverspeed(speedKmh: number, limitKmh: number, margin = 2): boolean {
  return speedKmh > limitKmh + margin;
}

/** Real-ish LRV / light diesel physics in SI units. */
export class TrainPhysics {
  massKg: number;
  weather: Weather;
  electric: boolean;
  speed = 0; // m/s
  powerNotch = 0; // 0..8
  brakeNotch = 0; // 0..8
  reverser: -1 | 0 | 1 = 0;
  sanding = false;
  pantographUp = true;
  doorsOpen = false;
  wheelslip = false;
  lineVoltage = 750;
  vigilanceTimer = 45;
  deadmanOk = true;
  /**
   * Automatic hold brake (standstill brake). Real LRVs apply it at standstill and keep it
   * until tractive effort can overcome gravity in the selected direction. Also forced
   * while the doors are open or traction is interlocked, so clearing the service brake
   * can never let the car roll away (v1.4.0 rolled back at −1.5 km/h with doors open).
   */
  holdBrake = false;

  axleFrac: number;

  constructor(cfg: PhysicsConfig) {
    this.massKg = cfg.massKg;
    this.weather = cfg.weather;
    this.electric = cfg.electric;
    this.axleFrac = cfg.axleFrac ?? (cfg.electric ? AXLE_FRAC_FLEXITY : AXLE_FRAC_WCR);
  }

  setWeather(w: Weather) { this.weather = w; }

  vMaxMs() {
    return this.electric ? VMAX_ELECTRIC_MS : VMAX_DIESEL_MS;
  }

  baseMu() {
    return adhesionMu(this.weather, this.sanding);
  }

  /** Max traction effort N vs speed (simplified Flexity / diesel curve). */
  maxTE(speedMs: number) {
    if (this.electric) {
      if (!this.pantographUp || this.lineVoltage < 500) return 0;
      // 4 × ~80 kW asynchronous motors, ~62 kN start (~1.1 m/s² at tare)
      const te0 = 62000;
      const pMax = 320000 * (this.lineVoltage / 750);
      if (speedMs < 1) return te0;
      return Math.min(te0, pMax / speedMs);
    }
    // RS-18 class: ~178 kN starting TE, ~1340 kW — adhesion usually binds first
    const te0 = 178000;
    const pMax = 1340000;
    if (speedMs < 1) return te0;
    return Math.min(te0, pMax / speedMs);
  }

  davisResistance(speedMs: number) {
    // Davis: A + Bv + Cv^2  (N), tuned for ~50 t LRV
    const v = Math.abs(speedMs);
    const t = this.massKg / 1000;
    const A = 20 * t;           // ~20 N per tonne rolling
    const B = 0.35 * t;
    const C = this.electric ? 5.2 : 8.5;
    return A + B * v + C * v * v;
  }

  gradeForce(grade: number) {
    return this.massKg * 9.81 * grade;
  }

  /**
   * Curve resistance (N). AREMA-style 0.8 lb/short-ton per degree of curve
   * (≈0.4 N/kN per degree, chord-100 ft definition D = 1746.4 / R[m]).
   * v1.3 used `mass·g·(600/R)·0.05`, which was ~40× too large (165 kN at R=100 m,
   * 331 kN at R≤50 m — far above the 62 kN starting TE) and stalled the LRV on any
   * densified-polyline kink (e.g. near Northfield / Block Line).
   */
  curveResistance(curvature: number) {
    const k = Math.abs(curvature);
    if (!Number.isFinite(k) || k < 1e-5) return 0;
    const R = Math.max(MIN_CURVE_RADIUS_M, 1 / k);
    const degrees = 1746.4 / R;
    const nPerKn = 0.4 * degrees;
    return (this.massKg * 9.81 / 1000) * nPerKn;
  }

  /** Speed-dependent available adhesion (Curtius–Kniffler shape, normalised to 1 at standstill). */
  adhesionAt(speedMs: number) {
    const vk = Math.abs(speedMs) * 3.6;
    const ck = (7.5 / (vk + 44) + 0.161) / (7.5 / 44 + 0.161);
    return this.baseMu() * ck;
  }

  step(dt: number, grade: number, curvature: number) {
    // Non-finite grade/curvature → 0 so speed never becomes NaN
    if (!Number.isFinite(grade)) grade = 0;
    if (!Number.isFinite(curvature)) curvature = 0;

    // Doors interlock / reverser / vigilance
    const canPower = !this.doorsOpen && this.reverser !== 0 && this.deadmanOk;
    const notchP = canPower ? this.powerNotch : 0;
    const demandTE = (notchP / 8) * this.maxTE(Math.abs(this.speed));
    // Powered-axle adhesion weight (not full consist mass), normal force on grade
    const axleLoad = this.massKg * 9.81 * this.axleFrac * Math.cos(Math.atan(grade));
    const maxAdhesion = this.adhesionAt(this.speed) * axleLoad;

    // Brakes: blended regen + friction, up to ~1.15 m/s² — also limited by adhesion
    // (brake adhesion uses all axles: friction brakes on the trailer truck too)
    const demandBrake = (this.brakeNotch / 8) * this.massKg * 1.15;
    const brakeAdhesion = this.adhesionAt(this.speed) * this.massKg * 9.81;

    const teSlip = notchP > 0 && demandTE > maxAdhesion;
    const brakeSlip = this.brakeNotch > 0 && Math.abs(this.speed) > 0.05 && demandBrake > brakeAdhesion;
    this.wheelslip = teSlip || brakeSlip;

    let te = Math.min(demandTE, maxAdhesion);
    if (teSlip) te *= 0.35; // reduced accel while slipping (no anti-slip recovery modelled)

    let Fbrake = Math.min(demandBrake, brakeAdhesion);
    if (brakeSlip) Fbrake *= 0.35; // reduced braking while sliding

    const resist = this.davisResistance(this.speed) + this.curveResistance(curvature);
    const Fgrade = this.gradeForce(grade);
    const dir = this.reverser === 0 ? 0 : this.reverser;

    // Hold brake: engage at standstill (or ≤ HOLD_BRAKE_MS with doors open / interlock),
    // release only when TE in the selected direction beats the grade force.
    const interlocked = !canPower || (this.electric && (!this.pantographUp || this.lineVoltage < 500));
    const tractionWins = dir !== 0 && notchP > 0 && dir * (dir * te - Fgrade) > 0;
    const slowEnough = Math.abs(this.speed) < (this.doorsOpen || interlocked ? HOLD_BRAKE_MS : STANDSTILL_MS);
    if (tractionWins && !this.doorsOpen) this.holdBrake = false;
    else if (slowEnough) this.holdBrake = true;
    else if (Math.abs(this.speed) >= HOLD_BRAKE_MS) this.holdBrake = false;
    if (this.holdBrake) {
      Fbrake += this.massKg * HOLD_BRAKE_DECEL;
    }

    let a: number;
    if (Math.abs(this.speed) < STANDSTILL_MS) {
      // Static case: rolling/curve resistance and brakes are reaction forces — they can
      // hold the car but never push it backwards (v1.3 applied them with sign(dir),
      // which made the car jitter ±0.3 m/s and "creep" when TE < resistance).
      const applied = dir * te - Fgrade;
      const holding = resist + Fbrake;
      if (Math.abs(applied) <= holding) {
        this.speed = 0;
        a = 0;
      } else {
        a = (applied - Math.sign(applied) * holding) / this.massKg;
        this.speed += a * dt;
      }
    } else {
      const sv = Math.sign(this.speed);
      const F = dir * te - sv * (Fbrake + resist) - Fgrade;
      a = F / this.massKg;
      const next = this.speed + a * dt;
      // Resistive forces may stop the car but not reverse it within one step
      if (Math.sign(next) !== sv && Math.abs(dir * te - Fgrade) <= Fbrake + resist) {
        this.speed = 0;
      } else {
        this.speed = next;
      }
    }
    if (!Number.isFinite(this.speed)) this.speed = 0;

    // Vehicle max speed cap (after integrate)
    const vmax = this.vMaxMs();
    if (Math.abs(this.speed) > vmax) {
      this.speed = Math.sign(this.speed) * vmax;
    }

    // stop creep
    if (this.brakeNotch >= 7 && Math.abs(this.speed) < 0.15) this.speed = 0;
    if (this.reverser === 0 && Math.abs(this.speed) < 0.2) this.speed = 0;

    // Vigilance
    this.vigilanceTimer -= dt;
    if (notchP > 0 || this.brakeNotch > 0) this.vigilanceTimer = 45;
    if (this.vigilanceTimer <= 0) {
      this.deadmanOk = false;
      this.brakeNotch = Math.max(this.brakeNotch, 8);
    }

    return { te, a, resist, Fbrake, demandTE, demandBrake, maxAdhesion };
  }

  resetVigilance() {
    this.vigilanceTimer = 45;
    this.deadmanOk = true;
  }

  speedKmh() { return Math.abs(this.speed) * 3.6; }

  /** HUD / tutorial: why traction is cut (doors, N, vigilance, panto, voltage). */
  powerBlockedReason(): string | null {
    if (this.doorsOpen) return 'Doors open — close with T';
    if (this.reverser === 0) return 'Reverser Neutral — press R for Forward';
    if (!this.deadmanOk) return 'Vigilance penalty — notch W/S to reset';
    if (this.electric && !this.pantographUp) return 'Pantograph down — press P';
    if (this.electric && this.lineVoltage < 500) return 'Line voltage low';
    return null;
  }
}

