import { SPEED_LIMITS_KMH } from './Physics';

export type RowClass = 'reserved' | 'street' | 'station';

export type RowSample = {
  s: number;
  row: RowClass;
  limit_kmh: number;
  arterial_name?: string;
  reason?: string;
};

type RowFile = {
  samples: RowSample[];
  km?: { reserved: number; street: number; station: number };
  limits_kmh?: { reserved: number; street: number; station: number };
};

/**
 * OSM-derived ION right-of-way lookup. Curvature heuristic is fallback only.
 */
export class RowClassifier {
  samples: RowSample[] = [];
  loaded = false;

  async load(url = './data/row-segments.json') {
    try {
      const data = (await (await fetch(url)).json()) as RowFile;
      this.samples = (data.samples || []).slice().sort((a, b) => a.s - b.s);
      this.loaded = this.samples.length > 0;
    } catch {
      this.samples = [];
      this.loaded = false;
    }
  }

  /** Pure helper — usable from tests without fetching. */
  static classifyAt(
    samples: RowSample[],
    s: number,
    nearStation: boolean,
    curvatureFallback: number,
  ): { row: RowClass; limitKmh: number } {
    if (nearStation) return { row: 'station', limitKmh: SPEED_LIMITS_KMH.station };
    if (!samples.length) {
      // curvature heuristic fallback (legacy)
      if (Math.abs(curvatureFallback) > 0.004) return { row: 'street', limitKmh: SPEED_LIMITS_KMH.street };
      return { row: 'reserved', limitKmh: SPEED_LIMITS_KMH.reserved };
    }
    // binary search nearest sample
    let lo = 0,
      hi = samples.length - 1;
    while (lo + 1 < hi) {
      const m = (lo + hi) >> 1;
      if (samples[m].s < s) lo = m;
      else hi = m;
    }
    const a = samples[lo],
      b = samples[hi];
    const pick = Math.abs(s - a.s) <= Math.abs(s - b.s) ? a : b;
    const row = pick.row;
    if (row === 'station') return { row, limitKmh: SPEED_LIMITS_KMH.station };
    if (row === 'street') return { row, limitKmh: SPEED_LIMITS_KMH.street };
    return { row: 'reserved', limitKmh: SPEED_LIMITS_KMH.reserved };
  }

  at(s: number, nearStation: boolean, curvature = 0) {
    return RowClassifier.classifyAt(this.samples, s, nearStation, curvature);
  }

  /** Whether s is in a street-running band (ignores station override for visuals). */
  isStreetBand(s: number): boolean {
    if (!this.samples.length) return false;
    let lo = 0,
      hi = this.samples.length - 1;
    while (lo + 1 < hi) {
      const m = (lo + hi) >> 1;
      if (this.samples[m].s < s) lo = m;
      else hi = m;
    }
    const a = this.samples[lo],
      b = this.samples[hi];
    const pick = Math.abs(s - a.s) <= Math.abs(s - b.s) ? a : b;
    return pick.row === 'street' || (pick.row === 'station' && (a.row === 'street' || b.row === 'street'));
  }
}

/** Exported for unit tests — mirrors bake classifier street-name rule. */
export function isStreetRunningArterialName(name: string | undefined | null): boolean {
  if (!name) return false;
  if (/Charles Street/i.test(name)) return true;
  if (/Caroline Street/i.test(name)) return true;
  if (/King Street (South|West)\b/i.test(name)) return true;
  return false;
}

export function classifyIonRowSample(opts: {
  s: number;
  arterialDistM: number;
  arterialName: string;
  nearStation: boolean;
}): { row: RowClass; limit_kmh: number } {
  if (opts.nearStation) return { row: 'station', limit_kmh: SPEED_LIMITS_KMH.station };
  if (opts.arterialDistM <= 12 && isStreetRunningArterialName(opts.arterialName)) {
    return { row: 'street', limit_kmh: SPEED_LIMITS_KMH.street };
  }
  if (
    opts.arterialDistM <= 10 &&
    /King Street/i.test(opts.arterialName || '') &&
    opts.s >= 6500 &&
    opts.s <= 8800
  ) {
    return { row: 'street', limit_kmh: SPEED_LIMITS_KMH.street };
  }
  return { row: 'reserved', limit_kmh: SPEED_LIMITS_KMH.reserved };
}
