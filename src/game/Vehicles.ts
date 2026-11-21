import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import {
  MODULES, LRV_WIDTH_M, LRV_HEIGHT_M, LRV_FLOOR_ATR_M, OCS_WIRE_HEIGHT_STREET_M,
} from './Clearances';

/** Tribute fleet number painted on the cab sides (no ION / GRT marks). */
export const FLEXITY_FLEET_NO = '514';
/** Cab nose depth (m) from the body joint to the tip. Raked, longer than the old 1.2 m half-cylinder. */
export const FLEXITY_NOSE_LEN_M = 1.72;

/**
 * Merge same-attribute BufferGeometries into one (positions, normals, uvs, index).
 * Keeps draw calls down: one mesh per material per module.
 */
function mergeGeos(geos: THREE.BufferGeometry[]): THREE.BufferGeometry | null {
  const gs = geos.filter((g) => g && g.getAttribute('position'));
  if (!gs.length) return null;
  const pos: number[] = [];
  const nrm: number[] = [];
  const uvs: number[] = [];
  const idx: number[] = [];
  let base = 0;
  for (const g of gs) {
    if (!g.getAttribute('normal')) g.computeVertexNormals();
    if (!g.getAttribute('uv')) {
      const n = g.getAttribute('position').count;
      g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(n * 2), 2));
    }
    const p = g.getAttribute('position');
    const n = g.getAttribute('normal');
    const u = g.getAttribute('uv');
    for (let i = 0; i < p.count; i++) {
      pos.push(p.getX(i), p.getY(i), p.getZ(i));
      nrm.push(n.getX(i), n.getY(i), n.getZ(i));
      uvs.push(u.getX(i), u.getY(i));
    }
    if (g.index) {
      for (let i = 0; i < g.index.count; i++) idx.push(g.index.getX(i) + base);
    } else {
      for (let i = 0; i < p.count; i++) idx.push(base + i);
    }
    base += p.count;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  out.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  out.setIndex(idx);
  return out;
}

function addMerged(parent: THREE.Object3D, geos: THREE.BufferGeometry[], mat: THREE.Material, name?: string) {
  const g = mergeGeos(geos);
  if (!g) return;
  const m = new THREE.Mesh(g, mat);
  if (name) m.name = name;
  parent.add(m);
}

/** 2D body profile in X/Y (metres, y = height above TOR). CCW when viewed from +z. */
function bodyProfile(
  halfW: number, yBot: number, yRoof: number,
  rShoulder: number, rBottom: number, tumble: number,
): THREE.Vector2[] {
  const xBot = halfW;
  const xTop = Math.max(0.2, halfW - tumble);
  const pts: THREE.Vector2[] = [];
  const arc = (cx: number, cy: number, r: number, a0: number, a1: number, n = 5) => {
    for (let i = 1; i <= n; i++) {
      const a = a0 + (a1 - a0) * (i / n);
      pts.push(new THREE.Vector2(cx + r * Math.cos(a), cy + r * Math.sin(a)));
    }
  };
  pts.push(new THREE.Vector2(0, yBot));
  pts.push(new THREE.Vector2(xBot - rBottom, yBot));
  arc(xBot - rBottom, yBot + rBottom, rBottom, -Math.PI / 2, 0);
  const ySide0 = yBot + rBottom;
  const ySide1 = yRoof - rShoulder;
  for (let i = 1; i <= 4; i++) {
    const t = i / 4;
    const y = ySide0 + (ySide1 - ySide0) * t;
    const x = xBot + (xTop - xBot) * t;
    pts.push(new THREE.Vector2(x, y));
  }
  arc(xTop - rShoulder, yRoof - rShoulder, rShoulder, 0, Math.PI / 2);
  pts.push(new THREE.Vector2(0, yRoof));
  const right = pts.slice(1);
  for (let i = right.length - 1; i >= 0; i--) {
    const p = right[i];
    if (p.x === 0) continue;
    pts.push(new THREE.Vector2(-p.x, p.y));
  }
  return pts;
}

function scaleProfile(src: THREE.Vector2[], sx: number, yBot: number, yRoof: number): THREE.Vector2[] {
  const y0 = Math.min(...src.map((p) => p.y));
  const y1 = Math.max(...src.map((p) => p.y));
  const span = Math.max(1e-6, y1 - y0);
  return src.map((p) => {
    const t = (p.y - y0) / span;
    return new THREE.Vector2(p.x * sx, yBot + t * (yRoof - yBot));
  });
}

/**
 * Extrude a closed XY profile along Z. u goes from u0 at z0 to u1 at z1;
 * v is 0 at the lowest point and 1 at the roof (for the side-livery texture).
 */
