/**
 * Platform placement along a (possibly curved) running track. Pure maths — no three.js —
 * so the stress test can check it headlessly.
 *
 * Side and stopping position come from the real OSM `railway=platform` outline next to
 * the running line when one exists (ION has side platforms at e.g. Conestoga, UW,
 * Laurier, Fairway and centre platforms at e.g. Northfield, Mill, Borden). Otherwise the
 * platform goes on the right of travel (North-American right-hand running) — flagged
 * `source: 'default'`.
 *
 * The platform edge follows the track curve at a constant lateral offset (sourced
 * PLATFORM_EDGE_OFFSET_M) instead of a straight 65 m box (v1.4.0 drifted 14 m off the
 * track at Allen).
 */
import { lonLatToLocal } from './coords';

export interface PlatformTrack {
  length: number;
  sampleRaw(s: number): { x: number; y: number; z: number };
  headingAt(s: number): number;
  nearestSLocal(x: number, z: number): number;
}

export type OsmPlatform = { osm: string; name?: string | null; ref?: string | null; ring: [number, number][] };

export type PlatformLayout = {
  /** +1 = right of travel (increasing s), −1 = left. */
  side: 1 | -1;
  sCentre: number;
  s0: number;
  s1: number;
  edgeOffset: number;
  width: number;
  source: 'osm' | 'default';
  osm?: string;
  /** Polyline every ~1 m: platform edge, back edge, rail-base height. */
  edge: { x: number; z: number; s: number; y: number }[];
  back: { x: number; z: number; s: number; y: number }[];
};

/** Left unit vector for heading h (same convention as Terrain / Articulation). */
export function leftOf(h: number) {
  return { x: Math.cos(h), z: -Math.sin(h) };
}

/** Signed lateral offset (+ = left of increasing s) and chainage of a local point. */
export function lateralOf(track: PlatformTrack, x: number, z: number) {
  const s = track.nearestSLocal(x, z);
  const p = track.sampleRaw(s);
  const l = leftOf(track.headingAt(Math.min(track.length - 2, Math.max(0, s - 1))));
  return { s, lat: (x - p.x) * l.x + (z - p.z) * l.z, d: Math.hypot(x - p.x, z - p.z) };
}

export function localRing(pl: OsmPlatform) {
  return pl.ring.map(([lon, lat]) => {
    const [x, z] = lonLatToLocal(lon, lat);
    return { x, z };
  });
}

/** Densify a ring so long polygon sides are sampled every ≤ 3 m. */
function densifyRing(ring: { x: number; z: number }[]) {
  const out: { x: number; z: number }[] = [];
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length];
    const n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) / 3));
    for (let k = 0; k < n; k++) out.push({ x: a.x + ((b.x - a.x) * k) / n, z: a.z + ((b.z - a.z) * k) / n });
  }
  return out;
}

/**
 * Find the OSM platform serving `track` near chainage `stationS`. With `onlyId` (station's
 * curated `platform_osm`) only that outline is considered, anywhere along the line.
 */
export function matchOsmPlatform(track: PlatformTrack, stationS: number, platforms: OsmPlatform[], search = 110, onlyId?: string) {
  const at = track.sampleRaw(stationS);
  let best: { pl: OsmPlatform; side: 1 | -1; s0: number; s1: number; score: number } | null = null;
  const cands = onlyId ? platforms.filter((p) => p.osm === onlyId) : platforms;
  if (onlyId) search = Infinity;
  for (const pl of cands) {
    const ring = densifyRing(localRing(pl));
    if (!ring.length) continue;
    const cx = ring.reduce((a, p) => a + p.x, 0) / ring.length, cz = ring.reduce((a, p) => a + p.z, 0) / ring.length;
    if (Number.isFinite(search) && Math.hypot(cx - at.x, cz - at.z) > search + 80) continue;
    let s0 = Infinity, s1 = -Infinity, minAbs = Infinity, sumLat = 0, n = 0;
    for (const v of ring) {
      const q = lateralOf(track, v.x, v.z);
      if (q.s <= 0.5 || q.s >= track.length - 0.5) continue; // beyond the line end
      s0 = Math.min(s0, q.s); s1 = Math.max(s1, q.s);
      minAbs = Math.min(minAbs, Math.abs(q.lat));
      sumLat += q.lat; n++;
    }
    if (!n) continue;
    // must sit beside this running line: nearest edge 0.3–4.5 m from its centreline
    // (a curated id may be a relation bounding box that overlaps the track, or sit a
    //  little wider on a centre platform: accept up to 6 m, side from the centroid)
    if (onlyId ? minAbs > 6 : minAbs < 0.3 || minAbs > 4.5) continue;
    const mid = (s0 + s1) / 2;
    if (Math.abs(mid - stationS) > search) continue;
    const side: 1 | -1 = sumLat / n > 0 ? -1 : 1; // lat>0 = left → side −1
    // relations carry only a bounding box here → prefer real way outlines
    const score = Math.abs(mid - stationS) + minAbs * 5 + (pl.osm.startsWith('relation/') ? 50 : 0);
    if (!best || score < best.score) best = { pl, side, s0, s1, score };
  }
  return best;
}

