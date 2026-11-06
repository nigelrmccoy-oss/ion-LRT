export type Weather = 'dry' | 'rain' | 'snow';
/** Rail-head condition: the weather, or a wet-leaf film (autumn) — see RAIL_MU. */
export type RailCondition = Weather | 'leaf';

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
/**
 * Bo'2Bo' = 4 powered of 6 axles: 3 trucks, power trucks under the end modules A and E, an
 * unpowered trailer truck under the centre module C (Bombardier FLEXITY Freedom brochure 2011;
 * UIC Bo'2Bo'; Railway Gazette, Oct 2011). Adhesive weight for traction = powered axles only.
 * The real axle-load split is NOT published; 4/6 assumes equal axle loads. Cross-check with the
 * sim's own module layout (Clearances.ts; mass ∝ length, suspended modules B and D carried half
 * by each neighbour): A truck 10.1 m + E truck 10.1 m of 30.8 m = 0.655, i.e. within 2 % of 4/6.
 * ESTIMATE.
 */
export const AXLE_FRAC_FLEXITY = 4 / 6;
/** Loco adhesive weight / consist (RS-18 on WCR). */
export const AXLE_FRAC_WCR = 112000 / MASS_WCR_KG;
export const AXLE_FRAC_CN = 120000 / MASS_CN_KG;

/** Flexity Freedom ~80 km/h; Guelph Sub diesel ~95 km/h */
export const VMAX_ELECTRIC_MS = 80 / 3.6;
export const VMAX_DIESEL_MS = 95 / 3.6;

/**
 * Civil speed-limit by ROW class (km/h).
 * SOURCE (street 50, reserved 70): Wikipedia "Ion rapid transit" — "maximum operating speed of Ion
 * light rail vehicles is 50 km/h along city streets and 70 km/h along railway rights of way"
 * (citing Waterloo Region Record, 19 Dec 2017); the same article gives 20–25 km/h where pedestrian
 * traffic is high → station 25 (ESTIMATE inside that range). v1.4.4 used an unsourced 40 for street.
 */
export const SPEED_LIMITS_KMH = {
  station: 25,
  street: 50,
  reserved: 70,
} as const;

export type RowClass = keyof typeof SPEED_LIMITS_KMH;

/** Below this |v| (m/s) the car is treated as standing (static friction logic). */
export const STANDSTILL_MS = 0.05;
/** Hold brake engages below this speed when doors are open / traction interlocked (m/s ≈ 1 km/h). */
export const HOLD_BRAKE_MS = 0.3;
/**
 * Hold-brake retarding capacity (m/s²) — holds the car on > 12 % grades. ESTIMATE (no published
 * Freedom parking-brake figure; Wikipedia/Bombardier give only "spring-applied park brake").
 */
export const HOLD_BRAKE_DECEL = 1.5;
/** Flexity Freedom minimum horizontal curve radius (Bombardier spec / Stage 2 ION EPR Table 4-2). */
export const MIN_CURVE_RADIUS_M = 25;
/** Vigilance (deadman) timer only runs above this speed (m/s ≈ 1.8 km/h) — ESTIMATE. */
export const VIGILANCE_MIN_SPEED_MS = 0.5;

// ───────────────────────── brakes ─────────────────────────
/**
 * Full-service (B8) deceleration of the friction/regenerative brake on dry level rail, m/s².
 * SOURCE: Bombardier FLEXITY Outlook (Innsbruck) data sheet, service braking 1.26 m/s²
 * (sibling Flexity platform: no ION/Freedom figure is published — Bombardier's 2011 Freedom
 * brochure lists only "regenerative + hydraulic disc + magnetic track brake"). Corroborated by
 * TCRP Report 13 / typical LRV service braking ≈ 3.0 mphps = 1.3 m/s². v1.4.3 used an unsourced 1.15.
 */
export const SERVICE_BRAKE_DECEL = 1.26;
/**
 * Emergency braking total, m/s²: friction brake at full service plus the magnetic track brake.
 * SOURCE: same Flexity Outlook data sheet, emergency braking 2.73 m/s² (sibling platform; the
 * Freedom figure is not published). DART design criteria quote 4–6 mphps (1.8–2.7 m/s²) for LRVs.
 */
export const EMERGENCY_BRAKE_DECEL = 2.73;
/** Magnetic track-brake share of the emergency rate (not adhesion-limited): 2.73 − 1.26. */
export const TRACK_BRAKE_DECEL = EMERGENCY_BRAKE_DECEL - SERVICE_BRAKE_DECEL;
/** Track brake needs motion to drag the magnets (m/s). ESTIMATE. */
export const TRACK_BRAKE_MIN_SPEED_MS = 0.5;
/**
 * The magnetic track brake is a magnet-shoe-on-rail friction brake, so it is NOT independent of
 * rail condition: wet, leaf, ice and grease films cut its force (field tests of an EMU's MTB on
 * water / leaf / grease contaminated rail: Proc. IMechE Part F 2011, doi 10.1177/0954409711408375).
 * Factor on TRACK_BRAKE_DECEL by rail condition. Dry 1.0. Contaminated rail: EN 16207 is
 * reported (secondary summary, railwaynews.net — not verified against the standard) to require
 * μ ≥ 0.25 dry and ≥ 0.15 wet/contaminated → 0.6; used for snow and leaf. Rain 0.8 is an
 * ESTIMATE between the two (a plain water film hurts less than leaves/ice). Cross-check: the
 * Flexity Outlook data sheet lists 6 × 81 kN = 486 kN magnet pull; the 1.47 m/s² share of a
 * 49.8 t car (73 kN) implies μ ≈ 0.15 on that pull — i.e. the sheet's emergency rate is already
 * a conservative (wet-rated) figure, so dry rail is capped at 1.0 rather than scaled up.
 */