function extrudeProfile(
  profile: THREE.Vector2[], z0: number, z1: number, u0: number, u1: number,
  caps: 'both' | 'z0' | 'z1' | 'none' = 'both',
): THREE.BufferGeometry {
  const n = profile.length;
  const y0 = Math.min(...profile.map((p) => p.y));
  const y1 = Math.max(...profile.map((p) => p.y));
  const ySpan = Math.max(1e-6, y1 - y0);
  const pos: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  // Side quads get unique verts so the +x side can flip u (lettering reads forward).
  const vOf = (p: THREE.Vector2) => (p.y - y0) / ySpan;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const p0 = profile[i], p1 = profile[j];
    const flipU = (p0.x + p1.x) / 2 > 0;
    const ua = flipU ? u1 : u0, ub = flipU ? u0 : u1;
    const base = pos.length / 3;
    pos.push(p0.x, p0.y, z0); uv.push(ua, vOf(p0));
    pos.push(p1.x, p1.y, z0); uv.push(ua, vOf(p1));
    pos.push(p0.x, p0.y, z1); uv.push(ub, vOf(p0));
    pos.push(p1.x, p1.y, z1); uv.push(ub, vOf(p1));
    idx.push(base, base + 1, base + 3, base, base + 3, base + 2);
  }
  const cap = (z: number, u: number, flip: boolean) => {
    const base = pos.length / 3;
    const cy = (y0 + y1) / 2;
    pos.push(0, cy, z);
    uv.push(u, 0.5);
    for (const p of profile) {
      pos.push(p.x, p.y, z);
      uv.push(u, (p.y - y0) / ySpan);
    }
    for (let i = 0; i < n; i++) {
      const a = base;
      const b = base + 1 + i;
      const c = base + 1 + ((i + 1) % n);
      if (flip) idx.push(a, c, b);
      else idx.push(a, b, c);
    }
  };
  if (caps === 'both' || caps === 'z0') cap(z0, u0, true);
  if (caps === 'both' || caps === 'z1') cap(z1, u1, false);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/** Loft a sequence of XY profiles sitting at given z, with u along the loft. */
function loftProfiles(
  rings: { pts: THREE.Vector2[]; z: number; u: number }[],
): THREE.BufferGeometry {
  if (rings.length < 2) return new THREE.BufferGeometry();
  const n = rings[0].pts.length;
  const y0 = Math.min(...rings[0].pts.map((p) => p.y));
  const y1 = Math.max(...rings[0].pts.map((p) => p.y));
  const ySpan = Math.max(1e-6, y1 - y0);
  const pos: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  const vOf = (p: THREE.Vector2) => (p.y - y0) / ySpan;
  for (let s = 0; s < rings.length - 1; s++) {
    const r0 = rings[s], r1 = rings[s + 1];
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const p0 = r0.pts[i], p1 = r0.pts[j], q0 = r1.pts[i], q1 = r1.pts[j];
      const flipU = (p0.x + p1.x) / 2 > 0;
      const u0 = flipU ? r1.u : r0.u, u1 = flipU ? r0.u : r1.u;
      const base = pos.length / 3;
      pos.push(p0.x, p0.y, r0.z); uv.push(u0, vOf(p0));
      pos.push(p1.x, p1.y, r0.z); uv.push(u0, vOf(p1));
      pos.push(q0.x, q0.y, r1.z); uv.push(u1, vOf(q0));
      pos.push(q1.x, q1.y, r1.z); uv.push(u1, vOf(q1));
      idx.push(base, base + 1, base + 3, base, base + 3, base + 2);
    }
  }
  const cap = (ringIdx: number, flip: boolean) => {
    const r = rings[ringIdx];
    const base = pos.length / 3;
    const cy = (Math.min(...r.pts.map((p) => p.y)) + Math.max(...r.pts.map((p) => p.y))) / 2;
    pos.push(0, cy, r.z);
    uv.push(r.u, 0.5);
    for (const p of r.pts) {
      pos.push(p.x, p.y, r.z);
      uv.push(r.u, (p.y - y0) / ySpan);
    }
    for (let i = 0; i < n; i++) {
      const a = base, b = base + 1 + i, c = base + 1 + ((i + 1) % n);
      if (flip) idx.push(a, c, b);
      else idx.push(a, b, c);
    }
  };
  cap(0, true);
  cap(rings.length - 1, false);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

function boxAt(w: number, h: number, d: number, x: number, y: number, z: number): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(w, h, d);
  g.translate(x, y, z);
  return g;
}

/** Canvas factory that is a no-op in node (stress tests bundle this file without a DOM). */
function drawCanvas(w: number, h: number, paint: (g: CanvasRenderingContext2D, W: number, H: number) => void): THREE.CanvasTexture | null {
  if (typeof document === 'undefined' || !document.createElement) return null;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d');
  if (!ctx) return null;
  paint(ctx, w, h);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  return tex;
}

/**
 * Tribute side livery, following the CC0 service-livery photos (514 / 507):
 * off-white body, charcoal skirt, blue roof band, blue A-pillar swoosh to the nose.
 * No ION / GRT / Region wordmarks. The photos have no red/magenta swoosh, so none is painted.
 *
 * UV: u = 0 at the rear of the module, 1 at the front (cab tip); v = 0 at the skirt, 1 at the roof.
 */
