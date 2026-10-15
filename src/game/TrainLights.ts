import * as THREE from 'three';
import type { ArticulatedLRV } from './Vehicles';
import { DIESEL_DIMS, DIESEL_COACH } from './Vehicles';
import { MODULES, LRV_FLOOR_ATR_M, LRV_WIDTH_M } from './Clearances';

/**
 * Train lighting (v1.4.3): Flexity dual headlights + light pool, red tail lights on the
 * trailing cab, lit destination signs and interior lighting; diesel headlight, ditch
 * lights and a flashing rear marker.
 *
 * FPS budget: exactly ONE real-time light per train (a SpotLight for the headlight beam,
 * castShadow = false). Everything else is unlit/emissive geometry, additive glow sprites
 * and a projected "light pool" decal on the track ahead. The spot stays in the scene and
 * is dimmed to 0 when the lights are off, so toggling never changes the scene's light
 * count (that would recompile every material's shader program and hitch the frame).
 */
export type LightsMode = 'auto' | 'on' | 'off';
export type TimeOfDay = 'day' | 'dusk' | 'night';

/** Max real-time (shader) lights a train may add. */
export const TRAIN_MAX_REALTIME_LIGHTS = 1;
/** Headlight beam: candela-like intensity (three.js physical units), range, cone. */
export const HEADLIGHT_INTENSITY = 420;
export const HEADLIGHT_RANGE_M = 160;
export const HEADLIGHT_ANGLE_RAD = 0.42;
/** Ditch lights alternate at this rate while flashing (Hz) — North American practice. */
export const DITCH_FLASH_HZ = 1.5;
/** Rear marker flash rate (Hz). */
export const MARKER_FLASH_HZ = 1;

/** Lights lit for mode + time of day: auto = on at dusk/night. */
export function lightsOn(mode: LightsMode, tod: TimeOfDay): boolean {
  return mode === 'on' || (mode === 'auto' && tod !== 'day');
}

/** H key: flip whatever is showing now (auto at night → off, auto by day → on). */
export function toggleLightsMode(mode: LightsMode, tod: TimeOfDay): LightsMode {
  return lightsOn(mode, tod) ? 'off' : 'on';
}

export function lightsLabel(mode: LightsMode, tod: TimeOfDay): string {
  const on = lightsOn(mode, tod);
  return `Lights ${on ? 'on' : 'off'}${mode === 'auto' ? ' (auto)' : ''}`;
}

function canvasTex(w: number, h: number, draw: (g: CanvasRenderingContext2D) => void) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d');
  if (g) draw(g);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

let glowTex: THREE.Texture | null = null;
function glowTexture() {
  if (glowTex) return glowTex;
  glowTex = canvasTex(64, 64, (g) => {
    const r = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    r.addColorStop(0, 'rgba(255,255,255,1)');
    r.addColorStop(0.25, 'rgba(255,255,255,0.55)');
    r.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = r;
    g.fillRect(0, 0, 64, 64);
  });
  return glowTex;
}

/** Two elongated beams (dual headlights) for the light-pool decal. */
function poolTexture() {
  return canvasTex(128, 256, (g) => {
    for (const cx of [40, 88]) {
      g.save();
      g.translate(cx, 40);
      g.scale(1, 4.2);
      const r = g.createRadialGradient(0, 0, 0, 0, 0, 46);
      r.addColorStop(0, 'rgba(255,246,225,0.9)');
      r.addColorStop(0.5, 'rgba(255,246,225,0.35)');
      r.addColorStop(1, 'rgba(255,246,225,0)');
      g.fillStyle = r;
      g.beginPath();
      g.arc(0, 0, 46, 0, Math.PI * 2);
      g.fill();
      g.restore();
    }
  });
}

/** Amber LED destination text. */
function destTexture(text: string) {
  return canvasTex(256, 52, (g) => {
    g.fillStyle = '#0b0b0b';
    g.fillRect(0, 0, 256, 52);
    g.fillStyle = '#ffb000';
    g.font = 'bold 28px monospace';
    g.textBaseline = 'middle';
    g.fillText(text.slice(0, 16), 8, 27);
  });
}

