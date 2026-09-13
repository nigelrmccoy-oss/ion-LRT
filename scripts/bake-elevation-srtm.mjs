import fs from 'fs';

// SRTM-30: 1° tile, 3601x3601 int16 BE, row0=north
function loadHgt(path, latBase, lonBase) {
  const buf = fs.readFileSync(path);
  const n = 3601;
  return {
    n, latBase, lonBase,
    sample(lat, lon) {
      const x = (lon - lonBase) * (n - 1);
      const y = (latBase + 1 - lat) * (n - 1); // from north
      if (x < 0 || y < 0 || x > n-1 || y > n-1) return null;
      const x0 = Math.floor(x), y0 = Math.floor(y);
      const x1 = Math.min(x0+1, n-1), y1 = Math.min(y0+1, n-1);
      const fx = x-x0, fy = y-y0;
      const rd = (yy,xx) => {
        const off = (yy * n + xx) * 2;
        let v = buf.readInt16BE(off);
        if (v === -32768) return null; // void
        return v;
      };
      const v00=rd(y0,x0), v10=rd(y0,x1), v01=rd(y1,x0), v11=rd(y1,x1);
      const vals = [v00,v10,v01,v11];
      if (vals.every(v=>v==null)) return null;
      const fill = vals.find(v=>v!=null);
      const a=v00??fill, b=v10??fill, c=v01??fill, d=v11??fill;
      return a*(1-fx)*(1-fy)+b*fx*(1-fy)+c*(1-fx)*fy+d*fx*fy;
    }
  };
}

const t81 = loadHgt('/tmp/srtm/N43W081.hgt', 43, -81);
const t80 = loadHgt('/tmp/srtm/N43W080.hgt', 43, -80);

function elev(lat, lon) {
  if (lon < -80) return t81.sample(lat, lon);
  return t80.sample(lat, lon);
}

const ion = JSON.parse(fs.readFileSync('public/data/ion-track.geojson')).features[0].geometry.coordinates;
const spur = JSON.parse(fs.readFileSync('public/data/waterloo-spur.geojson')).features[0].geometry.coordinates;
const guelph = JSON.parse(fs.readFileSync('public/data/guelph-sub.geojson')).features[0].geometry.coordinates;

const bounds = { minLon:-80.575, maxLon:-80.235, minLat:43.405, maxLat:43.612 };
// ~45m grid for high quality corridor DEM
const cellM = 45;
const latStep = cellM/111320;
const lonStep = cellM/(111320*Math.cos(43.5*Math.PI/180));
const cols = Math.ceil((bounds.maxLon - bounds.minLon)/lonStep) + 1;
const rows = Math.ceil((bounds.maxLat - bounds.minLat)/latStep) + 1;

// Corridor mask from tracks (~1km)
const cell = 0.005;
const hash = new Set();
function addPt(lon, lat) {
  const i = Math.floor(lat/cell), j = Math.floor(lon/cell);
  for (let di=-2; di<=2; di++) for (let dj=-2; dj<=2; dj++) hash.add((i+di)+','+(j+dj));
}
for (const t of [ion, spur, guelph]) for (const [lon,lat] of t) addPt(lon,lat);

const grid = new Float32Array(cols * rows);
grid.fill(-9999);
let valid = 0;
for (let r=0;r<rows;r++){
  for (let c=0;c<cols;c++){
    const lat = bounds.minLat + r*latStep;
    const lon = bounds.minLon + c*lonStep;
    if (!hash.has(Math.floor(lat/cell)+','+Math.floor(lon/cell))) continue;
    const e = elev(lat, lon);
    if (e==null) continue;
    grid[r*cols+c] = e;
    valid++;
  }
}

function profile(track) {
  return track.map(([lon,lat]) => {
    const e = elev(lat, lon);
    return e==null ? null : Math.round(e*10)/10;
  });
}

const profiles = { ion: profile(ion), spur: profile(spur), guelph: profile(guelph) };

function sampleGrid(lat, lon) {
  const c = (lon - bounds.minLon) / lonStep;
  const r = (lat - bounds.minLat) / latStep;
  const c0 = Math.floor(c), r0 = Math.floor(r);
  if (c0<0||r0<0||c0+1>=cols||r0+1>=rows) return elev(lat,lon);
  const tx=c-c0, ty=r-r0;
  const v = (rr,cc) => { const x=grid[rr*cols+cc]; return x===-9999?null:x; };
  const v00=v(r0,c0), v10=v(r0,c0+1), v01=v(r0+1,c0), v11=v(r0+1,c0+1);
  if ([v00,v10,v01,v11].every(x=>x==null)) return elev(lat,lon);
  const fill=[v00,v10,v01,v11].find(x=>x!=null);
  const a=v00??fill,b=v10??fill,c_=v01??fill,d=v11??fill;
  return a*(1-tx)*(1-ty)+b*tx*(1-ty)+c_*(1-tx)*ty+d*tx*ty;
}

const spots = {
  Conestoga: [43.49806, -80.52917],
  Northfield: [43.49736, -80.54330],
  UW: [43.47312, -80.54107],
  'Uptown Waterloo': [43.46414, -80.52289],
  'Downtown Kitchener': [43.45304, -80.49874],
  'Victoria Park': [43.45016, -80.49354],
  Fairway: [43.42236, -80.44194],
  'St Jacobs': [43.5405, -80.5538],
  Elmira: [43.5985, -80.5555],
  Breslau: [43.4748, -80.4165],
  Guelph: [43.5445, -80.2495],
};
const spot_checks_m = {};
for (const [name,[lat,lon]] of Object.entries(spots)) {
  const e = elev(lat,lon);
  spot_checks_m[name] = { lat, lon, elev_m: e==null?null:Math.round(e*10)/10 };
  console.log('SPOT', name, spot_checks_m[name].elev_m, 'm');
}

const packed = Buffer.alloc(grid.length * 4);
for (let i=0;i<grid.length;i++) packed.writeFloatLE(grid[i], i*4);
fs.writeFileSync('public/data/elevation.bin', packed);

const meta = {
  source: 'SRTM 30m (AWS elevation-tiles-prod skadi HGT). Vertical scale 1.0 — metres are metres. No exaggeration.',
  tiles: ['N43W081.hgt', 'N43W080.hgt'],
  bounds,
  latStep,
  lonStep,
  cols,
  rows,
  cell_m_approx: cellM,
  valid_cells: valid,
  binary: 'elevation.bin',
  binary_format: 'Float32 LE row-major; row0=south (minLat), col0=west (minLon); -9999=no data',
  vertical_scale: 1.0,
  track_profiles: profiles,
  spot_checks_m,
  baked_at: new Date().toISOString(),
};
fs.writeFileSync('public/data/elevation.json', JSON.stringify(meta));
console.log('grid', cols, 'x', rows, 'valid', valid, 'bin', packed.length);
console.log('ION elev', Math.min(...profiles.ion), '..', Math.max(...profiles.ion));
console.log('Spur elev', Math.min(...profiles.spur), '..', Math.max(...profiles.spur));
console.log('Guelph elev', Math.min(...profiles.guelph), '..', Math.max(...profiles.guelph));
