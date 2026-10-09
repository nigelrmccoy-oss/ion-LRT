/**
 * Kinematics for the 5-module Flexity Freedom (Bo'2Bo': power trucks under the cab
 * modules A/E, trailer truck under centre module C, suspended modules B/D).
 * Pure maths (no three.js) so the stress test can exercise it headlessly.
 *
 * Frame: x = east, z = south, y = up. yaw = atan2(dx, dz) of the module's forward axis
 * (same convention as Track.headingAt); pitch > 0 = nose up; roll > 0 = left side down.
 */
import {
  MODULES,
  TRUCK_FROM_NOSE_M,
  TRUCK_HALF_WHEELBASE_M,
  MAX_SUPERELEVATION_M,
  RAIL_CENTRES_M,
  RAIL_TOP_ABOVE_TRACK_Y_M,
} from './Clearances';

export type Vec3 = { x: number; y: number; z: number };

export interface TrackLike {
  length: number;
  pointAt(s: number): Vec3;
}

export type ModulePose = {
  name: string;
  kind: 'truck' | 'suspended';
  len: number;
  /** Body centre at top-of-rail level. */
  pos: Vec3;
  yaw: number;
  pitch: number;
  roll: number;
  /** Forward unit vector (horizontal) */
  fwd: { x: number; z: number };
};

export type ConsistPose = {
  modules: ModulePose[];
  trucks: { s: number; pos: Vec3; yaw: number }[];
  /** Nose (front coupler face) of the leading module. */
  nose: Vec3;
};

const CENTRE_TRUCK = 1;

function sub(a: Vec3, b: Vec3) { return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z }; }

/** Superelevation (m, + raises the outer rail) for signed curvature k (1/m) at speed v (m/s). */
export function superelevationFor(k: number, designSpeedMs: number, ballasted: boolean): number {
  if (!ballasted || !Number.isFinite(k) || Math.abs(k) < 1e-4) return 0;
  // Equilibrium e = G·v²·k/g, apply ~2/3 of it (unbalance allowed), cap.
  const eq = (RAIL_CENTRES_M * designSpeedMs * designSpeedMs * Math.abs(k)) / 9.81;
  return Math.min(MAX_SUPERELEVATION_M, eq * 0.67) * Math.sign(k);
}

/**
 * Pose all modules. `sCentre` is the chainage of the centre (trailer) truck — the
 * consist reference used by the game. `dir` = +1 when cab A leads toward increasing s.
 * `cantAt(s)` returns superelevation in metres (signed like curvature: + = left curve).
 */
export function poseConsist(
  track: TrackLike,
  sCentre: number,
  dir: 1 | -1 = 1,
  cantAt: (s: number) => number = () => 0,
): ConsistPose {
  const tA = TRUCK_FROM_NOSE_M[0], tC = TRUCK_FROM_NOSE_M[1], tE = TRUCK_FROM_NOSE_M[2];
  const truckS = [sCentre + dir * (tC - tA), sCentre, sCentre - dir * (tE - tC)];
  const top = RAIL_TOP_ABOVE_TRACK_Y_M;

  const trucks = truckS.map((s) => {
    const f = track.pointAt(s + dir * TRUCK_HALF_WHEELBASE_M);
    const r = track.pointAt(s - dir * TRUCK_HALF_WHEELBASE_M);
    const c = track.pointAt(s);
    const yaw = Math.atan2(f.x - r.x, f.z - r.z);
    const horiz = Math.max(1e-3, Math.hypot(f.x - r.x, f.z - r.z));
    const pitch = Math.atan2(f.y - r.y, horiz);
    const e = cantAt(s);
    // Positive cant on a left curve raises the right rail → body rolls left-side-down
    const roll = Math.asin(Math.max(-0.2, Math.min(0.2, e / RAIL_CENTRES_M)));
    return { s, pos: { x: c.x, y: c.y + top, z: c.z }, yaw, pitch, roll };
  });

  // Nose distance of each module's leading/trailing faces
  const faces: number[] = [];
  let acc = 0;
  for (const m of MODULES) { faces.push(acc); acc += m.len; }

  const modules: ModulePose[] = new Array(MODULES.length);
  // 1) truck-carried modules: rigid on their truck
  const truckOf: Record<number, number> = { 0: 0, 2: 1, 4: 2 };
  for (const [miStr, ti] of Object.entries(truckOf)) {
    const mi = Number(miStr);
    const m = MODULES[mi];
    const t = trucks[ti];
    const centreFromNose = faces[mi] + m.len / 2;
    const ahead = TRUCK_FROM_NOSE_M[ti] - centreFromNose; // + = body centre ahead of truck
    const fx = Math.sin(t.yaw), fz = Math.cos(t.yaw);
    const cp = Math.cos(t.pitch), sp = Math.sin(t.pitch);
    modules[mi] = {
      name: m.name,
      kind: m.kind,
      len: m.len,
      pos: { x: t.pos.x + fx * ahead * cp, y: t.pos.y + sp * ahead, z: t.pos.z + fz * ahead * cp },
      yaw: t.yaw,
      pitch: t.pitch,
      roll: t.roll,
      fwd: { x: fx, z: fz },
    };
  }
  // 2) suspended modules hang between the faces of their neighbours
  const faceOf = (mi: number, front: boolean): Vec3 => {
    const p = modules[mi];
    const k = (front ? 1 : -1) * (p.len / 2);
    const cp = Math.cos(p.pitch);
    return { x: p.pos.x + p.fwd.x * k * cp, y: p.pos.y + Math.sin(p.pitch) * k, z: p.pos.z + p.fwd.z * k * cp };
  };
  for (const mi of [1, 3]) {
    const m = MODULES[mi];
    const front = faceOf(mi - 1, false);
    const rear = faceOf(mi + 1, true);
    const d = sub(front, rear);
    const horiz = Math.max(1e-3, Math.hypot(d.x, d.z));
    const yaw = Math.atan2(d.x, d.z);
    const roll = (modules[mi - 1].roll + modules[mi + 1].roll) / 2;
    modules[mi] = {
      name: m.name,
      kind: m.kind,
      len: m.len,
      pos: { x: (front.x + rear.x) / 2, y: (front.y + rear.y) / 2, z: (front.z + rear.z) / 2 },
      yaw,
      pitch: Math.atan2(d.y, horiz),
      roll,
      fwd: { x: d.x / horiz, z: d.z / horiz },
    };
  }
  void CENTRE_TRUCK;
  const nose = faceOf(0, true);
  return {
    modules,
    trucks: trucks.map((t) => ({ s: t.s, pos: t.pos, yaw: t.yaw })),
    nose,
  };
}

/** Body plan-view corners for swept-path checks (4 per module, at mid-height). */
export function moduleCorners(p: ModulePose, width: number): { x: number; z: number }[] {
  const hl = p.len / 2, hw = width / 2;
  const fx = p.fwd.x, fz = p.fwd.z;
  // left = rotate fwd +90° (toward +x when facing +z)
  const lx = fz, lz = -fx;
  const out: { x: number; z: number }[] = [];
  for (const a of [hl, -hl]) {
    for (const b of [hw, -hw]) {
      out.push({ x: p.pos.x + fx * a + lx * b, z: p.pos.z + fz * a + lz * b });
    }
  }
  return out;
}