function makeLiveryTex(kind: 'cabA' | 'cabE' | 'mid'): THREE.CanvasTexture | null {
  return drawCanvas(2048, 512, (g, W, H) => {
    const vToY = (v: number) => (1 - v) * H;
    const uToX = (u: number) => u * W;
    g.fillStyle = '#e6eaef';
    g.fillRect(0, 0, W, H);
    for (let i = 0; i < 2200; i++) {
      const y = Math.random() * H;
      g.strokeStyle = `rgba(255,255,255,${0.04 + Math.random() * 0.08})`;
      g.beginPath();
      g.moveTo(0, y);
      g.lineTo(W, y + (Math.random() - 0.5) * 2);
      g.stroke();
    }
    g.fillStyle = '#1c1d20';
    g.fillRect(0, vToY(0.13), W, H - vToY(0.13));
    g.fillStyle = '#2a2c31';
    g.fillRect(0, vToY(0.135), W, 3);
    const BLUE = '#1a74c8';
    g.fillStyle = BLUE;
    g.fillRect(0, 0, W, vToY(0.88));
    g.fillStyle = '#155fa6';
    g.fillRect(0, vToY(0.88), W, 3);

    if (kind === 'cabA' || kind === 'cabE') {
      // Only as far as the body/nose joint (~u 0.73). The A-pillar itself is a 3D ribbon
      // on the lofted nose — painting the swoosh into the nose UVs zebra-striped the front.
      const spine: [number, number, number][] = [
        [0.50, 0.94, 0.06],
        [0.60, 0.94, 0.06],
        [0.68, 0.93, 0.055],
        [0.73, 0.90, 0.04],
        [0.74, 0.88, 0.01],
      ];
      const left: [number, number][] = [];
      const right: [number, number][] = [];
      for (const [u, v, hw] of spine) {
        left.push([u, v + hw]);
        right.push([u, v - hw]);
      }
      g.fillStyle = BLUE;
      g.beginPath();
      g.moveTo(uToX(left[0][0]), vToY(left[0][1]));
      for (const pt of left) g.lineTo(uToX(pt[0]), vToY(pt[1]));
      for (let i = right.length - 1; i >= 0; i--) g.lineTo(uToX(right[i][0]), vToY(right[i][1]));
      g.closePath();
      g.fill();

      const suffix = kind === 'cabA' ? 'A' : 'B';
      g.fillStyle = '#2c333c';
      g.font = 'bold 54px Helvetica, Arial, sans-serif';
      g.textAlign = 'left';
      g.textBaseline = 'middle';
      g.fillText(`${FLEXITY_FLEET_NO}${suffix}`, uToX(0.58), vToY(0.82));
    }
  });
}

function makeDoorTex(): THREE.CanvasTexture | null {
  return drawCanvas(256, 512, (g, W, H) => {
    g.fillStyle = '#1a1b1e';
    g.fillRect(0, 0, W, H);
    g.fillStyle = '#1c2a36';
    g.fillRect(18, 36, W - 36, H * 0.55);
    g.fillStyle = 'rgba(180,210,230,0.18)';
    g.fillRect(28, 48, (W - 36) * 0.45, 70);
    g.fillStyle = '#e6eaef';
    g.fillRect(18, H * 0.68, W - 36, H * 0.26);
  });
}

export type ArticulatedLRV = {
  group: THREE.Group;
  /** One group per module (A..E), origin = module centre at top of rail, forward = local +z. */
  modules: THREE.Group[];
  /** Truck meshes (power A, trailer C, power E), origin at TOR. */
  trucks: THREE.Group[];
};

/** Vite serves files in public/ at the app base. */
export const FLEXITY_GLB_URL = './models/flexity.glb';

const FLEXITY_MODULE_NAMES = [
  'module-A-cab', 'module-B', 'module-C-centre', 'module-D', 'module-E-cab',
] as const;
const FLEXITY_TRUCK_NAMES = ['truck-power-A', 'truck-trailer', 'truck-power-E'] as const;

/**
 * Blender's glTF exporter writes Y-up, -Z-forward. The sim is Y-up, +Z-forward
 * (cab A nose at local +z). Reflect through the XY plane (not a 180° Y rotation)
 * so left/right and lettering UVs stay put. Game.placeConsist can then pose
 * each module with only a track yaw.
 */