/**
 * Lay out a platform for `track` at `stationS`.
 * `otherTracks` (e.g. the opposite-direction ION line) cap the width so a platform never
 * reaches into the neighbouring track's clearance.
 */
export function layoutPlatform(
  track: PlatformTrack,
  stationS: number,
  opts: {
    platforms?: OsmPlatform[];
    /** Curated OSM id for this stop (stations.json `platform_osm`). */
    platformId?: string;
    edgeOffset: number;
    width: number;
    length: number;
    otherTracks?: PlatformTrack[];
    defaultSide?: 1 | -1;
    step?: number;
  },
): PlatformLayout {
  const m = opts.platforms?.length
    ? (opts.platformId ? matchOsmPlatform(track, stationS, opts.platforms, 110, opts.platformId) : null) ??
      matchOsmPlatform(track, stationS, opts.platforms)
    : null;
  const side: 1 | -1 = m ? m.side : (opts.defaultSide ?? 1);
  const centre = m ? (m.s0 + m.s1) / 2 : stationS;
  const half = opts.length / 2;
  const sC = Math.min(track.length - half - 1, Math.max(half + 1, centre));
  const s0 = Math.max(0, sC - half), s1 = Math.min(track.length, sC + half);
  const step = opts.step ?? 1;
  // width: keep the back edge ≥ edgeOffset from any other running line on that side
  let width = opts.width;
  for (const ot of opts.otherTracks ?? []) {
    for (let s = s0; s <= s1; s += 5) {
      const p = track.sampleRaw(s);
      const l = leftOf(track.headingAt(Math.min(track.length - 2, s)));
      const sx = -side; // left multiplier for this side (side +1 = right = −left)
      const q = lateralOf(ot, p.x + l.x * sx * (opts.edgeOffset + 0.5), p.z + l.z * sx * (opts.edgeOffset + 0.5));
      const op = ot.sampleRaw(q.s);
      const latOther = (op.x - p.x) * l.x * sx + (op.z - p.z) * l.z * sx; // distance toward platform side
      if (latOther > 0 && latOther < opts.edgeOffset + width + opts.edgeOffset) {
        width = Math.max(1.0, Math.min(width, latOther - 2 * opts.edgeOffset));
      }
    }
  }
  const edge: PlatformLayout['edge'] = [], back: PlatformLayout['back'] = [];
  for (let s = s0; s <= s1 + 1e-6; s += step) {
    const ss = Math.min(s, s1);
    const p = track.sampleRaw(ss);
    const l = leftOf(track.headingAt(Math.min(track.length - 2, Math.max(0, ss - 1))));
    const k = -side;
    edge.push({ x: p.x + l.x * k * opts.edgeOffset, z: p.z + l.z * k * opts.edgeOffset, s: ss, y: p.y });
    back.push({ x: p.x + l.x * k * (opts.edgeOffset + width), z: p.z + l.z * k * (opts.edgeOffset + width), s: ss, y: p.y });
  }
  return {
    side, sCentre: sC, s0, s1, edgeOffset: opts.edgeOffset, width,
    source: m ? 'osm' : 'default', osm: m?.pl.osm, edge, back,
  };
}
