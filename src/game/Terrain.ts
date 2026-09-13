import * as THREE from 'three';
import type { Elevation } from './elevation';
import type { Track } from './Track';
import type { RowClassifier } from './Row';
import type { SignalDef, CrossingDef, SignalAspect } from './Signals';

const CHUNK = 400; // metres

export class TerrainSystem {
  group = new THREE.Group();
  private elev: Elevation;
  private chunks = new Map<string, THREE.Object3D>();
  private scenery: any = null;
  private roads: { coords: number[][]; width: number; highway: string }[] = [];
  private row: RowClassifier | null = null;
  private signalDefs: SignalDef[] = [];
  private crossingDefs: CrossingDef[] = [];
  private signalMeshes = new Map<number, { group: THREE.Group; lamps: THREE.Mesh[] }>();
  private crossingMeshes = new Map<number, { group: THREE.Group; gate: THREE.Object3D; lamp: THREE.Mesh }>();
  private worldExtras = new THREE.Group(); // rails + signals + crossings (non-chunked / managed)
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
  private asphaltMat = new THREE.MeshStandardMaterial({ color: 0x2a2a2e, roughness: 0.95, metalness: 0.05 });
  private embeddedMat = new THREE.MeshStandardMaterial({ color: 0x353538, roughness: 0.92, metalness: 0.08 });
  private fenceMat = new THREE.MeshStandardMaterial({ color: 0x6e7888, metalness: 0.4, roughness: 0.55 });
  private mastMat = new THREE.MeshStandardMaterial({ color: 0x333338, metalness: 0.5, roughness: 0.45 });
  private redMat = new THREE.MeshStandardMaterial({ color: 0xff2020, emissive: 0xaa0000, emissiveIntensity: 0.9 });
  private amberMat = new THREE.MeshStandardMaterial({ color: 0xffaa00, emissive: 0x885500, emissiveIntensity: 0.9 });
  private greenMat = new THREE.MeshStandardMaterial({ color: 0x20ff40, emissive: 0x008820, emissiveIntensity: 0.9 });
  private offMat = new THREE.MeshStandardMaterial({ color: 0x221111, emissive: 0x000000, emissiveIntensity: 0 });

  constructor(elev: Elevation) {
    this.elev = elev;
    this.group.add(this.worldExtras);
  }

  /** Cheap wet-ground look: lower roughness / slight metalness when raining. */
  setWet(wet: boolean) {
    const r = wet ? 0.35 : 1;
    const m = wet ? 0.25 : 0;
    for (const mat of Object.values(this.landMats)) {
      mat.roughness = r;
      mat.metalness = m;
      mat.needsUpdate = true;
    }
    this.ballastMat.roughness = wet ? 0.45 : 1;
    this.ballastMat.metalness = wet ? 0.15 : 0;
    this.ballastMat.needsUpdate = true;
    this.railMat.roughness = wet ? 0.25 : 0.4;
    this.railMat.needsUpdate = true;
    this.asphaltMat.roughness = wet ? 0.4 : 0.95;
    this.asphaltMat.metalness = wet ? 0.2 : 0.05;
    this.asphaltMat.needsUpdate = true;
  }

  async loadScenery() {
    try {
      this.scenery = await (await fetch('./data/scenery.json')).json();
    } catch {
      this.scenery = null;
    }
    try {
      const roadsGj = await (await fetch('./data/roads.geojson')).json();
      this.roads = (roadsGj.features || []).map((f: any) => ({
        coords: f.geometry.coordinates as number[][],
        width: f.properties?.width || 6,
        highway: f.properties?.highway || 'residential',
      }));
    } catch {
      this.roads = [];
    }
  }

  setRowClassifier(row: RowClassifier | null) {
    this.row = row;
  }

  setSignalDefs(sigs: SignalDef[]) {
    this.signalDefs = sigs;
  }

  setCrossingDefs(xs: CrossingDef[]) {
    this.crossingDefs = xs;
  }