function bakeGltfForward(root: THREE.Object3D) {
  const marker = root.getObjectByName('axis-fwd') ?? root.getObjectByName('nose-A');
  if (marker) {
    root.updateMatrixWorld(true);
    const p = new THREE.Vector3();
    marker.getWorldPosition(p);
    if (marker.name === 'axis-fwd' && p.z > 0.3) return;
    if (marker.name === 'nose-A' && p.z > 1) return;
  }
  const flipZ = new THREE.Matrix4().makeScale(1, 1, -1);
  root.traverse((obj) => {
    obj.position.z *= -1;
    obj.rotation.x *= -1;
    obj.rotation.y *= -1;
    const mesh = obj as THREE.Mesh;
    if (!mesh.isMesh || !mesh.geometry) return;
    mesh.geometry = mesh.geometry.clone();
    mesh.geometry.applyMatrix4(flipZ);
    const idx = mesh.geometry.index;
    if (idx) {
      const arr = idx.array;
      for (let i = 0; i + 2 < arr.length; i += 3) {
        const t = arr[i];
        arr[i] = arr[i + 2];
        arr[i + 2] = t;
      }
      idx.needsUpdate = true;
    }
    mesh.geometry.computeVertexNormals();
  });
  root.updateMatrixWorld(true);
}

function wireFlexityHooks(root: THREE.Object3D) {
  root.traverse((o) => {
    // Only the plug-door empties (door-A-L, door-M-R.001, …), not merged
    // child meshes named door-A-L-lrvGlass / door-A-L-trim.
    if (o.name === 'door' || /^door-[ABDEM]-[LR](?:\.?\d+)?$/.test(o.name)) {
      o.name = 'door';
      o.userData.side = o.position.x >= 0 ? 1 : -1;
      o.userData.baseX = o.position.x;
      o.userData.baseZ = o.position.z;
    }
    if (o.name.startsWith('destSign')) o.name = 'destSign';
    if (o.name.startsWith('lampAnchor-')) {
      const kind = o.name.includes('tail') ? 'tail' : 'head';
      const tag = o.position.x < 0 ? 'L' : 'R';
      o.name = `lampAnchor-${kind}-${tag}`;
    }
    const mesh = o as THREE.Mesh;
    if (mesh.isMesh) {
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const mat of mats) {
        if (mat && /lrvGlass|glass/i.test(mat.name)) mat.name = 'lrvGlass';
      }
      mesh.castShadow = true;
    }
  });
  for (const n of ['axis-fwd', 'nose-A']) {
    const o = root.getObjectByName(n);
    if (o?.parent) o.parent.remove(o);
  }
}

/** Assemble a loaded Flexity GLB into the same ArticulatedLRV shape the procedural mesh uses. */
export function assembleFlexityFromGltf(scene: THREE.Object3D): ArticulatedLRV {
  const group = new THREE.Group();
  group.name = 'flexity';
  const modules: THREE.Group[] = [];
  for (const name of FLEXITY_MODULE_NAMES) {
    const o = scene.getObjectByName(name);
    if (!o) throw new Error(`Flexity GLB missing ${name}`);
    o.position.set(0, 0, 0);
    o.rotation.set(0, 0, 0);
    o.scale.set(1, 1, 1);
    bakeGltfForward(o);
    wireFlexityHooks(o);
    group.add(o);
    modules.push(o as THREE.Group);
  }
  const trucks: THREE.Group[] = [];
  for (const name of FLEXITY_TRUCK_NAMES) {
    const o = scene.getObjectByName(name);
    if (!o) throw new Error(`Flexity GLB missing ${name}`);
    o.position.set(0, 0, 0);
    o.rotation.set(0, 0, 0);
    o.scale.set(1, 1, 1);
    bakeGltfForward(o);
    group.add(o);
    trucks.push(o as THREE.Group);
  }
  if (!modules[0].getObjectByName('destSign') || !modules[0].getObjectByName('lampAnchor-head-L')) {
    throw new Error('Flexity GLB missing cab-A hooks after bake');
  }
  if (!modules[2].getObjectByName('pantoShoe') || !modules[2].getObjectByName('pantograph')) {
    throw new Error('Flexity GLB missing pantograph hooks');
  }
  let doors = 0;
  for (const m of modules) m.traverse((o) => { if (o.name === 'door') doors++; });
  if (doors !== 8) throw new Error(`Flexity GLB expected 8 doors, got ${doors}`);
  return { group, modules, trucks };
}

/**
 * Load the Blender-built GLB (public/models/flexity.glb). Falls back to the
 * procedural v1.4.8 mesh if the load fails, and always uses the procedural
 * mesh in Node (tests, drive-sim) where there is no fetch / GPU decoder.
 */
export async function createFlexityArticulatedAsync(
  url = FLEXITY_GLB_URL,
): Promise<ArticulatedLRV> {
  if (typeof window === 'undefined' || typeof fetch === 'undefined') {
    return createFlexityArticulated();
  }
  try {
    const loader = new GLTFLoader();
    const gltf = await loader.loadAsync(url);
    return assembleFlexityFromGltf(gltf.scene);
  } catch (err) {
    console.warn('[flexity] GLB load failed, using procedural mesh:', err);
    return createFlexityArticulated();
  }
}


