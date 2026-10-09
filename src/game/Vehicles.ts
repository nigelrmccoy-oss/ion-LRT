import * as THREE from 'three';
import {
  MODULES, LRV_WIDTH_M, LRV_HEIGHT_M, LRV_FLOOR_ATR_M, OCS_WIRE_HEIGHT_STREET_M,
} from './Clearances';

/** Procedural brushed-metal / ION tribute textures — no Street View / Apple Maps. */
function makeBrushedTex(base: string, speck = 0.08): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 256;
  const g = c.getContext('2d')!;
  g.fillStyle = base;
  g.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 4000; i++) {
    const y = Math.random() * 256;
    g.strokeStyle = `rgba(255,255,255,${Math.random() * speck})`;
    g.beginPath();
    g.moveTo(0, y);
    g.lineTo(256, y + (Math.random() - 0.5) * 2);
    g.stroke();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function makeWindowTex(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 128;
  c.height = 64;
  const g = c.getContext('2d')!;
  g.fillStyle = '#1a3040';
  g.fillRect(0, 0, 128, 64);
  g.fillStyle = 'rgba(140,190,220,0.55)';
  g.fillRect(4, 4, 120, 56);
  g.fillStyle = 'rgba(255,255,255,0.12)';
  g.fillRect(8, 8, 40, 20);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export type ArticulatedLRV = {
  group: THREE.Group;
  /** One group per module (A..E), origin = module centre at top of rail, forward = local +z. */
  modules: THREE.Group[];
  /** Truck meshes (power A, trailer C, power E), origin at TOR. */
  trucks: THREE.Group[];
};

/**
 * Articulated 5-module Flexity Freedom (30.8 m × 2.65 m × 3.6 m, Bo'2Bo').
 * Module lengths/truck positions from Clearances.ts (see docs/CLEARANCES.md).
 * Tribute silver/black/blue livery (procedural PBR; no official logos / Street View).
 */
export function createFlexityArticulated(): ArticulatedLRV {
  const g = new THREE.Group();
  g.name = 'flexity';
  const silverMap = makeBrushedTex('#a8b0bc', 0.1);
  const silver = new THREE.MeshStandardMaterial({ color: 0xb0b8c4, map: silverMap, metalness: 0.62, roughness: 0.32 });
  const black = new THREE.MeshStandardMaterial({ color: 0x1a1a1e, metalness: 0.45, roughness: 0.55 });
  const blue = new THREE.MeshStandardMaterial({ color: 0x1e5aa8, metalness: 0.35, roughness: 0.42 });
  const glass = new THREE.MeshStandardMaterial({
    color: 0x87b8d8, map: makeWindowTex(), metalness: 0.15, roughness: 0.08, transparent: true, opacity: 0.55,
  });
  const bogieMat = new THREE.MeshStandardMaterial({ color: 0x222224, metalness: 0.5, roughness: 0.6 });
  const doorMat = new THREE.MeshStandardMaterial({ color: 0x3c4450, metalness: 0.5, roughness: 0.4 });
  const doorway = new THREE.MeshStandardMaterial({ color: 0x0c0d10, roughness: 1 });

  const w = LRV_WIDTH_M;
  const floor = LRV_FLOOR_ATR_M;
  const roofTop = LRV_HEIGHT_M - 0.25; // body shell; roof pods reach LRV_HEIGHT_M
  const bodyH = roofTop - 0.18;
  const modules: THREE.Group[] = [];

  MODULES.forEach((m, i) => {
    const mg = new THREE.Group();
    mg.name = `module-${m.name}`;
    const isCab = i === 0 || i === MODULES.length - 1;
    const noseLen = isCab ? 1.2 : 0;
    const shellLen = m.len - noseLen - 0.05;
    const shellZ = isCab ? (i === 0 ? -noseLen / 2 : noseLen / 2) : 0;
    const body = new THREE.Mesh(new THREE.BoxGeometry(w * 0.985, bodyH, shellLen), silver);
    body.position.set(0, 0.18 + bodyH / 2, shellZ);
    mg.add(body);
    const skirt = new THREE.Mesh(new THREE.BoxGeometry(w * 0.99, 0.3, shellLen), black);
    skirt.position.set(0, 0.18 + 0.15, shellZ);
    mg.add(skirt);
    const stripe = new THREE.Mesh(new THREE.BoxGeometry(w + 0.02, 0.2, shellLen), blue);
    stripe.position.set(0, floor + 0.75, shellZ);
    mg.add(stripe);
    const winBand = new THREE.Mesh(new THREE.BoxGeometry(w + 0.025, 1.0, Math.max(0.5, shellLen - 1.0)), glass);
    winBand.position.set(0, floor + 1.55, shellZ);
    mg.add(winBand);
    // roof equipment pods (HVAC / traction) → overall height LRV_HEIGHT_M
    if (m.kind === 'truck' || i === 1 || i === 3) {
      const pod = new THREE.Mesh(new THREE.BoxGeometry(w * 0.6, LRV_HEIGHT_M - roofTop, Math.min(3, shellLen * 0.6)), silver);
      pod.position.set(0, roofTop + (LRV_HEIGHT_M - roofTop) / 2, shellZ);
      mg.add(pod);
    }
    // doors: 4 per side over the vehicle → one door per side on B, D and on cab modules
    if (i !== 2) {
      for (const side of [-1, 1]) {
        const dz = isCab ? (i === 0 ? -1.4 : 1.4) : 0;
        // dark doorway behind the leaf — visible once the plug door slides open
        const opening = new THREE.Mesh(new THREE.BoxGeometry(0.04, 2.0, 1.3), doorway);
        opening.position.set(side * (w / 2 - 0.005), floor + 1.0, dz);
        mg.add(opening);
        const door = new THREE.Mesh(new THREE.BoxGeometry(0.05, 2.0, 1.3), doorMat);
        door.name = 'door';
        door.position.set(side * (w / 2 + 0.02), floor + 1.0, dz);
        door.userData = { side, baseX: door.position.x, baseZ: dz };
        mg.add(door);
      }
    }
    if (isCab) {
      const front = i === 0 ? 1 : -1;
      // Rounded cab nose: half-cylinder (vertical axis) flattened in depth
      const nose = new THREE.Mesh(
        new THREE.CylinderGeometry(w * 0.49, w * 0.49, bodyH, 20, 1, false, 0, Math.PI),
        silver,
      );
      nose.scale.set(noseLen / (w * 0.49), 1, 1); // depth axis is local x before the yaw
      nose.rotation.y = front > 0 ? -Math.PI / 2 : Math.PI / 2;
      nose.position.set(0, 0.18 + bodyH / 2, front * (m.len / 2 - noseLen));
      mg.add(nose);
      const wind = new THREE.Mesh(new THREE.PlaneGeometry(w * 0.82, 1.15), glass);
      wind.position.set(0, floor + 1.75, front * (m.len / 2 - 0.12));
      wind.rotation.y = front > 0 ? 0 : Math.PI;
      wind.rotation.x = -0.12;
      mg.add(wind);
      const dest = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.34, 0.06), black);
      dest.name = 'destSign'; // hidden in the cab view (Game.updateCamera)
      dest.position.set(0, roofTop - 0.25, front * (m.len / 2 - 0.3));
      mg.add(dest);
    }
    if (i === 2) {
      const pan = new THREE.Group();
      const base = new THREE.Mesh(new THREE.BoxGeometry(0.35, 0.12, 0.9), black);
      base.position.y = LRV_HEIGHT_M + 0.06;
      pan.add(base);
      const arm = new THREE.Mesh(new THREE.BoxGeometry(0.07, 1.0, 0.07), black);
      arm.position.set(0, LRV_HEIGHT_M + 0.55, 0);
      arm.rotation.z = 0.35;
      pan.add(arm);
      const shoe = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.05, 0.14), black);
      // collector head height set at runtime to the local contact-wire height
      shoe.name = 'pantoShoe';
      shoe.position.set(0, OCS_WIRE_HEIGHT_STREET_M, 0);
      pan.add(shoe);
      pan.name = 'pantograph';
      mg.add(pan);
    }
    // bellows at the rear face (between this module and the next)
    if (i < MODULES.length - 1) {
      const bel = new THREE.Mesh(new THREE.BoxGeometry(w * 0.9, bodyH * 0.92, 0.6), black);
      bel.position.set(0, 0.18 + bodyH / 2, -m.len / 2 - 0.0);
      mg.add(bel);
    }
    g.add(mg);
    modules.push(mg);
  });

  const trucks: THREE.Group[] = [];
  for (let t = 0; t < 3; t++) {
    const tg = new THREE.Group();
    tg.name = t === 1 ? 'truck-trailer' : 'truck-power';
    const frame = new THREE.Mesh(new THREE.BoxGeometry(2.0, 0.35, 2.4), bogieMat);
    frame.position.y = 0.35;
    tg.add(frame);
    for (const zz of [-0.925, 0.925]) {
      for (const xx of [-0.72, 0.72]) {
        const wh = new THREE.Mesh(new THREE.CylinderGeometry(0.33, 0.33, 0.12, 12), bogieMat);
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
/** Driver eye in the cab window: right-hand seat, above the short hood, behind the windscreen. */
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
  g.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) (o as THREE.Mesh).castShadow = true;
  });
  return g;
}
