#!/usr/bin/env python3
"""
Bake the game's elevation data from NRCan HRDEM 1 m lidar DTM (bare earth, CGVD2013).

  coarse  public/data/elevation.bin       Float32 LE, ~25 m lon/lat grid over the whole play area
  fine    public/data/elevation-fine.bin  uint16 tiles, ~2 m lon/lat grid, only within CORRIDOR_M of
                                          the ION lines + the OMSF yard (and a narrower band on the
                                          heavy-rail lines)
  meta    public/data/elevation.json      grid metadata, sources, gap log, designed track profiles

Sources, in priority order per cell:
  1. HRDEM lidar project ON-Lake_Erie_2018-1m DTM   (LIO/OMAFRA Lake Erie 2018 lidar, 1 m)
  2. HRDEM mosaic 8_2-mosaic-1m DTM                  (NRCan best-available mosaic, 1 m)
  3. AWS Terrarium tiles (z15 fine / z12 coarse)    -- only where 1+2 have no data; logged
HRDEM: EPSG:3979 (NAD83(CSRS) Canada Atlas Lambert), heights CGVD2013 orthometric (m).
The game grid is lon/lat (game coords.ts treats lon/lat as WGS84; NAD83(CSRS)->WGS84 is applied
as a null transform by PROJ: <= ~1.5 m horizontal, irrelevant at the 5 m terrain mesh).

Run (nigian):  ~/.venvs/terrain/bin/python tools/terrain/bake-dem.py
"""
import io, json, math, os, sys, time, urllib.request
import numpy as np
import rasterio
from rasterio.vrt import WarpedVRT
from rasterio.enums import Resampling
from rasterio.transform import Affine
from pyproj import Transformer
from shapely.geometry import LineString, Point, Polygon, box
from shapely.ops import unary_union
from shapely.strtree import STRtree

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
DATA = os.path.join(ROOT, 'public', 'data')
CACHE = os.path.expanduser('~/.cache/ion-terrain')
os.makedirs(CACHE, exist_ok=True)
os.environ.setdefault('GDAL_DISABLE_READDIR_ON_OPEN', 'EMPTY_DIR')
os.environ.setdefault('CPL_VSIL_CURL_ALLOWED_EXTENSIONS', '.tif')
os.environ.setdefault('GDAL_HTTP_MULTIRANGE', 'YES')
os.environ.setdefault('GDAL_HTTP_MERGE_CONSECUTIVE_RANGES', 'YES')
os.environ.setdefault('VSI_CACHE', 'TRUE')
os.environ.setdefault('VSI_CACHE_SIZE', str(512 * 1024 * 1024))
os.environ.setdefault('GDAL_CACHEMAX', '1024')

S3 = 'https://canelevation-dem.s3.ca-central-1.amazonaws.com/'
SRC_DTM = [
    ('HRDEM lidar ON-Lake_Erie_2018-1m DTM', '/vsicurl/' + S3 + 'hrdem-lidar/ON-Lake_Erie_2018-1m-dtm.tif'),
    ('HRDEM mosaic 8_2-mosaic-1m DTM', '/vsicurl/' + S3 + 'hrdem-mosaic-1m/8_2-mosaic-1m-dtm.tif'),
]
SRC_DSM = '/vsicurl/' + S3 + 'hrdem-lidar/ON-Lake_Erie_2018-1m-dsm.tif'
TERRARIUM = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'

# ---- game projection (must match src/game/coords.ts exactly) ----------------------------
R = 6378137.0
ORIGIN_LAT, ORIGIN_LON = 43.45, -80.50
KX = math.pi / 180 * R * math.cos(math.radians(ORIGIN_LAT))
KZ = math.pi / 180 * R
def to_local(lon, lat):
    return ((lon - ORIGIN_LON) * KX, -(lat - ORIGIN_LAT) * KZ)
def to_lonlat(x, z):
    return (ORIGIN_LON + x / KX, ORIGIN_LAT - z / KZ)