/**
 * Articulated 5-module Flexity Freedom (30.8 m × 2.65 m × 3.6 m, Bo'2Bo').
 * Module lengths/truck positions from Clearances.ts (see docs/CLEARANCES.md).
 *
 * v1.4.8 procedural fallback (used in Node tests and if the GLB fails to load).
 * The in-game model is the Blender-built GLB from tools/blender/build_flexity.py,
 * assembled by createFlexityArticulatedAsync(). Shape language is inspired by
 * the Gold Coast Flexity 2 (curved raked nose, rounded shoulders) but the mesh
 * is original — not a copy. No official ION / GRT logos or wordmarks.
 */
export function createFlexityArticulated(): ArticulatedLRV {
  const g = new THREE.Group();
  g.name = 'flexity';

  const cabAMap = makeLiveryTex('cabA');
  const cabEMap = makeLiveryTex('cabE');
  const midMap = makeLiveryTex('mid');
  const doorMap = makeDoorTex();

  const bodyMat = (map: THREE.CanvasTexture | null) => new THREE.MeshStandardMaterial({
    color: 0xe8ecf1, map: map ?? undefined, metalness: 0.42, roughness: 0.32, side: THREE.FrontSide,
  });
  const matA = bodyMat(cabAMap);
  const matE = bodyMat(cabEMap);
  const matMid = bodyMat(midMap);
  const black = new THREE.MeshStandardMaterial({ color: 0x1a1b1e, metalness: 0.45, roughness: 0.55 });
  const glass = new THREE.MeshStandardMaterial({
    color: 0x1a2833, metalness: 0.15, roughness: 0.08, transparent: true, opacity: 0.58,
    side: THREE.DoubleSide,
  });
  glass.name = 'lrvGlass'; // interior lighting glows through it at night (TrainLights)
  const bogieMat = new THREE.MeshStandardMaterial({ color: 0x1e1f22, metalness: 0.5, roughness: 0.6 });
  const doorMat = new THREE.MeshStandardMaterial({
    color: 0x2a2c30, map: doorMap ?? undefined, metalness: 0.35, roughness: 0.45,
  });
  const doorway = new THREE.MeshStandardMaterial({ color: 0x0c0d10, roughness: 1 });
  const fairingMat = new THREE.MeshStandardMaterial({ color: 0xdde2e8, metalness: 0.4, roughness: 0.38 });
  const swooshMat = new THREE.MeshStandardMaterial({ color: 0x1a74c8, metalness: 0.25, roughness: 0.4 });

  const w = LRV_WIDTH_M;
  const halfW = w * 0.495;
  const yBot = 0.16;
  const yRoof = LRV_HEIGHT_M - 0.22;
  const rShoulder = 0.28;
  const rBottom = 0.10;
  const tumble = 0.08;
  const baseProf = bodyProfile(halfW, yBot, yRoof, rShoulder, rBottom, tumble);
  const noseLen = FLEXITY_NOSE_LEN_M;

  const modules: THREE.Group[] = [];

  MODULES.forEach((m, i) => {
    const mg = new THREE.Group();
    mg.name = `module-${m.name}`;
    const isCab = i === 0 || i === MODULES.length - 1;
    const front = i === 0 ? 1 : i === MODULES.length - 1 ? -1 : 0;
    const bodyMatI = i === 0 ? matA : i === MODULES.length - 1 ? matE : matMid;
    const bodyGeos: THREE.BufferGeometry[] = [];
    const blackGeos: THREE.BufferGeometry[] = [];
    const glassGeos: THREE.BufferGeometry[] = [];
    const fairGeos: THREE.BufferGeometry[] = [];
    const swooshGeos: THREE.BufferGeometry[] = [];

    const halfLen = m.len / 2;
    const zRear = -halfLen;
    const zFront = halfLen;
    const bodyZ0 = front === -1 ? -halfLen + noseLen : zRear;
    const bodyZ1 = front === 1 ? halfLen - noseLen : zFront;
    const uAt = (z: number) => {
      if (front === -1) return (halfLen - z) / m.len;
      return (z - zRear) / m.len;
    };

    const bodyCaps = front === 1 ? 'z0' : front === -1 ? 'z1' : 'both';
    bodyGeos.push(extrudeProfile(baseProf, bodyZ0, bodyZ1, uAt(bodyZ0), uAt(bodyZ1), bodyCaps));

    if (isCab) {
      const zJoint = front * (halfLen - noseLen);
      const stations = [
        { s: 0.00, sx: 1.00, yb: yBot, yr: yRoof },
        { s: 0.12, sx: 0.98, yb: yBot, yr: yRoof - 0.04 },
        { s: 0.30, sx: 0.92, yb: yBot + 0.01, yr: yRoof - 0.28 },
        { s: 0.48, sx: 0.80, yb: yBot + 0.04, yr: yRoof - 0.70 },
        { s: 0.66, sx: 0.60, yb: yBot + 0.10, yr: yRoof - 1.20 },
        { s: 0.82, sx: 0.38, yb: yBot + 0.20, yr: yRoof - 1.70 },
        { s: 0.93, sx: 0.20, yb: yBot + 0.32, yr: yBot + 1.05 },
        { s: 1.00, sx: 0.08, yb: yBot + 0.42, yr: yBot + 0.72 },
      ];
      const rings = stations.map((st) => {
        const z = zJoint + front * st.s * noseLen;
        return { pts: scaleProfile(baseProf, st.sx, st.yb, st.yr), z, u: uAt(z) };
      });
      bodyGeos.push(loftProfiles(rings));

      const screen = new THREE.PlaneGeometry(w * 0.78, 1.25, 16, 8);
      const pa = screen.attributes.position;
      const wrapR = 2.2;
      for (let k = 0; k < pa.count; k++) {
        const x = pa.getX(k);
        pa.setZ(k, -(x * x) / (2 * wrapR));
      }
      screen.computeVertexNormals();
      const rake = 0.50;
      screen.rotateX(front > 0 ? -rake : rake);
      if (front < 0) screen.rotateY(Math.PI);
      const sMid = 0.36;
      const zScreen = zJoint + front * sMid * noseLen;
      const yScreen = LRV_FLOOR_ATR_M + 1.62;
      screen.translate(0, yScreen, zScreen + front * 0.05);
      glassGeos.push(screen);

      const dest = new THREE.Mesh(new THREE.BoxGeometry(1.62, 0.20, 0.07), black);
      dest.name = 'destSign';
      dest.position.set(0, yRoof - 0.12, zJoint + front * 0.22);
      mg.add(dest);

      const yLamp = 0.70;
      const zLamp = front * (halfLen - 0.16);
      for (const [sx, tag] of [[-1, 'L'], [1, 'R']] as const) {
        const a = new THREE.Object3D();
        a.name = front > 0 ? `lampAnchor-head-${tag}` : `lampAnchor-tail-${tag}`;
        a.position.set(sx * 0.84, yLamp, zLamp);
        if (front < 0) a.rotation.y = Math.PI;
        mg.add(a);
      }

      blackGeos.push(boxAt(0.55, 0.22, 0.28, 0, yBot + 0.28, front * (halfLen - 0.08)));

      // Blue A-pillar swoosh (both sides), slightly proud of the lofted nose.
      for (const sx of [-1, 1]) {
        const curve = new THREE.CatmullRomCurve3([
          new THREE.Vector3(sx * (halfW - 0.06), yRoof - 0.14, zJoint + front * 0.05),
          new THREE.Vector3(sx * (halfW - 0.10), yRoof - 0.22, zJoint + front * 0.28),
          new THREE.Vector3(sx * halfW * 0.70, yRoof - 0.70, zJoint + front * 0.62),
          new THREE.Vector3(sx * halfW * 0.38, 1.05, zJoint + front * 1.05),
          new THREE.Vector3(sx * 0.20, 0.68, front * (halfLen - 0.30)),
          new THREE.Vector3(sx * 0.06, 0.52, front * (halfLen - 0.10)),
        ]);
        swooshGeos.push(new THREE.TubeGeometry(curve, 28, 0.032, 6, false));
      }
    }

    if (i !== 2) {
      const podLen = Math.min(2.6, Math.max(0.8, (bodyZ1 - bodyZ0) * 0.55));
      const zMid = (bodyZ0 + bodyZ1) / 2;
      fairGeos.push(boxAt(w * 0.52, 0.20, podLen, 0, yRoof + 0.10, zMid));
      // shallow rounded cap (ellipsoid) so the pod isn't a sharp box
      const cap = new THREE.SphereGeometry(0.5, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2);
      cap.scale(w * 0.26, 0.14, podLen * 0.48);
      cap.translate(0, yRoof + 0.20, zMid);
      fairGeos.push(cap);
    } else {
      fairGeos.push(boxAt(w * 0.42, 0.14, 1.6, 0, yRoof + 0.07, 0));
    }

    const winH = 0.95;
    const winY = LRV_FLOOR_ATR_M + 1.55;
    const doorZ = isCab ? (i === 0 ? -1.4 : 1.4) : 0;
    const doorHalf = 0.68;
    const panes: { z: number; len: number }[] = [];
    if (isCab) {
      const zA = i === 0 ? (halfLen - noseLen - 0.15) : -(halfLen - noseLen - 0.15);
      const zDoorFront = doorZ + (i === 0 ? doorHalf : -doorHalf);
      const mid = (zA + zDoorFront) / 2;
      const len = Math.abs(zA - zDoorFront) - 0.1;
      if (len > 0.4) panes.push({ z: mid, len });
    } else if (i !== 2) {
      const span = (bodyZ1 - bodyZ0) / 2 - doorHalf - 0.15;
      if (span > 0.4) {
        panes.push({ z: -doorHalf - 0.12 - span / 2, len: span });
        panes.push({ z: doorHalf + 0.12 + span / 2, len: span });
      }
    } else {
      panes.push({ z: 0, len: Math.max(0.5, m.len - 1.0) });
    }
    for (const pane of panes) {
      for (const side of [-1, 1]) {
        const pg = new THREE.PlaneGeometry(pane.len, winH);
        pg.rotateY(side > 0 ? Math.PI / 2 : -Math.PI / 2);
        pg.translate(side * (halfW + 0.012), winY, pane.z);
        glassGeos.push(pg);
        blackGeos.push(boxAt(0.02, winH + 0.04, pane.len + 0.04, side * (halfW + 0.008), winY, pane.z));
      }
    }

    if (i !== 2) {
      for (const side of [-1, 1]) {
        const dz = doorZ;
        const opening = new THREE.Mesh(new THREE.BoxGeometry(0.04, 2.0, 1.3), doorway);
        opening.position.set(side * (w / 2 - 0.005), LRV_FLOOR_ATR_M + 1.0, dz);
        mg.add(opening);
        const door = new THREE.Mesh(new THREE.BoxGeometry(0.05, 2.0, 1.3), doorMat);
        door.name = 'door';
        door.position.set(side * (w / 2 + 0.02), LRV_FLOOR_ATR_M + 1.0, dz);
        door.userData = { side, baseX: door.position.x, baseZ: dz };
        const dg = new THREE.Mesh(new THREE.PlaneGeometry(1.12, 1.1), glass);
        dg.rotation.y = side > 0 ? Math.PI / 2 : -Math.PI / 2;
        dg.position.set(side * 0.03, 0.25, 0);
        door.add(dg);
        mg.add(door);
      }
    }

    if (i < MODULES.length - 1) {
      const belZ = -m.len / 2;
      const belH = (yRoof - yBot) * 0.92;
      const belY = yBot + 0.04 + belH / 2;
      for (let r = 0; r < 5; r++) {
        const z = belZ + (r - 2) * 0.09;
        blackGeos.push(boxAt(w * 0.90, belH, 0.07, 0, belY, z));
      }
    }

    if (i === 2) {
      const pan = new THREE.Group();
      pan.name = 'pantograph';
      const base = new THREE.Mesh(new THREE.BoxGeometry(0.38, 0.10, 0.8), black);
      base.position.y = LRV_HEIGHT_M + 0.05;
      pan.add(base);
      const low = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.06, 1.15), black);
      low.position.set(0, LRV_HEIGHT_M + 0.45, 0.15);
      low.rotation.x = 0.55;
      pan.add(low);
      const up = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.05, 1.05), black);
      up.position.set(0, LRV_HEIGHT_M + 0.95, -0.05);
      up.rotation.x = -0.65;
      pan.add(up);
      const shoe = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.05, 0.16), black);
      shoe.name = 'pantoShoe';
      shoe.position.set(0, OCS_WIRE_HEIGHT_STREET_M, 0);
      pan.add(shoe);
      mg.add(pan);
    }

    addMerged(mg, bodyGeos, bodyMatI, 'body');
    addMerged(mg, blackGeos, black, 'trim');
    addMerged(mg, glassGeos, glass, 'windows');
    addMerged(mg, fairGeos, fairingMat, 'fairing');
    addMerged(mg, swooshGeos, swooshMat, 'swoosh');

    g.add(mg);
    modules.push(mg);
  });

  const trucks: THREE.Group[] = [];
  for (let t = 0; t < 3; t++) {
    const tg = new THREE.Group();
    tg.name = t === 1 ? 'truck-trailer' : 'truck-power';
    const tBlack: THREE.BufferGeometry[] = [];
    tBlack.push(boxAt(1.7, 0.28, 2.35, 0, 0.38, 0));
    for (const sx of [-1, 1]) {
      tBlack.push(boxAt(0.08, 0.38, 2.55, sx * 1.02, 0.36, 0));
    }
    addMerged(tg, tBlack, bogieMat, 'truck-frame');
    for (const zz of [-0.925, 0.925]) {
      for (const xx of [-0.72, 0.72]) {
        const wh = new THREE.Mesh(new THREE.CylinderGeometry(0.33, 0.33, 0.14, 16), bogieMat);
        wh.rotation.z = Math.PI / 2;
        wh.position.set(xx, 0.33, zz);
        tg.add(wh);
      }
    }
    g.add(tg);
    trucks.push(tg);
  }

  g.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) (o as THREE.Mesh).castShadow = true;
  });
  return { group: g, modules, trucks };
}

