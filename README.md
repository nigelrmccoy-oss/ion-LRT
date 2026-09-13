# ION LRT Simulator **v1.2**

**v1.1a** — real Flexity / WCR masses and traction, TTC-style door-close chime. Builds on v1.1 ROW/roads/signals.

Playable browser cab simulator of the Waterloo Region **ION LRT** (GrandLinq / Keolis / GRT tribute), plus the **CN Waterloo Spur / WCR to Elmira** and **Kitchener–Guelph** heavy-rail routes.

Built with **Vite + TypeScript + Three.js**. No Blender/Unity. No backend.

## Play (Windows)

Download the **v1.2** release zip from GitHub, unzip the whole folder, then double-click `ION LRT Simulator.exe` inside it. Keep the exe next to the other files in that folder.

Same game as this repo — not a fork. Rebuild the window after sim changes with `npm start`.

From source:

```bash
npm install
npm start
```

`npm start` builds the game and opens it in a desktop window.

## Quick start

```bash
npm install
npm run dev
```

Production build:

```bash
npm run build
npm run preview
```

## Controls

| Key | Action |
|-----|--------|
| W / ↑ | Power notch up |
| S / ↓ | Brake notch up |
| R | Reverser F → N → R |
| T | Doors (interlocked — no power when open) |
| Space | Horn |
| Shift | Sand (raises adhesion) |
| P | Pantograph (ION only) |
| C | Camera: cab / chase / trackside |
| Esc | Menu |
| Mouse | Look (click canvas to capture) |

**Street-running:** traffic signals cycle red/amber/green. Approaching slowly enables a short TSP wait then green bias (not always magically green). Running a red counts as a violation on the end-of-run report.

## Routes

1. **301 Fairway** — ION LRT Conestoga → Fairway (Flexity Freedom tribute)
2. **301 Conestoga** — reverse, with northbound-only stops
3. **WCR to Elmira** — Waterloo Spur diesel consist (Northfield → St. Jacobs → Elmira)
4. **Kitchener–Guelph** — CN/Metrolinx Guelph Sub diesel (Kitchener → Breslau → Guelph)

One-way ION platforms (baked into station lists):

- Southbound only: Willis Way, Victoria Park, Queen  
- Northbound only: Waterloo Public Square, Kitchener City Hall, Frederick  

## Physics notes

- Flexity Freedom **48.2 t empty** + ~8 t typical pax (56.2 t). Bo′2Bo′ (4 of 6 axles powered). Starting TE ~62 kN, ~320 kW at 750 V.
- WCR diesel **148 t** (RS-18 + coach); CN short consist **160 t**. Starting TE ~178 kN, ~1340 kW (adhesion-limited).
- Traction-effort vs speed; ION limited by **750 V DC** pantograph
- Doors: TTC-style 3-note chime + pneumatic close (Web Audio tribute, not a TTC recording)
- Adhesion μ ≈ 0.30 dry / 0.15 rain / 0.10 snow; sanding +0.08
- Wheelslip / wheel-slide when demanded TE **or brake** > μ × axle-load (same lamp; reduced effort)
- Vehicle vMax: Flexity 80 km/h, diesel ~95 km/h
- Davis resistance + **real DEM grade** + curve resistance
- Blended regen + friction brake model
- Simple vigilance timer (hold power/brake to reset)

Civil speed from **ROW class** (OSM-derived): reserved ~70, street ~40, station ~25 km/h. Curvature heuristic remains only as fallback where ROW samples are missing.

## Terrain & elevation (vertical scale = 1.0)

Heights come from **SRTM 30 m** tiles (`N43W081`, `N43W080` via AWS elevation-tiles-prod skadi HGT). **Metres are metres** — no Perlin hills, no vertical exaggeration.

Baked into the repo:

- `public/data/elevation.bin` — Float32 LE corridor heightfield (~45 m cells)
- `public/data/elevation.json` — bounds, resolution, track grade profiles, spot checks

### Spot-check elevations (m ASL, from baked DEM)

| Place | Elev (m) |
|-------|----------|
| Conestoga | 348.0 |
| Northfield | 338.9 |
| University of Waterloo | 338.0 |
| Uptown Waterloo | 326.5 |
| Downtown Kitchener | 332.4 |
| Block Line | 331.9 |
| Fairway | 329.5 |
| St. Jacobs | 330.4 |
| Elmira | 363.9 |
| Breslau | 313.6 |
| Guelph | 327.4 |

Rails sit on the DEM (+~0.35 m track bed). Grade physics uses the same track profile.

## Data sources

- **Alignment**: OpenStreetMap Overpass (`railway=light_rail` ION; Waterloo Spur; Metrolinx/CN Guelph Subdivision). Baked GeoJSON in `public/data/`.
- **Stations**: Wikipedia / GRT published coordinates, snapped to OSM track.
- **Elevation**: SRTM 30 m (see above).
- **Scenery**: OpenStreetMap landuse, parks, water, building footprints (extruded). **Stylized-realistic** — no Google Street View, Google Maps tiles, Apple Maps, or Look Around.
- **Roads / signals / ROW (v1.1)**: OpenStreetMap Overpass only.
  - `public/data/roads.geojson` — thinned highway network near the three rail corridors
  - `public/data/signals.json` — `highway=traffic_signals` / `crossing=traffic_signals` within ~40 m of ION
  - `public/data/crossings.json` — `railway=crossing` / `level_crossing` on ION, Spur, Guelph Sub
  - `public/data/row-segments.json` — ION samples (~40 m) classified `reserved` / `street` / `station`

ION OSM ways in this extract lack `embedded` / shared `highway` tags, so street vs reserved is derived from proximity to arterials named **King / Charles / Caroline** (verified KW mixed-running streets). Parallel reserved corridors (e.g. Northfield median, old CN ROW) stay `reserved`. ION street sections use traffic-signal TSP; Elmira/Guelph use crossing gates/flashers.

Re-bake scripts (optional): `scripts/bake-stations.mjs`, `scripts/bake-elevation-srtm.mjs`, `scripts/bake-scenery.mjs`, `scripts/bake-row-roads-signals.mjs`.

## Vehicle notes

- ION: 5-module Flexity-proportion LRV, silver/black/blue **tribute** livery (no official logos).
- Elmira / Guelph: simple diesel + coach consists (not Flexity on freight rails).

## Tests

```bash
npm test
```

Headless stress suite (`scripts/stress-test.mjs`) covers adhesion, vMax, interlocks, grades, civil/ROW limits, and red-signal violation helpers.

## Performance

World streams in ~400 m chunks with LOD-style culling (~±2 chunks). Roads are corridor-thinned (not every alley 2 km off the line). Mid-laptop target ~60 fps in cab view.

## License / attribution

Map data © OpenStreetMap contributors (ODbL). This is a fan-made simulator tribute, not an official GRT/GrandLinq/Keolis/Metrolinx/CN product.