  /**
   * Build rail mesh for a track. ION uses ROW class: reserved = ballast+fence+catenary;
   * street = embedded rails in asphalt, no rural fence.
   */
  buildRails(track: Track) {
    const g = new THREE.Group();
    const pts = track.points;
    const isIon = track.name.includes('ION');
    const step = 2;
    for (let i = 0; i < pts.length - 1; i += step) {
      const a = pts[i], b = pts[Math.min(pts.length - 1, i + step)];
      const dx = b.x - a.x, dz = b.z - a.z, dy = b.y - a.y;
      const len = Math.hypot(dx, dy, dz);
      if (len < 0.5) continue;
      const mid = new THREE.Vector3((a.x + b.x) / 2, (a.y + b.y) / 2 - 0.15, (a.z + b.z) / 2);
      const street = isIon && this.row ? this.row.isStreetBand((a.s + b.s) / 2) : false;

      if (street) {
        // Embedded rails in asphalt ribbon
        const bed = new THREE.Mesh(new THREE.BoxGeometry(3.6, 0.12, len), this.embeddedMat);
        bed.position.copy(mid);
        bed.position.y += 0.02;
        bed.lookAt(b.x, b.y - 0.15, b.z);
        g.add(bed);
      } else {
        const ballast = new THREE.Mesh(new THREE.BoxGeometry(3.2, 0.25, len), this.ballastMat);
        ballast.position.copy(mid);
        ballast.lookAt(b.x, b.y - 0.15, b.z);
        g.add(ballast);
      }
      for (const side of [-0.72, 0.72]) {
        const rail = new THREE.Mesh(
          new THREE.BoxGeometry(0.12, street ? 0.08 : 0.18, len),
          this.railMat,
        );
        const hx = dx / len, hz = dz / len;
        const px = -hz * side, pz = hx * side;
        rail.position.set(mid.x + px, mid.y + (street ? 0.08 : 0.15), mid.z + pz);
        rail.lookAt(b.x + px, b.y, b.z + pz);
        g.add(rail);
      }
    }

    if (isIon) {
      for (let s = 0; s < track.length; s += 50) {
        const p = track.sample(s);
        const street = this.row ? this.row.isStreetBand(s) : false;
        // Catenary everywhere ION (street + reserved)
        const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.15, 7.5, 6), this.railMat);
        const side = street ? 2.8 : 3.2;
        const hx = Math.sin(p.heading), hz = Math.cos(p.heading);
        pole.position.set(p.x - hz * side, p.y + 3.5, p.z + hx * side);
        g.add(pole);
        const wire = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.04, 50), this.railMat);
        wire.position.set(p.x, p.y + 5.6, p.z);
        wire.rotation.y = p.heading;
        g.add(wire);

        // Side fence / posts only on reserved corridor
        if (!street) {
          for (const sideSign of [-1, 1]) {
            const post = new THREE.Mesh(
              new THREE.BoxGeometry(0.08, 1.4, 0.08),
              this.fenceMat,
            );
            post.position.set(
              p.x - hz * sideSign * 4.2,
              p.y + 0.7,
              p.z + hx * sideSign * 4.2,
            );
            g.add(post);
            if (s % 100 < 50) {
              const railF = new THREE.Mesh(
                new THREE.BoxGeometry(0.04, 0.06, 48),
                this.fenceMat,
              );
              railF.position.set(
                p.x - hz * sideSign * 4.2,
                p.y + 1.1,
                p.z + hx * sideSign * 4.2,
              );
              railF.rotation.y = p.heading;
              g.add(railF);
            }
          }
        }
      }
    }
    this.worldExtras.add(g);
    return g;
  }

  /** Place 3D traffic-signal heads (street-running ION). */
  buildTrafficSignals(track: Track | null) {
    for (const [, m] of this.signalMeshes) {
      this.worldExtras.remove(m.group);
    }
    this.signalMeshes.clear();
    // Thin: keep signals within 35 m of track samples already filtered; cluster ~18 m
    const placed: SignalDef[] = [];
    for (const sig of this.signalDefs) {
      if (placed.some((p) => Math.hypot(p.x - sig.x, p.z - sig.z) < 18)) continue;
      // Prefer street-band signals for ION visuals
      if (this.row && !this.row.isStreetBand(sig.s_ion) && sig.dist_m > 18) continue;
      placed.push(sig);
    }
    for (const sig of placed) {
      const y = this.elev.heightAtLocal(sig.x, sig.z);
      const g = new THREE.Group();
      const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.1, 5.2, 6), this.mastMat);
      mast.position.set(0, 2.6, 0);
      g.add(mast);
      const housing = new THREE.Mesh(new THREE.BoxGeometry(0.35, 0.95, 0.28), this.mastMat);
      housing.position.set(0, 4.6, 0.1);
      g.add(housing);
      const lamps: THREE.Mesh[] = [];
      for (let i = 0; i < 3; i++) {
        const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.1, 8, 8), this.offMat);
        lamp.position.set(0, 4.9 - i * 0.28, 0.28);
        g.add(lamp);
        lamps.push(lamp);
      }
      // Orient roughly toward track if we have heading
      let heading = 0;
      if (track) {
        const p = track.sample(Math.min(track.length, Math.max(0, sig.s_ion)));
        heading = p.heading + Math.PI / 2;
      }
      g.position.set(sig.x, y, sig.z);
      g.rotation.y = heading;
      this.worldExtras.add(g);
      this.signalMeshes.set(sig.id, { group: g, lamps });
    }
  }

  /** Heavy-rail crossing gates / flashers. */
  buildCrossings() {
    for (const [, m] of this.crossingMeshes) {
      this.worldExtras.remove(m.group);
    }
    this.crossingMeshes.clear();
    for (const c of this.crossingDefs) {
      if (c.style !== 'gates_flashers') continue;
      const y = this.elev.heightAtLocal(c.x, c.z);
      const g = new THREE.Group();
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.12, 3.2, 6), this.mastMat);
      post.position.y = 1.6;
      g.add(post);
      const gate = new THREE.Group();
      const arm = new THREE.Mesh(new THREE.BoxGeometry(4.5, 0.12, 0.18), new THREE.MeshStandardMaterial({ color: 0xe8e8e8 }));
      // stripes
      for (let i = 0; i < 5; i++) {
        if (i % 2 === 0) continue;
        const stripe = new THREE.Mesh(
          new THREE.BoxGeometry(0.7, 0.13, 0.19),
          new THREE.MeshStandardMaterial({ color: 0xcc2020 }),
        );
        stripe.position.set(-1.8 + i * 0.9, 0, 0);
        gate.add(stripe);
      }
      arm.position.set(2.1, 0, 0);
      gate.add(arm);
      gate.position.set(0, 2.6, 0);
      g.add(gate);
      const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.15, 8, 8), this.redMat);
      lamp.position.set(0, 3.0, 0.25);
      g.add(lamp);
      g.position.set(c.x, y, c.z);
      this.worldExtras.add(g);
      this.crossingMeshes.set(c.id, { group: g, gate, lamp });
    }
  }

  updateSignalAspects(
    getAspect: (id: number) => SignalAspect | null,
  ) {
    for (const [id, mesh] of this.signalMeshes) {
      const asp = getAspect(id);
      const mats = [this.redMat, this.amberMat, this.greenMat];
      const on =
        asp === 'red' ? 0 : asp === 'amber' ? 1 : asp === 'green' ? 2 : -1;
      mesh.lamps.forEach((lamp, i) => {
        lamp.material = i === on ? mats[i] : this.offMat;
      });
    }
  }

  updateCrossingGates(
    activeIds: Set<number>,
    tSec: number,
  ) {
    for (const [id, mesh] of this.crossingMeshes) {
      const active = activeIds.has(id);
      // Gate down when active (rotation.z ~ -PI/2 from horizontal? arm is horizontal at rest up)
      // Rest: arm horizontal along +x at height; active: stays down (horizontal blocking)
      // Use raised = rotated up
      const target = active ? 0 : -Math.PI / 2;
      mesh.gate.rotation.z += (target - mesh.gate.rotation.z) * 0.08;
      const blink = active && Math.floor(tSec * 4) % 2 === 0;
      mesh.lamp.material = blink ? this.redMat : this.offMat;
      mesh.lamp.visible = true;
    }
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
      let r = 0.42, gch = 0.55, b = 0.32;
      if (lz < -2000 && lx < -2000) { r = 0.45; gch = 0.62; b = 0.38; }
      if (Math.hypot(lx + 1800, lz + 1600) < 900) { r = 0.55; gch = 0.52; b = 0.42; }
      if (Math.hypot(lx - 200, lz - 200) < 1200) { r = 0.5; gch = 0.48; b = 0.45; }
      if (lx > 3500 && lz > 2500) { r = 0.48; gch = 0.5; b = 0.4; }
      if (lz < -8000) { r = 0.4; gch = 0.58; b = 0.35; }
      if (lx > 15000) { r = 0.44; gch = 0.56; b = 0.36; }
      colors[i * 3] = r; colors[i * 3 + 1] = gch; colors[i * 3 + 2] = b;
    }
    pos.needsUpdate = true;
    geo.computeVertexNormals();
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1 }));
    mesh.position.set(x0 + CHUNK / 2, 0, z0 + CHUNK / 2);
    mesh.receiveShadow = true;
    g.add(mesh);

    // OSM road ribbons in this chunk
    const pad = 40;
    for (const road of this.roads) {
      const coords = road.coords;
      let touches = false;
      for (const [x, z] of coords) {
        if (x >= x0 - pad && x <= x0 + CHUNK + pad && z >= z0 - pad && z <= z0 + CHUNK + pad) {
          touches = true;
          break;
        }
      }
      if (!touches) continue;
      for (let i = 0; i < coords.length - 1; i++) {
        const [ax, az] = coords[i];
        const [bx, bz] = coords[i + 1];
        const mx = (ax + bx) / 2, mz = (az + bz) / 2;
        if (mx < x0 - pad || mx > x0 + CHUNK + pad || mz < z0 - pad || mz > z0 + CHUNK + pad) continue;
        const len = Math.hypot(bx - ax, bz - az);
        if (len < 1) continue;
        const y = this.elev.heightAtLocal(mx, mz) + 0.06;
        const ribbon = new THREE.Mesh(
          new THREE.BoxGeometry(road.width, 0.08, len),
          this.asphaltMat,
        );
        ribbon.position.set(mx, y, mz);
        ribbon.lookAt(bx, y, bz);
        g.add(ribbon);
      }
    }

    // Instanced trees (fewer near dense road chunks)
    const trees: THREE.Object3D[] = [];
    for (let n = 0; n < 28; n++) {
      const tx = x0 + Math.random() * CHUNK;
      const tz = z0 + Math.random() * CHUNK;
      const ty = this.elev.heightAtLocal(tx, tz);
      const tree = new THREE.Mesh(this.treeGeo, this.treeMat);
      tree.position.set(tx, ty + 3.5, tz);
      tree.rotation.y = Math.random() * Math.PI;
      const sc = 0.7 + Math.random() * 0.8;
      tree.scale.setScalar(sc);
      trees.push(tree);
    }
    for (const t of trees) g.add(t);

    if (this.scenery) {
      const spad = 50;
      const addPoly = (ring: number[][], mat: THREE.Material, yOff: number, extrudeH?: number) => {
        const shape = new THREE.Shape();
        let inside = false;
        for (let i = 0; i < ring.length; i++) {
          const [x, z] = ring[i];
          if (x >= x0 - spad && x <= x0 + CHUNK + spad && z >= z0 - spad && z <= z0 + CHUNK + spad) inside = true;
          if (i === 0) shape.moveTo(x, -z); else shape.lineTo(x, -z);
        }
        if (!inside) return;
        if (extrudeH && extrudeH > 0) {
          const eg = new THREE.ExtrudeGeometry(shape, { depth: extrudeH, bevelEnabled: false });
          eg.rotateX(-Math.PI / 2);
          const m = new THREE.Mesh(eg, mat);
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
