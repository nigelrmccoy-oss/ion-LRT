export type Weather = 'dry' | 'rain' | 'snow';

export type PhysicsConfig = {
  massKg: number;
  weather: Weather;
  electric: boolean; // Flexity vs diesel
};

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

export function adhesionMu(weather: Weather, sanding: boolean): number {
  let mu = weather === 'dry' ? 0.30 : weather === 'rain' ? 0.18 : 0.10;
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

  constructor(cfg: PhysicsConfig) {
    this.massKg = cfg.massKg;
    this.weather = cfg.weather;
    this.electric = cfg.electric;
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
      // ~70 kN starting, falls with power limit ~450 kW at 750 V
      const te0 = 70000;
      const pMax = 450000 * (this.lineVoltage / 750);
      if (speedMs < 1) return te0;
      return Math.min(te0, pMax / speedMs);
    }
    // diesel/cab: ~40 kN, 300 kW
    const te0 = 40000;
    const pMax = 300000;
    if (speedMs < 1) return te0;
    return Math.min(te0, pMax / speedMs);
  }

  davisResistance(speedMs: number) {
    // Davis: A + Bv + Cv^2  (N), tuned for ~50 t LRV
    const v = Math.abs(speedMs);
    const A = 1200, B = 40, C = 6.5;
    return A + B * v + C * v * v;
  }

  gradeForce(grade: number) {
    return this.massKg * 9.81 * grade;
  }

  curveResistance(curvature: number) {
    // empirical N ≈ mass * g * (600/R_m) style — curvature is 1/R
    if (curvature < 1e-5) return 0;
    const R = 1 / Math.abs(curvature);
    return this.massKg * 9.81 * (600 / Math.max(R, 50)) * 0.001 * 50; // scaled
  }

  step(dt: number, grade: number, curvature: number) {
    // Doors interlock / reverser / vigilance
    const canPower = !this.doorsOpen && this.reverser !== 0 && this.deadmanOk;
    const notchP = canPower ? this.powerNotch : 0;
    const demandTE = (notchP / 8) * this.maxTE(Math.abs(this.speed));
    // Powered-axle adhesion weight (not full consist mass)
    const axleFrac = this.electric ? 0.55 : 0.50;
    const axleLoad = this.massKg * 9.81 * axleFrac;
    const maxAdhesion = this.baseMu() * axleLoad;

    // Brakes: blended regen + friction, up to ~1.2 m/s² — also limited by adhesion
    const demandBrake = (this.brakeNotch / 8) * this.massKg * 1.2;

    const teSlip = demandTE > maxAdhesion && notchP > 0;
    const brakeSlip = demandBrake > maxAdhesion && this.brakeNotch > 0;
    this.wheelslip = teSlip || brakeSlip;

    let te = Math.min(demandTE, maxAdhesion);
    if (teSlip) te *= 0.35; // reduced accel while slipping

    let Fbrake = Math.min(demandBrake, maxAdhesion);
    if (brakeSlip) Fbrake *= 0.35; // reduced braking while sliding

    const resist = this.davisResistance(this.speed) + Math.abs(this.curveResistance(curvature));
    const Fgrade = this.gradeForce(grade);

    const dir = this.reverser === 0 ? 0 : this.reverser;
    let F = dir * te - Math.sign(this.speed || dir) * (Fbrake + resist) - Fgrade;
    if (Math.abs(this.speed) < 0.05 && this.brakeNotch > 0) F = -Fgrade * 0.2; // hold

    const a = F / this.massKg;
    this.speed += a * dt;

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
}