# ---- grids --------------------------------------------------------------------------------
BOUNDS = dict(minLon=-80.575, maxLon=-80.235, minLat=43.405, maxLat=43.612)  # unchanged play area
C_LAT = 0.000225     # ≈ 25.0 m
C_LON = 0.00031      # ≈ 25.0 m
F_LAT = 0.000018     # ≈ 2.00 m
F_LON = 0.000025     # ≈ 2.02 m
TILE = 128           # fine tile = 128×128 cells ≈ 256 m
ENC_OFF, ENC_SCALE = 200.0, 0.01   # uint16: h = OFF + v*SCALE ; v=0 → no data
CORRIDOR_M = 300.0   # ION lines + OMSF
HEAVY_CORRIDOR_M = 120.0  # Waterloo Spur / Guelph Sub (also playable)
OMSF_LONLAT = [(-80.5440, 43.4925), (-80.5375, 43.4925), (-80.5375, 43.4975), (-80.5440, 43.4975)]

def log(*a):
    print(*a, flush=True)

def load_line(f):
    return json.load(open(os.path.join(DATA, f)))['features'][0]['geometry']['coordinates']

LINES = {
    'ion': ('ion-track.geojson', 'light_rail'),
    'sb': ('ion-sb.geojson', 'light_rail'),
    'nb': ('ion-nb.geojson', 'light_rail'),
    'spur': ('waterloo-spur.geojson', 'rail'),
    'guelph': ('guelph-sub.geojson', 'rail'),
}

def corridor_polygon():
    polys = []
    for k, (f, _) in LINES.items():
        ls = LineString([to_local(*c) for c in load_line(f)])
        polys.append(ls.buffer(CORRIDOR_M if k in ('ion', 'sb', 'nb') else HEAVY_CORRIDOR_M))
    polys.append(Polygon([to_local(*c) for c in OMSF_LONLAT]).buffer(CORRIDOR_M))
    return unary_union(polys)

# ---- raster reading -----------------------------------------------------------------------
def warp_read(url, lon0, lat1, ncols, nrows, dlon, dlat, resampling=Resampling.average, overview=None):
    """Read a north-up lon/lat grid (row 0 = north edge lat1) from a 3979 COG. NaN = no data."""
    kw = {} if overview is None else {'overview_level': overview}
    with rasterio.open(url, **kw) as src:
        tr = Affine(dlon, 0, lon0, 0, -dlat, lat1)
        with WarpedVRT(src, crs='EPSG:4326', transform=tr, width=ncols, height=nrows,
                       resampling=resampling, src_nodata=src.nodata, nodata=-32767.0,
                       dtype='float32') as vrt:
            a = vrt.read(1)
    a = a.astype(np.float64)
    a[(a < -1000) | (a > 2000)] = np.nan
    return a

_tcache = {}
def terrarium_tile(z, x, y):
    key = (z, x, y)
    if key in _tcache:
        return _tcache[key]
    p = os.path.join(CACHE, f'terrarium-{z}-{x}-{y}.png')
    if not os.path.exists(p):
        req = urllib.request.Request(TERRARIUM.format(z=z, x=x, y=y), headers={'User-Agent': 'ion-lrt-sim'})
        open(p, 'wb').write(urllib.request.urlopen(req, timeout=60).read())
    from PIL import Image
    im = np.asarray(Image.open(p).convert('RGB')).astype(np.float64)
    h = im[..., 0] * 256 + im[..., 1] + im[..., 2] / 256 - 32768
    _tcache[key] = h
    return h

