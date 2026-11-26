import * as THREE from 'three';
import { Track } from './Track';

/** Wayside speed-limit board (tribute geometry only; no ION/TTC artwork or trademarks). */
export type SpeedBoard = {
  /** Position at track centreline (for placement relative to the track). */
  pos: { x: number; y: number; z: number };
  /** Offset from track centreline (driver's side, clear of the dynamic envelope). */
  offset: number;
  /** Posted speed (km/h). */
  speed: number;
  /** Whether this is an advance-warning board (true) or the actual limit board (false). */
  advance: boolean;
  /** Flag for estimates (unsourced sizes/offsets). */
  estimate: boolean;
};

/**
 * Build wayside speed-limit boards on the given track:
 * - A limit board at every posted-limit change.
 * - For reductions, an advance-warning board at least MIN_POSTED_LIMIT_M before it.
 * Boards are placed driver's side, offset clear of the dynamic envelope (ESTIMATE).
 */
export function buildWaysideSigns(track: Track, parent: THREE.Group): SpeedBoard[] {
  const boards: SpeedBoard[] = [];
  const minRun = Track.MIN_POSTED_LIMIT_M;
  const st = Track.CURVE_TAB_STEP;
  const tab = track['postedTab'];
  if (!tab) return boards;

  // LRV dynamic envelope half-width (ESTIMATE: LRV_WIDTH_M/2 + ENVELOPE_MARGIN_M + sway margin)
  const envelopeHalfWidth = 2.2; // ESTIMATE

  // Place boards at every limit change
  for (let i = 0; i < tab.length - 1; i++) {
    const s = i * st;
    const next = (i + 1) * st;
    const current = tab[i];
    const nextLim = tab[i + 1];

    // Place the actual limit board at the change point
    const pos = track.pointAt(next);
    const board: SpeedBoard = {
      pos,
      offset: envelopeHalfWidth,
      speed: nextLim,
      advance: false,
      estimate: true,
    };
    boards.push(board);

    // Place advance-warning board for reductions (if not already covered)
    if (nextLim < current) {
      const advanceS = Math.max(s, next - minRun);
      if (advanceS < next) {
        const advancePos = track.pointAt(advanceS);
        const advanceBoard: SpeedBoard = {
          pos: advancePos,
          offset: envelopeHalfWidth,
          speed: nextLim,
          advance: true,
          estimate: true,
        };
        boards.push(advanceBoard);
      }
    }
  }

  return boards;
}