export const TRACK_BRAKE_CONDITION_FACTOR: Record<RailCondition, number> = { dry: 1, rain: 0.8, snow: 0.6, leaf: 0.6 };
/**
 * Jerk (rate of change of acceleration) limits, m/s³. v1.4.4 stepped every force instantly
 * (0 → −2.8 m/s² in one 20 ms frame).
 *  Traction  1.34 m/s³ — DART light-rail design criteria vehicle jerk limit 3.0 mphpsps ±10 %
 *            (3.0 mph/s² = 1.34 m/s³). Cross-checks: RTD Denver LRT Design Criteria 2024 §13.2.6.6
 *            2.0 m/s³ +10 %; Italian UNI tram requirement ≤ 1.5 m/s³ (Megna et al., Urban Rail
 *            Transit 8, 2022, doi 10.1007/s40864-021-00163-6).
 *  Service brake 1.2 m/s³ — Yarra Trams "Rolling Stock – Tram – Braking Systems" §4.2.2.2:
 *            instantaneous jerk for service braking ≤ 1.2 m/s³.
 *  Emergency brake 5 m/s³ — ESTIMATE. RTD §13.2.6.6: "emergency brake applications shall not be
 *            jerk limited"; EN 13452-1 only defines a build-up time (project-specific). 5 m/s³
 *            builds the 2.73 m/s² emergency rate in 0.55 s (real MTB + hydraulic build-up is
 *            fractions of a second); the magnet itself is quoted ≈ 0.3 s but that figure is a
 *            secondary source.
 */
export const JERK_TRACTION_MS3 = 1.34;
export const JERK_SERVICE_BRAKE_MS3 = 1.2;
export const JERK_EMERGENCY_BRAKE_MS3 = 5;
/** Largest dt (s) a single step integrates; bigger gaps (tab switch, debugger) are clamped, not extrapolated. */
export const MAX_STEP_DT_S = 0.25;
/**
 * Rotating-mass factor: wheels, gears and motor rotors make the vehicle accelerate like
 * 1.06–1.10 × its static mass for a complete train (J.-M. Allenbach, "Electric Traction —
 * Base Principles", fig. 3.13). Mid value 1.08 (also gives 1.0 m/s² start accel at 56 t / 62 kN,
 * matching the Flexity family's ≈ 1.0 m/s² acceleration figure). Applies to every force → a
 * conversion, so braking rates above are true decelerations.
 */
export const ROTATING_MASS_FACTOR = 1.08;

// ───────────────────────── wheel–rail adhesion ─────────────────────────
/**
 * Design peak adhesion μ at standstill by rail condition (clean steel-on-steel unless noted).
 *  dry  0.30  Curtius–Kniffler dry μ(0)=7.5/44+0.161=0.33 (Curtius & Kniffler 1944 / Allenbach
 *             fig. 3.15) derated ≈ 10 % for design (typical dry range 0.2–0.4; RSSB / Integrail).
 *  rain 0.22  wet rail, standstill value of the Curtius–Kniffler shape. v1.4.4's 0.15 was low.
 *             Field data: British Rail tribometer-train wet values ≈ 0.20 and Ontrak tribometer
 *             wet median 0.20 vs dry 0.31 (Proc. IMechE Part F 2023, doi 10.1177/09544097231209483);
 *             "wet 0.25" in the classic adhesion literature (Advanced Steam Traction / Koffman);
 *             FRA "A Survey of Wheel/Rail Friction": design traction limits 0.17–0.20, braking
 *             0.15 (Stockholm) / 0.09 (UK) — 0.22 sits at the top of the design range and the
 *             speed shape takes it to ≈ 0.14 at 70 km/h. The same field data show contaminated
 *             rail far below that, hence snow/leaf stay low.
 *  snow 0.10  snow / frost / ice film: ESTIMATE inside the 0.05–0.15 range quoted for
 *             contaminated rail (no ION measurement exists).
 *  leaf 0.05  wet-leaf film 0.015–0.05 (RDG, "Leaves on the line"/Ingenia 2019).
 */
export const RAIL_MU: Record<RailCondition, number> = { dry: 0.30, rain: 0.22, snow: 0.10, leaf: 0.05 };
/**
 * Peak μ with sand effectively covering the rail head (Skipper 2022, Univ. Sheffield PhD /
 * Wear 2024: sanded peak adhesion dry 0.4–0.5, wet 0.3–0.4, leaf 0.1–0.2 in tests; Meierhofer
 * measured 0.3–0.4 wet sanded). The values below are deliberately conservative fractions of
 * those laboratory peaks (a moving train gets patchy cover) — ESTIMATES.
 */
export const SANDED_MU: Record<RailCondition, number> = { dry: 0.35, rain: 0.30, snow: 0.18, leaf: 0.12 };
/** Sand takes time to reach and cover the rail head (s to full effect) and stays after a pass (s to fade). ESTIMATES. */
export const SAND_RAMP_UP_S = 1.0;
export const SAND_FADE_S = 3.0;

/**
 * Critical creep s_c (creep at peak adhesion) by condition. THESE ARE ESTIMATES, not measured
 * ION values: only the order of magnitude comes from Polach 2005 (Wear 258) / Kalker — peak at
 * ≈ 1–2 % creep on dry rail, shifting to larger creep on wet and contaminated rail. The
 * creep curve below is a simplified Polach-style SHAPE (linear rise, one peak, falling branch to
 * A = μ∞/μ0), not Polach's full contact model (no spin, no contact-ellipse integration, no
 * speed-dependent friction-drop exponent); its absolute creep numbers are indicative only.
 */
