import * as THREE from 'three';
import type { Track } from './Track';
import type { Elevation } from './elevation';
import { lonLatToLocal } from './coords';
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
};

const WALL_COLORS = [0x8b4513, 0x1e5aa8, 0xc62828, 0x2e7d32, 0x6a1b9a, 0xf9a825, 0x00838f, 0x5d4037];

export class StationSystem {
  group = new THREE.Group();
  stations: StationDef[] = [];

  build(
    stations: StationDef[],
    track: Track,
    elev: Elevation,
    opts: { reverse?: boolean; heavyRail?: boolean; groundAt?: (x: number, z: number) => number } = {},
  ) {
    this.stations = stations;
    while (this.group.children.length) this.group.remove(this.group.children[0]);
    const groundAt = opts.groundAt ?? ((x: number, z: number) => elev.heightAtLocal(x, z));
    // Platforms on the right of the geometry's forward direction (left when the route
    // runs the line reversed) so they never sit on the parallel ION track.
    const sideSign = opts.reverse ? -1 : 1;
    const edge = opts.heavyRail ? GO_PLATFORM_EDGE_OFFSET_M : PLATFORM_EDGE_OFFSET_M;
    const hATR = opts.heavyRail ? GO_PLATFORM_HEIGHT_ATR_M : PLATFORM_HEIGHT_ATR_M;
    const platLen = opts.heavyRail ? 90 : PLATFORM_LENGTH_M;
    const platW = PLATFORM_WIDTH_M;
    const platMat = new THREE.MeshStandardMaterial({ color: 0xc0c4c8, roughness: 0.85 });
    const tactileMat = new THREE.MeshStandardMaterial({ color: 0xd9b400, roughness: 0.8 });
    stations.forEach((st, i) => {
      const p = track.sample(Math.min(track.length, st.distance_m));
      const g = new THREE.Group();
      const hx = Math.sin(p.heading), hz = Math.cos(p.heading);
      // right unit = (-cos h, sin h) in (x,z)
      const rx = -hz * sideSign, rz = hx * sideSign;
      const side = edge + platW / 2;
      const top = p.y + RAIL_TOP_ABOVE_TRACK_Y_M + hATR;
      const cx = p.x + rx * side, cz = p.z + rz * side;
      let low = top;
      for (const a of [-platLen / 2, 0, platLen / 2]) {
        for (const o of [edge, edge + platW]) {
          low = Math.min(low, groundAt(p.x + hx * a + rx * o, p.z + hz * a + rz * o));
        }
      }
      const depth = Math.max(0.3, top - low + 0.3);
      // platform: edge exactly PLATFORM_EDGE_OFFSET_M from track CL, top at TOR + height
      const plat = new THREE.Mesh(new THREE.BoxGeometry(platW, depth, platLen), platMat);
      plat.position.set(cx, top - depth / 2, cz);
      plat.rotation.y = p.heading;
      g.add(plat);
      const tactile = new THREE.Mesh(new THREE.BoxGeometry(0.61, 0.01, platLen), tactileMat);
      const to = edge + 0.305;
      tactile.position.set(p.x + rx * to, top + 0.006, p.z + rz * to);
      tactile.rotation.y = p.heading;
      g.add(tactile);
      const pY = top - 0.35; // legacy offsets below were relative to p.y + 0.35
      void pY;
      // shelter
      const shelter = new THREE.Mesh(
        new THREE.BoxGeometry(2.8, 0.08, 12),
        new THREE.MeshStandardMaterial({ color: 0x9aa3ad, metalness: 0.6, roughness: 0.3, transparent: true, opacity: 0.7 })
      );
      shelter.position.set(cx + rx * 0.4, top + 2.85, cz + rz * 0.4);
      shelter.rotation.y = p.heading;
      g.add(shelter);
      // feature wall
      const wall = new THREE.Mesh(
        new THREE.BoxGeometry(0.25, 3.0, 3.0),
        new THREE.MeshStandardMaterial({ color: WALL_COLORS[i % WALL_COLORS.length] })
      );
      wall.position.set(cx + rx * 1.5 + hx * 12, top + 1.5, cz + rz * 1.5 + hz * 12);
      wall.rotation.y = p.heading;
      g.add(wall);
      // name totem (simple box + canvas texture)
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
        new THREE.MeshBasicMaterial({ map: tex, transparent: true })
      );
      totem.position.set(cx - rx * 0.2, top + 2.45, cz - rz * 0.2);
      totem.rotation.y = p.heading + (sideSign > 0 ? -Math.PI / 2 : Math.PI / 2);
      g.add(totem);
      this.group.add(g);
    });
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
