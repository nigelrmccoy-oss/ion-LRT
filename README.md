# ION LRT Simulator

Playable browser cab simulator of the Waterloo Region **ION LRT** (GrandLinq / Keolis / GRT tribute), plus the **CN Waterloo Spur / WCR to Elmira** and **Kitchener–Guelph** heavy-rail routes.

Built with **Vite + TypeScript + Three.js**. No Blender/Unity. No backend.

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

## Routes

1. **301 Fairway** — ION LRT Conestoga → Fairway (Flexity Freedom tribute)
2. **301 Conestoga** — reverse, with northbound-only stops
3. **WCR to Elmira** — Waterloo Spur diesel consist (Northfield → St. Jacobs → Elmira)
4. **Kitchener–Guelph** — CN/Metrolinx Guelph Sub diesel (Kitchener → Breslau → Guelph)

One-way ION platforms (baked into station lists):

- Southbound only: Willis Way, Victoria Park, Queen  
- Northbound only: Waterloo Public Square, Kitchener City Hall, Frederick  

## Physics notes

- Mass ~50 t (LRV) / ~80 t (diesel consist)
- Traction-effort vs speed; ION limited by **750 V DC** pantograph
- Adhesion μ ≈ 0.30 dry / 0.18 rain / 0.10 snow; sanding +0.08
- Wheelslip when demanded TE > μ × axle-load (lamp + audio; reduced accel)
- Davis resistance + **real DEM grade** + curve resistance
- Blended regen + friction brake model
- Simple vigilance timer (hold power/brake to reset)

Civil speed heuristics: reserved ~70, street/curve ~40, station ~25 km/h.

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
| Victoria Park | 331.9 |
| Fairway | 329.5 |
| St. Jacobs | 330.4 |
| Elmira | 363.9 |
| Breslau | 313.6 |
| Guelph | 327.4 |

Rails sit on the DEM (+~0.35 m track bed). Grade physics uses the same track profile.

## Data sources

- **Alignment**: OpenStreetMap Overpass (`railway=light_rail` ION; `CN Waterloo Spur`; Metrolinx/CN Guelph Subdivision). Baked GeoJSON in `public/data/`.
- **Stations**: Wikipedia / GRT published coordinates, snapped to OSM track.
- **Elevation**: SRTM 30 m (see above).
- **Scenery**: OpenStreetMap landuse, parks, water, building footprints (extruded). **Stylized-realistic** — no Google Street View, Google Maps tiles, Apple Maps, or Look Around.

Re-bake scripts (optional): `scripts/bake-stations.mjs`, `scripts/bake-elevation-srtm.mjs`, `scripts/bake-scenery.mjs`.

## Vehicle notes

- ION: 5-module Flexity-proportion LRV, silver/black/blue **tribute** livery (no official logos).
- Elmira / Guelph: simple diesel + coach consists (not Flexity on freight rails).

## Performance

World streams in ~400 m chunks with LOD-style culling (~±2 chunks). Mid-laptop target ~60 fps in cab view.

## License / attribution

Map data © OpenStreetMap contributors (ODbL). This is a fan-made simulator tribute, not an official GRT/GrandLinq/Keolis/Metrolinx/CN product.
