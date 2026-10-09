/**
 * Clearance / dimension constants used by the sim geometry.
 * Every value is listed with its source in docs/CLEARANCES.md. Values marked
 * ESTIMATE there could not be sourced from a public document.
 * Pure data — no three.js import (bundled by scripts/stress-test.mjs).
 */

/** Flexity Freedom 5-module (Bombardier brochure; Region of Waterloo Stage 2 EPR §4.2.1 uses 30 m × 2.65 m). */
export const LRV_LENGTH_M = 30.8;
export const LRV_WIDTH_M = 2.65;
/** Height over top of rail, pantograph lowered (Bombardier brochure). */
export const LRV_HEIGHT_M = 3.6;
/** Minimum horizontal curve radius (Bombardier brochure; Stage 2 EPR Table 4-2). */
export const LRV_MIN_RADIUS_M = 25;

/**
 * Module layout nose→tail (ESTIMATE: proportions scaled from Bombardier's published
 * dimensioned drawing of the 5-module Flexity Outlook family car 6763/7670/3500/7670/6763 mm
 * to the Freedom's 30.8 m; Freedom uses the same Bo'2Bo' end-module-powered concept,
 * Railway Gazette 2011).
 * kind: 'truck' = body carried by its own truck (end cab modules + centre module),
 *       'suspended' = hung between neighbours, no truck.
 */
const SCALE = LRV_LENGTH_M / 32.366;
export const MODULES: { len: number; kind: 'truck' | 'suspended'; name: string }[] = [
  { len: 6.763 * SCALE, kind: 'truck', name: 'A-cab' },
  { len: 7.670 * SCALE, kind: 'suspended', name: 'B' },
  { len: 3.500 * SCALE, kind: 'truck', name: 'C-centre' },
  { len: 7.670 * SCALE, kind: 'suspended', name: 'D' },
  { len: 6.763 * SCALE, kind: 'truck', name: 'E-cab' },
];
/**
 * Truck centres measured from the leading nose (ESTIMATE, scaled from the same drawing:
 * 5013 / 11170 / 11170 / 5013 mm nose→truck→truck→truck→nose).
 * 0 = power truck under A, 1 = trailer truck under C, 2 = power truck under E.
 */
export const TRUCK_FROM_NOSE_M = [5.013 * SCALE, (5.013 + 11.17) * SCALE, (5.013 + 2 * 11.17) * SCALE];
/** Half truck wheelbase for pitch sampling (ESTIMATE, typical LRV 1.8–1.9 m wheelbase). */
export const TRUCK_HALF_WHEELBASE_M = 0.925;
/** Floor height above top of rail at doors (ESTIMATE — Flexity family low-floor entrance ~0.31–0.35 m). */
export const LRV_FLOOR_ATR_M = 0.33;

/** Platform height above top of rail. ESTIMATE cross-checked (see CLEARANCES.md). */
export const PLATFORM_HEIGHT_ATR_M = 0.30;
/** Track centreline → platform edge (Metrolinx LRT DCM B1.6.2, same Flexity Freedom fleet). */
export const PLATFORM_EDGE_OFFSET_M = 1.40;
/** Platform length / width (Stage 2 ION EPR §4.2.2, "consistent with Stage 1"). */
export const PLATFORM_LENGTH_M = 65;
export const PLATFORM_WIDTH_M = 3.5;

/** GO / heavy-rail platform (Metrolinx GTS-3004 / Level Boarding guideline): 127 mm ATR, edge 1632 mm. */
export const GO_PLATFORM_HEIGHT_ATR_M = 0.127;
export const GO_PLATFORM_EDGE_OFFSET_M = 1.632;

/** Nominal OCS contact wire height (Metrolinx LRT DCM C1.6.2). */
export const OCS_WIRE_HEIGHT_STREET_M = 5.5; // semi-exclusive / mixed-traffic
export const OCS_WIRE_HEIGHT_RESERVED_M = 4.8; // exclusive ROW at grade
/** Pole face offset from track centreline (ESTIMATE ≥ dynamic envelope + 50 mm, DCM B1.6.5). */
export const OCS_POLE_OFFSET_M = 2.9;
/** Pole spacing (ESTIMATE; typical urban auto-tensioned catenary spans 40–60 m). */
export const OCS_POLE_SPACING_M = 50;