/**
 * Diesel loco dimensions (model-local, forward = +z, origin = reference point on the
 * track at top of tie). RS-18-like hood unit with the cab near the front.
 */
export const DIESEL_DIMS = {
  hoodW: 2.6, hoodTop: 3.75, hoodZ0: -9.0, hoodZ1: 3.0, // long hood (behind the cab)
  cabW: 3.0, cabTop: 4.35, cabZ0: 3.0, cabZ1: 6.0,     // cab (eye is inside)
  noseTop: 2.9, noseZ1: 7.6,                            // short hood (below the eye line)
  frameTop: 1.45,
};
/** Coach behind the loco: gap after the long hood and body length (m). */
export const DIESEL_COACH = { gap: 1.2, len: 16 };
/** Consist extent around the chainage reference point: nose ahead, coach end behind (m). */
export const DIESEL_CONSIST_FRONT_M = DIESEL_DIMS.noseZ1;
export const DIESEL_CONSIST_REAR_M = -(DIESEL_DIMS.hoodZ0 - DIESEL_COACH.gap - DIESEL_COACH.len);
/** Driver eye in the loco cab window: right-hand seat, above the short hood, behind the windscreen. */
export const DIESEL_CAB_EYE = { x: -0.6, y: 3.55, z: 5.5 };