type Lamp = { mesh: THREE.Mesh; glow: THREE.Sprite; on: THREE.Color; off: THREE.Color };

function makeLamp(parent: THREE.Object3D, x: number, y: number, z: number, color: number, r = 0.11, glowSize = 0.9): Lamp {
  const on = new THREE.Color(color);
  const off = new THREE.Color(color).multiplyScalar(0.18);
  const mat = new THREE.MeshBasicMaterial({ color: off.clone(), toneMapped: false });
  const mesh = new THREE.Mesh(new THREE.CircleGeometry(r, 16), mat);
  mesh.position.set(x, y, z);
  mesh.name = 'lamp';
  const glow = new THREE.Sprite(new THREE.SpriteMaterial({
    map: glowTexture(), color, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false, toneMapped: false,
  }));
  glow.scale.setScalar(glowSize);
  glow.position.set(x, y, z);
  glow.visible = false;
  parent.add(mesh, glow);
  return { mesh, glow, on, off };
}

function setLamp(l: Lamp, lit: boolean) {
  (l.mesh.material as THREE.MeshBasicMaterial).color.copy(lit ? l.on : l.off);
  l.glow.visible = lit;
}

export class TrainLights {
  /** The one real-time light (headlight beam). */
  spot: THREE.SpotLight;
  head: Lamp[] = [];
  tail: Lamp[] = [];
  ditch: Lamp[] = [];
  marker: Lamp[] = [];
  pool: THREE.Mesh | null = null;
  /** Window / interior materials that glow when the interior lights are on. */
  interior: THREE.MeshStandardMaterial[] = [];
  /** Destination-sign faces (always lit, like the real LED signs). */
  destFaces: THREE.Mesh[] = [];
  lit = false;

  private constructor(parent: THREE.Object3D, pos: THREE.Vector3, aim: THREE.Vector3) {
    this.spot = new THREE.SpotLight(0xfff4e0, 0, HEADLIGHT_RANGE_M, HEADLIGHT_ANGLE_RAD, 0.55, 2);
    this.spot.name = 'headlightBeam';
    this.spot.castShadow = false;
    this.spot.position.copy(pos);
    this.spot.target.position.copy(aim);
    parent.add(this.spot, this.spot.target);
  }

  /** Flexity: lamps on cab A (lead, +z nose) and cab E (trailing, −z nose). */
  static forFlexity(lrv: ArticulatedLRV, destText: string): TrainLights {
    const a = lrv.modules[0], e = lrv.modules[lrv.modules.length - 1];
    const lenA = MODULES[0].len, lenE = MODULES[MODULES.length - 1].len;
    const noseA = lenA / 2 + 0.01, noseE = -(lenE / 2 + 0.01);
    const yLamp = LRV_FLOOR_ATR_M + 0.45;
    const L = new TrainLights(a, new THREE.Vector3(0, yLamp, noseA + 0.1), new THREE.Vector3(0, 0, noseA + 35));
    // the cab nose is a flattened half-cylinder (Vehicles: radius w·0.49, depth 1.2 m):
    // put each lamp on its surface, not in front of the tip
    const noseDepth = 1.2, r = LRV_WIDTH_M * 0.49;
    const onNose = (x: number) => noseDepth * Math.sqrt(Math.max(0, 1 - (x / r) ** 2)) - noseDepth + 0.01;
    for (const x of [-0.78, 0.78]) {
      L.head.push(makeLamp(a, x, yLamp, noseA + onNose(x), 0xfff6e8, 0.12, 1.1));
      const t = makeLamp(e, x, yLamp, noseE - onNose(x), 0xff1a10, 0.09, 0.7);
      t.mesh.rotation.y = Math.PI;
      L.tail.push(t);
    }
    // light pool on the track ahead (projected decal, no extra light)
    const pool = new THREE.Mesh(
      new THREE.PlaneGeometry(4.6, 26),
      new THREE.MeshBasicMaterial({
        map: poolTexture(), transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending,
        depthWrite: false, toneMapped: false, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4,
      }),
    );
    pool.name = 'lightPool';
    pool.rotation.x = -Math.PI / 2;
    pool.position.set(0, 0.04, noseA + 1 + 13);
    pool.visible = false;
    a.add(pool);
    L.pool = pool;
    // destination signs (both cabs): amber LED face in front of the sign box
    for (const m of [a, e]) {
      const box = m.getObjectByName('destSign');
      if (!box) continue;
      const front = m === a ? 1 : -1;
      const face = new THREE.Mesh(new THREE.PlaneGeometry(1.62, 0.28),
        new THREE.MeshBasicMaterial({ map: destTexture(destText), toneMapped: false }));
      face.name = 'destGlow';
      face.position.set(0, 0, front * 0.035);
      face.rotation.y = front > 0 ? 0 : Math.PI;
      box.add(face); // child: hidden with the sign in the cab view
      L.destFaces.push(face);
    }
    lrv.group.traverse((o) => {
      const mat = (o as THREE.Mesh).material as THREE.MeshStandardMaterial | undefined;
      if (mat && mat.name === 'lrvGlass' && !L.interior.includes(mat)) L.interior.push(mat);
    });
    return L;
  }