/** ION double-track tangent centres (Metrolinx LRT DCM B1.3.2 / B1.6.5 minimum). */
export const LRT_TRACK_CENTRES_M = 3.72;
/** Freight main-track centres (Transport Canada TC E-05 §5.1). */
export const FREIGHT_TRACK_CENTRES_M = 3.96;
/** TC E-05 Diagram 1: structure beside track, min from centreline (8'-4¼"). */
export const FREIGHT_SIDE_CLEARANCE_M = 2.546;
/** TC E-05 Diagram 1: min vertical clearance above TOR, non-electrified lines (22'-0"). */
export const FREIGHT_VERTICAL_CLEARANCE_M = 6.706;
/** TC E-05 §3.1(e): lateral allowance per degree of curve (m). */
export const CURVE_ALLOWANCE_PER_DEG_M = 0.0254;
/** Dynamic envelope to obstruction (Metrolinx LRT DCM B1.6.5). */
export const ENVELOPE_MARGIN_M = 0.05;
/** LRV body sway allowance each side (ESTIMATE). */
export const LRV_SWAY_M = 0.10;

/** Max design grade (Stage 2 ION EPR Table 4-2: 6 %); sim clamps DEM noise to 5 %. */
export const LRT_MAX_GRADE = 0.06;

/** Ballast / embedded formation (ESTIMATE — typical North American LRT sections). */
export const BALLAST_TOP_HALF_WIDTH_M = 1.6;
export const FORMATION_HALF_WIDTH_M = 3.2;
export const RAIL_BASE_BELOW_TRACK_Y_M = 0.0; // Track y = rail base / top of tie
export const FORMATION_DEPTH_M = 0.45; // track y → subgrade (tie + ballast depth)
export const CUT_SLOPE_H_PER_V = 2; // 2H:1V cut
export const FILL_SLOPE_H_PER_V = 2; // 2H:1V embankment
/** Above this fill height (m) render a bridge/viaduct instead of an embankment (ESTIMATE). */
export const BRIDGE_MIN_FILL_M = 6;

/** Max actual superelevation applied on ballasted reserved ROW (ESTIMATE, AREMA-typical LRT ≤ 150 mm). */
export const MAX_SUPERELEVATION_M = 0.10;
export const GAUGE_M = 1.435;
export const RAIL_CENTRES_M = 1.5;

/** Static swept-path offsets for a module on radius R: inner mid-chord sag & outer end throw (m). */
export function sweptOffsets(R: number, bogieCentres: number, overhang: number) {
  const r = Math.max(LRV_MIN_RADIUS_M, Math.abs(R));
  const inner = (bogieCentres * bogieCentres) / (8 * r);
  const outer = ((bogieCentres / 2 + overhang) ** 2 - (bogieCentres / 2) ** 2) / (2 * r);
  return { inner, outer };
}

/** Rail head top above Track point y (m) — Track y is mid-rail. */
export const RAIL_TOP_ABOVE_TRACK_Y_M = 0.09;

/**
 * Half-width of the LRV static swept envelope on radius R (m) + sway + DCM margin.
 * Governing cases: suspended module mid-chord sag (inside) and cab-nose throw (outside).
 */
export function envelopeHalfWidth(R: number) {
  const r = Math.max(LRV_MIN_RADIUS_M, Math.abs(R));
  const span = MODULES[1].len + 0.6; // joint-to-joint incl. bellows
  const inner = (span * span) / (8 * r);
  const a = TRUCK_FROM_NOSE_M[0];
  const half = LRV_WIDTH_M / 2;
  const outer = Math.hypot(r + half, a) - (r + half);
  return half + LRV_SWAY_M + Math.max(inner, outer) + ENVELOPE_MARGIN_M;
}
