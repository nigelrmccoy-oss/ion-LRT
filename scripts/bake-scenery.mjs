import fs from 'fs';

const raw = JSON.parse(fs.readFileSync('public/data/osm-scenery.json','utf8'));
console.log('raw elements', raw.elements.length);

// Local ENU projection origin (Central Station-ish)
const ORIGIN_LAT = 43.45;
const ORIGIN_LON = -80.50;
const R = 6378137;
function toLocal(lon, lat) {
  const x = (lon - ORIGIN_LON) * Math.PI/180 * R * Math.cos(ORIGIN_LAT*Math.PI/180);
  const z = -(lat - ORIGIN_LAT) * Math.PI/180 * R; // -Z north in three.js xz plane? we'll use +Z = south for rail progress southward OR keep +Z = -north
  return [x, z];
}

const landPolys = [];
const buildings = [];
const water = [];
const parks = [];

function ringArea(ring) {
  let a=0;
  for (let i=0;i<ring.length-1;i++) a += ring[i][0]*ring[i+1][1] - ring[i+1][0]*ring[i][1];
  return a/2;
}
function simplify(coords, tol=8) {
  // tiny douglas-peucker-ish: drop points closer than tol metres in local space
  if (coords.length < 4) return coords;
  const out = [coords[0]];
  for (let i=1;i<coords.length-1;i++){
    const [x,z]=toLocal(coords[i][0], coords[i][1]);
    const [px,pz]=toLocal(out[out.length-1][0], out[out.length-1][1]);
    if (Math.hypot(x-px,z-pz) >= tol) out.push(coords[i]);
  }
  out.push(coords[coords.length-1]);
  return out;
}

for (const e of raw.elements) {
  if (e.type !== 'way' || !e.geometry || e.geometry.length < 3) continue;
  const t = e.tags || {};
  const coords = e.geometry.map(g => [g.lon, g.lat]);
  // close ring if needed
  const first=coords[0], last=coords[coords.length-1];
  if (first[0]!==last[0]||first[1]!==last[1]) coords.push(first.slice());
  const simp = simplify(coords, t.building ? 4 : 12);
  if (simp.length < 4) continue;
  const local = simp.map(([lon,lat]) => {
    const [x,z]=toLocal(lon,lat);
    return [Math.round(x*10)/10, Math.round(z*10)/10];
  });

  if (t.building) {
    const levels = parseFloat(t['building:levels']||t.levels||'');
    const hTag = parseFloat(t.height||'');
    let h = Number.isFinite(hTag) ? hTag : (Number.isFinite(levels) ? levels*3.2 : 8);
    h = Math.min(h, 80);
    // skip tiny sheds
    const area = Math.abs(ringArea(local));
    if (area < 40) continue;
    buildings.push({ h: Math.round(h*10)/10, ring: local });
    continue;
  }
  if (t.natural==='water' || t.waterway==='riverbank' || t.landuse==='basin' || t.water) {
    water.push({ ring: local });
    continue;
  }
  if (t.leisure==='park' || t.leisure==='golf_course' || t.landuse==='grass' || t.landuse==='meadow' || t.landuse==='recreation_ground' || t.natural==='wood' || t.landuse==='forest') {
    const kind = (t.natural==='wood'||t.landuse==='forest') ? 'forest' : (t.leisure==='park'?'park':'grass');
    parks.push({ kind, ring: local });
    continue;
  }
  if (t.landuse) {
    landPolys.push({ kind: t.landuse, ring: local });
  }
}

// Cap counts for runtime
buildings.sort((a,b)=>Math.abs(ringArea(b.ring))-Math.abs(ringArea(a.ring)));
const out = {
  origin: { lat: ORIGIN_LAT, lon: ORIGIN_LON },
  projection: 'local tangent plane metres; x=east, z=south(+)',
  landuse: landPolys.slice(0, 2500),
  parks: parks.slice(0, 800),
  water: water.slice(0, 400),
  buildings: buildings.slice(0, 3500),
  source: 'OpenStreetMap — stylized extrusion, no Street View / proprietary map tiles',
};
fs.writeFileSync('public/data/scenery.json', JSON.stringify(out));
console.log({
  landuse: out.landuse.length,
  parks: out.parks.length,
  water: out.water.length,
  buildings: out.buildings.length,
  bytes: fs.statSync('public/data/scenery.json').size
});