  /** WCR / CN diesel: headlight + ditch lights on the short hood, flashing rear marker. */
  static forDiesel(g: THREE.Group): TrainLights {
    const D = DIESEL_DIMS;
    const zNose = D.noseZ1 + 0.02;
    const L = new TrainLights(g, new THREE.Vector3(0, D.noseTop - 0.35, zNose + 0.15), new THREE.Vector3(0, 0, zNose + 45));
    L.head.push(makeLamp(g, -0.22, D.noseTop - 0.35, zNose, 0xfff6e8, 0.13, 1.2));
    L.head.push(makeLamp(g, 0.22, D.noseTop - 0.35, zNose, 0xfff6e8, 0.13, 1.2));
    for (const x of [-1.15, 1.15]) L.ditch.push(makeLamp(g, x, D.frameTop - 0.25, D.noseZ1 + 0.32, 0xfff2d8, 0.1, 0.9));
    const zRear = D.hoodZ0 - DIESEL_COACH.gap - DIESEL_COACH.len - 0.02;
    const mk = makeLamp(g, 1.0, 1.6, zRear, 0xff2010, 0.1, 0.8);
    mk.mesh.rotation.y = Math.PI;
    L.marker.push(mk);
    g.traverse((o) => {
      const mat = (o as THREE.Mesh).material as THREE.MeshStandardMaterial | undefined;
      if (mat && (mat.name === 'coachGlass') && !L.interior.includes(mat)) L.interior.push(mat);
    });
    return L;
  }

  /** Real-time lights this train adds to the scene (for the FPS budget). */
  realtimeLights(): THREE.Light[] {
    return [this.spot];
  }

  /**
   * @param on      headlights / tail / marker lit (lightsOn(mode, tod))
   * @param tSec    sim clock (s) for flashing
   * @param ditchFlash  ditch lights alternate (horn / grade crossing ahead)
   */
  update(on: boolean, tSec: number, ditchFlash = false) {
    this.lit = on;
    this.spot.intensity = on ? HEADLIGHT_INTENSITY : 0;
    for (const l of this.head) setLamp(l, on);
    for (const l of this.tail) setLamp(l, on);
    if (this.pool) this.pool.visible = on;
    this.ditch.forEach((l, i) => {
      const phase = Math.floor(tSec * DITCH_FLASH_HZ * 2) % 2;
      setLamp(l, on && (!ditchFlash || phase === i));
    });
    const blink = Math.floor(tSec * MARKER_FLASH_HZ * 2) % 2 === 0;
    for (const l of this.marker) setLamp(l, on && blink);
    for (const m of this.interior) {
      m.emissive.set(on ? 0xffe6b8 : 0x000000);
      m.emissiveIntensity = on ? 0.85 : 0;
    }
  }
}
