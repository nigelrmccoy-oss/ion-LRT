/**
 * Bake the two real ION running lines (southbound + northbound) and the ION platform
 * outlines from OpenStreetMap.
 *
 *  - Tracks: OSM `railway=light_rail` ways (+ the shared `Ion;CN Waterloo Spur` rail ways) in public/data/osm-raw.json. ION ways carry
 *    `direction=north|south` on double-track/couplet sections; untagged ION ways are
 *    shared single track. The SB line is the shortest path Conestoga→Fairway over
 *    {south, untagged}; NB is Fairway→Conestoga over {north, untagged}. Yard and
 *    crossover ways are excluded.
 *  - Platforms: OSM `railway=platform` ways/relations (Overpass). Raw response cached in
 *    scripts/raw/overpass-platforms.json (set REFETCH=1 to query Overpass again).
 *
 * Outputs public/data/ion-sb.geojson, public/data/ion-nb.geojson, public/data/platforms.json
 * Usage: node scripts/bake-ion-tracks.mjs
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const out = path.join(root, 'public/data');
const R = 6378137, OLAT = 43.45, OLON = -80.5;
const toLocal = (lon, lat) => [((lon - OLON) * Math.PI) / 180 * R * Math.cos((OLAT * Math.PI) / 180), -((lat - OLAT) * Math.PI) / 180 * R];

const CONESTOGA = [-80.52917, 43.49806];
const FAIRWAY = [-80.44194, 43.42236];

const osm = JSON.parse(fs.readFileSync(path.join(out, 'osm-raw.json'), 'utf8'));
// ION light-rail ways, plus the shared freight track between Northfield and Uptown
// (OSM: railway=rail, name "Ion;CN Waterloo Spur", direction=south — SB ION runs on it).
const ways = osm.elements.filter((e) => e.type === 'way' && e.geometry && (
  e.tags?.railway === 'light_rail' || (e.tags?.railway === 'rail' && /\bion\b/i.test(e.tags?.name || ''))));

function buildPath(dirTag, from, to) {
  // Cost multipliers instead of hard exclusion: OSM topology has small gaps/ways with a
  // missing direction tag, so the opposite-direction track and crossovers stay usable but
  // are heavily penalised; the shortest path then follows the correct running line.
  const cost = (w) => {
    const t = w.tags;
    if (t.service === 'yard' || t.service === 'siding') return null;
    if (t.service === 'crossover') return 8;
    if (t.direction && t.direction !== dirTag) return 25;
    if (t.direction === dirTag) return 1;
    return /\bion\b/i.test(t.name || '') ? 1.05 : 3; // shared single track / untagged connector
  };
  const pos = new Map();
  const adj = new Map();
  const link = (a, b, k) => {
    const pa = pos.get(a), pb = pos.get(b);
    const d = Math.hypot(pa[0] - pb[0], pa[1] - pb[1]) * k;
    if (!adj.has(a)) adj.set(a, []);
    if (!adj.has(b)) adj.set(b, []);
    adj.get(a).push([b, d]);
    adj.get(b).push([a, d]);
  };
  for (const w of ways) {
    const k = cost(w);
    if (k == null) continue;
    w.nodes.forEach((n, i) => pos.set(n, [...toLocal(w.geometry[i].lon, w.geometry[i].lat), w.geometry[i].lon, w.geometry[i].lat]));
    for (let i = 1; i < w.nodes.length; i++) link(w.nodes[i - 1], w.nodes[i], k);
  }
  // Bridge OSM topology gaps (missing short ways at bridges/crossings, up to ~22 m in the
  // 2026 extract): dead-end nodes link to any node within 25 m (cost ×2)
  const nodes = [...adj.keys()];
  for (const n of nodes) {
    if (adj.get(n).length !== 1) continue;
    const p = pos.get(n);
    for (const m of nodes) {
      if (m === n) continue;
      const q = pos.get(m);
      if (Math.hypot(p[0] - q[0], p[1] - q[1]) < 25) link(n, m, 2);
    }
  }
  const nearest = (ll) => {
    const p = toLocal(...ll);
    let best = null, bd = Infinity;
    for (const [n, q] of pos) {
      if (!adj.has(n)) continue;
      const d = Math.hypot(q[0] - p[0], q[1] - p[1]);
      if (d < bd) { bd = d; best = n; }
    }
    return best;
  };
  const src = nearest(from), dst = nearest(to);
  // Dijkstra (graph is small)
  const dist = new Map([[src, 0]]), prev = new Map(), done = new Set();
  const open = [[0, src]];
  while (open.length) {
    open.sort((a, b) => a[0] - b[0]);
    const [d, u] = open.shift();
    if (done.has(u)) continue;
    done.add(u);
    if (u === dst) break;
    for (const [v, w] of adj.get(u) || []) {
      const nd = d + w;
      if (nd < (dist.get(v) ?? Infinity)) { dist.set(v, nd); prev.set(v, u); open.push([nd, v]); }
    }
  }
  if (!done.has(dst)) throw new Error(`no ${dirTag} path`);
  const seq = [];
  for (let u = dst; u !== undefined; u = prev.get(u)) seq.push(u);
  seq.reverse();
  let pts = seq.map((n) => pos.get(n));
  // Trim terminal hops onto the other track (the nearest node to a terminus may sit on
  // the parallel line): drop end vertices that turn by more than 60°.
  const turn = (a, b, c) => {
    const h1 = Math.atan2(b[0] - a[0], b[1] - a[1]), h2 = Math.atan2(c[0] - b[0], c[1] - b[1]);
    let d = h2 - h1;
    while (d > Math.PI) d -= 2 * Math.PI;
    while (d < -Math.PI) d += 2 * Math.PI;
    return Math.abs(d);
  };
  const lim = (60 * Math.PI) / 180;
  while (pts.length > 3 && turn(pts[pts.length - 3], pts[pts.length - 2], pts[pts.length - 1]) > lim) pts = pts.slice(0, -1);
  while (pts.length > 3 && turn(pts[0], pts[1], pts[2]) > lim) pts = pts.slice(1);
  let length = 0;
  for (let i = 1; i < pts.length; i++) length += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  const coords = pts.map((q) => [+q[2].toFixed(7), +q[3].toFixed(7)]);
  return { coords, length };
}

const sb = buildPath('south', CONESTOGA, FAIRWAY);
const nb = buildPath('north', FAIRWAY, CONESTOGA);
const gj = (name, dir, p) => ({
  type: 'FeatureCollection',
  features: [{
    type: 'Feature',
    properties: {
      name, route: 'ion', direction: dir, gauge_mm: 1435, electrified: '750V DC',
      length_m: Math.round(p.length),
      source: 'OpenStreetMap contributors (ODbL) — railway=light_rail ways, direction-tagged',
    },
    geometry: { type: 'LineString', coordinates: p.coords },
  }],
});
fs.writeFileSync(path.join(out, 'ion-sb.geojson'), JSON.stringify(gj('ION LRT southbound (Conestoga→Fairway)', 'south', sb)));
fs.writeFileSync(path.join(out, 'ion-nb.geojson'), JSON.stringify(gj('ION LRT northbound (Fairway→Conestoga)', 'north', nb)));
console.log(`SB ${sb.coords.length} pts ${sb.length.toFixed(0)} m; NB ${nb.coords.length} pts ${nb.length.toFixed(0)} m`);

// ---- platforms ------------------------------------------------------------------------
const rawFile = path.join(__dirname, 'raw/overpass-platforms.json');
if (process.env.REFETCH === '1' || !fs.existsSync(rawFile)) {
  const q = '[out:json][timeout:60];(way["railway"="platform"](43.40,-80.56,43.51,-80.43);relation["railway"="platform"](43.40,-80.56,43.51,-80.43););out tags geom;';
  const res = await fetch('https://overpass-api.de/api/interpreter', {
    method: 'POST',
    headers: { 'User-Agent': 'ion-LRT-sim-bake (github.com/nigelrmccoy-oss/ion-LRT)', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'data=' + encodeURIComponent(q),
  });
  fs.writeFileSync(rawFile, await res.text());
}
const raw = JSON.parse(fs.readFileSync(rawFile, 'utf8'));
const platforms = [];
for (const e of raw.elements) {
  let ring = null;
  if (e.geometry?.length) ring = e.geometry.map((g) => [+g.lon.toFixed(7), +g.lat.toFixed(7)]);
  else if (e.bounds) {
    // multipolygon relation without member geometry: use its bounding box
    const b = e.bounds;
    ring = [[b.minlon, b.minlat], [b.maxlon, b.minlat], [b.maxlon, b.maxlat], [b.minlon, b.maxlat]];
  }
  if (!ring) continue;
  const t = e.tags || {};
  platforms.push({ osm: `${e.type}/${e.id}`, name: t.name || null, ref: t.ref || null, local_ref: t.local_ref || null, ring });
}
fs.writeFileSync(path.join(out, 'platforms.json'), JSON.stringify({
  source: 'OpenStreetMap contributors (ODbL), railway=platform, Overpass ' + (raw.osm3s?.timestamp_osm_base || ''),
  platforms,
}));
console.log(`platforms: ${platforms.length}`);

// ---- station → OSM platform mapping ------------------------------------------------------
// Curated from the baked data: for every ION stop, the OSM platform whose centroid lies
// beside that direction's running line (lateral ≤ 5 m) at the stop. ION has centre
// platforms (one outline serves both lines) and side platforms (one per line); the
// side/centre arrangement follows from the outline's lateral position, not from this table.
const PLATFORM_OF = {
  ion_southbound: {
    conestoga: 'way/744253498', northfield: 'way/751178896', research: 'way/699821963', uw: 'way/532113393',
    laurier: 'way/696298644', willis: 'way/829567790', allen: 'way/743458294', grh: 'way/823658168',
    central: 'way/739451232', victoria: 'way/836238403', queen: 'way/836238402', market: 'way/466402907',
    borden: 'relation/16692801', mill: 'way/690922712', blockline: 'way/690921055', fairway: 'way/690921802',
  },
  ion_northbound: {
    fairway: 'way/1369817041', blockline: 'way/690921055', mill: 'way/690922712', borden: 'relation/16692801',
    market: 'way/466402907', frederick: 'way/729743029', cityhall: 'way/825518269', central: 'way/739451234',
    grh: 'way/823658168', allen: 'way/743458294', publicsquare: 'way/657397944', laurier: 'way/1022168432',
    uw: 'way/1020715334', research: 'way/699821963', northfield: 'way/751178896', conestoga: 'way/744253497',
  },
};
const stFile = path.join(out, 'stations.json');
const stationsJson = JSON.parse(fs.readFileSync(stFile, 'utf8'));
const byOsm = new Map(platforms.map((p) => [p.osm, p]));
for (const [routeKey, map] of Object.entries(PLATFORM_OF)) {
  const route = stationsJson.routes[routeKey];
  route.track = routeKey === 'ion_southbound' ? 'ion-sb.geojson' : 'ion-nb.geojson';
  route.reverse = false;
  for (const st of route.stations) {
    const id = map[st.id];
    if (!id || !byOsm.has(id)) { delete st.platform_osm; continue; }
    st.platform_osm = id;
    // stop target = OSM platform centroid (the hand-entered station points were up to
    // ~370 m off for Market/Borden/Queen)
    const ring = byOsm.get(id).ring;
    st.lon = +(ring.reduce((a, q) => a + q[0], 0) / ring.length).toFixed(6);
    st.lat = +(ring.reduce((a, q) => a + q[1], 0) / ring.length).toFixed(6);
  }
}
fs.writeFileSync(stFile, JSON.stringify(stationsJson, null, 2) + '\n');
console.log('stations.json: ION platform_osm + platform-centroid stop points written');
