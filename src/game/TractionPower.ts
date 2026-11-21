/**
 * Stage 1 ION traction-power model: 750 V DC Siemens Sitras modular TPSS
 * and a simple resistive overhead/return network.
 *
 * 400 kW / 62 kN vehicle ratings are unchanged (Physics.maxTE). Auxiliary kW,
 * loop resistance, and the downtown Kitchener site are ESTIMATES — see comments.
 *
 * Substation coordinates: OpenStreetMap `power=substation` + `substation=traction`
 * near railway=light_rail (ODbL, © OpenStreetMap contributors), queried 20 Nov 2026.
 * Names and “nearest station” labels are descriptive, not official Region numbers.
 */
import * as THREE from 'three';
import { haversineM, lonLatToLocal } from './coords';

/** EN 50163:2004 / IEC 60850 Table 1 for a 750 V DC system. */
export const UN_V = 750;
export const UMIN_V = 500;
export const UMAX1_V = 900;
export const UMAX2_V = 1000;

/**
 * Loop resistance of contact wire + messenger + rail return, ohm/km.
 * ESTIMATE: 150 mm² Cu contact ~0.12 Ω/km, paralleled with the messenger and
 * a rail return, typical 750 V LRT simple-catenary order of magnitude.
 */
export const LOOP_OHM_PER_KM = 0.15;
/** Floor so a train sitting on a TPSS site does not divide by zero. */
export const MIN_FEED_DISTANCE_M = 50;

/**
 * Auxiliary converter + HVAC load (kW) while the pantograph is up.
 * ESTIMATE — no ION or Freedom aux/HVAC figure is published.
 */
export const AUX_LOAD_KW = 40;

/** Same cap as Physics.maxTE electric power at 750 V (do not change the vehicle rating). */
export const TRACTION_POWER_W = 400_000;

export type TpssConfidence = 'high' | 'medium-high' | 'estimated';

export type TpssSite = {
  id: string;
  name: string;
  lat: number;
  lon: number;
  nearestStation: string;
  /** OSM way id, or null for the unmapped official-site placeholder. */
  osmWay: number | null;
  source: string;
  confidence: TpssConfidence;
  /** True for the downtown gap filler — not an OSM feature. */
  estimated?: boolean;
  /** Yard/shop (electrically segregated from the mainline in the AECOM design). */
  omsf?: boolean;
};

/**
 * Mapped ION-style traction substations plus one ESTIMATED downtown placeholder
 * (AECOM: 13 TPSS / 12 mainline; OSM had a 2.4 km gap from Grand River Hospital
 * to Kitchener Market with no traction box).
 */
