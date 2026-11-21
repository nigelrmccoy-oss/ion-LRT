/**
 * Fetch-layer wrappers for cacheable map assets.
 *
 * The persistent cache is consulted BEFORE a network slot is taken, so a
 * warm tile never waits behind Overpass / DEM / OIWMS downloads. Bing via
 * Cesium and Google 3D Tiles are rejected by isForbiddenToDiskCache and
 * are never written to disk.
 *
 * Terrain / HUD work should import these wrappers (cachedOverpass,
 * cachedDem, cachedOiwms) rather than calling fetch() directly.
 */
import {
  cacheGet,
  cachePut,
  fromB64,
  isForbiddenToDiskCache,
  makeCacheKey,
  toB64,
  type MapCacheKind,
} from './MapCache';

export {
  isForbiddenToDiskCache,
  makeCacheKey,
  CACHE_PREFIX,
  CACHE_VERSION,
  installCacheForTests,
  createMemoryCache,
  cacheGet,
  cachePut,
  cacheStats,
  clearMapCache,
} from './MapCache';

export const OVERPASS_ENDPOINTS = [
  'http://127.0.0.1:12346/api/interpreter',
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
] as const;

const MAX_SLOTS = 4;

type SlotWaiter = { priority: boolean; resolve: () => void };
const waiters: SlotWaiter[] = [];
let inFlight = 0;
let slotAcquires = 0;

export function mapSlotStats(): { inFlight: number; waiting: number; acquires: number } {
  return { inFlight, waiting: waiters.length, acquires: slotAcquires };
}

export function resetMapSlotsForTests(): void {
  waiters.length = 0;
  inFlight = 0;
  slotAcquires = 0;
}

export async function acquireNetworkSlot(priority = false): Promise<void> {
  if (inFlight < MAX_SLOTS) {
    inFlight++;
    slotAcquires++;
    return;
  }
  await new Promise<void>((resolve) => {
    if (priority) waiters.unshift({ priority, resolve });
    else waiters.push({ priority, resolve });
  });
}

function releaseNetworkSlot(): void {
  const next = waiters.shift();
  if (next) {
    slotAcquires++;
    next.resolve();
  } else {
    inFlight = Math.max(0, inFlight - 1);
  }
}

type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

let fetchImpl: FetchFn | null = null;

export function setMapFetchForTests(fn: FetchFn | null): void {
  fetchImpl = fn;
}

function rawFetch(input: string, init?: RequestInit): Promise<Response> {
  const fn = fetchImpl ?? fetch;
  return fn(input, init);
}

type BlobRecord = { fmt: 'b64'; type: string; b64: string };
type JsonRecord = { fmt: 'json'; json: unknown };

function isBlobRecord(v: unknown): v is BlobRecord {
  return !!v && typeof v === 'object' && (v as BlobRecord).fmt === 'b64' && typeof (v as BlobRecord).b64 === 'string';
}
function isJsonRecord(v: unknown): v is JsonRecord {
  return !!v && typeof v === 'object' && (v as JsonRecord).fmt === 'json' && 'json' in (v as JsonRecord);
}

export type CachedFetchInit = RequestInit & {
  kind: MapCacheKind;
  /** Jump the slot queue (tile under the train). */
  priority?: boolean;
};

/**
 * Cacheable GET/POST for OSM / DEM / OIWMS.
 * Forbidden URLs skip the disk cache entirely (HTTP cache only).
 */
export async function cachedFetch(url: string, init: CachedFetchInit): Promise<Response> {
  const { kind, priority, ...req } = init;
  if (isForbiddenToDiskCache(url)) {
    return rawFetch(url, req);
  }
  const rawKey = `${(req.method ?? 'GET').toUpperCase()} ${url} ${typeof req.body === 'string' ? req.body : ''}`;
  const key = await makeCacheKey(kind, rawKey);

  const hit = await cacheGet<unknown>(key);
  if (hit) {
    const res = responseFromRecord(hit.data);
    if (res) return res;
  }

  await acquireNetworkSlot(!!priority);
  try {
    const again = await cacheGet<unknown>(key);
    if (again) {
      const res = responseFromRecord(again.data);
      if (res) return res;
    }
    const res = await rawFetch(url, req);
    if (res.ok) {
      const clone = res.clone();
      const type = clone.headers.get('content-type') || 'application/octet-stream';
      try {
        if (kind === 'overpass' || type.includes('json')) {
          const json = await clone.json();
          const rec: JsonRecord = { fmt: 'json', json };
          await cachePut(key, rec);
          return new Response(JSON.stringify(json), {
            status: 200,
            headers: { 'content-type': type.includes('json') ? type : 'application/json' },
          });
        }
        const buf = new Uint8Array(await clone.arrayBuffer());
        const rec: BlobRecord = { fmt: 'b64', type, b64: toB64(buf) };
        await cachePut(key, rec, rec.b64.length);
        return new Response(buf, { status: 200, headers: { 'content-type': type } });
      } catch {
        return res;
      }
    }
    return res;
  } finally {
    releaseNetworkSlot();
  }
}

function responseFromRecord(data: unknown): Response | null {
  if (isJsonRecord(data)) {
    return new Response(JSON.stringify(data.json), {
      status: 200,
      headers: { 'content-type': 'application/json', 'x-ion-map-cache': 'hit' },
    });
  }
  if (isBlobRecord(data)) {
    return new Response(fromB64(data.b64), {
      status: 200,
      headers: { 'content-type': data.type || 'application/octet-stream', 'x-ion-map-cache': 'hit' },
    });
  }
  return null;
}

export async function cachedOverpass(query: string, endpoints: readonly string[] = OVERPASS_ENDPOINTS, signal?: AbortSignal): Promise<unknown> {
  let lastErr: unknown = new Error('Overpass: no endpoint tried');
  for (const url of endpoints) {
    if (isForbiddenToDiskCache(url)) continue;
    try {
      const res = await cachedFetch(url, {
        kind: 'overpass',
        method: 'POST',
        body: query,
        signal,
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
      });
      if (!res.ok) {
        lastErr = new Error(`Overpass ${res.status}`);
        continue;
      }
      return await res.json();
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

export async function cachedDem(url: string, signal?: AbortSignal): Promise<Blob> {
  if (isForbiddenToDiskCache(url)) {
    const res = await rawFetch(url, { signal });
    if (!res.ok) throw new Error(`DEM ${res.status}`);
    return res.blob();
  }
  const res = await cachedFetch(url, { kind: 'dem', signal });
  if (!res.ok) throw new Error(`DEM ${res.status}`);
  return res.blob();
}

export async function cachedOiwms(url: string, signal?: AbortSignal): Promise<Blob> {
  if (isForbiddenToDiskCache(url)) {
    throw new Error('Refusing to disk-cache a forbidden imagery URL');
  }
  const res = await cachedFetch(url, { kind: 'oiwms', signal });
  if (!res.ok) throw new Error(`OIWMS ${res.status}`);
  return res.blob();
}
