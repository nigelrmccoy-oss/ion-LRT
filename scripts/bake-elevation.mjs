import fs from 'fs';

const job = JSON.parse(fs.readFileSync('/tmp/elev-job.json','utf8'));
const {bounds, latRes, lonRes, cols, rows, trackPts} = job;

// Build track spatial hash for corridor mask (~900m)
const cell = 0.004; // ~400m
const trackHash = new Set();
function hk(lat,lon){ return Math.floor(lat/cell)+','+Math.floor(lon/cell); }
for (const [lat,lon] of trackPts) {
  for (let di=-3; di<=3; di++) for (let dj=-3; dj<=3; dj++) {
    trackHash.add(Math.floor(lat/cell)+di+','+(Math.floor(lon/cell)+dj));
  }
}

// 90m grid for terrain (2x the 60m plan for fewer API calls, still dense)
const latStep = 90/111320;
const lonStep = 90/(111320*Math.cos(43.5*Math.PI/180));
const gCols = Math.ceil((bounds.maxLon-bounds.minLon)/lonStep)+1;
const gRows = Math.ceil((bounds.maxLat-bounds.minLat)/latStep)+1;

const sampleLats = [];
const sampleLons = [];
const sampleMeta = []; // {type:'grid'|'track', i, j?}

for (let r=0;r<gRows;r++){
  for (let c=0;c<gCols;c++){
    const lat = bounds.minLat + r*latStep;
    const lon = bounds.minLon + c*lonStep;
    if (!trackHash.has(hk(lat,lon))) continue;
    sampleLats.push(lat);
    sampleLons.push(lon);
    sampleMeta.push({t:'g', r, c});
  }
}
// denser along tracks (~ every point we have, ~20-25m)
for (let i=0;i<trackPts.length;i++){
  sampleLats.push(trackPts[i][0]);
  sampleLons.push(trackPts[i][1]);
  sampleMeta.push({t:'t', i});
}
console.log('samples', sampleLats.length, 'grid cells possible', gCols*gRows, 'grid kept', sampleMeta.filter(m=>m.t==='g').length);

async function fetchBatch(lats, lons) {
  const url = `https://api.open-meteo.com/v1/elevation?latitude=${lats.join(',')}&longitude=${lons.join(',')}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error('HTTP '+res.status+' '+await res.text());
  const data = await res.json();
  return data.elevation;
}

const BATCH = 80;
const elevations = new Array(sampleLats.length);
let failures = 0;
for (let i=0; i<sampleLats.length; i+=BATCH) {
  const sl = sampleLats.slice(i, i+BATCH);
  const so = sampleLons.slice(i, i+BATCH);
  let ok=false;
  for (let attempt=0; attempt<4 && !ok; attempt++) {
    try {
      const elev = await fetchBatch(sl, so);
      for (let k=0;k<elev.length;k++) elevations[i+k] = elev[k];
      ok=true;
    } catch (e) {
      failures++;
      console.warn('batch', i, 'attempt', attempt, e.message);
      await new Promise(r => setTimeout(r, 500*(attempt+1)));
    }
  }
  if (!ok) {
    // fallback OpenTopoData for this batch
    try {
      const locs = sl.map((lat,idx)=>`${lat},${so[idx]}`).join('|');
      const res = await fetch(`https://api.opentopodata.org/v1/srtm30m?locations=${locs}`);
      const data = await res.json();
      for (let k=0;k<data.results.length;k++) elevations[i+k] = data.results[k].elevation;
      ok=true;
      console.log('opentopo fallback ok at', i);
    } catch (e2) {
      console.error('FATAL batch', i, e2.message);
      process.exit(1);
    }
  }
  if ((i/BATCH)%20===0) console.log('progress', i, '/', sampleLats.length);
  await new Promise(r => setTimeout(r, 50));
}

// Build grid array (NaN for empty)
const grid = new Float32Array(gCols * gRows);
grid.fill(NaN);
const trackElev = [];
for (let i=0;i<elevations.length;i++){
  const e = elevations[i];
  if (e==null || Number.isNaN(e)) continue;
  const m = sampleMeta[i];
  if (m.t==='g') grid[m.r * gCols + m.c] = e;
  if (m.t==='t') trackElev[m.i] = e;
}

