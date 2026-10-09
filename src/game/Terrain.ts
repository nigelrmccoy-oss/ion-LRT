import * as THREE from 'three';
import type { Elevation } from './elevation';
import type { Track } from './Track';
import type { RowClassifier } from './Row';
import type { SignalDef, CrossingDef, SignalAspect } from './Signals';
import type { CesiumIonImagery } from './CesiumIon';
import { GroundModel, GRID_M, SLOPE_REACH_M, ROAD_SINK_M, type CorridorTrack } from './Ground';
import {
  BALLAST_TOP_HALF_WIDTH_M,
  FORMATION_DEPTH_M,
  LRT_TRACK_CENTRES_M,
  OCS_WIRE_HEIGHT_RESERVED_M,
  OCS_WIRE_HEIGHT_STREET_M,
  OCS_POLE_OFFSET_M,
  OCS_POLE_SPACING_M,
  FREIGHT_SIDE_CLEARANCE_M,
  RAIL_CENTRES_M,
  RAIL_TOP_ABOVE_TRACK_Y_M,
  envelopeHalfWidth,
} from './Clearances';

const CHUNK = 400; // metres
const SEGS = CHUNK / GRID_M; // terrain vertices every GRID_M (5 m)

/** Shared polygon-offset settings: draped layers win depth ties against the terrain mesh. */
function offsetMat<T extends THREE.Material>(m: T, factor: number, units: number): T {
  m.polygonOffset = true;
  m.polygonOffsetFactor = factor;
  m.polygonOffsetUnits = units;
  return m;
}

type Poly = { ring: number[][]; minX: number; maxX: number; minZ: number; maxZ: number; color: [number, number, number] };

function pointInRing(x: number, z: number, ring: number[][]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], zi = ring[i][1], xj = ring[j][0], zj = ring[j][1];
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi + 1e-12) + xi) inside = !inside;
  }
  return inside;
}

