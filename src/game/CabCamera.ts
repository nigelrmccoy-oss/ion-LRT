/**
 * Cab-camera mesh visibility and driver's-eye placement for the Flexity lead module.
 *
 * The Blender GLB paints the wraparound front glass as object `windscreen`
 * (mesh `windscreen-glass`) with material `lrvGlassFront`: almost-black
 * base colour and alpha 1.0 (opaque). From inside the cab that sheet is a
 * solid black windscreen. Side glass (`lrvGlass`, alpha 0.92) is a different
 * material and is not hidden here.
 *
 * After the GLB material join, seats / bulkhead / wiper-arms are often no
 * longer under their original names; they live in per-material groups such
 * as `module-A-cab-seat` and `module-A-cab-trim`. Pre-join names are still
 * matched so the procedural fallback mesh keeps working.
 */
import type { Object3D, Vector3 } from 'three';
import { Vector3 as V3 } from 'three';
import { LRV_FLOOR_ATR_M } from './Clearances';

/** Right-hand seat, inboard of the parked +0.42 m wiper arm. */
export const CAB_EYE_X = 0.28;
/** Seated eye height above the low-floor (m). */
export const CAB_EYE_ABOVE_FLOOR_M = 1.62;
/** How far the eye sits behind the lead-module +z nose (m). */
export const CAB_EYE_BEHIND_NOSE_M = 0.85;

const STRIP_SUFFIX = /\.\d+$/;

export function isCabViewOccluder(name: string): boolean {
  if (!name) return false;
  const n = name.replace(STRIP_SUFFIX, '');
  if (n === 'windscreen' || n.startsWith('windscreen')) return true;
  if (n.startsWith('wiper-arm') || n.startsWith('wiper-blade')) return true;
  if (n === 'destSign' || n.startsWith('destSign')) return true;
  if (n === 'cab-dash' || n === 'cab-bulkhead' || n === 'sun-visor' || n === 'controller') return true;
  if (n === 'seat-R' || n === 'seat-L' || n === 'seat-base-R' || n === 'seat-base-L') return true;
  // Procedural fallback merges front and side glass under this name.
  if (n === 'windows') return true;
  // Post-join GLB groups on the lead cab module.
  if (n.endsWith('-seat') || n.endsWith('-interior') || n.endsWith('-trim')) return true;
  return false;
}

/** Hide occluders in cab view; restore them for chase / side cameras. */
export function setCabCameraMeshVisibility(root: Object3D, cabView: boolean): void {
  const visible = !cabView;
  root.traverse((o) => {
    if (isCabViewOccluder(o.name)) o.visible = visible;
  });
}

/** Lead-module local eye position (X right, Y up, Z forward). */
export function cabEyeLocal(leadLen: number): Vector3 {
  return new V3(
    CAB_EYE_X,
    LRV_FLOOR_ATR_M + CAB_EYE_ABOVE_FLOOR_M,
    leadLen / 2 - CAB_EYE_BEHIND_NOSE_M,
  );
}
