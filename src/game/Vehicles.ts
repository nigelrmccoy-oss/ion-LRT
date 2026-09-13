import * as THREE from 'three';

/** 5-module Flexity Freedom proportions (~30.8 m × 2.65 m), tribute livery — no official logos. */
export function createFlexity(): THREE.Group {
  const g = new THREE.Group();
  const silver = new THREE.MeshStandardMaterial({ color: 0xb0b8c4, metalness: 0.55, roughness: 0.35 });
  const black = new THREE.MeshStandardMaterial({ color: 0x1a1a1e, metalness: 0.4, roughness: 0.6 });
  const blue = new THREE.MeshStandardMaterial({ color: 0x1e5aa8, metalness: 0.3, roughness: 0.5 });
  const glass = new THREE.MeshStandardMaterial({ color: 0x87b8d8, metalness: 0.1, roughness: 0.1, transparent: true, opacity: 0.45 });

  const moduleLen = 5.8;
  const w = 2.65, h = 3.4;
  for (let i = 0; i < 5; i++) {
    const body = new THREE.Mesh(new THREE.BoxGeometry(w, h * 0.7, moduleLen - 0.15), silver);
    body.position.set(0, h * 0.45, (i - 2) * moduleLen);
    body.castShadow = true;
    g.add(body);
    const stripe = new THREE.Mesh(new THREE.BoxGeometry(w + 0.02, 0.25, moduleLen - 0.2), blue);
    stripe.position.set(0, 1.1, (i - 2) * moduleLen);
    g.add(stripe);
    // doors (4 per side visual marks)
    for (const side of [-1, 1]) {
      for (let d = 0; d < 2; d++) {
        const door = new THREE.Mesh(new THREE.BoxGeometry(0.08, 2.1, 1.2), black);
        door.position.set(side * (w / 2 + 0.02), 1.3, (i - 2) * moduleLen + (d === 0 ? -1.4 : 1.4));
        g.add(door);
      }
    }
  }
  // cab ends
  for (const z of [-2.5 * moduleLen, 2.5 * moduleLen]) {
    const cab = new THREE.Mesh(new THREE.BoxGeometry(w * 0.95, h * 0.65, 1.8), silver);
    cab.position.set(0, h * 0.42, z);
    g.add(cab);
    const wind = new THREE.Mesh(new THREE.BoxGeometry(w * 0.85, 1.2, 0.1), glass);
    wind.position.set(0, 2.0, z + Math.sign(z) * 0.95);
    g.add(wind);
  }
  // destination sign
  const dest = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.35, 0.08), black);
  dest.position.set(0, 2.85, -2.5 * moduleLen - 0.9);
  g.add(dest);
  // pantograph
  const pan = new THREE.Group();
  const base = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.1, 0.8), black);
  base.position.y = 3.5;
  pan.add(base);
  const arm = new THREE.Mesh(new THREE.BoxGeometry(0.08, 1.2, 0.08), black);
  arm.position.set(0, 4.1, 0);
  pan.add(arm);
  const shoe = new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.06, 0.15), black);
  shoe.position.set(0, 4.7, 0);
  pan.add(shoe);
  pan.name = 'pantograph';
  g.add(pan);

  g.traverse((o) => { if ((o as THREE.Mesh).isMesh) (o as THREE.Mesh).castShadow = true; });
  return g;
}

/** Simple WCR-style diesel / tourist consist. */
export function createDieselConsist(kind: 'wcr' | 'cn'): THREE.Group {
  const g = new THREE.Group();
  const bodyCol = kind === 'wcr' ? 0x2e5a3c : 0xb84a2a;
  const bodyMat = new THREE.MeshStandardMaterial({ color: bodyCol, metalness: 0.3, roughness: 0.55 });
  const black = new THREE.MeshStandardMaterial({ color: 0x222226, metalness: 0.4, roughness: 0.6 });
  const loco = new THREE.Mesh(new THREE.BoxGeometry(3.0, 3.8, 14), bodyMat);
  loco.position.set(0, 2.1, 0);
  g.add(loco);
  const cab = new THREE.Mesh(new THREE.BoxGeometry(3.0, 2.2, 3.2), black);
  cab.position.set(0, 3.5, -6.5);
  g.add(cab);
  const glass = new THREE.Mesh(new THREE.BoxGeometry(2.6, 1.0, 0.1), new THREE.MeshStandardMaterial({ color: 0x88aacc, transparent: true, opacity: 0.5 }));
  glass.position.set(0, 3.7, -8.1);
  g.add(glass);
  // coach
  const coach = new THREE.Mesh(new THREE.BoxGeometry(2.9, 3.6, 16), new THREE.MeshStandardMaterial({ color: 0xd8d0c4, metalness: 0.2, roughness: 0.7 }));
  coach.position.set(0, 2.0, 16);
  g.add(coach);
  g.traverse((o) => { if ((o as THREE.Mesh).isMesh) (o as THREE.Mesh).castShadow = true; });
  return g;
}