export const TPSS_SITES: readonly TpssSite[] = [
  {
    id: 'omsf-northfield',
    name: 'OMSF / Northfield',
    lat: 43.4975976,
    lon: -80.5431889,
    nearestStation: 'Northfield (518 Dutton Dr)',
    osmWay: 878420648,
    source: 'OSM way 878420648 (GRT, 13800;750) + 878420649',
    confidence: 'high',
    omsf: true,
  },
  {
    id: 'northfield-interlocking',
    name: 'Northfield interlocking',
    lat: 43.4957897,
    lon: -80.5421354,
    nearestStation: 'Northfield',
    osmWay: 886576473,
    source: 'OSM way 886576473 (substation=traction, 181 m from Northfield)',
    confidence: 'high',
    omsf: true,
  },
  {
    id: 'conestoga',
    name: 'Conestoga',
    lat: 43.4988108,
    lon: -80.5296633,
    nearestStation: 'Conestoga',
    osmWay: 1524238647,
    source: 'OSM way 1524238647 (GRT, 13800;750) + 881139599',
    confidence: 'high',
  },
  {
    id: 'bearinger',
    name: 'Bearinger',
    lat: 43.4857754,
    lon: -80.5448289,
    nearestStation: 'Research and Technology',
    osmWay: 1524238448,
    source: 'OSM way 1524238448 (GRT, 13800;750)',
    confidence: 'high',
  },
  {
    id: 'university',
    name: 'University of Waterloo',
    lat: 43.4763388,
    lon: -80.5433642,
    nearestStation: 'University of Waterloo',
    osmWay: 883462122,
    source: 'OSM way 883462122 (GRT, 13800;750)',
    confidence: 'high',
  },
  {
    id: 'waterloo-park',
    name: 'Waterloo Park',
    lat: 43.4663012,
    lon: -80.5316028,
    nearestStation: 'Laurier–Waterloo Park',
    osmWay: 602291969,
    source: 'OSM way 602291969 (substation=traction, no operator tag)',
    confidence: 'medium-high',
  },
  {
    id: 'grand-river-hospital',
    name: 'Grand River Hospital',
    lat: 43.4567084,
    lon: -80.5094134,
    nearestStation: 'Grand River Hospital',
    osmWay: 1557992536,
    source: 'OSM way 1557992536 (substation=traction)',
    confidence: 'medium-high',
  },
  {
    id: 'downtown-kitchener',
    name: 'Downtown Kitchener',
    lat: 43.4518,
    lon: -80.4945,
    nearestStation: 'Central / City Hall',
    osmWay: null,
    source: 'ESTIMATE — placeholder in the OSM gap between GRH and Market (AECOM 12 mainline sites)',
    confidence: 'estimated',
    estimated: true,
  },
  {
    id: 'kitchener-market',
    name: 'Kitchener Market',
    lat: 43.4463326,
    lon: -80.4830793,
    nearestStation: 'Kitchener Market',
    osmWay: 1265693919,
    source: 'OSM way 1265693919 (GRT, 13800;750)',
    confidence: 'high',
  },
  {
    id: 'borden',
    name: 'Borden',
    lat: 43.4422227,
    lon: -80.4756406,
    nearestStation: 'Borden',
    osmWay: 1524238950,
    source: 'OSM way 1524238950 (GRT, 13800;750)',
    confidence: 'high',
  },
  {
    id: 'overland',
    name: 'Overland',
    lat: 43.4295126,
    lon: -80.4728731,
    nearestStation: 'Mill',
    osmWay: 1524238951,
    source: 'OSM way 1524238951 (GRT, 13800;750)',
    confidence: 'high',
  },
  {
    id: 'block-line',
    name: 'Block Line',
    lat: 43.4218942,
    lon: -80.4622701,
    nearestStation: 'Block Line',
    osmWay: 1524238953,
    source: 'OSM way 1524238953 (GRT, 13800;750)',
    confidence: 'high',
  },
  {
    id: 'fairway',
    name: 'Fairway',
    lat: 43.421963,
    lon: -80.4436022,
    nearestStation: 'Fairway',
    osmWay: 1524238952,
    source: 'OSM way 1524238952 (GRT, 13800;750)',
    confidence: 'high',
  },
];

export type VoltageBand =
  | 'undervoltage'
  | 'low'
  | 'nominal'
  | 'high'
  | 'regen'
  | 'overvoltage';

export function voltageBand(volts: number): VoltageBand {
  if (!Number.isFinite(volts) || volts < UMIN_V) return 'undervoltage';
  if (volts < 700) return 'low';
  if (volts <= 800) return 'nominal';
  if (volts <= UMAX1_V) return 'high';
  if (volts <= UMAX2_V) return 'regen';
  return 'overvoltage';
}

export type NearbyTpss = {
  site: TpssSite;
  distanceM: number;
};

export function nearestSubstations(lat: number, lon: number, n = 2, sites: readonly TpssSite[] = TPSS_SITES): NearbyTpss[] {
  return sites
    .map((site) => ({ site, distanceM: haversineM([lon, lat], [site.lon, site.lat]) }))
    .sort((a, b) => a.distanceM - b.distanceM)
    .slice(0, Math.max(1, n));
}

