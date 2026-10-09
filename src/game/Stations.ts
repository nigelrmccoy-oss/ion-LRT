import * as THREE from 'three';
import type { Track } from './Track';
import type { Elevation } from './elevation';
import { layoutPlatform, type OsmPlatform, type PlatformLayout } from './PlatformLayout';
import {
  PLATFORM_EDGE_OFFSET_M, PLATFORM_HEIGHT_ATR_M, PLATFORM_LENGTH_M, PLATFORM_WIDTH_M,
  RAIL_TOP_ABOVE_TRACK_Y_M, GO_PLATFORM_EDGE_OFFSET_M, GO_PLATFORM_HEIGHT_ATR_M,
} from './Clearances';

export type StationDef = {
  id: string;
  name: string;
  lat: number;
  lon: number;
  distance_m: number;
  trackIndex?: number;
  /** Set by build(): +1 platform right of travel, −1 left. */
  platformSide?: 1 | -1;
  platformSource?: 'osm' | 'default';
  /** Curated OSM platform outline id (ION). */
  platform_osm?: string;
};

const WALL_COLORS = [0x8b4513, 0x1e5aa8, 0xc62828, 0x2e7d32, 0x6a1b9a, 0xf9a825, 0x00838f, 0x5d4037];

/** Strip mesh between two polylines (same length), heights per vertex. */
function stripGeo(a: { x: number; y: number; z: number }[], b: { x: number; y: number; z: number }[]) {
  const pos: number[] = [], idx: number[] = [];
  for (let i = 0; i < a.length; i++) {
    pos.push(a[i].x, a[i].y, a[i].z, b[i].x, b[i].y, b[i].z);
    if (i > 0) {
      const p = (i - 1) * 2, c = i * 2;
      idx.push(p, c, p + 1, p + 1, c, c + 1);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

export class StationSystem {
  group = new THREE.Group();
  stations: StationDef[] = [];
  layouts = new Map<string, PlatformLayout>();

  build(
    stations: StationDef[],
    track: Track,
    elev: Elevation,
    opts: {
      heavyRail?: boolean;
      groundAt?: (x: number, z: number) => number;
      platforms?: OsmPlatform[];
      otherTracks?: Track[];
    } = {},
  ) {
    this.stations = stations;
    this.layouts.clear();
    while (this.group.children.length) this.group.remove(this.group.children[0]);
    const groundAt = opts.groundAt ?? ((x: number, z: number) => elev.heightAtLocal(x, z));
    const edge = opts.heavyRail ? GO_PLATFORM_EDGE_OFFSET_M : PLATFORM_EDGE_OFFSET_M;
    const hATR = opts.heavyRail ? GO_PLATFORM_HEIGHT_ATR_M : PLATFORM_HEIGHT_ATR_M;
    const platLen = opts.heavyRail ? 90 : PLATFORM_LENGTH_M;
    const platMat = new THREE.MeshStandardMaterial({ color: 0xc0c4c8, roughness: 0.85, side: THREE.DoubleSide });
    const tactileMat = new THREE.MeshStandardMaterial({
      color: 0xd9b400, roughness: 0.8, side: THREE.DoubleSide,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    });
    stations.forEach((st, i) => {
      const lay = layoutPlatform(track, Math.min(track.length, st.distance_m), {
        platforms: opts.platforms,
        platformId: st.platform_osm,
        edgeOffset: edge,
        width: PLATFORM_WIDTH_M,
        length: platLen,
        otherTracks: opts.otherTracks,
        defaultSide: 1,
      });
      this.layouts.set(st.id, lay);
      st.platformSide = lay.side;
      st.platformSource = lay.source;
      // stop at the middle of the real platform
      st.distance_m = Math.round(lay.sCentre);
      const g = new THREE.Group();
      const top = (y: number) => y + RAIL_TOP_ABOVE_TRACK_Y_M + hATR;
      let low = Infinity;
      for (let k = 0; k < lay.edge.length; k += 3) {
        low = Math.min(low, groundAt(lay.edge[k].x, lay.edge[k].z), groundAt(lay.back[k].x, lay.back[k].z), top(lay.edge[k].y) - 0.3);
      }
      low -= 0.3;
      const eTop = lay.edge.map((p) => ({ x: p.x, y: top(p.y), z: p.z }));
      const bTop = lay.back.map((p) => ({ x: p.x, y: top(p.y), z: p.z }));
      const eLow = lay.edge.map((p) => ({ x: p.x, y: low, z: p.z }));
      const bLow = lay.back.map((p) => ({ x: p.x, y: low, z: p.z }));
      for (const geo of [stripGeo(eTop, bTop), stripGeo(eTop, eLow), stripGeo(bTop, bLow),
        stripGeo([eTop[0], eLow[0]], [bTop[0], bLow[0]]),
        stripGeo([eTop[eTop.length - 1], eLow[eLow.length - 1]], [bTop[bTop.length - 1], bLow[bLow.length - 1]])]) {
        const m = new THREE.Mesh(geo, platMat);
        m.receiveShadow = true;
        g.add(m);
      }
      // tactile strip 0.61 m wide along the (curved) edge
      const tIn = lay.edge.map((p, k) => {
        const b = lay.back[k];
        const f = 0.61 / Math.max(0.61, lay.width);
        return { x: p.x + (b.x - p.x) * f, y: top(p.y) + 0.004, z: p.z + (b.z - p.z) * f };
      });
      const tOut = eTop.map((p) => ({ x: p.x, y: p.y + 0.004, z: p.z }));
      g.add(new THREE.Mesh(stripGeo(tOut, tIn), tactileMat));

      // furniture in the local frame at the platform centre
      const mid = Math.floor(lay.edge.length / 2);
      const e = lay.edge[mid], bk = lay.back[mid];
      const heading = track.headingAt(Math.min(track.length - 2, Math.max(0, lay.sCentre - 1)));
      const ox = (bk.x - e.x) / Math.max(0.01, lay.width), oz = (bk.z - e.z) / Math.max(0.01, lay.width); // unit toward back
      const cx = (e.x + bk.x) / 2, cz = (e.z + bk.z) / 2;
      const yTop = top(e.y);
      const hx = Math.sin(heading), hz = Math.cos(heading);
      const shelter = new THREE.Mesh(
        new THREE.BoxGeometry(Math.min(2.8, lay.width), 0.08, 12),
        new THREE.MeshStandardMaterial({ color: 0x9aa3ad, metalness: 0.6, roughness: 0.3, transparent: true, opacity: 0.7 })
      );
      shelter.position.set(cx + ox * 0.2, yTop + 2.85, cz + oz * 0.2);
      shelter.rotation.y = heading;
      g.add(shelter);
      const wall = new THREE.Mesh(
        new THREE.BoxGeometry(0.25, 3.0, 3.0),
        new THREE.MeshStandardMaterial({ color: WALL_COLORS[i % WALL_COLORS.length] })
      );
      const wallIdx = Math.min(lay.back.length - 1, mid + 12);
      const wb = lay.back[wallIdx], we = lay.edge[wallIdx];
      wall.position.set(wb.x + (we.x - wb.x) * 0.15, top(we.y) + 1.5, wb.z + (we.z - wb.z) * 0.15);
      wall.rotation.y = track.headingAt(Math.min(track.length - 2, we.s));
      g.add(wall);
      const canvas = document.createElement('canvas');
      canvas.width = 256; canvas.height = 64;
      const ctx = canvas.getContext('2d')!;
      ctx.fillStyle = '#111';
      ctx.fillRect(0, 0, 256, 64);
      ctx.fillStyle = '#fff';
      ctx.font = 'bold 22px system-ui';
      ctx.fillText(st.name, 12, 40);
      const tex = new THREE.CanvasTexture(canvas);
      const totem = new THREE.Mesh(
        new THREE.PlaneGeometry(4, 1),
        new THREE.MeshBasicMaterial({ map: tex, transparent: true, side: THREE.DoubleSide })
      );
      totem.position.set(cx - ox * 0.2, yTop + 2.45, cz - oz * 0.2);
      // face the track: plane normal toward the edge
      totem.rotation.y = Math.atan2(-ox, -oz);
      void hx; void hz;
      g.add(totem);
      this.group.add(g);
    });
    // keep chainage order after re-centring on the real platforms
    stations.sort((a, b) => a.distance_m - b.distance_m);
  }

  nextStation(s: number): StationDef | null {
    for (const st of this.stations) {
      if (st.distance_m > s + 5) return st;
    }
    return null;
  }


  /** Recompute distance_m from track geometry (after elevation remesh). */
  refreshDistances(track: Track) {
    for (const st of this.stations) {
      st.distance_m = Math.round(track.nearestS(st.lon, st.lat));
    }
  }

  nearStation(s: number, radius = 80) {
    return this.stations.find((st) => Math.abs(st.distance_m - s) < radius) || null;
  }
}
