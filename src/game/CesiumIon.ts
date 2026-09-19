import * as THREE from 'three';
import { localToLonLat } from './coords';

export type IonImageryStatus = 'off' | 'loading' | 'ready' | 'error' | 'missing_token';

type IonEndpoint = {
  url?: string;
  accessToken?: string;
  mapStyle?: string;
  /** Bing-style quadkey template variants from Ion asset 2 */
  resource?: string;
};

/**
 * Optional Cesium Ion World Imagery (asset 2) for KW photoreal ground.
 * Token from VITE_CESIUM_ION_TOKEN only — never logged or committed.
 * Falls back silently when missing/invalid.
 */
export class CesiumIonImagery {
  status: IonImageryStatus = 'missing_token';
  private endpoint: IonEndpoint | null = null;
  private loader = new THREE.TextureLoader();
  private cache = new Map<string, THREE.Texture>();
  private tileUrl: ((x: number, y: number, z: number) => string) | null = null;

  async init(): Promise<IonImageryStatus> {
    const token = (import.meta.env.VITE_CESIUM_ION_TOKEN || '').trim();
    if (!token) {
      this.status = 'missing_token';
      return this.status;
    }
    this.status = 'loading';
    try {
      // Asset 2 = Cesium World Imagery (Bing Aerial via Ion). Do not print token.
      const res = await fetch(
        `https://api.cesium.com/v1/assets/2/endpoint?access_token=${encodeURIComponent(token)}`,
      );
      if (!res.ok) {
        this.status = 'error';
        return this.status;
      }
      const data = (await res.json()) as IonEndpoint & {
        mapStyle?: string;
        url?: string;
        accessToken?: string;
        imageryProviders?: unknown;
      };
      this.endpoint = data;
      this.tileUrl = this.buildTileUrl(data, token);
      this.status = this.tileUrl ? 'ready' : 'error';
    } catch {
      this.status = 'error';
    }
    return this.status;
  }

  private buildTileUrl(
    data: IonEndpoint & { url?: string; accessToken?: string },
    ionToken: string,
  ): ((x: number, y: number, z: number) => string) | null {
    // Ion asset 2 typically returns a Bing-style template or authenticated URL root.
    const root = data.url || '';
    const at = data.accessToken || ionToken;
    if (!root && !at) return null;

    // Prefer explicit template with {x}{y}{z} or {quadkey}
    if (root.includes('{quadkey}') || root.includes('{x}')) {
      return (x, y, z) => {
        let u = root;
        if (u.includes('{quadkey}')) {
          u = u.replace('{quadkey}', this.quadKey(x, y, z));
        } else {
          u = u
            .replace('{z}', String(z))
            .replace('{x}', String(x))
            .replace('{y}', String(y));
        }
        if (u.includes('{accessToken}') || u.includes('{access_token}')) {
          u = u.replace('{accessToken}', at).replace('{access_token}', at);
        } else if (!u.includes('access_token=') && at) {
          u += (u.includes('?') ? '&' : '?') + `access_token=${encodeURIComponent(at)}`;
        }
        return u;
      };
    }

    // Fallback: Cesium Ion REST tile proxy for asset 2 (XYZ)
    // https://api.cesium.com/v1/assets/2/endpoint documents Bing; many tokens accept:
    // https://tile.googleapis.com is NOT used — stay on Cesium Ion hosts only.
    if (root) {
      const base = root.replace(/\/?$/, '');
      return (x, y, z) =>
        `${base}/${z}/${x}/${y}.jpeg?access_token=${encodeURIComponent(at)}`;
    }

    // Last resort: Ion imagery tiles via assets API (may 404 on some accounts — status error then)
    return (x, y, z) =>
      `https://api.cesium.com/v1/assets/2/tiles/${z}/${x}/${y}?access_token=${encodeURIComponent(at)}`;
  }

  private quadKey(x: number, y: number, z: number): string {
    let q = '';
    for (let i = z; i > 0; i--) {
      let digit = 0;
      const mask = 1 << (i - 1);
      if ((x & mask) !== 0) digit += 1;
      if ((y & mask) !== 0) digit += 2;
      q += String(digit);
    }
    return q;
  }

  /** Web Mercator tile indices covering local metres at zoom. */
  localToTile(x: number, z: number, zoom: number): { tx: number; ty: number } {
    const [lon, lat] = localToLonLat(x, z);
    const n = 2 ** zoom;
    const tx = Math.floor(((lon + 180) / 360) * n);
    const latRad = (lat * Math.PI) / 180;
    const ty = Math.floor(
      ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n,
    );
    return { tx, ty };
  }

  /**
   * Load a single aerial texture for a chunk centre. Returns null on miss/error.
   * Never throws token into console.
   */
  async textureForLocal(cx: number, cz: number, zoom = 16): Promise<THREE.Texture | null> {
    if (this.status !== 'ready' || !this.tileUrl) return null;
    const { tx, ty } = this.localToTile(cx, cz, zoom);
    const key = `${zoom}/${tx}/${ty}`;
    const hit = this.cache.get(key);
    if (hit) return hit;
    const url = this.tileUrl(tx, ty, zoom);
    try {
      const tex = await new Promise<THREE.Texture>((resolve, reject) => {
        this.loader.load(url, resolve, undefined, reject);
      });
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.anisotropy = 4;
      tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
      this.cache.set(key, tex);
      return tex;
    } catch {
      return null;
    }
  }

  hudLabel(): string {
    switch (this.status) {
      case 'ready':
        return 'Ion imagery';
      case 'loading':
        return 'Ion loading…';
      case 'error':
        return 'Ion fallback';
      case 'missing_token':
        return 'OSM / DEM';
      default:
        return 'OSM / DEM';
    }
  }
}
