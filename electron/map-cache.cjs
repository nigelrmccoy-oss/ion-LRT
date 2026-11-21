/**
 * Electron disk cache for map assets (OSM / DEM / OIWMS).
 * 16 GB cap, LRU by last-access time; the newest put is never evicted.
 * Version-prefixed keys (vNNN:kind:…) so a format change does not wipe the folder.
 *
 * Shape matches nig-drives/electron/map-cache.cjs (read-only reference).
 */
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');

const DEFAULT_CAP = 16 * 1024 ** 3;
const TRIM = 0.95;
const KEY_RE = /^(v\d{2,4}:(overpass|dem|oiwms):|dem:|oiwms:|overpass:)/;

exports.CACHE_CAP_BYTES = DEFAULT_CAP;

exports.installMapCache = (ipc, dir, owner, opts) => {
  const CAP = (opts && opts.capBytes) || DEFAULT_CAP;
  const filename = (key) => {
    if (typeof key !== 'string' || key.length > 2048 || !KEY_RE.test(key)) throw new Error('Invalid map key');
    return path.join(dir, createHash('sha256').update(key).digest('hex') + '.json');
  };
  const indexPath = path.join(dir, 'index.json');
  let index = new Map();
  let indexDirty = false;
  let indexSaveAt = 0;
  let serial = Promise.resolve();
  const handle = (op, fn) => ipc.handle('map-cache:' + op, (event, value) => {
    if (owner) {
      const web = typeof owner === 'function' ? owner() : owner;
      if (event.sender !== web || event.senderFrame !== event.sender.mainFrame) {
        throw new Error('Untrusted frame');
      }
    }
    const task = serial.then(() => fn(value));
    serial = task.catch(() => {});
    return task;
  });
  const loadIndex = async () => {
    try {
      const data = await fs.readFile(indexPath, 'utf8');
      const obj = JSON.parse(data);
      const m = new Map();
      for (const [k, v] of Object.entries(obj)) m.set(k, v);
      return m;
    } catch (e) {
      if (e.code === 'ENOENT') return new Map();
      throw e;
    }
  };
  const saveIndex = async () => {
    if (!indexDirty) return;
    indexDirty = false;
    const tmp = indexPath + '.tmp';
    await fs.writeFile(tmp, JSON.stringify(Object.fromEntries(index)));
    await fs.rename(tmp, indexPath);
  };
  const files = async () => (await fs.readdir(dir).catch((e) => {
    if (e.code === 'ENOENT') return [];
    throw e;
  })).filter((n) => /^[a-f0-9]{64}\.json$/.test(n));
  const rebuildIndex = async () => {
    const m = new Map();
    let total = 0;
    for (const n of await files()) {
      const p = path.join(dir, n);
      const st = await fs.stat(p);
      m.set(n, { size: st.size, at: st.mtimeMs });
      total += st.size;
    }
    index = m;
    return total;
  };
  const ensureIndex = async () => {
    if (index.size === 0) return rebuildIndex();
    return Array.from(index.values()).reduce((s, v) => s + v.size, 0);
  };
  const updateLru = async (name, size) => {
    const now = Date.now();
    index.set(name, { size, at: now });
    indexDirty = true;
    if (now >= indexSaveAt) {
      indexSaveAt = now + 30000;
      await saveIndex();
    }
  };
  const evictLru = async (total, protectName) => {
    const toDelete = [];
    for (const [name, v] of index) {
      if (name !== 'index.json') toDelete.push({ name, at: v.at });
    }
    toDelete.sort((a, b) => a.at - b.at);
    for (const { name } of toDelete) {
      if (name === protectName) continue; // never evict the newest
      const v = index.get(name);
      if (!v) continue;
      await fs.unlink(path.join(dir, name)).catch(() => {});
      index.delete(name);
      total -= v.size;
      if (total <= CAP * TRIM) break;
    }
    indexDirty = true;
  };
  handle('get', async (key) => {
    const name = filename(key);
    try {
      const data = await fs.readFile(name, 'utf8');
      const base = path.basename(name);
      const v = index.get(base);
      if (v) {
        const now = Date.now();
        index.set(base, { ...v, at: now });
        indexDirty = true;
        if (now >= indexSaveAt) {
          indexSaveAt = now + 30000;
          await saveIndex();
        }
      }
      return JSON.parse(data);
    } catch (e) {
      if (e.code === 'ENOENT') return null;
      throw e;
    }
  });
  handle('put', async (row) => {
    if (!row || typeof row.key !== 'string' || !Number.isFinite(row.t) || row.data === undefined) {
      throw new Error('Invalid map row');
    }
    const name = filename(row.key);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(name + '.tmp', JSON.stringify(row));
    await fs.rename(name + '.tmp', name);
    const st = await fs.stat(name);
    const base = path.basename(name);
    await updateLru(base, st.size);
    let total = await ensureIndex();
    // ensureIndex already includes this file if it was known; still cap-check
    if (total > CAP) await evictLru(total, base);
    await saveIndex();
  });
  handle('stats', async () => {
    const total = await ensureIndex();
    return { count: index.size, bytes: total };
  });
  handle('clear', async () => {
    for (const n of await files()) await fs.unlink(path.join(dir, n));
    index.clear();
    indexDirty = true;
    await saveIndex();
  });
  serial = serial.then(() => loadIndex().then((m) => { index = m; })).catch(() => {});
  return { evictLru, filename, CAP };
};
