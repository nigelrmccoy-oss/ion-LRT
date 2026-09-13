export type Weather = 'dry' | 'rain' | 'snow';

export type PhysicsConfig = {
  massKg: number;
  weather: Weather;
  electric: boolean; // Flexity vs diesel
};

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

  baseMu() {
    let mu = this.weather === 'dry' ? 0.30 : this.weather === 'rain' ? 0.18 : 0.10;
    if (this.sanding) mu = Math.min(0.35, mu + 0.08);
    return mu;
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
    // Doors interlock
    const canPower = !this.doorsOpen && this.reverser !== 0 && this.deadmanOk;
    const notchP = canPower ? this.powerNotch : 0;
    const demandTE = (notchP / 8) * this.maxTE(Math.abs(this.speed));
    const axleLoad = this.massKg * 9.81; // treat as total adhesion weight
    const maxAdhesion = this.baseMu() * axleLoad;
    this.wheelslip = demandTE > maxAdhesion && notchP > 0;
    let te = Math.min(demandTE, maxAdhesion);
    if (this.wheelslip) te *= 0.35; // reduced accel while slipping

    // Brakes: blended regen + friction, up to ~1.2 m/s²
    const Fbrake = (this.brakeNotch / 8) * this.massKg * 1.2;

    const resist = this.davisResistance(this.speed) + Math.abs(this.curveResistance(curvature));
    const Fgrade = this.gradeForce(grade);

    const dir = this.reverser === 0 ? 0 : this.reverser;
    let F = dir * te - Math.sign(this.speed || dir) * (Fbrake + resist) - Fgrade;
    if (Math.abs(this.speed) < 0.05 && this.brakeNotch > 0) F = -Fgrade * 0.2; // hold

    const a = F / this.massKg;
    this.speed += a * dt;
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

    return { te, a, resist, Fbrake };
  }

  resetVigilance() {
    this.vigilanceTimer = 45;
    this.deadmanOk = true;
  }

  speedKmh() { return Math.abs(this.speed) * 3.6; }
}
