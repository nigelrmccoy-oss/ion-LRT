/**
 * Persistent map-asset cache for ion-LRT.
 *
 * Browser: IndexedDB + navigator.storage.persist().
 * Electron: a disk folder via window.mapCache (electron/map-cache.cjs).
 *
 * 16 GB cap, LRU eviction (least-recently-used first; the newest entry is
 * never evicted). Keys are version-prefixed (`v100:kind:…`) so a format
 * bump starts a new keyspace and leaves older records to age out, rather
 * than wiping the store.
 *
 * Do not disk-cache Bing (including Cesium World Imagery / asset 2) or
 * Google Photorealistic 3D Tiles — their terms forbid it. HTTP cache
 * headers only.
 */
export const CACHE_VERSION = 'v100';
export const CACHE_PREFIX = `${CACHE_VERSION}:`;
export const CACHE_CAP_BYTES = 16 * 1024 ** 3;
export const CACHE_TRIM_RATIO = 0.95;

export type MapCacheKind = 'overpass' | 'dem' | 'oiwms';

export type CacheRow = {
  key: string;
  t: number;
  data: unknown;
  bytes?: number;
};

export type CacheStats = { count: number; bytes: number; notice: string; persisted: boolean | null };

export interface DiskCache {
  get(key: string): Promise<CacheRow | null>;
  put(row: CacheRow): Promise<void>;
  stats(): Promise<{ count: number; bytes: number }>;
  clear(): Promise<void>;
}

declare global {
  interface Window {
    mapCache?: DiskCache;
  }
}

export let cacheNotice = '';
export let storagePersisted: boolean | null = null;

const DB_NAME = 'ion-lrt-map';
const STORE = 'responses';

let testBackend: DiskCache | null = null;
let dbP: Promise<IDBDatabase | null> | null = null;

export function installCacheForTests(backend: DiskCache | null): void {
  testBackend = backend;
}

export function createMemoryCache(capBytes = CACHE_CAP_BYTES): DiskCache & {
  keys(): string[];
  row(key: string): CacheRow | undefined;
} {
  const rows = new Map<string, CacheRow>();
  const sizeOf = (row: CacheRow) => row.bytes ?? estimateBytes(row);
  const total = () => {
    let n = 0;
    for (const r of rows.values()) n += sizeOf(r);
    return n;
  };
  const evict = (protectKey: string) => {
    evictLru(rows, capBytes, protectKey, sizeOf);
  };
  return {
    async get(key: string) {
      const row = rows.get(key);
      if (!row) return null;
      row.t = Date.now();
      return { ...row };
    },
    async put(row: CacheRow) {
      const stored: CacheRow = {
        key: row.key,
        t: Number.isFinite(row.t) ? row.t : Date.now(),
        data: row.data,
        bytes: row.bytes ?? estimateBytes(row),
      };
      rows.set(stored.key, stored);
      evict(stored.key);
    },
    async stats() {
      return { count: rows.size, bytes: total() };
    },
    async clear() {
      rows.clear();
    },
    keys() {
      return [...rows.keys()];
    },
    row(key: string) {
      return rows.get(key);
    },
  };
}

function evictLru(
  rows: Map<string, CacheRow>,
  capBytes: number,
  protectKey: string,
  sizeOf: (row: CacheRow) => number,
): void {
  let bytes = 0;
  for (const r of rows.values()) bytes += sizeOf(r);
  if (bytes <= capBytes) return;
  const target = Math.floor(capBytes * CACHE_TRIM_RATIO);
  const order = [...rows.values()].sort((a, b) => a.t - b.t);
  for (const row of order) {
    if (bytes <= target) break;
    if (row.key === protectKey) continue; // never evict the newest
    rows.delete(row.key);
    bytes -= sizeOf(row);
  }
}

export function estimateBytes(row: { data: unknown; key?: string }): number {
  try {
    if (typeof Blob !== 'undefined') return new Blob([JSON.stringify(row)]).size;
  } catch { /* fall through */ }
  try {
    return JSON.stringify(row).length;
  } catch {
    return 64;
  }
}

