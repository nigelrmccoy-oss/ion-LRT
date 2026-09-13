import * as THREE from 'three';
import type { Elevation } from './elevation';
import type { Track } from './Track';

const CHUNK = 400; // metres

export class TerrainSystem {
  group = new THREE.Group();
  private elev: Elevation;
  private chunks = new Map<string, THREE.Object3D>();
  private scenery: any = null;
  private treeGeo = new THREE.ConeGeometry(2.2, 7, 5);
  private treeMat = new THREE.MeshStandardMaterial({ color: 0x2d5a2d });
  private landMats: Record<string, THREE.MeshStandardMaterial> = {
    residential: new THREE.MeshStandardMaterial({ color: 0xc4b8a0, roughness: 1 }),
    commercial: new THREE.MeshStandardMaterial({ color: 0xb0a090, roughness: 1 }),
    industrial: new THREE.MeshStandardMaterial({ color: 0x8a8680, roughness: 1 }),
    retail: new THREE.MeshStandardMaterial({ color: 0xd0c4b0, roughness: 1 }),
    education: new THREE.MeshStandardMaterial({ color: 0x9cba8a, roughness: 1 }),
    university: new THREE.MeshStandardMaterial({ color: 0x8fb87a, roughness: 1 }),
    campus: new THREE.MeshStandardMaterial({ color: 0x8fb87a, roughness: 1 }),
    grass: new THREE.MeshStandardMaterial({ color: 0x6a9a4a, roughness: 1 }),
    forest: new THREE.MeshStandardMaterial({ color: 0x3d6b34, roughness: 1 }),
    park: new THREE.MeshStandardMaterial({ color: 0x5a9a4a, roughness: 1 }),
    default: new THREE.MeshStandardMaterial({ color: 0x6e8b52, roughness: 1 }),
  };
  private buildingMat = new THREE.MeshStandardMaterial({ color: 0xd8d2c8, roughness: 0.85, metalness: 0.05 });
  private waterMat = new THREE.MeshStandardMaterial({ color: 0x3a6ea5, roughness: 0.25, metalness: 0.3 });
  private railMat = new THREE.MeshStandardMaterial({ color: 0x444448, metalness: 0.7, roughness: 0.4 });
  private ballastMat = new THREE.MeshStandardMaterial({ color: 0x6a6560, roughness: 1 });

  constructor(elev: Elevation) {
    this.elev = elev;
  }

  async loadScenery() {
    try {
      this.scenery = await (await fetch('./data/scenery.json')).json();
    } catch {
      this.scenery = null;
    }
  }