/** Simple WCR / CN diesel consist: hood unit + one coach behind it (forward = +z). */
export function createDieselConsist(kind: 'wcr' | 'cn'): THREE.Group {
  const g = new THREE.Group();
  const D = DIESEL_DIMS;
  const bodyCol = kind === 'wcr' ? 0x2e5a3c : 0xb84a2a;
  const bodyMat = new THREE.MeshStandardMaterial({ color: bodyCol, metalness: 0.35, roughness: 0.5 });
  const black = new THREE.MeshStandardMaterial({ color: 0x222226, metalness: 0.4, roughness: 0.6 });
  const glassMat = new THREE.MeshStandardMaterial({ color: 0x88aacc, transparent: true, opacity: 0.35, side: THREE.DoubleSide });
  const box = (w: number, y0: number, y1: number, z0: number, z1: number, mat: THREE.Material, name = '') => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, y1 - y0, z1 - z0), mat);
    m.position.set(0, (y0 + y1) / 2, (z0 + z1) / 2);
    if (name) m.name = name;
    g.add(m);
    return m;
  };
  box(3.0, 0.9, D.frameTop, D.hoodZ0 - 0.6, D.noseZ1 + 0.3, black, 'frame');
  box(D.hoodW, D.frameTop, D.hoodTop, D.hoodZ0, D.hoodZ1, bodyMat, 'longHood');
  box(D.hoodW * 0.85, D.frameTop, D.noseTop, D.cabZ1, D.noseZ1, bodyMat, 'shortHood');
  // Cab as separate walls/roof (hollow), so the eye inside sees out through the windows
  const cabH = D.cabTop - D.frameTop;
  const wallT = 0.06;
  const cab = new THREE.Group();
  cab.name = 'cab';
  const panel = (w: number, h: number, d: number, x: number, y: number, z: number, mat: THREE.Material) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    m.position.set(x, y, z);
    cab.add(m);
  };
  const midZ = (D.cabZ0 + D.cabZ1) / 2, len = D.cabZ1 - D.cabZ0;
  panel(D.cabW, wallT, len, 0, D.cabTop, midZ, bodyMat); // roof
  for (const sx of [-1, 1]) {
    panel(wallT, 1.6, len, sx * D.cabW / 2, D.frameTop + 0.8, midZ, bodyMat); // lower side
    panel(wallT, cabH - 2.6, len, sx * D.cabW / 2, D.cabTop - (cabH - 2.6) / 2, midZ, bodyMat); // above side window
    panel(wallT, 1.0, len * 0.9, sx * D.cabW / 2, D.frameTop + 2.1, midZ, glassMat); // side window
  }
  panel(D.cabW, 1.85, wallT, 0, D.frameTop + 0.925, D.cabZ1, bodyMat); // front below windscreen
  panel(D.cabW, 1.0, wallT, 0, D.frameTop + 2.35, D.cabZ1, glassMat); // windscreen
  panel(D.cabW, D.cabTop - (D.frameTop + 2.85), wallT, 0, (D.cabTop + D.frameTop + 2.85) / 2, D.cabZ1, bodyMat);
  panel(D.cabW, cabH, wallT, 0, D.frameTop + cabH / 2, D.cabZ0, bodyMat); // rear wall
  g.add(cab);
  const coach = new THREE.Mesh(
    new THREE.BoxGeometry(2.9, 3.6, DIESEL_COACH.len),
    new THREE.MeshStandardMaterial({ color: 0xd8d0c4, metalness: 0.2, roughness: 0.7 }),
  );
  coach.name = 'coach';
  coach.position.set(0, 2.0, D.hoodZ0 - DIESEL_COACH.gap - DIESEL_COACH.len / 2);
  g.add(coach);
  // coach window band (glows with the interior lights at night — TrainLights)
  const coachGlass = new THREE.MeshStandardMaterial({ color: 0x2a3440, metalness: 0.2, roughness: 0.2 });
  coachGlass.name = 'coachGlass';
  const win = new THREE.Mesh(new THREE.BoxGeometry(2.94, 0.8, DIESEL_COACH.len - 2), coachGlass);
  win.name = 'coachWindows';
  win.position.set(0, 2.55, coach.position.z);
  g.add(win);
  g.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) (o as THREE.Mesh).castShadow = true;
  });
  return g;
}