function nativeDisk(): DiskCache | undefined {
  if (testBackend) return testBackend;
  if (typeof window !== 'undefined') return window.mapCache;
  return undefined;
}

export async function askPersist(): Promise<void> {
  try {
    if (typeof navigator === 'undefined' || !navigator.storage?.persist) return;
    if (nativeDisk() && !testBackend) return; // Electron folder is already persistent
    storagePersisted = (await navigator.storage.persisted()) || (await navigator.storage.persist());
    if (!storagePersisted) {
      cacheNotice = 'Browser may clear the map cache (persistent storage not granted)';
    }
  } catch {
    storagePersisted = false;
  }
}

function openDb(): Promise<IDBDatabase | null> {
  if (dbP) return dbP;
  dbP = new Promise((resolve) => {
    try {
      if (typeof indexedDB === 'undefined') return resolve(null);
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          db.createObjectStore(STORE, { keyPath: 'key' }).createIndex('t', 't');
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return dbP;
}

export function versionedKey(kind: MapCacheKind, raw: string): string {
  return `${CACHE_PREFIX}${kind}:${raw}`;
}

export async function hashKey(raw: string): Promise<string> {
  const bytes = new TextEncoder().encode(raw);
  if (typeof crypto !== 'undefined' && crypto.subtle) {
    const buf = await crypto.subtle.digest('SHA-256', bytes);
    return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
  }
  // FNV-1a 64-bit fallback (tests without SubtleCrypto).
  let h = 0xcbf29ce484222325n;
  for (const b of bytes) {
    h ^= BigInt(b);
    h = (h * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return h.toString(16).padStart(16, '0');
}

export async function makeCacheKey(kind: MapCacheKind, raw: string): Promise<string> {
  const direct = versionedKey(kind, raw);
  if (direct.length <= 1800) return direct;
  return versionedKey(kind, `h:${await hashKey(raw)}`);
}

/** True when terms forbid anything beyond ordinary HTTP caching. */
export function isForbiddenToDiskCache(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  const host = u.hostname.toLowerCase();
  const path = u.pathname.toLowerCase();
  const href = url.toLowerCase();

  if (
    /(?:^|\.)((?:ecn\.)?(?:tiles\.)?virtualearth\.net|bing\.com|bing\.net|tile\.googleapis\.com|maps\.googleapis\.com|maps\.google\.com|earth\.google\.com)$/i.test(
      host,
    )
  ) {
    return true;
  }
  if (host.endsWith('googleapis.com') && /3dtiles|photorealistic|maptiles|v1\/3d/.test(href)) {
    return true;
  }
  if (host.endsWith('cesium.com') || host.endsWith('cesiumion.com')) {
    // Asset 2 = Cesium World Imagery (Bing Aerial). Asset 2275207 = Google P3DT.
    if (/\/assets\/(2|2275207)(\/|$)/.test(path)) return true;
    if (/3dtiles|photorealistic|world.?imagery|\bbing\b/.test(href)) return true;
  }
  if (/\bvirtualearth\b|\bbing\.com\b/.test(href)) return true;
  if (/photorealistic.?3d|\/3dtiles\//.test(href)) return true;
  return false;
}

export async function cacheGet<T>(key: string): Promise<{ data: T; ageMs: number } | null> {
  const native = nativeDisk();
  if (native) {
    try {
      const r = await native.get(key);
      return r ? { data: r.data as T, ageMs: Date.now() - r.t } : null;
    } catch {
      cacheNotice = 'Map disk unavailable';
      return null;
    }
  }
  const db = await openDb();
  if (!db) return null;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE, 'readwrite');
      const store = tx.objectStore(STORE);
      const req = store.get(key);
      req.onsuccess = () => {
        const row = req.result as CacheRow | undefined;
        if (!row) {
          resolve(null);
          return;
        }
        row.t = Date.now();
        store.put(row);
        resolve({ data: row.data as T, ageMs: 0 });
      };
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

export async function cachePut(key: string, data: unknown, bytes?: number): Promise<void> {
  const row: CacheRow = { key, t: Date.now(), data, bytes };
  row.bytes = bytes ?? estimateBytes(row);
  try {
    const native = nativeDisk();
    if (native) {
      await native.put(row);
      return;
    }
    const db = await openDb();
    if (!db) {
      cacheNotice = 'Map storage unavailable';
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(row);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
    void trimIndexedDb(db, key);
  } catch {
    cacheNotice = 'Map storage full or unavailable — existing tiles kept';
  }
}

async function trimIndexedDb(db: IDBDatabase, protectKey: string): Promise<void> {
  try {
    const cap = await effectiveCap();
    const all: CacheRow[] = await new Promise((resolve) => {
      const out: CacheRow[] = [];
      const req = db.transaction(STORE, 'readonly').objectStore(STORE).openCursor();
      req.onsuccess = () => {
        const c = req.result;
        if (!c) return resolve(out);
        out.push(c.value as CacheRow);
        c.continue();
      };
      req.onerror = () => resolve(out);
    });
    let bytes = all.reduce((s, r) => s + (r.bytes ?? estimateBytes(r)), 0);
    if (bytes <= cap) return;
    const target = Math.floor(cap * CACHE_TRIM_RATIO);
    all.sort((a, b) => a.t - b.t);
    const drop: string[] = [];
    for (const r of all) {
      if (bytes <= target) break;
      if (r.key === protectKey) continue;
      drop.push(r.key);
      bytes -= r.bytes ?? estimateBytes(r);
    }
    if (!drop.length) return;
    await new Promise<void>((resolve) => {
      const tx = db.transaction(STORE, 'readwrite');
      const store = tx.objectStore(STORE);
      for (const k of drop) store.delete(k);
      tx.oncomplete = () => {
        cacheNotice = 'Map storage trimmed (least-recently-used tiles)';
        resolve();
      };
      tx.onerror = () => resolve();
    });
  } catch {
    /* fail soft */
  }
}

async function effectiveCap(): Promise<number> {
  try {
    const estimate = await navigator.storage?.estimate?.();
    if (estimate?.quota) return Math.min(CACHE_CAP_BYTES, Math.floor(0.8 * estimate.quota));
  } catch { /* ignore */ }
  return CACHE_CAP_BYTES;
}

export async function cacheStats(): Promise<CacheStats> {
  const native = nativeDisk();
  if (native) {
    const s = await native.stats();
    return { ...s, notice: cacheNotice, persisted: storagePersisted ?? true };
  }
  const db = await openDb();
  let count = 0;
  let bytes = 0;
  if (db) {
    await new Promise<void>((resolve) => {
      const req = db.transaction(STORE).objectStore(STORE).openCursor();
      req.onsuccess = () => {
        const c = req.result;
        if (!c) {
          resolve();
          return;
        }
        count++;
        bytes += (c.value as CacheRow).bytes ?? estimateBytes(c.value);
        c.continue();
      };
      req.onerror = () => resolve();
    });
  }
  try {
    const estimate = await navigator.storage?.estimate?.();
    if (estimate?.quota && (estimate.usage ?? 0) / estimate.quota > 0.85) {
      cacheNotice = 'Map storage near browser quota';
    }
  } catch { /* ignore */ }
  return { count, bytes, notice: cacheNotice, persisted: storagePersisted };
}

export async function clearMapCache(): Promise<void> {
  const native = nativeDisk();
  if (native) await native.clear();
  else {
    const db = await openDb();
    if (db) {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).clear();
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    }
  }
  cacheNotice = '';
}

export function toB64(bytes: Uint8Array): string {
  let b64 = '';
  const chunk = 32 * 1024;
  for (let i = 0; i < bytes.length; i += chunk) {
    const slice = bytes.subarray(i, i + chunk);
    b64 += String.fromCharCode(...slice);
  }
  return btoa(b64);
}

export function fromB64(s: string): Uint8Array {
  const bin = atob(s);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}