/** Parallel feed resistance from every TPSS: 1/R = Σ 1/(r · d_km), d ≥ 50 m. */
export function equivalentResistanceOhm(lat: number, lon: number, sites: readonly TpssSite[] = TPSS_SITES): number {
  let sum = 0;
  for (const site of sites) {
    const dM = Math.max(MIN_FEED_DISTANCE_M, haversineM([lon, lat], [site.lon, site.lat]));
    const r = LOOP_OHM_PER_KM * (dM / 1000);
    if (r > 0) sum += 1 / r;
  }
  return sum > 0 ? 1 / sum : 10;
}

export type PowerSampleIn = {
  lat: number;
  lon: number;
  /** Traction electrical power at the pantograph, W. Motoring > 0, regen < 0. */
  tractionPowerW: number;
  pantographUp: boolean;
  /** Override aux (tests). Default AUX_LOAD_KW when the pan is up. */
  auxKw?: number;
  sites?: readonly TpssSite[];
};

export type PowerSample = {
  voltageV: number;
  currentA: number;
  /** Total line power (traction + aux), kW. Motoring/draw > 0, regen < 0. */
  powerKw: number;
  tractionKw: number;
  auxKw: number;
  /** Regen that could not be accepted because the line hit Umax2, kW. */
  dumpedKw: number;
  pantographUp: boolean;
  band: VoltageBand;
  nearest: NearbyTpss;
  second: NearbyTpss | null;
  section: string;
};

function solveVoltage(iDrawA: number, reqOhm: number): number {
  const v = UN_V - iDrawA * reqOhm;
  if (!Number.isFinite(v)) return UN_V;
  return Math.max(0, Math.min(UMAX2_V, v));
}

/**
 * One-shot resistive load-flow at the train. Aux is a constant draw (estimate).
 * Regen raises the line; if it would exceed Umax2 the surplus is reported as dumpedKw
 * (resistor brake / unreceptive line).
 */
export function samplePower(input: PowerSampleIn): PowerSample {
  const sites = input.sites ?? TPSS_SITES;
  const near = nearestSubstations(input.lat, input.lon, 2, sites);
  const nearest = near[0]!;
  const second = near[1] ?? null;
  const section = second
    ? `${nearest.site.name} – ${second.site.name}`
    : `Fed by ${nearest.site.name}`;

  if (!input.pantographUp) {
    return {
      voltageV: 0,
      currentA: 0,
      powerKw: 0,
      tractionKw: 0,
      auxKw: 0,
      dumpedKw: 0,
      pantographUp: false,
      band: 'undervoltage',
      nearest,
      second,
      section,
    };
  }

  const auxW = (input.auxKw ?? AUX_LOAD_KW) * 1000;
  const req = equivalentResistanceOhm(input.lat, input.lon, sites);

  // Iterate once or twice: I = P / V, V = Un − I R. Start at Un.
  let v = UN_V;
  let tractionW = input.tractionPowerW;
  let dumpedW = 0;
  let i = 0;
  for (let k = 0; k < 4; k++) {
    const pLine = tractionW + auxW;
    i = pLine / Math.max(80, v);
    v = solveVoltage(i, req);
    if (tractionW < 0 && v >= UMAX2_V - 0.5) {
      // Line unreceptive: only the current that holds V at Umax2 is accepted.
      const iMax = (UN_V - UMAX2_V) / req; // negative
      const pAccept = iMax * UMAX2_V - auxW; // more negative = more regen accepted
      const want = input.tractionPowerW;
      if (want < pAccept) {
        dumpedW = pAccept - want;
        tractionW = pAccept;
        i = iMax;
        v = UMAX2_V;
      }
    }
  }

  const powerW = tractionW + auxW;
  return {
    voltageV: v,
    currentA: i,
    powerKw: powerW / 1000,
    tractionKw: tractionW / 1000,
    auxKw: auxW / 1000,
    dumpedKw: dumpedW / 1000,
    pantographUp: true,
    band: voltageBand(v),
    nearest,
    second,
    section,
  };
}

