import * as THREE from 'three';
import { TilesRenderer } from '3d-tiles-renderer';
import {
  CesiumIonAuthPlugin,
  GLTFExtensionsPlugin,
  ReorientationPlugin,
  TileCompressionPlugin,
} from '3d-tiles-renderer/plugins';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { ORIGIN_LAT, ORIGIN_LON } from './coords';

/** Cesium ion asset id of Google Photorealistic 3D Tiles. */
export const GOOGLE_P3DT_ION_ASSET = 2275207;
/**
 * Geoid undulation (ellipsoid − orthometric height) near Kitchener–Waterloo, metres.
 * ESTIMATE (EGM/CGG2013 ≈ −36 m in southern Ontario); the residual is removed at run time
 * by ray-casting the tiles under the train (see autoAlign).
 */
export const GEOID_N_KW_M = -36;

export type PhotorealStatus = 'off' | 'missing_token' | 'loading' | 'ready' | 'error';

/**
 * Optional Google Photorealistic 3D Tiles (via Cesium ion) as in-sim scenery.
 * Token comes only from VITE_CESIUM_ION_TOKEN (gitignored .env.local) and is never logged.
 * Tiles are re-oriented so lat/lon ORIGIN maps to the sim's local tangent plane
 * (x = east, z = south, y = up; y = 0 at Elevation.baseElev).
 */
export class PhotorealTiles {
  status: PhotorealStatus = 'off';
  root = new THREE.Group();
  private tiles: TilesRenderer | null = null;
  private ray = new THREE.Raycaster();
  private lastAlign = 0;
  private offsets: number[] = [];
  private creditsEl: HTMLElement | null = null;
  private creditTimer = 0;
  private ionCredits: { text: string; img?: string; href?: string }[] = [];
  onFailure: (() => void) | null = null;

  constructor() {
    this.root.name = 'photoreal-3d-tiles';
    // ReorientationPlugin yields +X west / +Z north; the sim uses +X east / +Z south.
    this.root.rotation.y = Math.PI;
  }

  async init(camera: THREE.Camera, renderer: THREE.WebGLRenderer, baseElev: number): Promise<boolean> {
    const token = (import.meta.env.VITE_CESIUM_ION_TOKEN || '').trim();
    if (!token) {
      this.status = 'missing_token';
      return false;
    }
    this.status = 'loading';
    try {
      const tiles = new TilesRenderer();
      tiles.registerPlugin(new CesiumIonAuthPlugin({
        apiToken: token,
        assetId: String(GOOGLE_P3DT_ION_ASSET),
        autoRefreshToken: true,
      }));
      const draco = new DRACOLoader();
      draco.setDecoderPath('https://www.gstatic.com/draco/versioned/decoders/1.5.7/');
      tiles.registerPlugin(new GLTFExtensionsPlugin({ dracoLoader: draco }));
      tiles.registerPlugin(new TileCompressionPlugin());
      tiles.registerPlugin(new ReorientationPlugin({
        lat: ORIGIN_LAT * THREE.MathUtils.DEG2RAD,
        lon: ORIGIN_LON * THREE.MathUtils.DEG2RAD,
        height: baseElev + GEOID_N_KW_M,
        recenter: true,
      }));
      tiles.errorTarget = 12;
      tiles.setCamera(camera);
      tiles.setResolutionFromRenderer(camera, renderer);
      tiles.addEventListener('load-error', (e: any) => {
        // Root failure (bad token, no asset access, quota) → fall back to OSM scenery
        if (!e || e.tile == null) {
          this.status = 'error';
          this.root.visible = false;
          this.onFailure?.();
        }
      });
      tiles.addEventListener('load-tile-set', () => {
        if (this.status === 'loading') this.status = 'ready';
      });
      this.tiles = tiles;
      this.root.add(tiles.group);
      this.root.visible = true;
      void this.fetchIonCredits(token);
      return true;
    } catch {
      this.status = 'error';
      return false;
    }
  }

