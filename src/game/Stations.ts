import * as THREE from 'three';
import type { Track } from './Track';
import type { Elevation } from './elevation';
import { lonLatToLocal } from './coords';

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

  build(stations: StationDef[], track: Track, elev: Elevation) {
    this.stations = stations;
    while (this.group.children.length) this.group.remove(this.group.children[0]);
    stations.forEach((st, i) => {
      const p = track.sample(Math.min(track.length, st.distance_m));
      const g = new THREE.Group();
      // platform
      const plat = new THREE.Mesh(
        new THREE.BoxGeometry(3.5, 0.4, 35),
        new THREE.MeshStandardMaterial({ color: 0xc0c4c8, roughness: 0.85 })
      );
      const side = 3.0;
      const hx = Math.sin(p.heading), hz = Math.cos(p.heading);
      plat.position.set(p.x - hz * side, p.y + 0.35, p.z + hx * side);
      plat.rotation.y = p.heading;
      g.add(plat);
      // shelter
      const shelter = new THREE.Mesh(
        new THREE.BoxGeometry(2.8, 0.08, 12),
        new THREE.MeshStandardMaterial({ color: 0x9aa3ad, metalness: 0.6, roughness: 0.3, transparent: true, opacity: 0.7 })
      );
      shelter.position.set(p.x - hz * side, p.y + 3.2, p.z + hx * side);
      shelter.rotation.y = p.heading;
      g.add(shelter);
      // feature wall
      const wall = new THREE.Mesh(
        new THREE.BoxGeometry(0.25, 3.0, 3.0),
        new THREE.MeshStandardMaterial({ color: WALL_COLORS[i % WALL_COLORS.length] })
      );
      wall.position.set(p.x - hz * (side + 1.5), p.y + 1.7, p.z + hx * (side + 1.5) + hx * 12);
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
      totem.position.set(p.x - hz * (side + 0.2), p.y + 2.8, p.z + hx * (side + 0.2));
      totem.rotation.y = p.heading + Math.PI;
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

  nearStation(s: number, radius = 80) {
    return this.stations.find((st) => Math.abs(st.distance_m - s) < radius) || null;
  }
}