  /** Build rail mesh for a track (full length, lightweight). */
  buildRails(track: Track) {
    const g = new THREE.Group();
    const pts = track.points;
    // ballast ribbon via tube-ish boxes along segments every N
    const step = 2;
    for (let i = 0; i < pts.length - 1; i += step) {
      const a = pts[i], b = pts[Math.min(pts.length - 1, i + step)];
      const dx = b.x - a.x, dz = b.z - a.z, dy = b.y - a.y;
      const len = Math.hypot(dx, dy, dz);
      if (len < 0.5) continue;
      const mid = new THREE.Vector3((a.x + b.x) / 2, (a.y + b.y) / 2 - 0.15, (a.z + b.z) / 2);
      const ballast = new THREE.Mesh(new THREE.BoxGeometry(3.2, 0.25, len), this.ballastMat);
      ballast.position.copy(mid);
      ballast.lookAt(b.x, b.y - 0.15, b.z);
      g.add(ballast);
      for (const side of [-0.72, 0.72]) {
        const rail = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.18, len), this.railMat);
        // offset sideways
        const hx = dx / len, hz = dz / len;
        const px = -hz * side, pz = hx * side;
        rail.position.set(mid.x + px, mid.y + 0.15, mid.z + pz);
        rail.lookAt(b.x + px, b.y, b.z + pz);
        g.add(rail);
      }
    }
    // catenary poles every ~50 m for electric routes
    if (track.name.includes('ION')) {
      for (let s = 0; s < track.length; s += 50) {
        const p = track.sample(s);
        const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.15, 7.5, 6), this.railMat);
        const side = 3.2;
        const hx = Math.sin(p.heading), hz = Math.cos(p.heading);
        pole.position.set(p.x - hz * side, p.y + 3.5, p.z + hx * side);
        g.add(pole);
        const wire = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.04, 50), this.railMat);
        wire.position.set(p.x, p.y + 5.6, p.z);
        wire.rotation.y = p.heading;
        g.add(wire);
      }
    }
    this.group.add(g);
    return g;
  }

  update(cx: number, cz: number, activeTracks: Track[]) {
    const ix = Math.floor(cx / CHUNK);
    const iz = Math.floor(cz / CHUNK);
    const need = new Set<string>();
    const rad = 2;
    for (let dz = -rad; dz <= rad; dz++) {
      for (let dx = -rad; dx <= rad; dx++) {
        need.add(`${ix + dx},${iz + dz}`);
      }
    }
    for (const key of [...this.chunks.keys()]) {
      if (!need.has(key)) {
        const obj = this.chunks.get(key)!;
        this.group.remove(obj);
        obj.traverse((o) => {
          const m = o as THREE.Mesh;
          if (m.geometry) m.geometry.dispose();
        });
        this.chunks.delete(key);
      }
    }
    for (const key of need) {
      if (this.chunks.has(key)) continue;
      const [sx, sz] = key.split(',').map(Number);
      const chunk = this.buildChunk(sx, sz, activeTracks);
      this.chunks.set(key, chunk);
      this.group.add(chunk);
    }
  }

  private buildChunk(ix: number, iz: number, _tracks: Track[]) {
    const g = new THREE.Group();
    g.userData.key = `${ix},${iz}`;
    const x0 = ix * CHUNK, z0 = iz * CHUNK;
    const segs = 20;
    const geo = new THREE.PlaneGeometry(CHUNK, CHUNK, segs, segs);
    geo.rotateX(-Math.PI / 2);
    const pos = geo.attributes.position;
    const colors = new Float32Array(pos.count * 3);
    for (let i = 0; i < pos.count; i++) {
      const lx = pos.getX(i) + x0 + CHUNK / 2;
      const lz = pos.getZ(i) + z0 + CHUNK / 2;
      const y = this.elev.heightAtLocal(lx, lz);
      pos.setY(i, y);
      // land-cover tint by rough region
      let r = 0.42, gch = 0.55, b = 0.32;
      if (lz < -2000 && lx < -2000) { r = 0.45; gch = 0.62; b = 0.38; } // UW / north Waterloo greener
      if (Math.hypot(lx + 1800, lz + 1600) < 900) { r = 0.55; gch = 0.52; b = 0.42; } // uptown
      if (Math.hypot(lx - 200, lz - 200) < 1200) { r = 0.5; gch = 0.48; b = 0.45; } // downtown Kitchener
      if (lx > 3500 && lz > 2500) { r = 0.48; gch = 0.5; b = 0.4; } // Fairway retail
      if (lz < -8000) { r = 0.4; gch = 0.58; b = 0.35; } // toward Elmira farmland
      if (lx > 15000) { r = 0.44; gch = 0.56; b = 0.36; } // Guelph approach
      colors[i * 3] = r; colors[i * 3 + 1] = gch; colors[i * 3 + 2] = b;
    }
    pos.needsUpdate = true;
    geo.computeVertexNormals();
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1 }));
    mesh.position.set(x0 + CHUNK / 2, 0, z0 + CHUNK / 2);
    mesh.receiveShadow = true;
    g.add(mesh);

    // Instanced trees
    const trees: THREE.Object3D[] = [];
    for (let n = 0; n < 40; n++) {
      const tx = x0 + Math.random() * CHUNK;
      const tz = z0 + Math.random() * CHUNK;
      const ty = this.elev.heightAtLocal(tx, tz);
      // skip if too close to origin rail band — rough
      const tree = new THREE.Mesh(this.treeGeo, this.treeMat);
      tree.position.set(tx, ty + 3.5, tz);
      tree.rotation.y = Math.random() * Math.PI;
      const sc = 0.7 + Math.random() * 0.8;
      tree.scale.setScalar(sc);
      trees.push(tree);
    }
    for (const t of trees) g.add(t);

    // Scenery polygons intersecting chunk
    if (this.scenery) {
      const pad = 50;
      const addPoly = (ring: number[][], mat: THREE.Material, yOff: number, extrudeH?: number) => {
        const shape = new THREE.Shape();
        let inside = false;
        for (let i = 0; i < ring.length; i++) {
          const [x, z] = ring[i];
          if (x >= x0 - pad && x <= x0 + CHUNK + pad && z >= z0 - pad && z <= z0 + CHUNK + pad) inside = true;
          if (i === 0) shape.moveTo(x, -z); else shape.lineTo(x, -z);
        }
        if (!inside) return;
        if (extrudeH && extrudeH > 0) {
          const eg = new THREE.ExtrudeGeometry(shape, { depth: extrudeH, bevelEnabled: false });
          eg.rotateX(-Math.PI / 2);
          const m = new THREE.Mesh(eg, mat);
          // drape approx using centroid height
          let cx = 0, cz = 0;
          for (const [x, z] of ring) { cx += x; cz += z; }
          cx /= ring.length; cz /= ring.length;
          m.position.y = this.elev.heightAtLocal(cx, cz) + yOff;
          g.add(m);
        } else {
          const sg = new THREE.ShapeGeometry(shape);
          sg.rotateX(-Math.PI / 2);
          const m = new THREE.Mesh(sg, mat);
          let cx = 0, cz = 0;
          for (const [x, z] of ring) { cx += x; cz += z; }
          cx /= ring.length; cz /= ring.length;
          m.position.y = this.elev.heightAtLocal(cx, cz) + 0.05 + yOff;
          g.add(m);
        }
      };
      for (const p of this.scenery.parks || []) {
        const mat = this.landMats[p.kind] || this.landMats.park;
        addPoly(p.ring, mat, 0.02);
      }
      for (const p of this.scenery.water || []) addPoly(p.ring, this.waterMat, 0.01);
      for (const p of this.scenery.landuse || []) {
        const mat = this.landMats[p.kind] || this.landMats.default;
        addPoly(p.ring, mat, 0.03);
      }
      for (const b of this.scenery.buildings || []) {
        addPoly(b.ring, this.buildingMat, 0, b.h || 8);
      }
    }
    return g;
  }
}