def terrarium_at(lon, lat, z):
    n = 2 ** z
    xf = (lon + 180) / 360 * n
    yf = (1 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2 * n
    tx, ty = int(xf), int(yf)
    h = terrarium_tile(z, tx, ty)
    px = min(255, max(0, int((xf - tx) * 256)))
    py = min(255, max(0, int((yf - ty) * 256)))
    return float(h[py, px])

# ---- bake ---------------------------------------------------------------------------------
def bake_coarse(meta):
    cols = int(math.ceil((BOUNDS['maxLon'] - BOUNDS['minLon']) / C_LON)) + 1
    rows = int(math.ceil((BOUNDS['maxLat'] - BOUNDS['minLat']) / C_LAT)) + 1
    # cell centres at minLon + c*C_LON (grid is node-registered, like the old SRTM grid)
    lon0 = BOUNDS['minLon'] - C_LON / 2
    lat1 = BOUNDS['minLat'] + (rows - 1) * C_LAT + C_LAT / 2
    out = np.full((rows, cols), np.nan)
    srcs = []
    for name, url in SRC_DTM:
        t0 = time.time()
        a = warp_read(url, lon0, lat1, cols, rows, C_LON, C_LAT, Resampling.average, overview=3)  # 16 m overview
        fill = np.isnan(out) & ~np.isnan(a)
        out[fill] = a[fill]
        srcs.append({'source': name, 'cells': int(fill.sum())})
        log(f'coarse {name}: {fill.sum()} cells ({time.time()-t0:.0f}s)')
    gaps = np.argwhere(np.isnan(out))
    for (r, c) in gaps:
        lon = lon0 + (c + 0.5) * C_LON
        lat = lat1 - (r + 0.5) * C_LAT
        out[r, c] = terrarium_at(lon, lat, 12)
    srcs.append({'source': 'AWS Terrarium z12 (gap fill)', 'cells': int(len(gaps))})
    log(f'coarse terrarium gap cells: {len(gaps)}')
    grid = out[::-1].astype(np.float32)  # row0 = south
    grid.tofile(os.path.join(DATA, 'elevation.bin'))
    meta.update(bounds=BOUNDS, latStep=C_LAT, lonStep=C_LON, cols=cols, rows=rows,
                cell_m_approx=25, valid_cells=int(np.isfinite(grid).sum()))
    meta['coarse_sources'] = srcs
    return grid

def bake_fine(meta, corridor):
    nT_lon = int(math.ceil((BOUNDS['maxLon'] - BOUNDS['minLon']) / (F_LON * TILE)))
    nT_lat = int(math.ceil((BOUNDS['maxLat'] - BOUNDS['minLat']) / (F_LAT * TILE)))
    tiles = []
    for tj in range(nT_lat):
        for ti in range(nT_lon):
            lo = BOUNDS['minLon'] + ti * TILE * F_LON
            la = BOUNDS['minLat'] + tj * TILE * F_LAT
            x0, z1 = to_local(lo, la)
            x1, z0 = to_local(lo + TILE * F_LON, la + TILE * F_LAT)
            if corridor.intersects(box(x0, z0, x1, z1)):
                tiles.append((ti, tj))
    log(f'fine tiles: {len(tiles)} (~{len(tiles)*TILE*TILE*2/1e6:.1f} MB)')
    # read in blocks of tiles (8×8) to keep HTTP efficient
    blocks = {}
    for ti, tj in tiles:
        blocks.setdefault((ti // 8, tj // 8), []).append((ti, tj))
    data = {}
    gap_cells = []
    src_counts = {name: 0 for name, _ in SRC_DTM}
    t0 = time.time()
    for bi, ((bx, by), members) in enumerate(sorted(blocks.items())):
        ti0, tj0 = bx * 8, by * 8
        tis = [m[0] for m in members]; tjs = [m[1] for m in members]
        ti0, ti1 = min(tis), max(tis) + 1
        tj0, tj1 = min(tjs), max(tjs) + 1
        ncols, nrows = (ti1 - ti0) * TILE, (tj1 - tj0) * TILE
        # cell (c,r) centre: lon = minLon + (ti*TILE + c)*F_LON  (node-registered)
        lon0 = BOUNDS['minLon'] + ti0 * TILE * F_LON - F_LON / 2
        lat1 = BOUNDS['minLat'] + (tj1 * TILE - 1) * F_LAT + F_LAT / 2
        acc = np.full((nrows, ncols), np.nan)
        for name, url in SRC_DTM:
            if not np.isnan(acc).any():
                break
            a = warp_read(url, lon0, lat1, ncols, nrows, F_LON, F_LAT, Resampling.average)
            fill = np.isnan(acc) & ~np.isnan(a)
            acc[fill] = a[fill]
        acc = acc[::-1]  # row0 = south
        for ti, tj in members:
            sub = acc[(tj - tj0) * TILE:(tj - tj0 + 1) * TILE, (ti - ti0) * TILE:(ti - ti0 + 1) * TILE].copy()
            miss = np.argwhere(np.isnan(sub))
            for (r, c) in miss:
                lon = BOUNDS['minLon'] + (ti * TILE + c) * F_LON
                lat = BOUNDS['minLat'] + (tj * TILE + r) * F_LAT
                sub[r, c] = terrarium_at(lon, lat, 15)
                gap_cells.append((lon, lat))
            data[(ti, tj)] = sub
        log(f'  block {bi+1}/{len(blocks)} tiles={len(members)} ({time.time()-t0:.0f}s)')
    # pack
    order = sorted(tiles, key=lambda t: (t[1], t[0]))
    buf = bytearray()
    for t in order:
        v = np.clip(np.round((data[t] - ENC_OFF) / ENC_SCALE), 1, 65535).astype('<u2')
        buf += v.tobytes()
    open(os.path.join(DATA, 'elevation-fine.bin'), 'wb').write(buf)
    # gap log (clustered to ~50 m cells)
    clusters = {}
    for lon, lat in gap_cells:
        k = (round(lon / 0.0006), round(lat / 0.00045))
        clusters.setdefault(k, [0, lon, lat])[0] += 1
    meta['fine'] = {
        'binary': 'elevation-fine.bin',
        'format': 'uint16 LE tiles of tileCells×tileCells, row-major, row0=south, col0=west; '
                  'h_m = encOffset + v*encScale; v=0 no data. Tile order = tiles[] order.',
        'origin': {'lon': BOUNDS['minLon'], 'lat': BOUNDS['minLat']},
        'lonStep': F_LON, 'latStep': F_LAT, 'tileCells': TILE,
        'encOffset': ENC_OFF, 'encScale': ENC_SCALE,
        'tiles': [list(t) for t in order],
        'cell_m_approx': 2.0,
        'corridor_m': {'ion_and_omsf': CORRIDOR_M, 'heavy_rail': HEAVY_CORRIDOR_M},
    }
    meta['fine_gaps'] = {
        'terrarium_cells': len(gap_cells),
        'fraction': len(gap_cells) / max(1, len(order) * TILE * TILE),
        'clusters': sorted([{'lon': round(v[1], 5), 'lat': round(v[2], 5), 'cells': v[0]} for v in clusters.values()],
                           key=lambda c: -c['cells'])[:50],
    }
    log(f'fine terrarium gap cells: {len(gap_cells)}')
    return data

class FineSampler:
    def __init__(self, data, coarse):
        self.data = data; self.coarse = coarse
    def raw(self, lon, lat):
        c = (lon - BOUNDS['minLon']) / F_LON
        r = (lat - BOUNDS['minLat']) / F_LAT
        c0, r0 = int(math.floor(c)), int(math.floor(r))
        tx, ty = c - c0, r - r0
        vals = []
        for (rr, cc) in ((r0, c0), (r0, c0 + 1), (r0 + 1, c0), (r0 + 1, c0 + 1)):
            t = self.data.get((cc // TILE, rr // TILE))
            if t is None:
                return self.coarse_at(lon, lat)
            vals.append(t[rr % TILE, cc % TILE])
        v00, v10, v01, v11 = vals
        return v00 * (1 - tx) * (1 - ty) + v10 * tx * (1 - ty) + v01 * (1 - tx) * ty + v11 * tx * ty
    def coarse_at(self, lon, lat):
        g = self.coarse; rows, cols = g.shape
        c = (lon - BOUNDS['minLon']) / C_LON; r = (lat - BOUNDS['minLat']) / C_LAT
        c0, r0 = int(c), int(r); tx, ty = c - c0, r - r0
        return float(g[r0, c0] * (1 - tx) * (1 - ty) + g[r0, c0 + 1] * tx * (1 - ty) + g[r0 + 1, c0] * (1 - tx) * ty + g[r0 + 1, c0 + 1] * tx * ty)

# ---- track design profile -----------------------------------------------------------------
STEP_TARGET = 2.0
# ION: Stage 2 EPR Table 4-2 max grade 6 % (0.5 % margin for the game's 5 m resample); heavy rail 2 %
GRADE_CAP = {'ion': 0.0595, 'sb': 0.0595, 'nb': 0.0595, 'spur': 0.0195, 'guelph': 0.0195}
PLATFORM_REACH_M = 6.0
MIN_VR_M = 300.0
PLATFORM_MAX_GRADE = 0.01

def osm_ways():
    d = json.load(open(os.path.join(DATA, 'osm-raw.json')))
    nodes = {e['id']: (e['lon'], e['lat']) for e in d['elements'] if e['type'] == 'node' and 'lon' in e}
    out = []
    for e in d['elements']:
        if e['type'] != 'way':
            continue
        t = e.get('tags', {})
        if 'geometry' in e:
            g = [(p['lon'], p['lat']) for p in e['geometry']]
        else:
            g = [nodes[n] for n in e.get('nodes', []) if n in nodes]
        if len(g) >= 2:
            out.append((e['id'], t, g))
    return out

def design_line(key, coords, fs, dsm_sampler, bridges_osm, platforms, stations, follow=None):
    xs = np.array([to_local(*c) for c in coords])
    seg = np.hypot(np.diff(xs[:, 0]), np.diff(xs[:, 1]))
    hs_v = np.concatenate([[0], np.cumsum(seg)])
    L = hs_v[-1]
    NS = int(math.ceil(L / STEP_TARGET)) + 1
    S = np.linspace(0.0, L, NS)
    STEP = float(S[1] - S[0])   # uniform, ≈ 2 m, exact to the line length
    X = np.interp(S, hs_v, xs[:, 0]); Z = np.interp(S, hs_v, xs[:, 1])
    fx = np.gradient(X); fz = np.gradient(Z); n = np.hypot(fx, fz); fx /= n; fz /= n
    # ground: median of centreline and ±1.5 m (rails sit on this surface)
    G = np.empty(len(S))
    for i in range(len(S)):
        vals = []
        for o in (-1.5, 0.0, 1.5):
            lon, lat = to_lonlat(X[i] + fz[i] * o, Z[i] - fx[i] * o)
            vals.append(fs.raw(lon, lat))
        G[i] = float(np.median(vals))
    rail_kind = LINES[key][1]
    # --- bridges (OSM bridge=yes on the same railway kind) ---
    bl = [LineString([to_local(*p) for p in g]) for (_, t, g) in bridges_osm if t.get('railway') == rail_kind]
    tree = STRtree(bl) if bl else None
    onb = np.zeros(len(S), bool)
    if tree is not None:
        for i in range(len(S)):
            pt = Point(X[i], Z[i])
            for j in tree.query(pt.buffer(4.0)):
                if bl[j].distance(pt) <= 4.0:
                    onb[i] = True; break
    spans = []
    i = 0
    while i < len(S):
        if not onb[i]:
            i += 1; continue
        j = i
        while j + 1 < len(S) and (onb[j + 1] or (j + 4 < len(S) and onb[j + 1:j + 4].any())):
            j += 1
        if (S[j] - S[i]) >= 6:
            spans.append([i, j])
        i = j + 1
    pinned = np.zeros(len(S), bool)
    onbridge = np.zeros(len(S), bool)
    Y = G.copy()
    bridge_out = []
    for (i, j) in spans:
        a = max(0, i - 3); b = min(len(S) - 1, j + 3)   # 6 m abutment margin
        ya = float(np.median(G[max(0, a - 3):a + 1])); yb = float(np.median(G[b:b + 4]))
        deck = ya + (yb - ya) * (S[a:b + 1] - S[a]) / max(1e-6, S[b] - S[a])
        # DSM check: deck top surface (rails/ballast) seen by the lidar first return
        dsm = []
        for k in range(i, j + 1, 2):
            lon, lat = to_lonlat(X[k], Z[k])
            v = dsm_sampler(lon, lat)
            if v is not None:
                dsm.append(v - deck[k - a])
        appr = []
        for k in list(range(max(0, a - 40), a, 2)) + list(range(b + 1, min(len(S), b + 41), 2)):
            lon, lat = to_lonlat(X[k], Z[k])
            v = dsm_sampler(lon, lat)
            if v is not None:
                appr.append(v - G[k])
        under = float(np.min(G[i:j + 1]))
        check = float(np.median(dsm) - np.median(appr)) if dsm and appr else 0.0
        crest = 0.0
        if check > 0.3 and len(dsm) >= 5:
            # Lidar first return sits higher over the span than on the approaches: the deck is
            # on a crest, not straight between abutments. Use the DSM along the span minus the
            # approach DSM−DTM offset (OCS wires/poles are on both), median-filtered.
            off = float(np.median(appr))
            ks = list(range(i, j + 1, 2))
            dd = []
            for k in ks:
                lon, lat = to_lonlat(X[k], Z[k])
                v = dsm_sampler(lon, lat)
                dd.append(np.nan if v is None else v - off)
            dd = np.array(dd)
            ok = ~np.isnan(dd)
            from scipy.ndimage import median_filter as _mf
            dk = np.interp(S[i:j + 1], np.array(S[ks])[ok], _mf(dd[ok], size=5, mode='nearest'))
            crest = float(np.max(dk - deck[i - a:j - a + 1]))
            deck[i - a:j - a + 1] = np.maximum(deck[i - a:j - a + 1], dk)
        Y[a:b + 1] = deck; onbridge[a:b + 1] = True
        bridge_out.append({'s0': round(float(S[a]), 1), 's1': round(float(S[b]), 1),
                           'deck_asl': [round(ya, 2), round(yb, 2)],
                           'lowest_ground_under_asl': round(under, 2),
                           'clearance_m': round(float(np.min(deck[i - a:j - a + 1]) - under), 2),
                           'dsm_minus_deck_median_m': round(float(np.median(dsm)), 2) if dsm else None,
                           'dsm_minus_ground_on_approaches_m': round(float(np.median(appr)), 2) if appr else None,
                           'crest_from_dsm_m': round(crest, 2),
                           'deck_check_m': round(float(np.median(dsm) - np.median(appr)), 2) if dsm and appr else None,
                           'lon': round(to_lonlat(X[(i + j) // 2], Z[(i + j) // 2])[0], 6),
                           'lat': round(to_lonlat(X[(i + j) // 2], Z[(i + j) // 2])[1], 6)})
    # --- platforms (ION lines only): level over the platform length ---
    plat_out = []
    if rail_kind == 'light_rail':
        for p in platforms:
            ring = [to_local(*c) for c in p['ring']]
            if len(ring) < 3:
                continue
            poly = Polygon(ring)
            if not poly.is_valid:
                poly = poly.buffer(0)
            near = np.array([poly.distance(Point(X[i], Z[i])) <= PLATFORM_REACH_M for i in range(len(S))])
            if near.sum() * STEP < 15:
                continue
            idx = np.where(near)[0]
            # longest contiguous run
            runs = np.split(idx, np.where(np.diff(idx) > 2)[0] + 1)
            run = max(runs, key=len)
            i, j = int(run[0]), int(run[-1])
            if pinned[i:j + 1].any() or onbridge[i:j + 1].any():
                continue
            # straight grade line through the platform (no vertical curve on the platform),
            # grade clamped to PLATFORM_MAX_GRADE (accessible boarding; 0 = dead level)
            ss = S[i:j + 1] - S[i:j + 1].mean()
            gfit = float(np.polyfit(ss, G[i:j + 1], 1)[0]) if j > i else 0.0
            gp = max(-PLATFORM_MAX_GRADE, min(PLATFORM_MAX_GRADE, gfit))
            lvl = float(np.median(G[i:j + 1] - gp * ss))
            Y[i:j + 1] = lvl + gp * ss; pinned[i:j + 1] = True
            plat_out.append({'name': p.get('name'), 'osm': p.get('osm'), 's0': round(float(S[i]), 1),
                             's1': round(float(S[j]), 1), 'level_asl': round(lvl, 3), 'grade': round(gp, 4),
                             'ground_grade': round(gfit, 4),
                             'ground_range_m': round(float(G[i:j + 1].max() - G[i:j + 1].min()), 2)})
    # --- design: penalised least squares (smoothing spline) with pins + grade cap ---
    #   minimise  Σ w_i (y_i − G_i)²  +  λ Σ (Δ²y_i / STEP²)²     (pins: w = 1e6)
    # λ is raised until the tightest vertical curve is ≥ MIN_VR_M (real LRT design minimum,
    # TTC/ION-class streetcar-LRT criteria use ~250–500 m; we take 300 m). Lidar outliers
    # (|G − 21-pt median| > 1 m, e.g. culvert openings, kerbs under the 3-sample cross-section)
    # get low weight so they don't pull the rail line.
    from scipy.ndimage import median_filter
    import scipy.sparse as sp
    from scipy.sparse.linalg import spsolve
    cap = GRADE_CAP[key]
    N = len(S)
    med = median_filter(Y, size=21, mode='nearest')
    w = np.where(np.abs(Y - med) > 1.0, 0.02, 1.0)
    shared = np.zeros(N, bool)
    if follow is not None:
        # double track: share the other line's formation where the two run side by side
        from scipy.spatial import cKDTree
        fX, fZ, fy = follow
        dist, idx = cKDTree(np.c_[fX, fZ]).query(np.c_[X, Z])
        wt = np.clip((12.0 - dist) / (12.0 - 5.0), 0, 1)
        # let this line's own level platforms win: fade the follow out within 60 m of them
        if pinned.any():
            from scipy.ndimage import distance_transform_edt
            dpin = distance_transform_edt(~pinned) * STEP
            wt = wt * np.clip((dpin - 10.0) / 50.0, 0, 1)
        Y = np.where(wt > 0, (1 - wt) * Y + wt * fy[idx], Y)
        shared = (wt > 0) & ~pinned
        w = np.where(shared, np.maximum(w, 30.0 * wt), w)   # deck target: strong but not a hard pin (spline rounds the crest/abutments)
    w[pinned] = 1e6
    D = sp.diags([np.ones(N - 2), -2 * np.ones(N - 2), np.ones(N - 2)], [0, 1, 2], shape=(N - 2, N)) / STEP ** 2
    DtD = (D.T @ D).tocsc()
    def solve(lam, ww, target):
        A = (sp.diags(ww) + lam * DtD).tocsc()
        return spsolve(A, ww * target)
    free = ~pinned
    free_c = ~(pinned[1:-1] & pinned[:-2] & pinned[2:])   # pin joints count, pin interiors don't
    def min_vr(y):
        c = (np.abs(np.diff(y, 2)) / STEP ** 2)[free_c]
        return 1 / max(1e-12, c.max()) if len(c) else 1e9
    lam = 2e3
    for _ in range(14):
        y = solve(lam, w, Y)
        if min_vr(y) >= MIN_VR_M:
            break
        lam *= 1.8
    # grade cap: where exceeded, re-solve with the over-steep stretch pulled toward the
    # Lipschitz-clamped line (pins held) — keeps the curve smooth instead of kinking it.
    def limit(y):
        y = y.copy()
        for _ in range(200):
            ch = False
            for fwd in (True, False):
                rng = range(1, N) if fwd else range(N - 2, -1, -1)
                for i in rng:
                    if pinned[i]:
                        continue
                    jn = i - 1 if fwd else i + 1
                    m = cap * abs(S[i] - S[jn])
                    c = min(y[jn] + m, max(y[jn] - m, y[i]))
                    if abs(c - y[i]) > 1e-9:
                        y[i] = c; ch = True
            if not ch:
                break
        return y
    for _ in range(4):
        g = np.abs(np.diff(y)) / STEP
        if g.max() <= cap + 1e-6:
            break
        yl = limit(y)
        ww = w.copy(); ww[np.abs(yl - y) > 1e-3] = 50.0; ww[pinned] = 1e6
        y = solve(lam, ww, np.where(pinned, Y, yl))
    y = limit(y)
    # per-vertex profile (for the geojson's own vertices)
    prof_v = np.interp(hs_v, S, y)
    g = np.diff(y) / np.diff(S)
    curv = np.diff(g) / STEP
    stats = {
        'length_m': round(float(L), 1), 'step_m': round(STEP, 6), 'grade_cap': cap,
        'max_grade': round(float(np.abs(g).max()), 4),
        'max_grade_at_s': round(float(S[np.argmax(np.abs(g))]), 1),
        'raw_ground_max_grade_20m': round(float(np.abs(np.diff(G[::10]) / np.diff(S[::10])).max()), 4),
        'min_vertical_radius_m': round(float(1 / max(1e-9, np.abs(curv).max())), 0),
        'track_vs_ground_rms_m': round(float(np.sqrt(np.mean(((y - G)[~pinned & ~onbridge]) ** 2))), 3),
        'track_vs_ground_max_m': round(float(np.abs((y - G)[~pinned & ~onbridge]).max()), 3),
        'min_vertical_radius_at_s': round(float(S[1 + np.argmax(np.abs(np.diff(y, 2)))]), 1),
    }
    return {
        'profile_vertex': [round(float(v), 3) for v in prof_v],
        '_xyz': (X, Z, y),
        'design': {'step_m': STEP, 'y': [round(float(v), 3) for v in y],
                   'ground': [round(float(v), 2) for v in G],
                   'bridges': bridge_out, 'platforms': plat_out, 'stats': stats},
    }

def main():
    t0 = time.time()
    meta = {
        'source': 'NRCan HRDEM 1 m lidar DTM (bare earth). Primary: ON-Lake_Erie_2018-1m; fallback: '
                  'HRDEM mosaic 8_2-mosaic-1m; gaps: AWS Terrarium. Vertical datum CGVD2013 (m, orthometric). '
                  'Source CRS EPSG:3979 resampled (area average) to lon/lat grids. Vertical scale 1.0.',
        'vertical_datum': 'CGVD2013',
        'source_crs': 'EPSG:3979',
        'binary': 'elevation.bin',
        'binary_format': 'Float32 LE row-major; row0=south (minLat), col0=west (minLon); -9999=no data',
        'vertical_scale': 1,
        'licence': 'HRDEM: Open Government Licence - Canada; Terrarium: Mapzen/AWS open terrain (various open sources)',
    }
    if '--design-only' in sys.argv:
        meta = json.load(open(os.path.join(DATA, 'elevation.json')))
        coarse = np.fromfile(os.path.join(DATA, 'elevation.bin'), dtype='<f4').reshape(meta['rows'], meta['cols']).astype(np.float64)
        fm = meta['fine']; T = fm['tileCells']
        raw = np.fromfile(os.path.join(DATA, fm['binary']), dtype='<u2').reshape(-1, T, T)
        fine = {tuple(t): fm['encOffset'] + raw[k].astype(np.float64) * fm['encScale'] for k, t in enumerate(fm['tiles'])}
    else:
        corridor = corridor_polygon()
        log(f'corridor area {corridor.area/1e6:.1f} km²')
        coarse = bake_coarse(meta)
        fine = bake_fine(meta, corridor)
    fs = FineSampler(fine, coarse)
    # DSM sampler (bridge-deck check)
    dsm_src = rasterio.open(SRC_DSM)
    to3979 = Transformer.from_crs(4326, 3979, always_xy=True)
    def dsm_at(lon, lat):
        v = float(list(dsm_src.sample([to3979.transform(lon, lat)]))[0][0])
        return None if v < -1000 else v
    ways = osm_ways()
    bridges = [w for w in ways if w[1].get('bridge') == 'yes' and w[1].get('railway') in ('light_rail', 'rail')]
    platforms = json.load(open(os.path.join(DATA, 'platforms.json')))['platforms']
    ion_names = set()
    st = json.load(open(os.path.join(DATA, 'stations.json')))
    for r in st['routes'].values():
        if 'ion' in r.get('track', ''):
            for s in r['stations']:
                ion_names.add(s.get('platform_osm'))
    ion_plats = [p for p in platforms if p.get('osm') in ion_names]
    log(f'bridges(osm rail+lrt): {len(bridges)}  ION platforms: {len(ion_plats)}')
    profiles, design = {}, {}
    done = {}
    for key in ['sb', 'nb', 'ion', 'spur', 'guelph']:
        f = LINES[key][0]
        follow = done['sb']['_xyz'] if key in ('nb', 'ion') else None
        r = design_line(key, load_line(f), fs, dsm_at, bridges, ion_plats, st, follow)
        done[key] = r
        profiles[key] = r['profile_vertex']
        design[key] = r['design']
        log(key, json.dumps(r['design']['stats']), 'bridges', len(r['design']['bridges']), 'platforms', len(r['design']['platforms']))
    meta['track_profiles'] = profiles
    meta['track_profiles_note'] = ('Designed rail-bed-minus-0.35 m ASL per geojson vertex. Full 2 m design in '
                                   'track-design.json (bridges keep deck height, platforms level, grade-capped, '
                                   'vertical curves).')
    old = json.load(open(os.path.join(DATA, 'elevation.json'))) if '--design-only' not in sys.argv else meta
    spots = {}
    for k, v in old.get('spot_checks_m', {}).items():
        spots[k] = {'lat': v['lat'], 'lon': v['lon'], 'elev_m': round(fs.raw(v['lon'], v['lat']), 2)}
    meta['spot_checks_m'] = spots
    meta['baked_at'] = time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())
    json.dump(meta, open(os.path.join(DATA, 'elevation.json'), 'w'), separators=(',', ':'))
    json.dump({'note': 'Rail design profiles on a 2 m horizontal-chainage grid along each geojson line '
                       '(chainage in game local metres, geojson stored order). y = rail bed − 0.35 m (ASL).',
               'lines': design}, open(os.path.join(DATA, 'track-design.json'), 'w'), separators=(',', ':'))
    log(f'done in {time.time()-t0:.0f}s')

if __name__ == '__main__':
    main()
