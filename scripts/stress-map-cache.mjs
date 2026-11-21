/**
 * Persistent map-cache tests: LRU at the cap, versioned keys,
 * cache-hit before a network slot, and Bing/Google disk-cache exclusion.
 */
import * as esbuild from 'esbuild';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const require = createRequire(import.meta.url);

async function bundleEntry(entry, name) {
  const dir = await mkdtemp(path.join(tmpdir(), `ion-lrt-${name}-`));
  const outfile = path.join(dir, `${name}.mjs`);
  await esbuild.build({
    entryPoints: [entry],
    outfile,
    format: 'esm',
    platform: 'node',
    bundle: true,
    logLevel: 'silent',
  });
  const mod = await import(pathToFileURL(outfile).href + `?t=${Date.now()}`);
  return { mod, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

function mockIpc() {
  const handlers = new Map();
  const sender = { mainFrame: {} };
  const event = { sender, senderFrame: sender.mainFrame };
  return {
    handle(name, fn) { handlers.set(name, fn); },
    invoke(name, value) {
      const fn = handlers.get(name);
      if (!fn) throw new Error('no handler ' + name);
      return fn(event, value);
    },
    owner: () => sender,
  };
}

export async function mapCacheTests(assert) {
  const { mod, cleanup } = await bundleEntry(path.join(root, 'src/game/map/mapFetch.ts'), 'MapFetch');
  const preloadBundle = await bundleEntry(path.join(root, 'src/game/map/mapPreload.ts'), 'MapPreload');
  const uiBundle = await bundleEntry(path.join(root, 'src/game/map/mapCacheUi.ts'), 'MapCacheUi');
  const {
    installCacheForTests,
    createMemoryCache,
    cacheGet,
    cachePut,
    cacheStats,
    clearMapCache,
    makeCacheKey,
    CACHE_PREFIX,
    CACHE_VERSION,
    isForbiddenToDiskCache,
  } = mod;
  const {
    cachedFetch,
    cachedDem,
    cachedOiwms,
    setMapFetchForTests,
    resetMapSlotsForTests,
    mapSlotStats,
  } = mod;
  const { planPreload, tilesAround, lonLatToTile, TERRARIUM_URL, OIWMS_TILE_URL } = preloadBundle.mod;
  const { formatCacheStatsLine } = uiBundle.mod;

  try {
    // ----- LRU eviction at a small cap; newest is never trimmed -----
    {
      const mem = createMemoryCache(2500);
      installCacheForTests(mem);
      await cachePut('v100:dem:a', { fmt: 'json', json: 'A'.repeat(400) }, 900);
      await delay(5);
      await cachePut('v100:dem:b', { fmt: 'json', json: 'B'.repeat(400) }, 900);
      await delay(5);
      await cachePut('v100:dem:c', { fmt: 'json', json: 'C'.repeat(400) }, 900);
      const keys = mem.keys().sort();
      assert('cache. LRU evicts the least-recently-used key at the cap', !keys.includes('v100:dem:a') && keys.includes('v100:dem:b') && keys.includes('v100:dem:c'), keys.join(','));
      const st = await cacheStats();
      assert('cache. LRU total stays at or under the cap', st.bytes <= 2500, `bytes=${st.bytes}`);
      assert('cache. newest key survived eviction', !!mem.row('v100:dem:c'));
    }

    {
      const mem = createMemoryCache(2500);
      installCacheForTests(mem);
      await cachePut('v100:dem:a', { n: 1 }, 900);
      await delay(5);
      await cachePut('v100:dem:b', { n: 2 }, 900);
      await delay(5);
      await cacheGet('v100:dem:a'); // A is now more recently used than B
      await delay(5);
      await cachePut('v100:dem:c', { n: 3 }, 900);
      const keys = mem.keys().sort();
      assert('cache. LRU uses access time, not insert time', keys.includes('v100:dem:a') && !keys.includes('v100:dem:b') && keys.includes('v100:dem:c'), keys.join(','));
    }

    {
      const mem = createMemoryCache(1000);
      installCacheForTests(mem);
      await cachePut('v100:dem:old', { n: 1 }, 400);
      await delay(5);
      await cachePut('v100:dem:huge', { n: 2 }, 1500); // over the cap by itself
      assert('cache. never evicts the newest even if it alone exceeds the cap', mem.keys().includes('v100:dem:huge') && !mem.keys().includes('v100:dem:old'), mem.keys().join(','));
    }

    // ----- Versioned keys: a format bump does not wipe the store -----
    {
      const mem = createMemoryCache(16 * 1024);
      installCacheForTests(mem);
      await cachePut('v099:dem:same', { old: true }, 100);
      const cur = await makeCacheKey('dem', 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/12/1/2.png');
      await cachePut(cur, { new: true }, 100);
      assert('cache. current keys use the v100 prefix', cur.startsWith('v100:dem:'), cur);
      assert('cache. CACHE_VERSION is v100', CACHE_VERSION === 'v100' && CACHE_PREFIX === 'v100:');
      const keys = mem.keys().sort();
      assert('cache. old versioned keys remain after a prefix bump', keys.includes('v099:dem:same') && keys.includes(cur), keys.join(','));
      const oldHit = await cacheGet('v099:dem:same');
      const newHit = await cacheGet(cur);
      assert('cache. both versions are readable until LRU ages the old one out', !!oldHit && oldHit.data.old === true && !!newHit && newHit.data.new === true);
      await clearMapCache();
      assert('cache. clear empties every version', mem.keys().length === 0);
    }

    // ----- Cache hit is served BEFORE a network slot is taken -----
    {
      const mem = createMemoryCache(1_000_000);
      installCacheForTests(mem);
      resetMapSlotsForTests();
      let fetches = 0;
      setMapFetchForTests(async (url) => {
        fetches++;
        return new Response(new Uint8Array([137, 80, 78, 71]), {
          status: 200,
          headers: { 'content-type': 'image/png' },
        });
      });
      const url = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/14/4589/5999.png';
      const a = await cachedDem(url);
      const midFetch = fetches;
      const midSlots = mapSlotStats().acquires;
      const b = await cachedDem(url);
      assert('cache. miss hits the network once', midFetch === 1 && a.size >= 4, `fetches=${midFetch} size=${a.size}`);
      assert('cache. miss takes a network slot', midSlots === 1, `acquires=${midSlots}`);
      assert('cache. hit does not call fetch again', fetches === 1, `fetches=${fetches}`);
      assert('cache. hit is served before a network slot', mapSlotStats().acquires === midSlots, `acquires=${mapSlotStats().acquires}`);
      assert('cache. hit still returns the tile', b.size === a.size);
      setMapFetchForTests(null);
      resetMapSlotsForTests();
    }

    // A second overlapping request should also skip the slot once cached
    {
      const mem = createMemoryCache(1_000_000);
      installCacheForTests(mem);
      resetMapSlotsForTests();
      let fetches = 0;
      setMapFetchForTests(async () => {
        fetches++;
        return new Response(JSON.stringify({ elements: [1] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      });
      const url = 'https://overpass-api.de/api/interpreter';
      await cachedFetch(url, { kind: 'overpass', method: 'POST', body: '[out:json];out;' });
      const before = mapSlotStats().acquires;
      await cachedFetch(url, { kind: 'overpass', method: 'POST', body: '[out:json];out;' });
      assert('cache. Overpass cache hit skips fetch and slot', fetches === 1 && mapSlotStats().acquires === before);
      setMapFetchForTests(null);
    }

    // ----- Bing / Google / Cesium imagery must never be disk-cached -----
    {
      const forbidden = [
        'https://dev.virtualearth.net/REST/v1/Imagery/Map/Aerial/43.45,-80.5/14',
        'https://t0.tiles.virtualearth.net/tiles/a0231.jpeg?g=1',
        'https://ecn.t1.tiles.virtualearth.net/tiles/a0231.jpeg',
        'https://www.bing.com/maps?q=kitchener',
        'https://api.cesium.com/v1/assets/2/endpoint?access_token=secret',
        'https://api.cesium.com/v1/assets/2/tiles/16/1/2?access_token=secret',
        'https://api.cesium.com/v1/assets/2275207/endpoint?access_token=secret',
        'https://tile.googleapis.com/v1/3dtiles/root.json?key=x',
        'https://tile.googleapis.com/v1/3dtiles/datasets/CesiumGooglePhotorealistic3DTiles/tiles/1',
        'https://maps.googleapis.com/maps/api/streetview?location=43,-80',
      ];
      const allowed = [
        'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/14/4589/5999.png',
        'https://ws.lioservices.lrc.gov.on.ca/arcgis2/rest/services/LIO_Imagery/Ontario_Imagery_Web_Map_Service/MapServer/tile/16/23456/12345',
        'https://overpass-api.de/api/interpreter',
        'http://127.0.0.1:12346/api/interpreter',
        'https://overpass.kumi.systems/api/interpreter',
        'https://canelevation-dem.s3.ca-central-1.amazonaws.com/hrdem-mosaic-1m/8_2-mosaic-1m-dtm.tif',
      ];
      const bad = forbidden.filter((u) => !isForbiddenToDiskCache(u));
      const good = allowed.filter((u) => isForbiddenToDiskCache(u));
      assert('cache. Bing, Cesium World Imagery and Google 3D Tiles are excluded', bad.length === 0, bad.join(' | '));
      assert('cache. OSM, Terrarium, HRDEM and OIWMS are cacheable', good.length === 0, good.join(' | '));

      const mem = createMemoryCache(1_000_000);
      installCacheForTests(mem);
      resetMapSlotsForTests();
      let fetches = 0;
      setMapFetchForTests(async (url) => {
        fetches++;
        return new Response(new Uint8Array([1, 2, 3, 4]), { status: 200, headers: { 'content-type': 'image/jpeg' } });
      });
      const bing = 'https://t0.tiles.virtualearth.net/tiles/a0231.jpeg?g=1';
      const res = await cachedFetch(bing, { kind: 'oiwms' });
      assert('cache. forbidden URLs still fetch over the network (HTTP cache only)', res.ok && fetches === 1);
      assert('cache. forbidden URLs are not written to the disk cache', mem.keys().length === 0, mem.keys().join(','));
      try {
        await cachedOiwms(bing);
        assert('cache. cachedOiwms refuses a Bing URL', false);
      } catch (err) {
        assert('cache. cachedOiwms refuses a Bing URL', /refus|forbid/i.test(String(err)) && mem.keys().length === 0);
      }
      setMapFetchForTests(null);
    }

    // ----- Preload planner stays on cacheable sources -----
    {
      const plan = planPreload({
        lon: -80.522, lat: 43.497, // near Conestoga / OMSF
        ahead: [{ lon: -80.50, lat: 43.45 }, { lon: -80.48, lat: 43.43 }],
        fetch: false,
      });
      const all = [...plan.dem, ...plan.oiwms];
      assert('cache. preload plans Terrarium and OIWMS tiles', plan.dem.length > 0 && plan.oiwms.length > 0 && plan.overpassQueries.length > 0,
        `dem=${plan.dem.length} oiwms=${plan.oiwms.length} osm=${plan.overpassQueries.length}`);
      assert('cache. preload DEM URLs use the Terrarium template', plan.dem.every((u) => u.startsWith(TERRARIUM_URL.split('{z}')[0])));
      assert('cache. preload imagery URLs use OIWMS, not Bing', plan.oiwms.every((u) => u.startsWith(OIWMS_TILE_URL.split('{z}')[0])));
      assert('cache. preload plan contains no forbidden URLs', all.every((u) => !isForbiddenToDiskCache(u)));
      const origin = lonLatToTile(-80.5, 43.45, 14);
      const nearby = tilesAround(-80.5, 43.45, 14, 1200);
      assert('cache. tilesAround includes the tile under the train', nearby.some((t) => t.x === origin.x && t.y === origin.y && t.z === 14));
    }

    {
      const line = formatCacheStatsLine({ count: 12, bytes: 2 * 1048576, notice: '', persisted: true });
      assert('cache. Options line reports size and persistence', /12 tiles/.test(line) && /2\.0 MiB/.test(line) && /16 GB/.test(line) && /persistent/.test(line), line);
    }

    // ----- Electron disk folder: same LRU + versioned-key rules -----
    {
      const dir = await mkdtemp(path.join(tmpdir(), 'ion-lrt-electron-cache-'));
      try {
        const { installMapCache } = require(path.join(root, 'electron/map-cache.cjs'));
        const ipc = mockIpc();
        installMapCache(ipc, dir, ipc.owner, { capBytes: 3000 });
        const put = (key, payload) => ipc.invoke('map-cache:put', { key, t: Date.now(), data: payload });
        const get = (key) => ipc.invoke('map-cache:get', key);
        await put('v100:dem:a', { blob: 'A'.repeat(1200) });
        await delay(15);
        await put('v100:dem:b', { blob: 'B'.repeat(1200) });
        await delay(15);
        await put('v100:dem:c', { blob: 'C'.repeat(1200) });
        const a = await get('v100:dem:a');
        const b = await get('v100:dem:b');
        const c = await get('v100:dem:c');
        assert('electron cache. LRU evicts the oldest file at the cap', a === null && b && c && c.data.blob.startsWith('C'), `a=${a && 'hit'} b=${b && 'hit'} c=${c && 'hit'}`);
        await put('v099:dem:legacy', { old: 1 });
        const legacy = await get('v099:dem:legacy');
        const stillC = await get('v100:dem:c');
        assert('electron cache. version prefix is accepted; old keys do not wipe new ones', !!legacy && !!stillC);

        let threw = false;
        try { await put('https://t0.tiles.virtualearth.net/tiles/a.jpeg', { n: 1 }); } catch { threw = true; }
        assert('electron cache. rejects an unprefixed (e.g. Bing) key', threw);

        const st = await ipc.invoke('map-cache:stats');
        assert('electron cache. stats reports count and bytes', st.count >= 1 && st.bytes > 0, JSON.stringify(st));
        await ipc.invoke('map-cache:clear');
        const cleared = await ipc.invoke('map-cache:stats');
        assert('electron cache. clear empties the folder', cleared.count === 0 && cleared.bytes === 0, JSON.stringify(cleared));
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    }
  } finally {
    installCacheForTests(null);
    setMapFetchForTests(null);
    resetMapSlotsForTests();
    await cleanup();
    await preloadBundle.cleanup();
    await uiBundle.cleanup();
  }
}