const LAND_COLORS: Record<string, [number, number, number]> = {
  residential: [0.77, 0.72, 0.63],
  commercial: [0.69, 0.63, 0.56],
  industrial: [0.54, 0.53, 0.5],
  retail: [0.82, 0.77, 0.69],
  education: [0.61, 0.73, 0.54],
  university: [0.56, 0.72, 0.48],
  campus: [0.56, 0.72, 0.48],
  grass: [0.42, 0.6, 0.29],
  forest: [0.24, 0.42, 0.2],
  park: [0.35, 0.6, 0.29],
  default: [0.43, 0.55, 0.32],
};

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
  // Rails win depth ties against draped roads / street pavement (roads used −2/−4 and
  // covered the left rail near Central at grazing angles)
  private railMat = offsetMat(new THREE.MeshStandardMaterial({ color: 0x444448, metalness: 0.7, roughness: 0.4 }), -4, -8);
  private ballastMat = new THREE.MeshStandardMaterial({ color: 0x6a6560, roughness: 1 });
  private asphaltMat = new THREE.MeshStandardMaterial({ color: 0x2a2a2e, roughness: 0.95, metalness: 0.05 });
  private embeddedMat = new THREE.MeshStandardMaterial({ color: 0x353538, roughness: 0.92, metalness: 0.08 });
  private fenceMat = new THREE.MeshStandardMaterial({ color: 0x6e7888, metalness: 0.4, roughness: 0.55 });
  private mastMat = new THREE.MeshStandardMaterial({ color: 0x333338, metalness: 0.5, roughness: 0.45 });
  private redMat = new THREE.MeshStandardMaterial({ color: 0xff2020, emissive: 0xaa0000, emissiveIntensity: 0.9 });
  private amberMat = new THREE.MeshStandardMaterial({ color: 0xffaa00, emissive: 0x885500, emissiveIntensity: 0.9 });
  private greenMat = new THREE.MeshStandardMaterial({ color: 0x20ff40, emissive: 0x008820, emissiveIntensity: 0.9 });
  private offMat = new THREE.MeshStandardMaterial({ color: 0x221111, emissive: 0x000000, emissiveIntensity: 0 });
  private ion: CesiumIonImagery | null = null;
  /** Corrected heightfield (DEM + track cut/fill corridor). */
  ground: GroundModel;
  private polys: Poly[] = [];
  private corridorMat = offsetMat(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1 }), -1, -2);
  private roadMat = offsetMat(new THREE.MeshStandardMaterial({ color: 0x2a2a2e, roughness: 0.95, metalness: 0.05 }), -2, -4);
  private deckMat = new THREE.MeshStandardMaterial({ color: 0x9a9890, roughness: 0.9 });
  private ribbonGroup = new THREE.Group();
  private sceneryGroups: THREE.Object3D[] = [];
  private photoreal = false;
  /** Contact-wire height lookup per ION chainage (for pantograph). */
  wireHeightAt: (s: number) => number = () => OCS_WIRE_HEIGHT_STREET_M;

  constructor(elev: Elevation) {
    this.elev = elev;
    this.ground = new GroundModel(elev);
    this.group.add(this.worldExtras);
    this.group.add(this.ribbonGroup);
  }

  /**
   * Register track corridors before building rails / chunks. ION gets the street flag
   * from the OSM ROW classifier and a second (visual) track on reserved sections.
   */
  setCorridors(tracks: Track[]) {
    // v1.4.1: ION is two real running lines (SB + NB from OSM), each its own corridor —
    // no synthetic "parallel visual track" any more.
    for (const t of tracks) {
      const isIon = t.name.includes('ION');
      this.ground.addTrack(t, {
        isStreet: isIon && this.row ? (s) => this.row!.isStreetBand(t.refS(s)) : undefined,
      });
    }
    this.ground.setRoads(this.roads);
  }

  /** Photoreal 3D tiles replace the OSM ground/buildings; rails, OCS and stations stay. */
  setPhotorealMode(on: boolean) {
    this.photoreal = on;
    for (const c of this.chunks.values()) c.visible = !on;
    this.ribbonGroup.visible = !on;
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
    this.roadMat.roughness = wet ? 0.4 : 0.95;
    this.roadMat.metalness = wet ? 0.2 : 0.05;
    this.roadMat.needsUpdate = true;
    this.corridorMat.roughness = wet ? 0.5 : 1;
    this.corridorMat.needsUpdate = true;
  }

  async loadScenery() {
    try {
      this.scenery = await (await fetch('./data/scenery.json')).json();
    } catch {
      this.scenery = null;
    }
    this.polys = [];
    if (this.scenery) {
      const add = (ring: number[][], color: [number, number, number]) => {
        if (!ring || ring.length < 3) return;
        let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
        for (const [x, z] of ring) {
          if (x < minX) minX = x; if (x > maxX) maxX = x;
          if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
        }
        this.polys.push({ ring, minX, maxX, minZ, maxZ, color });
      };
      // painting order = priority (later wins): landuse < parks < water
      for (const p of this.scenery.landuse || []) add(p.ring, LAND_COLORS[p.kind] || LAND_COLORS.default);
      for (const p of this.scenery.parks || []) add(p.ring, LAND_COLORS[p.kind] || LAND_COLORS.park);
      for (const p of this.scenery.water || []) add(p.ring, [0.23, 0.43, 0.65]);
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

  setIonImagery(ion: CesiumIonImagery | null) {
    this.ion = ion;
  }


  private corridorFor(track: Track): CorridorTrack | null {
    return this.ground.tracks.find((c) => c.track === track) || null;
  }

  /**
   * Corridor ribbon (formation + cut/fill slopes, draped on the corrected heightfield),
   * ballast prism / embedded slab, rails, bridges and — for ION — OCS + second track.
   * Call setCorridors() first.
   */
  buildRails(track: Track) {
    const g = new THREE.Group();
    const isIon = track.name.includes('ION');
    const cor = this.corridorFor(track);
    if (!cor) {
      this.ground.addTrack(track);
    }
    const corridor = this.corridorFor(track)!;
    const smp = corridor.samples;
    const street = (i: number) => smp[i].street;
    const parallel = (i: number) => smp[i].left - smp[i].right; // >0 → second track on left

    // ---- 1. corridor ribbon (skips bridge spans) -------------------------------------
    const ribbonOffsets = (i: number) => {
      const c = smp[i];
      const L = c.left, R = c.right;
      const outs = [0, 1.5, 3.5, 6, 9, 13, SLOPE_REACH_M];
      const left = outs.map((o) => L + o);
      const right = outs.map((o) => -(R + o)).reverse();
      const mid: number[] = [];
      for (const v of [-R + 0.01, -BALLAST_TOP_HALF_WIDTH_M, 0, BALLAST_TOP_HALF_WIDTH_M, L - 0.01]) {
        if (v > -R && v < L) mid.push(v);
      }
      return [...right, ...mid, ...left];
    };
    const flushRibbon = (from: number, to: number) => {
      if (to - from < 1) return;
      const cols = ribbonOffsets(from).length;
      const pos: number[] = [], col: number[] = [], idx: number[] = [];
      for (let i = from; i <= to; i++) {
        const c = smp[i];
        const offs = ribbonOffsets(i);
        const lx = c.fz, lz = -c.fx;
        for (let k = 0; k < cols; k++) {
          const o = offs[k] ?? offs[offs.length - 1];
          const x = c.x + lx * o, z = c.z + lz * o;
          const inFlat = o > -c.right && o < c.left;
          const h = inFlat ? c.form : this.ground.exactHeight(x, z) - this.ground.roadSink(x, z);
          pos.push(x, h, z);
          let r = 0.42, gg = 0.55, b = 0.3; // grass slope
          if (inFlat) {
            if (c.street) { r = 0.36; gg = 0.36; b = 0.37; } // asphalt / embedded concrete
            else { r = 0.45; gg = 0.42; b = 0.38; } // gravel shoulder
          } else if (Math.abs(h - c.form) < 0.05) {
            // shared formation with a neighbouring line: same colour as its flat zone
            if (c.street) { r = 0.36; gg = 0.36; b = 0.37; } else { r = 0.45; gg = 0.42; b = 0.38; }
          }
          col.push(r, gg, b);
        }
      }
      for (let i = 0; i < to - from; i++) {
        for (let k = 0; k < cols - 1; k++) {
          const a0 = i * cols + k, a1 = a0 + 1, b0 = a0 + cols, b1 = b0 + 1;
          idx.push(a0, b0, a1, a1, b0, b1);
        }
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
      geo.setIndex(idx);
      geo.computeVertexNormals();
      const mesh = new THREE.Mesh(geo, this.corridorMat);
      mesh.receiveShadow = true;
      this.ribbonGroup.add(mesh);
    };
    {
      let start = -1;
      const CHUNK_SAMPLES = 100;
      for (let i = 0; i < smp.length; i++) {
        const ok = !smp[i].bridge && (i === 0 || street(i) === street(i - 1)) && (i === 0 || parallel(i) === parallel(i - 1));
        if (start < 0) { if (!smp[i].bridge) start = i; continue; }
        if (!ok || i - start >= CHUNK_SAMPLES) {
          flushRibbon(start, smp[i].bridge ? i - 1 : i);
          start = smp[i].bridge ? -1 : i;
        }
      }
      if (start >= 0) flushRibbon(start, smp.length - 1);
    }

    // ---- 2. ballast prism (continuous strip) + rails ------------------------------------
    const railTop = RAIL_TOP_ABOVE_TRACK_Y_M;
    const lines: number[] = [0];
    for (const lineOff of lines) {
      const bpos: number[] = [], bidx: number[] = [];
      let run = 0;
      const rails: number[][] = [[], []];
      for (let i = 0; i < smp.length; i++) {
        const c = smp[i];
        const has = lineOff === 0;
        const lx = c.fz, lz = -c.fx;
        const cx = c.x + lx * lineOff, cz = c.z + lz * lineOff;
        if (!has) { run = 0; rails[0].push(NaN, NaN, NaN); rails[1].push(NaN, NaN, NaN); continue; }
        if (!c.street) {
          const topY = c.y - 0.03, botY = c.bridge ? c.y - 0.3 : c.form + 0.02;
          const hwTop = BALLAST_TOP_HALF_WIDTH_M, hwBot = hwTop + (topY - botY) * 1.5;
          for (const [o, y] of [[-hwBot, botY], [-hwTop, topY], [hwTop, topY], [hwBot, botY]] as [number, number][]) {
            bpos.push(cx + lx * o, y, cz + lz * o);
          }
          const base = bpos.length / 3 - 4;
          if (run > 0) {
            const p0 = base - 4;
            for (let k = 0; k < 3; k++) bidx.push(p0 + k, base + k, p0 + k + 1, p0 + k + 1, base + k, base + k + 1);
          }
          run++;
        } else run = 0;
        for (let side = 0; side < 2; side++) {
          const o = (side === 0 ? -1 : 1) * RAIL_CENTRES_M / 2;
          rails[side].push(cx + lx * o, c.y + railTop, cz + lz * o);
        }
      }
      if (bidx.length) {
        const bg = new THREE.BufferGeometry();
        bg.setAttribute('position', new THREE.Float32BufferAttribute(bpos, 3));
        bg.setIndex(bidx);
        bg.computeVertexNormals();
        const bm = new THREE.Mesh(bg, this.ballastMat);
        bm.receiveShadow = true;
        g.add(bm);
      }
      // Rails as thin strips (head 7 cm wide, web drops to tie level)
      for (const r of rails) {
        const pos: number[] = [], idx: number[] = [];
        let prev = -1;
        for (let i = 0; i + 2 < r.length; i += 3) {
          const x = r[i], y = r[i + 1], z = r[i + 2];
          if (!Number.isFinite(x)) { prev = -1; continue; }
          const c = smp[Math.floor(i / 3)] ?? smp[smp.length - 1];
          const lx = c.fz * 0.035, lz = -c.fx * 0.035;
          pos.push(x - lx, y, z - lz, x + lx, y, z + lz, x - lx, y - 0.16, z - lz, x + lx, y - 0.16, z + lz);
          const cur = pos.length / 3 - 4;
          if (prev >= 0) {
            idx.push(prev, cur, prev + 1, prev + 1, cur, cur + 1); // head
            idx.push(prev + 2, cur + 2, prev, prev, cur + 2, cur); // left web
            idx.push(prev + 1, cur + 1, prev + 3, prev + 3, cur + 1, cur + 3); // right web
          }
          prev = cur;
        }
        if (!idx.length) continue;
        const rg = new THREE.BufferGeometry();
        rg.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
        rg.setIndex(idx);
        rg.computeVertexNormals();
        const rm = new THREE.Mesh(rg, this.railMat);
        g.add(rm);
      }
    }

    // ---- 3. bridges / viaducts where the rail is well above terrain -----------------------
    for (let i = 0; i < smp.length - 1; i++) {
      const c = smp[i], n = smp[i + 1];
      if (!c.bridge || !n.bridge) continue;
      const w = c.left + c.right;
      const mid = new THREE.Vector3((c.x + n.x) / 2, (c.y + n.y) / 2 - FORMATION_DEPTH_M + 0.05, (c.z + n.z) / 2);
      const len = Math.hypot(n.x - c.x, n.z - c.z) + 0.05;
      const deck = new THREE.Mesh(new THREE.BoxGeometry(w, 0.8, len), this.deckMat);
      const off = (c.left - c.right) / 2;
      deck.position.set(mid.x + c.fz * off, mid.y - 0.4, mid.z - c.fx * off);
      deck.rotation.y = Math.atan2(c.fx, c.fz);
      g.add(deck);
      if (Math.round(c.s) % 24 < corridor.step) {
        const ground = this.elev.heightAtLocal(c.x, c.z);
        const h = c.form - 0.8 - ground;
        if (h > 0.5) {
          const pier = new THREE.Mesh(new THREE.BoxGeometry(w * 0.6, h, 1.2), this.deckMat);
          pier.position.set(c.x + c.fz * off, ground + h / 2, c.z - c.fx * off);
          pier.rotation.y = deck.rotation.y;
          g.add(pier);
        }
      }
    }

    // ---- 4. ION overhead contact system (one wire per running line) ----------------------
    if (isIon) {
      const streetAt = (s: number) => !!(this.row && this.row.isStreetBand(track.refS(s)));
      const wireH = (s: number) => (streetAt(s) ? OCS_WIRE_HEIGHT_STREET_M : OCS_WIRE_HEIGHT_RESERVED_M);
      // pantograph lookup is keyed to reference chainage
      this.wireHeightAt = (sRef: number) =>
        (this.row && this.row.isStreetBand(sRef)) ? OCS_WIRE_HEIGHT_STREET_M : OCS_WIRE_HEIGHT_RESERVED_M;
      const wp: number[] = [];
      for (let s = 0; s <= track.length; s += 10) {
        const p = track.sample(s);
        const lx = Math.cos(p.heading), lz = -Math.sin(p.heading);
        const stagger = (Math.floor(s / OCS_POLE_SPACING_M) % 2 === 0 ? 1 : -1) * 0.2;
        wp.push(p.x + lx * stagger, p.y + railTop + wireH(s), p.z + lz * stagger);
      }
      const segs: number[] = [];
      for (let i = 0; i + 5 < wp.length; i += 3) segs.push(wp[i], wp[i + 1], wp[i + 2], wp[i + 3], wp[i + 4], wp[i + 5]);
      const lg = new THREE.BufferGeometry();
      lg.setAttribute('position', new THREE.Float32BufferAttribute(segs, 3));
      g.add(new THREE.LineSegments(lg, new THREE.LineBasicMaterial({ color: 0x2b2b2b })));
      for (let s = 0; s < track.length; s += OCS_POLE_SPACING_M) {
        const p = track.sample(s);
        const R = p.curvature > 1e-5 ? 1 / p.curvature : 1e6;
        const off = Math.max(OCS_POLE_OFFSET_M, envelopeHalfWidth(R) + 0.3);
        const lx = Math.cos(p.heading), lz = -Math.sin(p.heading);
        // pole on the right; if another line is on that side (pole would stand in the
        // gap / its envelope) use the left; if both sides are taken, the neighbour's poles
        // carry the cantilever.
        let side = 0;
        for (const cand of [-1, 1]) {
          const px = p.x + lx * cand * off, pz = p.z + lz * cand * off;
          if (this.ground.nearestOtherTrackDist(px, pz, track) > off) { side = cand; break; }
        }
        if (!side) continue;
        const wh = wireH(s);
        const poleH = wh + 1.4;
        const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.16, poleH, 8), this.mastMat);
        const px = p.x + lx * side * off, pz = p.z + lz * side * off;
        pole.position.set(px, p.y + poleH / 2 - 0.3, pz);
        g.add(pole);
        const reach = off + 0.5;
        const arm = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.06, reach), this.mastMat);
        arm.position.set(px - lx * side * reach / 2, p.y + railTop + wh + 0.9, pz - lz * side * reach / 2);
        arm.rotation.y = p.heading + Math.PI / 2;
        g.add(arm);
        // fence post on reserved ROW, outside the pole, unless another line is there
        if (!streetAt(s)) {
          const fo = side * (off + 1.0);
          const fx = p.x + lx * fo, fz = p.z + lz * fo;
          if (this.ground.nearestOtherTrackDist(fx, fz, track) > off + 1) {
            const post = new THREE.Mesh(new THREE.BoxGeometry(0.08, 1.4, 0.08), this.fenceMat);
            post.position.set(fx, this.ground.exactHeight(fx, fz) + 0.7, fz);
            g.add(post);
          }
        }
      }
    }
    this.worldExtras.add(g);
    return g;
  }

  /** Place 3D traffic-signal heads (street-running ION), clear of every running line. */
  buildTrafficSignals(tracks: Track[] | null) {
    for (const [, m] of this.signalMeshes) {
      this.worldExtras.remove(m.group);
    }
    this.signalMeshes.clear();
    const lines = tracks ?? [];
    const placed: SignalDef[] = [];
    for (const sig of this.signalDefs) {
      if (placed.some((p) => Math.hypot(p.x - sig.x, p.z - sig.z) < 18)) continue;
      if (this.row && !this.row.isStreetBand(sig.s_ion) && sig.dist_m > 18) continue;
      placed.push(sig);
    }
    const clearance = (x: number, z: number) => {
      let worst = Infinity;
      for (const t of lines) {
        const s = t.nearestSLocal(x, z);
        const p = t.sample(s);
        const R = p.curvature > 1e-5 ? 1 / p.curvature : 1e6;
        const need = Math.max(OCS_POLE_OFFSET_M + 0.6, envelopeHalfWidth(R) + 0.6);
        worst = Math.min(worst, Math.hypot(x - p.x, z - p.z) - need);
      }
      return worst;
    };
    for (const sig of placed) {
      // Keep the mast outside every LRV dynamic envelope (OSM nodes often sit on the rail)
      let sx = sig.x, sz = sig.z, heading = 0;
      if (lines.length) {
        let near = lines[0], nd = Infinity, ns = 0;
        for (const t of lines) {
          const s = t.nearestSLocal(sx, sz);
          const q = t.sampleRaw(s);
          const d = Math.hypot(q.x - sx, q.z - sz);
          if (d < nd) { nd = d; near = t; ns = s; }
        }
        const p = near.sample(ns);
        heading = p.heading + Math.PI / 2;
        if (clearance(sx, sz) < 0) {
          const lx = Math.cos(p.heading), lz = -Math.sin(p.heading);
          const lat = (sx - p.x) * lx + (sz - p.z) * lz;
          const pref = lat > 0.01 ? 1 : -1;
          let done = false;
          for (const extra of [0, 1, 2, 3, 4, 5, 6, 8, 10]) {
            for (const side of [pref, -pref]) {
              const o = OCS_POLE_OFFSET_M + 0.6 + extra;
              const cx = p.x + lx * side * o, cz = p.z + lz * side * o;
              if (clearance(cx, cz) >= 0) { sx = cx; sz = cz; done = true; break; }
            }
            if (done) break;
          }
        }
      }
      const y = this.ground.exactHeight(sx, sz);
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
      g.position.set(sx, y, sz);
      g.rotation.y = heading;
      this.worldExtras.add(g);
      this.signalMeshes.set(sig.id, { group: g, lamps });
    }
  }

  /** Heavy-rail crossing gates / flashers. */
  buildCrossings(tracksByLine: Record<string, Track | undefined> = {}) {
    for (const [, m] of this.crossingMeshes) {
      this.worldExtras.remove(m.group);
    }
    this.crossingMeshes.clear();
    for (const c of this.crossingDefs) {
      if (c.style !== 'gates_flashers') continue;
      // Gate mast outside Transport Canada TC E-05 side clearance (2.546 m from track CL)
      let cx = c.x, cz = c.z;
      const t = tracksByLine[c.line];
      if (t) {
        const p = t.sample(Math.min(t.length, Math.max(0, c.s)));
        const off = FREIGHT_SIDE_CLEARANCE_M + 1.0;
        cx = p.x - Math.cos(p.heading) * off;
        cz = p.z + Math.sin(p.heading) * off;
      }
      const y = this.ground.exactHeight(cx, cz);
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
      g.position.set(cx, y, cz);
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
    const n = SEGS + 1;
    // ---- ground: grid on the corrected heightfield, landuse painted per vertex ----------
    const pos = new Float32Array(n * n * 3);
    const colors = new Float32Array(n * n * 3);
    const uvs = new Float32Array(n * n * 2);
    const polys = this.polys.filter(
      (p) => p.maxX >= x0 && p.minX <= x0 + CHUNK && p.maxZ >= z0 && p.minZ <= z0 + CHUNK,
    );
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const x = x0 + i * GRID_M, z = z0 + j * GRID_M;
        const k = j * n + i;
        const y = this.ground.gridHeight(x, z);
        pos[k * 3] = x; pos[k * 3 + 1] = y; pos[k * 3 + 2] = z;
        let r = 0.42, gch = 0.55, b = 0.32;
        for (const p of polys) {
          if (x < p.minX || x > p.maxX || z < p.minZ || z > p.maxZ) continue;
          if (pointInRing(x, z, p.ring)) { [r, gch, b] = p.color; }
        }
        // slight noise so large fields aren't flat colour
        const nse = (Math.sin(x * 0.13) * Math.cos(z * 0.11)) * 0.025;
        colors[k * 3] = r + nse; colors[k * 3 + 1] = gch + nse; colors[k * 3 + 2] = b + nse;
        uvs[k * 2] = i / SEGS; uvs[k * 2 + 1] = 1 - j / SEGS;
      }
    }
    // Same diagonal as GroundModel.surfaceHeight: triangles (a,d,c) and (a,c,b) where
    // a=(i,j) b=(i,j+1) c=(i+1,j+1) d=(i+1,j); winding chosen so normals face +y.
    const idx: number[] = [];
    for (let j = 0; j < SEGS; j++) {
      for (let i = 0; i < SEGS; i++) {
        const a = j * n + i, d = a + 1, bb = a + n, c = bb + 1;
        idx.push(a, c, d, a, bb, c);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    const groundMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1 });
    const mesh = new THREE.Mesh(geo, groundMat);
    mesh.receiveShadow = true;
    g.add(mesh);
    // Optional Cesium Ion aerial (fallback keeps vertex colours)
    if (this.ion && this.ion.status === 'ready') {
      const cx = x0 + CHUNK / 2, cz = z0 + CHUNK / 2;
      void this.ion.textureForLocal(cx, cz, 16).then((tex) => {
        if (!tex || !mesh.parent) return;
        groundMat.map = tex;
        groundMat.vertexColors = false;
        groundMat.color.set(0xffffff);
        groundMat.needsUpdate = true;
      });
    }

    // ---- OSM roads: per-vertex drape on the rendered terrain surface (+ rail level at
    //      level crossings), polygonOffset against the ground ------------------------------
    const pad = 40;
    const rpos: number[] = [], ridx: number[] = [];
    // Roads follow the smooth design surface; the terrain mesh and corridor-ribbon slopes
    // are sunk ROAD_SINK_M under every road (GroundModel.roadSink), so neither can poke
    // through between road vertices. Inside a track's flat zone (street running) the road
    // sits at pavement level, below the rail head.
    const drapeY = (x: number, z: number) => this.ground.roadHeight(x, z);
    for (const road of this.roads) {
      const coords = road.coords;
      for (let i = 0; i < coords.length - 1; i++) {
        const [ax, az] = coords[i];
        const [bx, bz] = coords[i + 1];
        const mx = (ax + bx) / 2, mz = (az + bz) / 2;
        if (mx < x0 - pad || mx > x0 + CHUNK + pad || mz < z0 - pad || mz > z0 + CHUNK + pad) continue;
        // only the owning chunk draws a segment (avoid double draw z-fight)
        if (Math.floor(mx / CHUNK) !== ix || Math.floor(mz / CHUNK) !== iz) continue;
        const len = Math.hypot(bx - ax, bz - az);
        if (len < 0.5) continue;
        const ux = (bx - ax) / len, uz = (bz - az) / len;
        const hw = road.width / 2;
        const steps = Math.max(1, Math.ceil(len / 2.5));
        const across = Math.max(1, Math.ceil(road.width / 2.5)); // ≤ 2.5 m between vertices
        let prev = -1;
        for (let k = 0; k <= steps; k++) {
          const t = k / steps;
          const x = ax + (bx - ax) * t, z = az + (bz - az) * t;
          const lx = -uz, lz = ux;
          for (let c = 0; c <= across; c++) {
            const o = -hw + (2 * hw * c) / across;
            rpos.push(x + lx * o, drapeY(x + lx * o, z + lz * o), z + lz * o);
          }
          const cur = rpos.length / 3 - (across + 1);
          if (prev >= 0) {
            for (let c = 0; c < across; c++) ridx.push(prev + c, cur + c, prev + c + 1, prev + c + 1, cur + c, cur + c + 1);
          }
          prev = cur;
        }
      }
    }
    if (ridx.length) {
      const rg = new THREE.BufferGeometry();
      rg.setAttribute('position', new THREE.Float32BufferAttribute(rpos, 3));
      rg.setIndex(ridx);
      rg.computeVertexNormals();
      // ribbons may be wound either way depending on direction → double-sided
      const rm = new THREE.Mesh(rg, this.roadMat);
      this.roadMat.side = THREE.DoubleSide;
      rm.receiveShadow = true;
      g.add(rm);
    }

    // ---- trees (never inside the track corridor) ---------------------------------------
    for (let k = 0; k < 28; k++) {
      const tx = x0 + Math.random() * CHUNK;
      const tz = z0 + Math.random() * CHUNK;
      if (this.ground.inRibbon(tx, tz)) continue;
      const ty = this.ground.surfaceHeight(tx, tz);
      const tree = new THREE.Mesh(this.treeGeo, this.treeMat);
      tree.position.set(tx, ty + 3.5, tz);
      tree.rotation.y = Math.random() * Math.PI;
      tree.scale.setScalar(0.7 + Math.random() * 0.8);
      g.add(tree);
    }

    // ---- buildings: base sunk to the lowest draped ground under the footprint -----------
    if (this.scenery) {
      for (const bld of this.scenery.buildings || []) {
        const ring: number[][] = bld.ring;
        if (!ring || ring.length < 3) continue;
        let cx = 0, cz = 0;
        for (const [x, z] of ring) { cx += x; cz += z; }
        cx /= ring.length; cz /= ring.length;
        if (Math.floor(cx / CHUNK) !== ix || Math.floor(cz / CHUNK) !== iz) continue;
        let lo = Infinity, hi = -Infinity;
        for (const [x, z] of ring) {
          const h = this.ground.surfaceHeight(x, z);
          if (h < lo) lo = h;
          if (h > hi) hi = h;
        }
        const shape = new THREE.Shape();
        ring.forEach(([x, z], i) => (i === 0 ? shape.moveTo(x, -z) : shape.lineTo(x, -z)));
        const height = (bld.h || 8) + (hi - lo) + 0.3;
        const eg = new THREE.ExtrudeGeometry(shape, { depth: height, bevelEnabled: false });
        eg.rotateX(-Math.PI / 2);
        const m = new THREE.Mesh(eg, this.buildingMat);
        m.position.y = lo - 0.3;
        m.castShadow = true;
        m.receiveShadow = true;
        g.add(m);
      }
    }
    g.visible = !this.photoreal;
    return g;
  }
}
