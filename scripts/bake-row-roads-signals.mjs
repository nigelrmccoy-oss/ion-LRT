/**
 * Bake OSM roads, traffic signals, rail crossings, and ION ROW classification.
 * Source: Overpass only (no Street View / proprietary tiles).
 *
 * Usage:
 *   OVERPASS_JSON=/tmp/overpass-raw.json node scripts/bake-row-roads-signals.mjs
 *   node scripts/bake-row-roads-signals.mjs   # fetches Overpass
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const outDir = path.join(root, 'public/data');

const ORIGIN_LAT = 43.45;
const ORIGIN_LON = -80.5;
const R = 6378137;
const BBOX = { s: 43.38, w: -80.6, n: 43.53, e: -80.38 };

function toLocal(lon, lat) {
  const x = ((lon - ORIGIN_LON) * Math.PI) / 180 * R * Math.cos((ORIGIN_LAT * Math.PI) / 180);
  const z = -((lat - ORIGIN_LAT) * Math.PI) / 180 * R;
  return [x, z];
}
function hav(a, b) {
  const toR = (d) => (d * Math.PI) / 180;
  const dlat = toR(b[1] - a[1]);
  const dlon = toR(b[0] - a[0]);
  const s =
    Math.sin(dlat / 2) ** 2 +
    Math.cos(toR(a[1])) * Math.cos(toR(b[1])) * Math.sin(dlon / 2) ** 2;
  return 2 * 6371000 * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s));
}
function distPointSegLocal(px, pz, ax, az, bx, bz) {
  const dx = bx - ax,
    dz = bz - az;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / (dx * dx + dz * dz + 1e-9)));
  return Math.hypot(px - (ax + t * dx), pz - (az + t * dz));
}

const QUERY = `
[out:json][timeout:120];
(
  way["highway"~"^(primary|secondary|tertiary|residential|trunk|unclassified)$"](${BBOX.s},${BBOX.w},${BBOX.n},${BBOX.e});
  node["highway"="traffic_signals"](${BBOX.s},${BBOX.w},${BBOX.n},${BBOX.e});
  node["crossing"="traffic_signals"](${BBOX.s},${BBOX.w},${BBOX.n},${BBOX.e});
  node["railway"="crossing"](${BBOX.s},${BBOX.w},${BBOX.n},${BBOX.e});
  node["railway"="level_crossing"](${BBOX.s},${BBOX.w},${BBOX.n},${BBOX.e});
  way["railway"="light_rail"](${BBOX.s},${BBOX.w},${BBOX.n},${BBOX.e});
  way["railway"="rail"](${BBOX.s},${BBOX.w},${BBOX.n},${BBOX.e});
);
out body geom;
`;

async function fetchOverpass() {
  const urls = [
    'https://overpass-api.de/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter',
  ];
  for (let attempt = 0; attempt < 4; attempt++) {
    const url = urls[attempt % urls.length];
    try {
      console.log(`Overpass attempt ${attempt + 1}: ${url}`);
      const res = await fetch(url, {
        method: 'POST',
        body: QUERY,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      if (!json.elements?.length) throw new Error('empty elements');
      return json;
    } catch (err) {
      console.warn('  failed:', err.message);
      await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
    }
  }
  throw new Error('Overpass failed after retries');
}

function loadTracks() {
  const files = {
    ion: 'ion-track.geojson',
    spur: 'waterloo-spur.geojson',
    guelph: 'guelph-sub.geojson',
  };
  const tracks = {};
  for (const [key, file] of Object.entries(files)) {
    const gj = JSON.parse(fs.readFileSync(path.join(outDir, file), 'utf8'));
    const coords = gj.features[0].geometry.coordinates;
    const pts = [];
    let s = 0;
    for (let i = 0; i < coords.length; i++) {
      const [lon, lat] = coords[i];
      const [x, z] = toLocal(lon, lat);
      if (i > 0) s += hav(coords[i - 1], coords[i]);
      pts.push({ lon, lat, x, z, s });
    }
    tracks[key] = { pts, length: s };
  }
  return tracks;
}

function minDistToTrack(lon, lat, trackPts) {
  const [x, z] = toLocal(lon, lat);
  let best = 1e12;
  // stride for speed
  const stride = Math.max(1, Math.floor(trackPts.length / 800));
  for (let i = 0; i < trackPts.length - 1; i += stride) {
    const a = trackPts[i];
    const b = trackPts[Math.min(trackPts.length - 1, i + stride)];
    const d = distPointSegLocal(x, z, a.x, a.z, b.x, b.z);
    if (d < best) best = d;
  }
  return best;
}

function nearestOnTrack(lon, lat, trackPts) {
  const [x, z] = toLocal(lon, lat);
  let best = 1e12,
    bestS = 0,
    bestI = 0;
  for (let i = 0; i < trackPts.length - 1; i++) {
    const a = trackPts[i],
      b = trackPts[i + 1];
    const d = distPointSegLocal(x, z, a.x, a.z, b.x, b.z);
    if (d < best) {
      best = d;
      const dx = b.x - a.x,
        dz = b.z - a.z;
      const t = Math.max(0, Math.min(1, ((x - a.x) * dx + (z - a.z) * dz) / (dx * dx + dz * dz + 1e-9)));
      bestS = a.s + t * (b.s - a.s);
      bestI = i;
    }
  }
  return { dist: best, s: bestS, i: bestI };
}

/** OSM-derived street-running names verified for KW ION mixed sections. */
function isStreetRunningName(name) {
  if (!name) return false;
  if (/Charles Street/i.test(name)) return true;
  if (/Caroline Street/i.test(name)) return true;
  if (/King Street (South|West)\b/i.test(name)) return true;
  return false;
}