/**
 * Traction electrical power (W) from the last physics step.
 * Motoring: TE × |v|. Regen: minus the service-brake mechanical power, capped at
 * TRACTION_POWER_W (same inverter rating). ESTIMATE of the regen share — the
 * real blend with friction discs is not published.
 */
export function tractionPowerFromForces(opts: {
  electric: boolean;
  pantographUp: boolean;
  speedMs: number;
  teN: number;
  serviceBrakeN: number;
}): number {
  if (!opts.electric || !opts.pantographUp) return 0;
  const v = Math.abs(opts.speedMs);
  if (v < 0.05) return 0;
  if (opts.teN > 1) return opts.teN * v;
  if (opts.serviceBrakeN > 1) return -Math.min(TRACTION_POWER_W, opts.serviceBrakeN * v);
  return 0;
}

/** Simple 4.5 × 14.5 m Siemens-style container, no operator marks. */
export function buildTpssProps(groundAt: (x: number, z: number) => number, sites: readonly TpssSite[] = TPSS_SITES): THREE.Group {
  const root = new THREE.Group();
  root.name = 'tpss-props';
  const bodyMat = new THREE.MeshStandardMaterial({ color: 0x5a6168, metalness: 0.35, roughness: 0.55 });
  const roofMat = new THREE.MeshStandardMaterial({ color: 0x2c3034, metalness: 0.2, roughness: 0.7 });
  const skirtMat = new THREE.MeshStandardMaterial({ color: 0x3a3f44, roughness: 0.8 });
  const ventMat = new THREE.MeshStandardMaterial({ color: 0x2a2e32, roughness: 0.6 });
  for (const site of sites) {
    const [x, z] = lonLatToLocal(site.lon, site.lat);
    const y = groundAt(x, z);
    const g = new THREE.Group();
    g.name = `tpss-${site.id}`;
    g.position.set(x, y, z);
    // 14.5 m long, 4.5 m wide, ~3.2 m high (Stage 2 EPR, Stage 1-like)
    const body = new THREE.Mesh(new THREE.BoxGeometry(14.5, 3.0, 4.5), bodyMat);
    body.position.y = 1.65;
    body.castShadow = true;
    body.receiveShadow = true;
    const roof = new THREE.Mesh(new THREE.BoxGeometry(14.9, 0.18, 4.9), roofMat);
    roof.position.y = 3.2;
    const skirt = new THREE.Mesh(new THREE.BoxGeometry(15.0, 0.25, 5.0), skirtMat);
    skirt.position.y = 0.12;
    const vent = new THREE.Mesh(new THREE.BoxGeometry(3.2, 0.8, 0.15), ventMat);
    vent.position.set(0, 2.2, 2.28);
    g.add(body, roof, skirt, vent);
    // modest pad
    const pad = new THREE.Mesh(
      new THREE.BoxGeometry(16, 0.12, 7),
      new THREE.MeshStandardMaterial({ color: 0x6d6d6d, roughness: 0.95 }),
    );
    pad.position.y = 0.04;
    pad.receiveShadow = true;
    g.add(pad);
    root.add(g);
  }
  return root;
}


/** Shift a TPSS box off the running way and yaw it with the nearest track. */
export function nudgeTpssOffTrack(
  group: THREE.Group,
  nearest: (x: number, z: number) => { x: number; z: number; heading: number },
  groundAt: (x: number, z: number) => number,
  clearanceM = 14,
) {
  for (const child of group.children) {
    const x = child.position.x, z = child.position.z;
    const p = nearest(x, z);
    const rx = Math.cos(p.heading);
    const rz = -Math.sin(p.heading);
    const lateral = (x - p.x) * rx + (z - p.z) * rz;
    const sign = lateral >= 0 ? 1 : -1;
    if (Math.abs(lateral) < clearanceM) {
      child.position.x = p.x + rx * sign * clearanceM;
      child.position.z = p.z + rz * sign * clearanceM;
    }
    child.position.y = groundAt(child.position.x, child.position.z);
    child.rotation.y = p.heading;
  }
}