export const CRITICAL_CREEP: Record<RailCondition, number> = { dry: 0.015, rain: 0.025, snow: 0.035, leaf: 0.04 };
/**
 * Large-slip friction ratio μ∞/μ0 (Polach 2005, "Creep forces in simulations of traction vehicles
 * running on adhesion limit", Wear 258: A = 0.40 for dry and wet contact).
 */
export const POLACH_A = 0.40;
/** Rate at which normalised creep runs away (or recovers) once past the adhesion peak, 1/s. ESTIMATE. */
export const CREEP_RUNAWAY_RATE = 4;
/** Upper bound of the normalised creep state (x = s/s_c). */
const CREEP_X_MAX = 12;

/**
 * Quasi-static creep-force characteristic, force / peak force versus x = s / s_c:
 * linear rise to the peak at x = 1 (2x/(1+x²), Kalker-like), then a falling branch towards
 * the large-slip level POLACH_A. Continuous, peak = 1 at x = 1. SIMPLIFIED Polach-style shape
 * (see CRITICAL_CREEP): the form is chosen for a stable inverse on the rising branch and the
 * Polach A = 0.40 large-slip limit — it is not Polach's published force law.
 */
export function creepForceFraction(x: number): number {
  const u = Math.abs(x);
  return u <= 1 ? (2 * u) / (1 + u * u) : POLACH_A + (1 - POLACH_A) * (2 / (1 + u * u));
}
/** Inverse on the stable (rising) branch: x for a force ratio r ∈ [0,1]. */
export function creepFromForceFraction(r: number): number {
  const q = Math.max(0, Math.min(1, r));
  return q < 1e-9 ? 0 : (1 - Math.sqrt(1 - q * q)) / q;
}

/** Curtius–Kniffler speed shape, normalised to 1 at standstill (v in km/h). Dry: 7.5/(v+44)+0.161; wet/contaminated: …+0.130. */
export function curtiusKnifflerFactor(speedKmh: number, condition: RailCondition = 'dry'): number {
  const c = condition === 'dry' ? 0.161 : 0.130;
  return (7.5 / (Math.abs(speedKmh) + 44) + c) / (7.5 / 44 + c);
}

/** Peak adhesion μ with sand cover 0…1 (boolean accepted: true = full cover). */
export function adhesionMu(condition: RailCondition, sanding: boolean | number): number {
  const cover = typeof sanding === 'number' ? Math.max(0, Math.min(1, sanding)) : sanding ? 1 : 0;
  const clean = RAIL_MU[condition];
  return clean + (Math.max(clean, SANDED_MU[condition]) - clean) * cover;
}

/**
 * Wheel-slip control (traction) — ESTIMATES. The Flexity's traction control is creep-
 * controlled: on slip the inverter holds the tractive effort just below the adhesion peak
 * (on the rising branch of the creep curve) instead of letting it fall. Fraction of the peak
 * that the controller holds: modern IGBT drive vs older diesel relays.
 */
export const SLIP_CONTROL_TE_FRAC_ELECTRIC = 0.95;
export const SLIP_CONTROL_TE_FRAC_DIESEL = 0.85;
/** Wheel-slide protection (brakes): fraction of the adhesion peak held while sliding. ESTIMATE. */
export const SLIDE_CONTROL_BRAKE_FRAC = 0.9;
/**
 * Large-slip force ratio without slip control / WSP (slipControl = false): once past the peak
 * the force falls along creepForceFraction towards this level (Polach 2005 A = 0.40).
 */
export const UNCONTROLLED_SLIP_FRAC = POLACH_A;
/** Automatic sanding keeps sanding this long after the last detected slip/slide (s). */
export const AUTO_SAND_HOLD_S = 3;

// ───────────────────────── running resistance ─────────────────────────
const LBF_N = 4.44822;
const SHORT_TON_T = 0.907185; // tonne per short ton
const MPH_PER_MS = 2.23694;
const FT2_PER_M2 = 10.7639;
/** 1 lb per short ton in N per tonne. */
const N_PER_T_PER_LB_TON = LBF_N / SHORT_TON_T;

/**
 * Davis (1926), "The Tractive Resistance of Electric Locomotives and Cars", Gen. Electric Review
 * Oct 1926, eq. (15) for light interurban / street-railway cars (lb per short ton, V mph):
 *     R = 1.3 + 29/w + b·V + C·A·V² / (w·n)
 * w = short tons per axle, n = axles, A = frontal area ft². Table II flange term b: motor cars in
 * trains 0.045, operated singly 0.09, locomotives 0.03; air coefficient C: 0.0024 for the leading
 * vehicle, 0.00034 for trailing cars in multiple-unit trains.
 */
export type DavisVehicle = { axles: number; flangeB: number; airNPerMs2: number };
const airN = (C: number, areaM2: number) => C * areaM2 * FT2_PER_M2 * LBF_N * MPH_PER_MS * MPH_PER_MS;
/**
 * Flexity Freedom: 6 axles; one articulated unit "operated singly" → b = 0.09; C = 0.0024; frontal
 * area 2.65 m × 3.6 m = 9.54 m² (Bombardier brochure width × height; a slight over-estimate of the
 * silhouette, Davis's typical A for 55 t+ cars is 115 ft² = 10.7 m²).
 */
export const DAVIS_FLEXITY: DavisVehicle = { axles: 6, flangeB: 0.09, airNPerMs2: airN(0.0024, 2.65 * 3.6) };
/**
 * Diesel loco + one coach (RS-18 + coach): 8 axles, b = 0.045 (motor car/locomotive in a train),
 * air 0.0024 on the loco's front (≈ 3.1 × 4.1 m, ESTIMATE) plus 0.00034 on the trailing coach
 * (≈ 3.0 × 3.8 m, ESTIMATE).
 */
