import * as THREE from 'three';

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

/**
 * 5-module Flexity Freedom proportions (~30.8 m × 2.65 m).
 * Rounded cab noses + articulated joints — less boxy than v1.2.
 * Tribute silver/black/blue livery (procedural PBR; no official logos / Street View).
 */
export function createFlexity(): THREE.Group {
  const g = new THREE.Group();
  const silverMap = makeBrushedTex('#a8b0bc', 0.1);
  const silver = new THREE.MeshStandardMaterial({
    color: 0xb0b8c4,
    map: silverMap,
    metalness: 0.62,
    roughness: 0.32,
  });
  const black = new THREE.MeshStandardMaterial({ color: 0x1a1a1e, metalness: 0.45, roughness: 0.55 });
  const blue = new THREE.MeshStandardMaterial({ color: 0x1e5aa8, metalness: 0.35, roughness: 0.42 });
  const glassMap = makeWindowTex();
  const glass = new THREE.MeshStandardMaterial({
    color: 0x87b8d8,
    map: glassMap,
    metalness: 0.15,
    roughness: 0.08,
    transparent: true,
    opacity: 0.55,
  });

  const moduleLen = 5.8;
  const w = 2.65;
  const h = 3.4;

  for (let i = 0; i < 5; i++) {
    const z0 = (i - 2) * moduleLen;
    // Slightly tapered body (less pure box)
    const body = new THREE.Mesh(new THREE.BoxGeometry(w * 0.98, h * 0.62, moduleLen - 0.35), silver);
    body.position.set(0, h * 0.42, z0);
    body.castShadow = true;
    g.add(body);
    // Roof curve suggestion
    const roof = new THREE.Mesh(new THREE.CylinderGeometry(w * 0.48, w * 0.48, moduleLen - 0.4, 12, 1, false, 0, Math.PI), silver);
    roof.rotation.z = Math.PI / 2;
    roof.rotation.y = Math.PI / 2;
    roof.position.set(0, h * 0.72, z0);
    g.add(roof);
    const stripe = new THREE.Mesh(new THREE.BoxGeometry(w + 0.04, 0.22, moduleLen - 0.4), blue);
    stripe.position.set(0, 1.05, z0);
    g.add(stripe);
    for (const side of [-1, 1]) {
      for (let d = 0; d < 2; d++) {
        const door = new THREE.Mesh(new THREE.BoxGeometry(0.06, 2.05, 1.15), black);
        door.position.set(side * (w / 2 + 0.01), 1.25, z0 + (d === 0 ? -1.35 : 1.35));
        g.add(door);
      }
      const win = new THREE.Mesh(new THREE.PlaneGeometry(1.5, 1.0), glass);
      win.position.set(side * (w / 2 + 0.03), 2.05, z0);
      win.rotation.y = side > 0 ? Math.PI / 2 : -Math.PI / 2;
      g.add(win);
    }
    // Articulation bellows between modules
    if (i < 4) {
      const joint = new THREE.Mesh(
        new THREE.CylinderGeometry(w * 0.42, w * 0.42, 0.55, 10),
        black,
      );
      joint.rotation.z = Math.PI / 2;
      joint.position.set(0, h * 0.4, z0 + moduleLen / 2);
      g.add(joint);
    }
  }

  // Rounded cab noses (lathe)
  const cabProfile = [
    new THREE.Vector2(0.05, 0),
    new THREE.Vector2(w * 0.48, 0.15),
    new THREE.Vector2(w * 0.5, 1.1),
    new THREE.Vector2(w * 0.48, 2.2),
    new THREE.Vector2(w * 0.35, 2.9),
    new THREE.Vector2(0.1, 3.15),
  ];
  for (const sign of [-1, 1]) {
    const nose = new THREE.Mesh(new THREE.LatheGeometry(cabProfile, 20), silver);
    nose.rotation.x = Math.PI / 2;
    nose.position.set(0, 0.15, sign * (2.5 * moduleLen + 0.2));
    if (sign > 0) nose.rotation.z = Math.PI;
    g.add(nose);
    const wind = new THREE.Mesh(new THREE.PlaneGeometry(w * 0.85, 1.15), glass);
    wind.position.set(0, 2.05, sign * (2.5 * moduleLen + 0.95));
    wind.rotation.y = sign > 0 ? 0 : Math.PI;
    wind.rotation.x = sign > 0 ? -0.15 : 0.15;
    g.add(wind);
  }

  const dest = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.38, 0.08), black);
  dest.position.set(0, 2.9, -2.5 * moduleLen - 1.05);
  g.add(dest);

  const pan = new THREE.Group();
  const base = new THREE.Mesh(new THREE.BoxGeometry(0.35, 0.12, 0.9), black);
  base.position.y = 3.55;
  pan.add(base);
  const arm = new THREE.Mesh(new THREE.BoxGeometry(0.07, 1.15, 0.07), black);
  arm.position.set(0, 4.15, 0);
  arm.rotation.z = 0.35;
  pan.add(arm);
  const shoe = new THREE.Mesh(new THREE.BoxGeometry(1.85, 0.05, 0.14), black);
  shoe.position.set(0, 4.75, 0);
  pan.add(shoe);
  pan.name = 'pantograph';
  g.add(pan);

  g.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) (o as THREE.Mesh).castShadow = true;
  });
  return g;
}

/** Simple WCR-style diesel / tourist consist. */
export function createDieselConsist(kind: 'wcr' | 'cn'): THREE.Group {
  const g = new THREE.Group();
  const bodyCol = kind === 'wcr' ? 0x2e5a3c : 0xb84a2a;
  const bodyMat = new THREE.MeshStandardMaterial({ color: bodyCol, metalness: 0.35, roughness: 0.5 });
  const black = new THREE.MeshStandardMaterial({ color: 0x222226, metalness: 0.4, roughness: 0.6 });
  const loco = new THREE.Mesh(new THREE.BoxGeometry(3.0, 3.8, 14), bodyMat);
  loco.position.set(0, 2.1, 0);
  g.add(loco);
  const cab = new THREE.Mesh(new THREE.BoxGeometry(3.0, 2.2, 3.2), black);
  cab.position.set(0, 3.5, -6.5);
  g.add(cab);
  const glass = new THREE.Mesh(
    new THREE.BoxGeometry(2.6, 1.0, 0.1),
    new THREE.MeshStandardMaterial({ color: 0x88aacc, transparent: true, opacity: 0.5 }),
  );
  glass.position.set(0, 3.7, -8.1);
  g.add(glass);
  const coach = new THREE.Mesh(
    new THREE.BoxGeometry(2.9, 3.6, 16),
    new THREE.MeshStandardMaterial({ color: 0xd8d0c4, metalness: 0.2, roughness: 0.7 }),
  );
  coach.position.set(0, 2.0, 16);
  g.add(coach);
  g.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) (o as THREE.Mesh).castShadow = true;
  });
  return g;
}