  /** Provider attribution (logo + html) for the asset, read from the ion endpoint. */
  private async fetchIonCredits(token: string) {
    try {
      const res = await fetch(
        `https://api.cesium.com/v1/assets/${GOOGLE_P3DT_ION_ASSET}/endpoint?access_token=${encodeURIComponent(token)}`,
      );
      if (!res.ok) return;
      const json = await res.json();
      const atts: { html?: string }[] = json.attributions || [];
      this.ionCredits = atts.map((a) => {
        // Parse safely: keep only text, first <img src> and first <a href> (no innerHTML)
        const doc = new DOMParser().parseFromString(a.html || '', 'text/html');
        const img = doc.querySelector('img')?.getAttribute('src') || undefined;
        const href = doc.querySelector('a')?.getAttribute('href') || undefined;
        const text = (doc.body.textContent || '').trim();
        return { text, img, href };
      });
    } catch {
      /* attribution falls back to static text */
    }
  }

  update(camera: THREE.Camera, renderer: THREE.WebGLRenderer, train: { x: number; y: number; z: number }) {
    if (!this.tiles || this.status === 'error') return;
    camera.updateMatrixWorld();
    this.tiles.setResolutionFromRenderer(camera, renderer);
    this.tiles.update();
    const now = performance.now();
    if (now - this.lastAlign > 1500) {
      this.lastAlign = now;
      this.autoAlign(train);
    }
    if (now - this.creditTimer > 1000) {
      this.creditTimer = now;
      this.renderCredits();
    }
  }

  /**
   * Remove residual vertical datum error (geoid estimate, DEM bias): ray-cast the
   * photogrammetry straight down at the train and nudge the tileset so its ground
   * meets the rail formation. Median of recent samples, clamped to ±60 m.
   */
  private autoAlign(train: { x: number; y: number; z: number }) {
    if (!this.tiles) return;
    this.ray.set(new THREE.Vector3(train.x, train.y + 300, train.z), new THREE.Vector3(0, -1, 0));
    const hits = this.ray.intersectObject(this.tiles.group, true);
    if (!hits.length) return;
    // ignore hits on things far above the rail (trees, OCS, bridges): take the lowest
    const hitY = hits[hits.length - 1].point.y;
    const want = train.y - 0.4;
    const delta = want - hitY;
    if (Math.abs(delta) > 120) return;
    this.offsets.push(this.root.position.y + delta);
    if (this.offsets.length > 9) this.offsets.shift();
    const sorted = [...this.offsets].sort((a, b) => a - b);
    const med = sorted[Math.floor(sorted.length / 2)];
    this.root.position.y = THREE.MathUtils.clamp(med, -60, 60);
  }

  /** On-screen attribution required by Google Map Tiles API + Cesium ion terms. */
  showAttribution(on: boolean) {
    if (!this.creditsEl) {
      this.creditsEl = document.getElementById('photorealCredits');
    }
    if (this.creditsEl) this.creditsEl.classList.toggle('hidden', !on || this.status === 'missing_token' || this.status === 'error');
    if (on && this.status !== 'error') this.renderCredits();
  }

  private renderCredits() {
    const el = this.creditsEl || document.getElementById('photorealCredits');
    if (!el) return;
    this.creditsEl = el;
    el.textContent = '';
    const parts: string[] = [];
    if (this.tiles) {
      for (const a of this.tiles.getAttributions()) {
        if (a.type === 'string' && a.value) parts.push(String(a.value));
      }
    }
    // Provider logos/credits from the ion endpoint (Google logo etc.)
    for (const c of this.ionCredits) {
      if (c.img) {
        const im = document.createElement('img');
        im.src = c.img;
        im.alt = c.text || 'Google';
        im.className = 'credit-logo';
        el.appendChild(im);
      }
    }
    // Google Maps attribution + aggregated per-tile data attributions (Map Tiles API
    // policy), kept visually separate from the renderer / Cesium ion credit.
    const google = document.createElement('span');
    google.setAttribute('aria-label', 'Google Maps');
    google.textContent = `Google Maps${parts.length ? ' · Map data: ' + parts.join('; ') : ''}`;
    el.appendChild(google);
    const ion = document.createElement('span');
    ion.className = 'credit-sep';
    const status = this.status === 'error' ? ' (unavailable — OSM fallback)' : '';
    ion.textContent = `Streamed via Cesium ion${status}`;
    el.appendChild(ion);
  }

  dispose() {
    if (this.tiles) {
      this.root.remove(this.tiles.group);
      this.tiles.dispose();
      this.tiles = null;
    }
    this.status = 'off';
    this.offsets = [];
    this.root.position.y = 0;
  }
}
