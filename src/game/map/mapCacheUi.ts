/**
 * Start-menu Options row: cache size + Clear. Asks the browser for persistent
 * storage (IndexedDB that survives reloads / restarts / updates).
 */
import { askPersist, cacheStats, clearMapCache, storagePersisted } from './MapCache';

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(1)} KiB`;
  if (n < 1073741824) return `${(n / 1048576).toFixed(1)} MiB`;
  return `${(n / 1073741824).toFixed(2)} GiB`;
}

export function formatCacheStatsLine(s: {
  count: number;
  bytes: number;
  notice: string;
  persisted: boolean | null;
}): string {
  const persist =
    s.persisted === true
      ? 'persistent'
      : s.persisted === false
        ? 'not persistent (browser may evict)'
        : '16 GB cap, LRU';
  const notice = s.notice ? ` · ${s.notice}` : '';
  return `${s.count} tile${s.count === 1 ? '' : 's'} · ${formatBytes(s.bytes)} of 16 GB · ${persist}${notice}`;
}

export async function refreshMapCacheInfo(el?: HTMLElement | null): Promise<void> {
  const label = el ?? document.getElementById('mapCacheInfo');
  if (!label) return;
  try {
    const s = await cacheStats();
    label.textContent = formatCacheStatsLine(s);
  } catch {
    label.textContent = 'Map storage unavailable';
  }
}

export function bindMapCacheOptions(root: ParentNode = document): void {
  void askPersist().then(() => {
    if (storagePersisted === false) {
      /* first gesture retry below */
    }
    void refreshMapCacheInfo(root.querySelector<HTMLElement>('#mapCacheInfo'));
  });
  if (typeof window !== 'undefined') {
    window.addEventListener(
      'pointerdown',
      () => {
        if (!storagePersisted) void askPersist().then(() => refreshMapCacheInfo(root.querySelector<HTMLElement>('#mapCacheInfo')));
      },
      { once: true },
    );
  }
  const btn = root.querySelector('#clearMapCacheBtn');
  btn?.addEventListener('click', () => {
    if (!confirm('Clear the saved map cache (OSM, elevation, Ontario imagery)? Areas will need downloading again. Bing / Google 3D Tiles are not stored here.')) {
      return;
    }
    void clearMapCache().then(() => refreshMapCacheInfo(root.querySelector<HTMLElement>('#mapCacheInfo')));
  });
}
