#!/usr/bin/env python3
"""Independent check points: 1 m HRDEM DTM read straight from the NRCan COG (not from the
game bake) at random points in the ION corridor. Output: tools/terrain/truth-points.json,
used by scripts/audit-terrain-dtm.mjs and the stress test."""
import json, math, os, random
import numpy as np, rasterio
from rasterio.windows import Window
from pyproj import Transformer
from shapely.geometry import LineString, Point, Polygon
from shapely.ops import unary_union
import importlib.util
HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location('bk', os.path.join(HERE, 'bake-dem.py'))
bk = importlib.util.module_from_spec(spec); spec.loader.exec_module(bk)
random.seed(20261121)
ion = unary_union([LineString([bk.to_local(*c) for c in bk.load_line(f)]) for f in ('ion-track.geojson', 'ion-sb.geojson', 'ion-nb.geojson')])
omsf = Polygon([bk.to_local(*c) for c in bk.OMSF_LONLAT])
corr = unary_union([ion.buffer(300), omsf.buffer(300)])
allrail = unary_union([ion] + [LineString([bk.to_local(*c) for c in bk.load_line(f)]) for f in ('waterloo-spur.geojson', 'guelph-sub.geojson')])
minx, minz, maxx, maxz = corr.bounds
src = rasterio.open(bk.SRC_DTM[0][1]); t = Transformer.from_crs(4326, 3979, always_xy=True)
inv = ~src.transform
def dtm(lon, lat):
    x, y = t.transform(lon, lat)
    c, r = inv * (x, y)
    c -= 0.5; r -= 0.5   # pixel centres
    c0, r0 = int(math.floor(c)), int(math.floor(r))
    a = src.read(1, window=Window(c0, r0, 2, 2)).astype(float)
    if a.shape != (2, 2) or (a < -1000).any():
        return None
    tx, ty = c - c0, r - r0
    return float(a[0, 0] * (1 - tx) * (1 - ty) + a[0, 1] * tx * (1 - ty) + a[1, 0] * (1 - tx) * ty + a[1, 1] * tx * ty)
pts = []
while len(pts) < 400:
    x, z = random.uniform(minx, maxx), random.uniform(minz, maxz)
    p = Point(x, z)
    if not corr.contains(p):
        continue
    lon, lat = bk.to_lonlat(x, z)
    h = dtm(lon, lat)
    if h is None:
        continue
    pts.append({'lon': round(lon, 7), 'lat': round(lat, 7), 'dtm_m': round(h, 3), 'd_rail_m': round(allrail.distance(p), 1)})
# station platforms: lidar height at the OSM platform centroid, for the station check
plat = json.load(open(os.path.join(bk.DATA, 'platforms.json')))['platforms']
st = json.load(open(os.path.join(bk.DATA, 'stations.json')))
names = {}
for r in st['routes'].values():
    if 'ion' in r.get('track', ''):
        for s in r['stations']:
            names[s.get('platform_osm')] = s['name']
stations = []
for p in plat:
    if p.get('osm') in names and len(p['ring']) >= 3:
        c = Polygon(p['ring']).centroid
        h = dtm(c.x, c.y)
        stations.append({'name': names[p['osm']], 'osm': p['osm'], 'lon': round(c.x, 7), 'lat': round(c.y, 7), 'dtm_platform_m': None if h is None else round(h, 3)})
json.dump({'source': bk.SRC_DTM[0][0] + ' (1 m, bilinear, read directly from the NRCan COG)', 'vertical_datum': 'CGVD2013',
           'seed': 20261121, 'points': pts, 'stations': stations},
          open(os.path.join(HERE, 'truth-points.json'), 'w'), indent=0)
print(len(pts), 'points', len(stations), 'station platforms', sum(1 for p in pts if p['d_rail_m'] > 25), 'beyond 25 m of rail')