export const DAVIS_DIESEL: DavisVehicle = { axles: 8, flangeB: 0.045, airNPerMs2: airN(0.0024, 3.1 * 4.1) + airN(0.00034, 3.0 * 3.8) };

/** Davis running resistance (N) for a vehicle of massKg at speed v (m/s). */
export function davisResistanceN(massKg: number, speedMs: number, veh: DavisVehicle): number {
  const v = Math.abs(speedMs);
  const tonnes = massKg / 1000;
  const wShortTonsPerAxle = (tonnes / SHORT_TON_T) / veh.axles;
  const lbPerTon = 1.3 + 29 / wShortTonsPerAxle + veh.flangeB * v * MPH_PER_MS;
  return lbPerTon * N_PER_T_PER_LB_TON * tonnes + veh.airNPerMs2 * v * v;
}

/**
 * Curve resistance in N/kN of weight on radius R (m). AREMA: 0.8 lb per short ton per degree of
 * curve = 0.4 N/kN per degree, degree of curve D = 1746.4 / R (100-ft chord). Cross-check vs the
 * Röckl formula (500/(R−30) N/kN for R < 300 m): R=100 m → 7.0 vs 7.1; R=200 m → 3.5 vs 2.9.
 * Below R ≈ 50 m both are extrapolations (Röckl diverges at 30 m); the Flexity minimum is 25 m.
 * ESTIMATE in that range — no tram-specific tight-curve figure was found.
 */