// Fill small holes in grid by neighbor average
function fillHoles(passes=3){
  for (let p=0;p<passes;p++){
    const copy = Float32Array.from(grid);
    for (let r=0;r<gRows;r++){
      for (let c=0;c<gCols;c++){
        const i=r*gCols+c;
        if (!Number.isNaN(copy[i])) continue;
        // only fill if near corridor (has neighbor)
        let s=0,n=0;
        for (const [dr,dc] of [[-1,0],[1,0],[0,-1],[0,1],[-1,-1],[1,1],[-1,1],[1,-1]]){
          const rr=r+dr, cc=c+dc;
          if (rr<0||cc<0||rr>=gRows||cc>=gCols) continue;
          const v=copy[rr*gCols+cc];
          if (!Number.isNaN(v)){ s+=v; n++; }
        }
        if (n>=2) grid[i]=s/n;
      }
    }
  }
}
fillHoles(4);

// Spot checks
const spot = [
  ['Conestoga', 43.49806, -80.52917],
  ['Northfield', 43.49736, -80.54330],
  ['UW', 43.47312, -80.54107],
  ['Uptown Waterloo', 43.46414, -80.52289],
  ['Downtown Kitchener', 43.45304, -80.49874],
  ['Fairway', 43.42236, -80.44194],
  ['St Jacobs', 43.5405, -80.5538],
  ['Elmira', 43.5985, -80.5555],
  ['Guelph', 43.5445, -80.2495],
];
function sampleGrid(lat, lon){
  const c = (lon - bounds.minLon) / lonStep;
  const r = (lat - bounds.minLat) / latStep;
  const c0 = Math.floor(c), r0 = Math.floor(r);
  if (c0<0||r0<0||c0+1>=gCols||r0+1>=gRows) return null;
  const tx=c-c0, ty=r-r0;
  const v00=grid[r0*gCols+c0], v10=grid[r0*gCols+c0+1], v01=grid[(r0+1)*gCols+c0], v11=grid[(r0+1)*gCols+c0+1];
  if ([v00,v10,v01,v11].some(Number.isNaN)) {
    const vals=[v00,v10,v01,v11].filter(v=>!Number.isNaN(v));
    return vals.length? vals.reduce((a,b)=>a+b,0)/vals.length : null;
  }
  return v00*(1-tx)*(1-ty)+v10*tx*(1-ty)+v01*(1-tx)*ty+v11*tx*ty;
}
const spotChecks = {};
for (const [name,lat,lon] of spot){
  spotChecks[name] = {lat, lon, elev_m: sampleGrid(lat,lon)};
  console.log('SPOT', name, spotChecks[name].elev_m);
}

// Pack grid as base64 float32 for compact storage, plus JSON metadata
const validCount = [...grid].filter(v=>!Number.isNaN(v)).length;
// Replace NaN with sentinel -9999 for binary
const packed = Buffer.alloc(grid.length * 4);
for (let i=0;i<grid.length;i++){
  packed.writeFloatLE(Number.isNaN(grid[i]) ? -9999 : grid[i], i*4);
}
fs.writeFileSync('public/data/elevation.bin', packed);

// Track profiles (split by route)
const ionN = JSON.parse(fs.readFileSync('public/data/ion-track.geojson')).features[0].geometry.coordinates.length;
const spurN = JSON.parse(fs.readFileSync('public/data/waterloo-spur.geojson')).features[0].geometry.coordinates.length;
const guelphN = JSON.parse(fs.readFileSync('public/data/guelph-sub.geojson')).features[0].geometry.coordinates.length;
let off=0;
const profiles = {
  ion: trackElev.slice(off, off+=ionN),
  spur: trackElev.slice(off, off+=spurN),
  guelph: trackElev.slice(off, off+=guelphN),
};

const meta = {
  source: 'Open-Meteo Elevation API (SRTM/DEM blend), vertical scale 1.0 (metres=metres), no exaggeration',
  fallback: 'OpenTopoData srtm30m on batch failure',
  bounds,
  latStep,
  lonStep,
  cols: gCols,
  rows: gRows,
  cell_m_approx: 90,
  valid_cells: validCount,
  binary: 'elevation.bin',
  binary_format: 'Float32 LE row-major, row0=south, col0=west; -9999=no data',
  track_profiles: {
    ion: profiles.ion,
    spur: profiles.spur,
    guelph: profiles.guelph,
  },
  spot_checks_m: spotChecks,
  baked_at: new Date().toISOString(),
};
// Keep profiles in separate smaller file to avoid huge JSON parse of meta with all elevations twice
const elevJson = {
  ...meta,
  track_profiles: {
    ion: profiles.ion,
    spur: profiles.spur,
    guelph: profiles.guelph,
  }
};
fs.writeFileSync('public/data/elevation.json', JSON.stringify(elevJson));
console.log('wrote elevation.bin', packed.length, 'elevation.json', fs.statSync('public/data/elevation.json').size);
console.log('ION elev range', Math.min(...profiles.ion.filter(Number.isFinite)), Math.max(...profiles.ion.filter(Number.isFinite)));
