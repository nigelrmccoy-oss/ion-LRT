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

/** LRV dynamic envelope half-width plus a small wayside clearance. ESTIMATE. */
export const WAYSIDE_OFFSET_M = 2.2;

function speedBoardTexture(speed: number, advance: boolean): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 128;
  c.height = 128;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = advance ? '#e8c84a' : '#f4f4f0';
  ctx.fillRect(0, 0, 128, 128);
  ctx.strokeStyle = '#1a1a1a';
  ctx.lineWidth = 8;
  ctx.strokeRect(6, 6, 116, 116);
  ctx.fillStyle = '#111';
  ctx.font = 'bold 64px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(String(Math.round(speed)), 64, 64);
  const tex = new THREE.CanvasTexture(c);
  tex.needsUpdate = true;
  return tex;
}

/** Procedural face for tests / Node (no document). */
function boardMaterial(speed: number, advance: boolean): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({
    color: advance ? 0xe8c84a : 0xf4f4f0,
    roughness: 0.7,
    metalness: 0.05,
  });
  if (typeof document !== 'undefined') {
    mat.map = speedBoardTexture(speed, advance);
    mat.color.set(0xffffff);
  }
  mat.name = advance ? 'speed-board-advance' : 'speed-board';
  return mat;
}

export function createSpeedBoardMesh(speed: number, advance: boolean): THREE.Group {
  const g = new THREE.Group();
  g.name = advance ? 'speed-board-advance' : 'speed-board';
  const post = new THREE.Mesh(
    new THREE.CylinderGeometry(0.04, 0.05, 2.4, 6),
    new THREE.MeshStandardMaterial({ color: 0x333333, roughness: 0.7 }),
  );
  post.position.y = 1.2;
  g.add(post);
  const face = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.55, 0.05), boardMaterial(speed, advance));
  face.position.set(0, 2.15, 0.04);
  face.name = 'speed-board-face';
  g.add(face);
  return g;
}

/**
 * Build wayside speed-limit boards on the given track:
 * - A limit board at every posted-limit change.
 * - For reductions, an advance-warning board at least MIN_POSTED_LIMIT_M before it.
 * Boards are placed driver's side, offset clear of the dynamic envelope (ESTIMATE).
 * Meshes are added to `parent`.
 */
export function buildWaysideSigns(track: Track, parent: THREE.Group): SpeedBoard[] {
  const boards: SpeedBoard[] = [];
  const changes = track.postedChanges();
  const minRun = Track.MIN_POSTED_LIMIT_M;
  const offset = WAYSIDE_OFFSET_M;
  let prevKmh = changes.length ? null : null;
  // Seed previous limit from the start of the line
  let lastKmh = 0;
  if (changes.length) {
    const first = changes[0];
    // limit just before the first change
    lastKmh = track.speedLimitKmh(Math.max(0, first.s - 1), false);
  }

  for (const ch of changes) {
    const p = track.sample(Math.max(0, Math.min(track.length, ch.s)));
    const board: SpeedBoard = {
      pos: { x: p.x, y: p.y, z: p.z },
      offset,
      speed: ch.kmh,
      advance: false,
      estimate: true,
    };
    boards.push(board);
    placeBoard(parent, p, offset, ch.kmh, false);

    if (ch.kmh < lastKmh) {
      const advanceS = Math.max(0, ch.s - minRun);
      if (advanceS < ch.s) {
        const ap = track.sample(advanceS);
        boards.push({
          pos: { x: ap.x, y: ap.y, z: ap.z },
          offset,
          speed: ch.kmh,
          advance: true,
          estimate: true,
        });
        placeBoard(parent, ap, offset, ch.kmh, true);
      }
    }
    lastKmh = ch.kmh;
  }
  return boards;
}

function placeBoard(
  parent: THREE.Group,
  p: { x: number; y: number; z: number; heading: number },
  offset: number,
  speed: number,
  advance: boolean,
) {
  const lx = Math.cos(p.heading), lz = -Math.sin(p.heading);
  const mesh = createSpeedBoardMesh(speed, advance);
  mesh.position.set(p.x + lx * offset, p.y, p.z + lz * offset);
  // Face the approaching train (and the road, in street running).
  mesh.rotation.y = p.heading + Math.PI;
  parent.add(mesh);
}