export function curveResistanceNPerKn(radiusM: number): number {
  if (!Number.isFinite(radiusM) || radiusM <= 0) return 0;
  const R = Math.max(MIN_CURVE_RADIUS_M, radiusM);
  return 0.4 * (1746.4 / R);
}
/** Röckl curve resistance (N/kN), R < 300 m branch — used only as a cross-check in the tests. */
export function rocklCurveResistanceNPerKn(radiusM: number): number {
  return radiusM < 300 ? 500 / (radiusM - 30) : 650 / (radiusM - 55);
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
 * Curve equilibrium + unbalance budget for the curve-speed formula (mm). TCRP Report 57
 * (Track Design Handbook for LRT, 2000) §3.2.5.2: actual superelevation Ea 100 mm desired /
 * 150 mm absolute, unbalanced superelevation Eu 75 mm (3 in) desired / 115 mm (4.5 in)
 * absolute, "equates to the 0.1 g limit that passengers can tolerate comfortably" (§2.4.6.2).
 * The sim posts the absolute limit (114 mm, Ea + Eu with the street track's Ea ≈ 0), i.e.
 * lateral acceleration g·Eu/1500 = 0.75 m/s² = 0.076 g < 0.1 g. The TCRP 155 curve-speed formula
 * below is the same equation.
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

/** Lateral (unbalanced) acceleration in m/s² at speed v (m/s) on radius R with the given Ea (m). */
export function lateralAccel(speedMs: number, radiusM: number, actualCantM = 0, railCentresM = 1.5): number {
  return (speedMs * speedMs) / Math.max(MIN_CURVE_RADIUS_M, radiusM) - 9.81 * (actualCantM / railCentresM);
}

export function isOverspeed(speedKmh: number, limitKmh: number, margin = 2): boolean {
  return speedKmh > limitKmh + margin;
}

/**
 * ATP-style overspeed supervision. The driver's HUD warning stays at limit + 2 km/h (isOverspeed).
 * Penalty (full-service) brake with traction cut-out is applied at limit + 5 km/h and released when
 * the speed is back at or below the limit. NO SOURCE: the +5 km/h penalty margin is an ESTIMATE
 * (no published ION/Freedom overspeed-enforcement figure was found); it only needs to sit above
 * the +2 km/h HUD warning and well below a dangerous overspeed. The vehicle maximum (80 km/h,
 * VMAX_*) is enforced the same way instead of a hard clamp.
 */
export const OVERSPEED_PENALTY_MARGIN_KMH = 5;
/** Backstop: speed is hard-limited only this factor above the vehicle maximum (e.g. a runaway downhill). */
export const VMAX_BACKSTOP_FACTOR = 1.1;

/**
 * Speed after dt on the jerk-limited stopping profile v' = −√(2·J·v) (deceleration a = √(2·J·v)
 * falls to zero at rest at exactly the jerk J): v(t) = (√v₀ − √(J/2)·t)², exact for any dt.
 */
export function jerkLimitedSpeed(v: number, jerk: number, dt: number): number {
  const r = Math.sqrt(Math.max(0, v)) - Math.sqrt(jerk / 2) * dt;
  return r > 0 ? r * r : 0;
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
  /** Wet-leaf film on the rail (autumn). Overrides rain; snow/ice keeps its own condition. */
  leafFall = false;
  pantographUp = true;
  doorsOpen = false;
  wheelslip = false;
  lineVoltage = 750;
  vigilanceTimer = 45;
  deadmanOk = true;
  /** Emergency brake (friction at full service + magnetic track brake). Applied by a vigilance failure. */
  emergencyBrake = false;
  /**
   * Automatic hold brake (standstill brake). Real LRVs apply it at standstill and keep it
   * until tractive effort can overcome gravity in the selected direction. Also forced
   * while the doors are open or traction is interlocked, so clearing the service brake
   * can never let the car roll away (v1.4.0 rolled back at −1.5 km/h with doors open).
   */
  holdBrake = false;
  /** Creep-controlled traction + wheel-slide protection (real Flexity / modern locos). */
  slipControl = true;
  /** Automatic sanding on wheelslip / slide (driver Shift = manual sanding). */
  autoSand = true;
  /** Seconds of automatic sanding left (re-armed while slipping). */
  autoSandTimer = 0;
  /** Sand cover on the rail head 0…1 (ramps up while sanding, fades afterwards). */
  sandCover = 0;
  /** Normalised creep x = s/s_c of the powered axles (traction) and of all axles (braking). > 1 = past the adhesion peak. */
  creepXTraction = 0;
  creepXBrake = 0;
  /** ATP-style penalty brake: set by enforceSpeedLimit() on overspeed, cleared when back under the limit. */
  overspeedPenalty = false;
  /**
   * Jerk-limited command states (accelerations, m/s²): demanded traction, friction brake and
   * magnetic track brake after the jerk limiter. Forces are these × the effective mass.
   */
  cmdTractionA = 0;
  cmdFrictionA = 0;
  cmdTrackA = 0;
  /** Hold-brake application, m/s² (ramped up; released at once). */
  cmdHoldA = 0;

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

  /** Effective (inertial) mass incl. rotating parts, kg. */
  effMassKg() { return this.massKg * ROTATING_MASS_FACTOR; }

  /** Sand reaching the rail: manual (Shift) or automatic after a slip. */
  sandActive() {
    return this.sanding || (this.autoSand && this.autoSandTimer > 0);
  }

  /** Current rail-head condition (weather, or wet leaves when leafFall and not snowing). */
  railCondition(): RailCondition {
    return this.leafFall && this.weather !== 'snow' ? 'leaf' : this.weather;
  }

  baseMu() {
    return adhesionMu(this.railCondition(), this.sandCover);
  }

  /** Creep (fraction, e.g. 0.012 = 1.2 %) of the powered axles. */
  creepTraction() { return this.creepXTraction * CRITICAL_CREEP[this.railCondition()]; }
  creepBrake() { return this.creepXBrake * CRITICAL_CREEP[this.railCondition()]; }

  /** Max traction effort N vs speed (simplified Flexity / diesel curve). */
  maxTE(speedMs: number) {
    if (this.electric) {
      if (!this.pantographUp || !(this.lineVoltage >= 500)) return 0;
      // Motor power: 4 × 100 kW three-phase asynchronous motors = 400 kW — SOURCE: Bombardier
      // FLEXITY Outlook (Innsbruck) data sheet "Four 3-phase asynchronous motors, 100 kW motor
      // power", same Bo'2Bo' layout with 2 powered bogies (also strassenbahn-online.de data table
      // for the Outlook family: 4 × 100 kW). The Freedom's own motor rating is not published, so
      // 400 kW is sibling-platform data (v1.4.4's 320 kW was an unsourced 4 × 80 kW guess).
      // Starting TE 62 kN = 1.0 m/s² at 56 t × 1.08 rotating mass — the Outlook sheet's average
      // acceleration (2/3 load) of 1 m/s². ESTIMATE. Consistency: 62 kN × 6.45 m/s = 400 kW, i.e.
      // constant-TE up to 23 km/h and constant power (TE = P/v) above.
      const te0 = 62000;
      const pMax = 400000 * (this.lineVoltage / 750);
      if (speedMs < 1) return te0;
      return Math.min(te0, pMax / speedMs);
    }
    // RS-18 class: ~178 kN starting TE, ~1340 kW — adhesion usually binds first
    const te0 = 178000;
    const pMax = 1340000;
    if (speedMs < 1) return te0;
    return Math.min(te0, pMax / speedMs);
  }

  /** Davis (1926) eq. 15 running resistance, N — see DAVIS_FLEXITY / DAVIS_DIESEL. */
  davisResistance(speedMs: number) {
    return davisResistanceN(this.massKg, speedMs, this.electric ? DAVIS_FLEXITY : DAVIS_DIESEL);
  }

  /**
   * Grade force N (+ uphill). `grade` = rise/run (Track.grade, i.e. tan θ); the along-track
   * component of weight is m·g·sin θ = m·g·grade/√(1+grade²). (v1.4.4's Track stored sin θ under
   * the name "rise/run", so this conversion was applied twice; Track now stores true rise/run.)
   */
  gradeForce(grade: number) {
    return this.massKg * 9.81 * (grade / Math.sqrt(1 + grade * grade));
  }

  /**
   * Curve resistance (N): AREMA 0.4 N/kN per degree (see curveResistanceNPerKn).
   * v1.3 used `mass·g·(600/R)·0.05`, which was ~40× too large (165 kN at R=100 m,
   * 331 kN at R≤50 m — far above the 62 kN starting TE) and stalled the LRV on any
   * densified-polyline kink (e.g. near Northfield / Block Line).
   */
  curveResistance(curvature: number) {
    const k = Math.abs(curvature);
    if (!Number.isFinite(k) || k < 1e-5) return 0;
    return (this.massKg * 9.81 / 1000) * curveResistanceNPerKn(1 / k);
  }

  /** Speed-dependent available adhesion (Curtius–Kniffler shape, normalised to 1 at standstill). */
  adhesionAt(speedMs: number) {
    return this.baseMu() * curtiusKnifflerFactor(Math.abs(speedMs) * 3.6, this.railCondition());
  }

  /**
   * Highest braking deceleration (m/s², vs inertial mass) the rail can give at this speed.
   * All axles brake, and the wheel–rail normal force is m·g·cos θ (cos θ = 1/√(1+grade²) for a
   * rise/run grade); v1.4.4 omitted that factor on the brake side only.
   */
  adhesionDecel(speedMs: number, grade = 0) {
    const g = Number.isFinite(grade) ? grade : 0;
    return (this.adhesionAt(speedMs) * 9.81) / Math.sqrt(1 + g * g) / ROTATING_MASS_FACTOR;
  }

  /**
   * ATP-style overspeed supervision (call once per frame with the civil/curve limit at the train).
   * Penalty service brake + traction cut-out above limit + OVERSPEED_PENALTY_MARGIN_KMH, released
   * when the speed is back at or below the limit. The vehicle maximum is enforced the same way.
   * Returns whether the penalty is active.
   */
  enforceSpeedLimit(limitKmh: number): boolean {
    const lim = Math.min(Number.isFinite(limitKmh) ? limitKmh : Infinity, this.vMaxMs() * 3.6);
    const v = this.speedKmh();
    if (!Number.isFinite(v)) this.overspeedPenalty = false;
    else if (v > lim + OVERSPEED_PENALTY_MARGIN_KMH) this.overspeedPenalty = true;
    else if (v <= lim) this.overspeedPenalty = false;
    return this.overspeedPenalty;
  }

  private lastResult = { te: 0, a: 0, resist: 0, Fbrake: 0, demandTE: 0, demandBrake: 0, maxAdhesion: 0, creepTraction: 0, creepBrake: 0 };

  /** Replace any non-finite or out-of-range state/input with a safe value so one bad frame cannot poison later ones. */
  private sanitize() {
    const fin = (x: number, d: number) => (Number.isFinite(x) ? x : d);
    this.speed = fin(this.speed, 0);
    this.sandCover = Math.max(0, Math.min(1, fin(this.sandCover, 0)));
    this.autoSandTimer = Math.max(0, fin(this.autoSandTimer, 0));
    this.vigilanceTimer = fin(this.vigilanceTimer, 45);
    this.creepXTraction = Math.max(0, fin(this.creepXTraction, 0));
    this.creepXBrake = Math.max(0, fin(this.creepXBrake, 0));
    this.cmdTractionA = fin(this.cmdTractionA, 0);
    this.cmdFrictionA = fin(this.cmdFrictionA, 0);
    this.cmdTrackA = fin(this.cmdTrackA, 0);
    this.cmdHoldA = fin(this.cmdHoldA, 0);
    this.lineVoltage = fin(this.lineVoltage, 0);
    this.powerNotch = Math.max(0, Math.min(8, fin(this.powerNotch, 0)));
    this.brakeNotch = Math.max(0, Math.min(8, fin(this.brakeNotch, 0)));
  }

  /**
   * Jerk limiter. Moves each command towards its target while the sum of the time each channel
   * would need at its own jerk limit stays within dt, so the net rate of change of acceleration
   * never exceeds the largest single limit (traction and brake changes share the budget).
   */
  private ramp(dt: number, targets: number[], current: number[], jerk: number[]): number[] {
    let need = 0;
    for (let i = 0; i < targets.length; i++) need += Math.abs(targets[i] - current[i]) / jerk[i];
    const k = need > dt ? dt / need : 1;
    return current.map((c, i) => c + (targets[i] - c) * k);
  }

  step(dt: number, grade: number, curvature: number) {
    // Guard dt and every input: a NaN/∞/≤0 dt is a skipped frame, not a poisoned state.
    if (!Number.isFinite(dt) || dt <= 0 || !(this.massKg > 0)) return { ...this.lastResult };
    dt = Math.min(dt, MAX_STEP_DT_S);
    this.sanitize();
    if (!Number.isFinite(grade)) grade = 0;
    if (!Number.isFinite(curvature)) curvature = 0;
    grade = Math.max(-1, Math.min(1, grade));

    // Sand reaches the rail with a delay and leaves a film behind
    this.sandCover = this.sandActive()
      ? Math.min(1, this.sandCover + dt / SAND_RAMP_UP_S)
      : Math.max(0, this.sandCover - dt / SAND_FADE_S);

    // Doors interlock / reverser / vigilance / overspeed penalty
    const canPower = !this.doorsOpen && this.reverser !== 0 && this.deadmanOk && !this.overspeedPenalty;
    const notchP = canPower ? this.powerNotch : 0;
    const mEff = this.effMassKg();
    const absV = Math.abs(this.speed);

    // ── jerk-limited commands (m/s²) ──
    const emergency = this.emergencyBrake;
    const frictionNotch = emergency || this.overspeedPenalty ? 8 : this.brakeNotch;
    const tgtTE = (notchP / 8) * this.maxTE(absV) / mEff;
    const tgtFric = (frictionNotch / 8) * SERVICE_BRAKE_DECEL;
    const tgtTrack = emergency && absV > TRACK_BRAKE_MIN_SPEED_MS ? TRACK_BRAKE_DECEL * TRACK_BRAKE_CONDITION_FACTOR[this.railCondition()] : 0;
    // Hold brake: applied with the service jerk limit, released at once (TE is ramped, so the net force stays continuous)
    const tgtHold = this.holdBrake ? (this.massKg * HOLD_BRAKE_DECEL) / mEff : 0;
    // Traction cut-out on an emergency / interlock is immediate (EN 13452-1 §5.1.3: traction is cut off at once)
    if (!canPower) this.cmdTractionA = 0;
    if (!this.holdBrake) this.cmdHoldA = 0;
    const jFric = emergency ? JERK_EMERGENCY_BRAKE_MS3 : JERK_SERVICE_BRAKE_MS3;
    const [cT, cF, cK, cH] = this.ramp(
      dt,
      [canPower ? tgtTE : 0, tgtFric, tgtTrack, tgtHold],
      [this.cmdTractionA, this.cmdFrictionA, this.cmdTrackA, this.cmdHoldA],
      [JERK_TRACTION_MS3, jFric, JERK_EMERGENCY_BRAKE_MS3, JERK_SERVICE_BRAKE_MS3],
    );
    this.cmdTractionA = cT; this.cmdFrictionA = cF; this.cmdTrackA = cK; this.cmdHoldA = cH;

    const demandTE = this.cmdTractionA * mEff;
    // Powered-axle adhesion weight (not full consist mass), normal force on grade
    const cosT = 1 / Math.sqrt(1 + grade * grade);
    const axleLoad = this.massKg * 9.81 * this.axleFrac * cosT;
    const peakT = this.adhesionAt(this.speed) * axleLoad;

    // Brakes: blended regen + friction at SERVICE_BRAKE_DECEL (B8), limited by adhesion
    // (brake adhesion uses all axles: friction brakes on the trailer truck too, normal force
    // m·g·cos θ like traction); the emergency brake adds the magnetic track brake, which does
    // not depend on wheel–rail adhesion (but does on rail contamination: TRACK_BRAKE_CONDITION_FACTOR).
    const demandBrake = this.cmdFrictionA * mEff;
    const peakB = this.adhesionAt(this.speed) * this.massKg * 9.81 * cosT;

    const teSlip = notchP > 0 && demandTE > peakT;
    const brakeSlip = demandBrake > 0 && absV > 0.05 && demandBrake > peakB;
    this.wheelslip = teSlip || brakeSlip;

    // Creep-force curve: held on the rising branch (slip control / WSP), or — without it —
    // sliding past the peak down the falling branch until demand drops below the available force.
    const teFrac = this.electric ? SLIP_CONTROL_TE_FRAC_ELECTRIC : SLIP_CONTROL_TE_FRAC_DIESEL;
    let te = 0;
    if (demandTE <= 0 || peakT <= 0) { this.creepXTraction = 0; }
    else if (this.slipControl) {
      te = Math.min(demandTE, teFrac * peakT);
      this.creepXTraction = creepFromForceFraction(te / peakT);
    } else {
      [te, this.creepXTraction] = this.creepLimited(demandTE, peakT, this.creepXTraction, dt);
    }

    let Fbrake = 0;
    if (demandBrake <= 0 || absV <= 0.05) {
      // near rest the creep state is not integrated, but WSP still holds the same fraction of the peak as
      // above 0.05 m/s (an un-derated peak here was a 0.2 m/s² step in the last metres of a leaf stop)
      Fbrake = Math.min(demandBrake, this.slipControl ? SLIDE_CONTROL_BRAKE_FRAC * peakB : peakB);
      this.creepXBrake = 0;
    } else if (this.slipControl) {
      Fbrake = Math.min(demandBrake, SLIDE_CONTROL_BRAKE_FRAC * peakB);
      this.creepXBrake = creepFromForceFraction(Fbrake / peakB);
    } else {
      [Fbrake, this.creepXBrake] = this.creepLimited(demandBrake, peakB, this.creepXBrake, dt);
    }
    const FfrictionStatic = Fbrake; // service friction only (static case adds the full hold brake)
    Fbrake += mEff * this.cmdTrackA;

    // Automatic sanding: armed by any slip/slide, sands for AUTO_SAND_HOLD_S afterwards
    if (this.autoSand && this.wheelslip) this.autoSandTimer = AUTO_SAND_HOLD_S;
    else this.autoSandTimer = Math.max(0, this.autoSandTimer - dt);

    const resist = this.davisResistance(this.speed) + this.curveResistance(curvature);
    const Fgrade = this.gradeForce(grade);
    const dir = this.reverser === 0 ? 0 : this.reverser;

    // Hold brake: engage at standstill (or ≤ HOLD_BRAKE_MS with doors open / interlock),
    // release only when TE in the selected direction beats the grade force.
    const interlocked = !canPower || (this.electric && (!this.pantographUp || !(this.lineVoltage >= 500)));
    const tractionWins = dir !== 0 && notchP > 0 && dir * (dir * te - Fgrade) > 0;
    const slowEnough = absV < (this.doorsOpen || interlocked ? HOLD_BRAKE_MS : STANDSTILL_MS);
    if (tractionWins && !this.doorsOpen) this.holdBrake = false;
    else if (slowEnough) this.holdBrake = true;
    else if (absV >= HOLD_BRAKE_MS) this.holdBrake = false;
    if (!this.holdBrake) this.cmdHoldA = 0;
    const FholdFull = this.holdBrake ? this.massKg * HOLD_BRAKE_DECEL : 0;

    // Stop smoothing: a jerk-limited stop has a ≤ √(2·J·v) near rest, so braking force is tapered
    // instead of the v1.4.4 hard "speed = 0" snap (7.8 m/s² in one frame).
    //
    // v1.4.5 capped brake force above STANDSTILL_MS with gradeHold = max(0, −sv·Fgrade). On an
    // uphill stop that term is 0, so the moving branch ran at |a| = aCap + g·sinθ while the
    // static branch (< STANDSTILL_MS) followed the pure profile at |a| = aCap — a jump of
    // g·sinθ in one frame (Code Critic on 4.5 % at dt = 0.02: 22.98 m/s³ service /
    // 28.73 m/s³ emergency; even 1 % gave 6.08 / 10.26). Both branches now share one
    // grade-aware profile: desired decel aCap, clamped by the physical ceiling with grade
    // included, floor 0 so the ease-to-rest matches the flat-track comfort curve.
    const jStop = emergency ? JERK_EMERGENCY_BRAKE_MS3 : JERK_SERVICE_BRAKE_MS3;

    let a: number;
    const vStart = this.speed;
    const applied = dir * te - Fgrade;
    const FbrakeCmd = FfrictionStatic + mEff * this.cmdTrackA; // friction + track (ramped)
    const holdNow = this.holdBrake ? mEff * this.cmdHoldA : 0;
    const FbrakeTotal = FbrakeCmd + holdNow;
    const holdingFull = resist + FbrakeCmd + FholdFull;
    const aCap = absV > 0 ? (absV - jerkLimitedSpeed(absV, jStop, dt)) / dt : 0;
    // Under power that beats grade + resistance: force-integrate (traction path). Otherwise,
    // when the brakes can hold the car against grade, follow the shared jerk-limited stop
    // profile — same formula above and below STANDSTILL_MS, so the boundary is continuous.
    const pulling = dir !== 0 && notchP > 0 && dir * (dir * te - Fgrade) > resist;
    if (!pulling && Math.abs(applied) <= holdingFull) {
      if (absV === 0) {
        a = 0;
      } else {
        const sv = Math.sign(this.speed);
        // Physical decel ceiling with the current brakes (grade included):
        // F = dir·te − sv·(Fbrake+resist) − Fgrade  ⇒  (−sv)·a = (−sv·dir·te + Fbrake + resist + sv·Fgrade)/m
        const aCeil = Math.max(0, (-sv * dir * te + FbrakeTotal + resist + sv * Fgrade) / mEff);
        const aDecel = Math.min(aCap, aCeil); // floor 0: ease to rest on uphill like the flat profile
        this.speed = sv * Math.max(0, absV - aDecel * dt);
        a = (this.speed - vStart) / dt;
        // Report the brake force that realises aDecel (0 when the profile is coasting on grade)
        Fbrake = Math.min(FbrakeTotal, Math.max(0, aDecel * mEff - resist - sv * Fgrade + sv * dir * te));
      }
    } else if (absV < STANDSTILL_MS) {
      // Static and can't hold (or pulling against the brakes): reaction forces never push backwards.
      const holding = holdingFull;
      if (Math.abs(applied) <= holding) {
        a = 0;
        this.speed = 0;
      } else {
        a = (applied - Math.sign(applied) * holding) / mEff;
        this.speed += a * dt;
      }
    } else {
      // Moving under power, or brakes can't hold: force integration. Still taper the brake
      // channel with grade in the budget so a downhill runaway / partial-brake case stays
      // on the profile when the brakes have the capacity.
      const sv = Math.sign(this.speed);
      const FbrakeEff = Math.min(FbrakeTotal, Math.max(0, mEff * aCap - resist - sv * Fgrade));
      const F = dir * te - sv * (FbrakeEff + resist) - Fgrade;
      a = F / mEff;
      const next = this.speed + a * dt;
      // Resistive forces may stop the car but not reverse it within one step
      if (Math.sign(next) !== sv && Math.abs(dir * te - Fgrade) <= FbrakeEff + resist) {
        this.speed = 0;
      } else {
        this.speed = next;
      }
      Fbrake = FbrakeEff;
    }
    if (!Number.isFinite(this.speed)) this.speed = 0;

    // Vehicle maximum is enforced by the ATP-style penalty brake (enforceSpeedLimit); the hard
    // clamp is only a backstop a little above it.
    const vcap = this.vMaxMs() * VMAX_BACKSTOP_FACTOR;
    if (Math.abs(this.speed) > vcap) this.speed = Math.sign(this.speed) * vcap;

    // Vigilance: speed-dependent like real LRV/loco devices — it does not count down at
    // a standstill (v1.4.1 penalised a 45 s station dwell with an emergency brake).
    if (Math.abs(this.speed) > VIGILANCE_MIN_SPEED_MS) this.vigilanceTimer -= dt;
    if (notchP > 0 || this.brakeNotch > 0) this.vigilanceTimer = 45;
    if (this.vigilanceTimer <= 0) {
      this.deadmanOk = false;
      this.brakeNotch = Math.max(this.brakeNotch, 8);
      this.emergencyBrake = true; // vigilance penalty = emergency brake application
    }

    this.lastResult = { te, a, resist, Fbrake, demandTE, demandBrake, maxAdhesion: peakT, creepTraction: this.creepTraction(), creepBrake: this.creepBrake() };
    return { ...this.lastResult };
  }

  /**
   * One step of the uncontrolled creep state: returns [force, normalised creep]. Demand under the
   * peak → stable point on the rising branch. Demand above the peak → creep runs away along the
   * falling branch (force → POLACH_A × peak) until the demand falls below the force available at
   * the present creep; then creep recovers to the stable branch (hysteresis).
   */
  private creepLimited(demand: number, peak: number, x: number, dt: number): [number, number] {
    const r = demand / peak;
    let nx = x;
    if (r <= 1 && x <= 1) nx = creepFromForceFraction(r);
    else {
      nx = Math.max(x, 1);
      nx += (r > creepForceFraction(nx) ? 1 : -1) * CREEP_RUNAWAY_RATE * dt;
      nx = Math.max(0, Math.min(CREEP_X_MAX, nx));
      if (nx <= 1 && r <= 1) nx = creepFromForceFraction(r);
    }
    const f = nx <= 1 && r <= 1 ? demand : Math.min(demand, peak * creepForceFraction(nx));
    return [f, nx];
  }

  resetVigilance() {
    this.vigilanceTimer = 45;
    this.deadmanOk = true;
    this.emergencyBrake = false;
  }

  speedKmh() { return Math.abs(this.speed) * 3.6; }

  /** HUD / tutorial: why traction is cut (doors, N, vigilance, panto, voltage). */
  powerBlockedReason(): string | null {
    if (this.doorsOpen) return 'Doors open — close with T';
    if (this.reverser === 0) return 'Reverser Neutral — press R for Forward';
    if (this.overspeedPenalty) return 'Overspeed penalty brake — slow below the limit';
    if (!this.deadmanOk) return 'Vigilance penalty — notch W/S to reset';
    if (this.electric && !this.pantographUp) return 'Pantograph down — press P';
    if (this.electric && this.lineVoltage < 500) return 'Line voltage low';
    return null;
  }
}
