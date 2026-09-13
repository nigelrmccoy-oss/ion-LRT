import fs from 'fs';

const STATIONS = {
  conestoga: {name:'Conestoga', lat:43.49806, lon:-80.52917},
  northfield: {name:'Northfield', lat:43.49736, lon:-80.54330},
  research: {name:'Research and Technology', lat:43.48136, lon:-80.54527},
  uw: {name:'University of Waterloo', lat:43.47312, lon:-80.54107},
  laurier: {name:'Laurier–Waterloo Park', lat:43.46899, lon:-80.53450},
  publicsquare: {name:'Waterloo Public Square', lat:43.46414, lon:-80.52289},
  willis: {name:'Willis Way', lat:43.46228, lon:-80.52354},
  allen: {name:'Allen', lat:43.46015, lon:-80.51886},
  grh: {name:'Grand River Hospital', lat:43.45730, lon:-80.51217},
  central: {name:'Central Station', lat:43.45304, lon:-80.49874},
  cityhall: {name:'Kitchener City Hall', lat:43.4516, lon:-80.4925},
  victoria: {name:'Victoria Park', lat:43.45016, lon:-80.49354},
  frederick: {name:'Frederick', lat:43.4488, lon:-80.4878},
  queen: {name:'Queen', lat:43.4472, lon:-80.4865},
  market: {name:'Kitchener Market', lat:43.4435, lon:-80.4810},
  borden: {name:'Borden', lat:43.4390, lon:-80.4755},
  mill: {name:'Mill', lat:43.43395, lon:-80.47839},
  blockline: {name:'Block Line', lat:43.42260, lon:-80.46263},
  fairway: {name:'Fairway', lat:43.42236, lon:-80.44194},
  stjacobs: {name:'St. Jacobs', lat:43.5405, lon:-80.5538},
  elmira: {name:'Elmira', lat:43.5985, lon:-80.5555},
  kitchener: {name:'Kitchener', lat:43.4556, lon:-80.4985},
  breslau: {name:'Breslau', lat:43.4748, lon:-80.4165},
  guelph: {name:'Guelph', lat:43.5445, lon:-80.2495},
};

function haversine(a,b){
  const R=6371000; const toR=x=>x*Math.PI/180;
  const φ1=toR(a[1]), φ2=toR(b[1]);
  const Δφ=toR(b[1]-a[1]), Δλ=toR(b[0]-a[0]);
  const s=Math.sin(Δφ/2)**2+Math.cos(φ1)*Math.cos(φ2)*Math.sin(Δλ/2)**2;
  return 2*R*Math.atan2(Math.sqrt(s),Math.sqrt(1-s));
}
function loadTrack(file){
  const g=JSON.parse(fs.readFileSync(file,'utf8'));
  return g.features[0].geometry.coordinates;
}
function cumDist(path){
  const d=[0];
  for (let i=1;i<path.length;i++) d.push(d[i-1]+haversine(path[i-1],path[i]));
  return d;
}
function project(st, track){
  const cd=cumDist(track);
  let best=0, bd=1e18;
  for (let i=0;i<track.length;i++){
    const d=haversine([st.lon,st.lat], track[i]);
    if (d<bd){bd=d;best=i;}
  }
  return {...st, trackIndex:best, distance_m:Math.round(cd[best]), snap_lon:track[best][0], snap_lat:track[best][1], snap_err_m:Math.round(bd)};
}

const ion = loadTrack('public/data/ion-track.geojson');
const spur = loadTrack('public/data/waterloo-spur.geojson');
const guelphT = loadTrack('public/data/guelph-sub.geojson');
const ionRev = ion.slice().reverse();

const sbIds = ['conestoga','northfield','research','uw','laurier','willis','allen','grh','central','victoria','queen','market','borden','mill','blockline','fairway'];
const nbIds = ['fairway','blockline','mill','borden','market','frederick','cityhall','central','grh','allen','publicsquare','laurier','uw','research','northfield','conestoga'];

const ionLen = JSON.parse(fs.readFileSync('public/data/ion-track.geojson')).features[0].properties.length_m;
const spurLen = JSON.parse(fs.readFileSync('public/data/waterloo-spur.geojson')).features[0].properties.length_m;
const guelphLen = JSON.parse(fs.readFileSync('public/data/guelph-sub.geojson')).features[0].properties.length_m;

const stations = {
  meta: {
    ion_km: +(ionLen/1000).toFixed(2),
    spur_km: +(spurLen/1000).toFixed(2),
    guelph_km: +(guelphLen/1000).toFixed(2),
    source: 'OpenStreetMap + Wikipedia station coords',
    one_way: 'SB: Willis Way, Victoria Park, Queen; NB: Waterloo Public Square, Kitchener City Hall, Frederick'
  },
  routes: {
    ion_southbound: {
      id:'ion_sb', name:'301 Fairway', vehicle:'flexity', track:'ion-track.geojson', reverse:false,
      stations: sbIds.map(id => project({id, ...STATIONS[id], directions:['sb']}, ion))
    },
    ion_northbound: {
      id:'ion_nb', name:'301 Conestoga', vehicle:'flexity', track:'ion-track.geojson', reverse:true,
      stations: nbIds.map(id => project({id, ...STATIONS[id], directions:['nb']}, ionRev))
    },
    elmira: {
      id:'elmira', name:'WCR to Elmira', vehicle:'diesel', track:'waterloo-spur.geojson', reverse:false,
      stations: ['northfield','stjacobs','elmira'].map(id => project({id, ...STATIONS[id]}, spur))
    },
    guelph: {
      id:'guelph', name:'Kitchener–Guelph', vehicle:'diesel', track:'guelph-sub.geojson', reverse:false,
      stations: ['kitchener','breslau','guelph'].map(id => project({id, ...STATIONS[id]}, guelphT))
    }
  }
};
fs.writeFileSync('public/data/stations.json', JSON.stringify(stations, null, 2));
console.log('SB snaps:', stations.routes.ion_southbound.stations.map(s=>`${s.name}:${s.snap_err_m}m`).join(' | '));
console.log('Elmira:', stations.routes.elmira.stations.map(s=>`${s.name}:${s.snap_err_m}m`).join(' | '));
console.log('Guelph:', stations.routes.guelph.stations.map(s=>`${s.name}:${s.snap_err_m}m`).join(' | '));

const bounds = { minLon:-80.575, maxLon:-80.235, minLat:43.405, maxLat:43.612 };
const latRes = 60/111320;
const lonRes = 60/(111320*Math.cos(43.5*Math.PI/180));
const cols = Math.ceil((bounds.maxLon-bounds.minLon)/lonRes)+1;
const rows = Math.ceil((bounds.maxLat-bounds.minLat)/latRes)+1;
console.log('DEM grid', cols, 'x', rows, '=', cols*rows);

const trackPts = [];
for (const t of [ion, spur, guelphT]) {
  for (const [lon,lat] of t) trackPts.push([lat, lon]);
}
fs.writeFileSync('/tmp/elev-job.json', JSON.stringify({bounds, latRes, lonRes, cols, rows, trackPts}));
console.log('track elev samples', trackPts.length);