function classifyIonSample(s, distArterial, arterialName, nearStation) {
  if (nearStation) return { row: 'station', limit_kmh: 25, reason: 'near_station' };
  if (distArterial <= 12 && isStreetRunningName(arterialName)) {
    return { row: 'street', limit_kmh: 40, reason: `osm_near_${arterialName}` };
  }
  // King Street North only in uptown band (not Conestoga parallel reserved)
  if (
    distArterial <= 10 &&
    /King Street/i.test(arterialName || '') &&
    s >= 6500 &&
    s <= 8800
  ) {
    return { row: 'street', limit_kmh: 40, reason: `osm_near_${arterialName}` };
  }
  return { row: 'reserved', limit_kmh: 70, reason: distArterial < 20 ? `parallel_${arterialName || 'road'}` : 'dedicated_corridor' };
}

async function main() {
  let raw;
  if (process.env.OVERPASS_JSON && fs.existsSync(process.env.OVERPASS_JSON)) {
    raw = JSON.parse(fs.readFileSync(process.env.OVERPASS_JSON, 'utf8'));
    console.log('Loaded', process.env.OVERPASS_JSON, 'elements', raw.elements.length);
  } else {
    raw = await fetchOverpass();
    fs.writeFileSync(path.join(outDir, 'osm-row-raw.json'), JSON.stringify(raw));
    console.log('Fetched elements', raw.elements.length);
  }

  const tracks = loadTracks();
  const allRailPts = [...tracks.ion.pts, ...tracks.spur.pts, ...tracks.guelph.pts];

  // Stations for station class
  const stationsFile = JSON.parse(fs.readFileSync(path.join(outDir, 'stations.json'), 'utf8'));
  const ionStations = [
    ...(stationsFile.routes.ion_southbound?.stations || []),
    ...(stationsFile.routes.ion_northbound?.stations || []),
  ];
  // unique by id for southbound distances
  const stationSs = (stationsFile.routes.ion_southbound?.stations || []).map((st) => st.distance_m);

  // --- Arterial segments for ROW + road thinning ---
  const roadWays = [];
  const arterialSegs = [];
  for (const e of raw.elements) {
    if (e.type !== 'way' || !e.geometry || e.geometry.length < 2 || !e.tags?.highway) continue;
    const h = e.tags.highway;
    if (!['primary', 'secondary', 'tertiary', 'residential', 'trunk', 'unclassified'].includes(h)) continue;
    const coords = e.geometry.map((g) => [g.lon, g.lat]);
    // distance of way midpoint to any rail
    const mid = coords[Math.floor(coords.length / 2)];
    const dRail = Math.min(
      minDistToTrack(mid[0], mid[1], tracks.ion.pts),
      minDistToTrack(mid[0], mid[1], tracks.spur.pts),
      minDistToTrack(mid[0], mid[1], tracks.guelph.pts),
    );
    // keep roads near corridor; drop tiny alleys far away
    const maxDist = h === 'residential' || h === 'unclassified' ? 90 : 160;
    if (dRail > maxDist) continue;

    const local = coords.map(([lon, lat]) => {
      const [x, z] = toLocal(lon, lat);
      return [Math.round(x * 10) / 10, Math.round(z * 10) / 10];
    });
    // thin geometry
    const thinned = [local[0]];
    for (let i = 1; i < local.length; i++) {
      const prev = thinned[thinned.length - 1];
      if (Math.hypot(local[i][0] - prev[0], local[i][1] - prev[1]) >= 12 || i === local.length - 1) {
        thinned.push(local[i]);
      }
    }
    if (thinned.length < 2) continue;
    const width =
      h === 'trunk' || h === 'primary' ? 10 : h === 'secondary' ? 8 : h === 'tertiary' ? 7 : 5.5;
    roadWays.push({
      id: e.id,
      highway: h,
      name: e.tags.name || '',
      width,
      coords: thinned,
      d_rail: Math.round(dRail),
    });

    if (['primary', 'secondary', 'tertiary', 'trunk'].includes(h)) {
      for (let i = 0; i < coords.length - 1; i++) {
        const [ax, az] = toLocal(coords[i][0], coords[i][1]);
        const [bx, bz] = toLocal(coords[i + 1][0], coords[i + 1][1]);
        arterialSegs.push({
          ax,
          az,
          bx,
          bz,
          name: e.tags.name || '',
          highway: h,
        });
      }
    }
  }

  // --- Traffic signals near ION (~40 m) ---
  const signals = [];
  const seenSig = new Set();
  for (const e of raw.elements) {
    if (e.type !== 'node') continue;
    const t = e.tags || {};
    const isSig = t.highway === 'traffic_signals' || t.crossing === 'traffic_signals';
    if (!isSig) continue;
    const { dist, s } = nearestOnTrack(e.lon, e.lat, tracks.ion.pts);
    if (dist > 40) continue;
    const key = `${e.lon.toFixed(5)},${e.lat.toFixed(5)}`;
    if (seenSig.has(key)) continue;
    seenSig.add(key);
    const [x, z] = toLocal(e.lon, e.lat);
    signals.push({
      id: e.id,
      lon: e.lon,
      lat: e.lat,
      x: Math.round(x * 10) / 10,
      z: Math.round(z * 10) / 10,
      s_ion: Math.round(s),
      dist_m: Math.round(dist * 10) / 10,
      kind: t.highway === 'traffic_signals' ? 'traffic_signals' : 'crossing_signals',
      // simple phase offset from position for desync
      phase_offset_s: Math.round((s * 0.37) % 60),
    });
  }
  signals.sort((a, b) => a.s_ion - b.s_ion);

  // --- Rail crossings on all three lines ---
  const crossings = [];
  const seenX = new Set();
  for (const e of raw.elements) {
    if (e.type !== 'node') continue;
    const t = e.tags || {};
    if (t.railway !== 'crossing' && t.railway !== 'level_crossing') continue;
    let bestLine = null,
      bestDist = 1e9,
      bestS = 0;
    for (const [line, tr] of Object.entries(tracks)) {
      const r = nearestOnTrack(e.lon, e.lat, tr.pts);
      if (r.dist < bestDist) {
        bestDist = r.dist;
        bestLine = line;
        bestS = r.s;
      }
    }
    if (bestDist > 35 || !bestLine) continue;
    // Prefer heavy-rail lines for gate visuals; keep ION pedestrian crossings lightly
    const key = `${e.lon.toFixed(5)},${e.lat.toFixed(5)}`;
    if (seenX.has(key)) continue;
    seenX.add(key);
    const [x, z] = toLocal(e.lon, e.lat);
    crossings.push({
      id: e.id,
      lon: e.lon,
      lat: e.lat,
      x: Math.round(x * 10) / 10,
      z: Math.round(z * 10) / 10,
      line: bestLine,
      s: Math.round(bestS),
      dist_m: Math.round(bestDist * 10) / 10,
      kind: t.railway,
      // gates/flashers on heavy rail; ION uses traffic signals for street
      style: bestLine === 'ion' ? 'ion_ped' : 'gates_flashers',
    });
  }

  // --- ION way tag inventory (ROW evidence) ---
  const ionWays = [];
  for (const e of raw.elements) {
    if (e.type !== 'way' || e.tags?.railway !== 'light_rail') continue;
    const mid = e.geometry?.[Math.floor((e.geometry?.length || 0) / 2)];
    const tags = e.tags || {};
    ionWays.push({
      id: e.id,
      tags: {
        railway: tags.railway,
        name: tags.name,
        old_name: tags.old_name,
        embedded: tags.embedded,
        embedded_rails: tags.embedded_rails,
        highway: tags.highway,
        'railway:preferred_direction': tags['railway:preferred_direction'],
        usage: tags.usage,
        service: tags.service,
        electrified: tags.electrified,
        gauge: tags.gauge,
        maxspeed: tags.maxspeed,
        direction: tags.direction,
        'railway:interlaced': tags['railway:interlaced'],
        subdivision: tags.subdivision,
      },
      mid: mid ? { lon: mid.lon, lat: mid.lat } : null,
    });
  }

  // --- Classify ION samples every ~40 m ---
  const samples = [];
  const sampleStep = 40;
  let nextS = 0;
  for (let i = 0; i < tracks.ion.pts.length; i++) {
    const p = tracks.ion.pts[i];
    if (i > 0 && p.s < nextS && i < tracks.ion.pts.length - 1) continue;
    nextS = p.s + sampleStep;

    let bestD = 1e9,
      bestName = '',
      bestH = '';
    for (const seg of arterialSegs) {
      const d = distPointSegLocal(p.x, p.z, seg.ax, seg.az, seg.bx, seg.bz);
      if (d < bestD) {
        bestD = d;
        bestName = seg.name;
        bestH = seg.highway;
      }
    }
    const nearStation = stationSs.some((ss) => Math.abs(ss - p.s) < 55);
    const cls = classifyIonSample(p.s, bestD, bestName, nearStation);
    samples.push({
      s: Math.round(p.s),
      lon: p.lon,
      lat: p.lat,
      x: Math.round(p.x * 10) / 10,
      z: Math.round(p.z * 10) / 10,
      row: cls.row,
      limit_kmh: cls.limit_kmh,
      reason: cls.reason,
      arterial_dist_m: Math.round(bestD * 10) / 10,
      arterial_name: bestName,
      arterial_highway: bestH,
    });
  }

  // Merge contiguous segments for summary
  const segments = [];
  for (const sm of samples) {
    const last = segments[segments.length - 1];
    if (last && last.row === sm.row) {
      last.s1 = sm.s;
      last.samples++;
    } else {
      segments.push({ row: sm.row, s0: sm.s, s1: sm.s, samples: 1 });
    }
  }

  let kmReserved = 0,
    kmStreet = 0,
    kmStation = 0;
  for (let i = 0; i < samples.length - 1; i++) {
    const ds = (samples[i + 1].s - samples[i].s) / 1000;
    if (samples[i].row === 'reserved') kmReserved += ds;
    else if (samples[i].row === 'street') kmStreet += ds;
    else kmStation += ds;
  }

  const roadsGeo = {
    type: 'FeatureCollection',
    properties: {
      source: 'OpenStreetMap Overpass',
      projection: 'local tangent metres baked in coordinates_local',
      origin: { lat: ORIGIN_LAT, lon: ORIGIN_LON },
      note: 'Thinned highway network near ION / Waterloo Spur / Guelph Sub',
    },
    features: roadWays.map((w) => ({
      type: 'Feature',
      properties: {
        id: w.id,
        highway: w.highway,
        name: w.name,
        width: w.width,
        d_rail: w.d_rail,
      },
      geometry: {
        type: 'LineString',
        coordinates: w.coords, // local x,z stored as [x,z]
      },
    })),
  };

  const signalsOut = {
    source: 'OpenStreetMap (highway=traffic_signals / crossing=traffic_signals)',
    filter: 'within ~40 m of ION alignment',
    cycle_s: 30,
    tsp_approach_m: 80,
    tsp_speed_kmh: 25,
    tsp_wait_s: 2.5,
    signals,
  };

  const crossingsOut = {
    source: 'OpenStreetMap (railway=crossing / level_crossing)',
    activate_distance_m: 180,
    crossings,
  };

  const rowOut = {
    source: 'OpenStreetMap — arterial proximity + verified KW street-running names; curvature heuristic is runtime fallback only',
    note: 'OSM has no embedded=/highway= on ION ways in this extract; street vs reserved from distance to King/Charles/Caroline arterials',
    sample_step_m: sampleStep,
    limits_kmh: { reserved: 70, street: 40, station: 25 },
    km: {
      reserved: Math.round(kmReserved * 100) / 100,
      street: Math.round(kmStreet * 100) / 100,
      station: Math.round(kmStation * 100) / 100,
    },
    segments,
    samples,
    ion_way_tags: ionWays,
  };

  fs.writeFileSync(path.join(outDir, 'roads.geojson'), JSON.stringify(roadsGeo));
  fs.writeFileSync(path.join(outDir, 'signals.json'), JSON.stringify(signalsOut));
  fs.writeFileSync(path.join(outDir, 'crossings.json'), JSON.stringify(crossingsOut));
  fs.writeFileSync(path.join(outDir, 'row-segments.json'), JSON.stringify(rowOut));

  console.log({
    roads: roadWays.length,
    signals: signals.length,
    crossings: crossings.length,
    ion_ways: ionWays.length,
    samples: samples.length,
    km: rowOut.km,
    segments: segments.map((s) => `${s.row} ${s.s0}-${s.s1}`),
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
