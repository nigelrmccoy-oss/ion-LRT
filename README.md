# ION LRT Simulator **v1.4**

Playable browser / Electron cab simulator of the Waterloo Region **ION LRT** (GrandLinq / Keolis / GRT tribute), plus the **CN Waterloo Spur / WCR to Elmira** and **Kitchener–Guelph** heavy-rail routes.

Built with **Vite + TypeScript + Three.js**. No Blender/Unity. No backend.

## What’s new in v1.4

- **Articulated Flexity Freedom**: 5 modules in the Bo′2Bo′ layout (power trucks under the cab modules, trailer truck under the centre module, two suspended modules). Every module is placed from the track spline at its truck/joint chainages, so the car bends through S-curves and stays inside its dynamic envelope (verified on a 25 m-radius S-curve in `npm test`).
- **Terrain-following**: per-module pitch from rail heights at the truck wheelsets, small roll from superelevation on ballasted curves (none in street running). Cab camera rides in cab A; chase cam follows the lead module.
- **No more clipping**: cut/fill corridor along every track. Formation level inside the bed, 2H:1V cut/fill slopes, and a bridge where the rail is ≥ 6 m above the DEM. A min-filtered terrain mesh sits under a fine corridor ribbon, so ground never pokes through the rails, ballast or train (checked over all 16 km of ION against the real DEM).
- **Draped roads / landuse**: roads are draped per-vertex on the rendered terrain surface with `polygonOffset`. Landuse, parks and water are painted into the terrain vertex colours, which removes the flat floating slabs. Building bases sit on the lowest ground under their footprint.
- **Fixed P7 dry SLIP / ~1 km/h creep** (route 301 near Northfield): curve resistance was ~40× too large (165 kN at R = 100 m vs 62 kN starting TE). It was also applied as a reversing force at standstill. Curve resistance is now AREMA-style (~0.4 N/kN per degree), standstill uses static friction, curvature is chord-smoothed, adhesion follows a Curtius–Kniffler speed curve, and the SLIP lamp is clearly dim when off. There is a regression test.
- **Clearances from public records**: vehicle size, platform height and edge offset, OCS wire height, track centres, pole and mast offsets, and TC E-05 freight clearances. Values and source URLs are in [`docs/CLEARANCES.md`](docs/CLEARANCES.md). Unsourced values are marked as estimates there.
- **Optional photoreal scenery**: Google Photorealistic 3D Tiles streamed through Cesium ion (asset 2275207) with `3d-tiles-renderer`. They are re-oriented onto the sim's local tangent plane (origin 43.45 N, −80.50 E) and auto-aligned vertically. Turn them on in the menu. Google Maps and data attribution is shown on screen. Without a token, or if loading fails, the sim falls back to OSM scenery.

## What was new in v1.3

- **P0 departure fix**: reverser key **R** cycles **Neutral → Forward → Reverse** (v1.2 incorrectly went N→Reverse, which clamps motion at s≈0 so the train never left the terminal).
- Interlock HUD banner (doors / Neutral / vigilance / pantograph / voltage).
- Skippable **controls tutorial** (menu checkbox).
- Optional **Cesium Ion** aerial imagery for KW via `VITE_CESIUM_ION_TOKEN` (fallback to OSM/DEM colours).
- Audio: inverter whine vs load; flange / wheel roar on curves.
- **Minimap** + next-station name with distance and ETA.
- Less boxy Flexity (rounded noses, roof curve, procedural PBR tribute textures — no Street View / Apple Maps).
- Electron: application menu removed so cab keys are not stolen.
- Esc: first press releases pointer lock; second opens menu.
- MSTS / Open Rails–inspired physics mapping documented below (SI units).

## Play (Windows)

```bash
cd C:\Users\Nigel\Documents\ion-LRT
git pull
npm install
npm start
```

`npm start` builds and opens the Electron window. For browser only: `npm run dev`.

### Cesium Ion (optional)

1. Copy `.env.example` → `.env.local` (gitignored).
2. Set `VITE_CESIUM_ION_TOKEN=` to your [Cesium Ion](https://ion.cesium.com/tokens) token.
3. Restart `npm start` / `npm run dev`.

**Never commit `.env.local` or the token.** Without a token the sim uses the existing DEM + stylized ground (fully playable).

With a token, the menu checkbox **Photoreal 3D scenery** loads Google Photorealistic 3D Tiles (Cesium ion asset 2275207). Your ion account must have that asset added (ion → Asset Depot → "Google Photorealistic 3D Tiles"). Usage is billed against your ion/Google quota. Tiles are streamed only (never cached to disk) and need an internet connection. The required **Google Maps** attribution and per-tile data credits are shown bottom-left while the option is on. Note: the token is compiled into the local `dist/` bundle by Vite (`dist/` and `release/` are gitignored), so do not share a build made with your token.

## Controls

| Key | Action |
|-----|--------|
| R | Reverser **N → F → R** |
| W / ↑ | Power notch up |
| S / ↓ | Brake notch up |
| T | Doors (interlocked — no power when open; only when stopped) |
| Space | Horn |
| Shift | Sand (raises adhesion) |
| P | Pantograph (ION only) |
| C | Camera: cab / chase / trackside |
| Esc | Release mouse, then menu |
| Mouse | Look (click canvas to capture) |

**Depart:** R until HUD shows **F**, doors closed, W to notch power. HUD shows why power is blocked if stuck.

## Routes

1. **301 Fairway** — ION LRT Conestoga → Fairway (Flexity Freedom tribute)
2. **301 Conestoga** — reverse, with northbound-only stops
3. **WCR to Elmira** — Waterloo Spur diesel
4. **Kitchener–Guelph** — CN/Metrolinx Guelph Sub diesel

## Physics (SI) & MSTS / Open Rails mapping

Internal model is SI (kg, m, s, N). Inspired by classic MSTS / Open Rails `.eng` / `.wag` notions:

| OR / MSTS-style idea | This sim (SI) |
|----------------------|---------------|
| Mass (t) | `massKg` (Flexity tare 48200 + ~8000 pax) |
| MaxPower / MaxForce | `maxTE()` — electric ~62 kN start, 320 kW @ 750 V; diesel ~178 kN / 1340 kW |
| NumWheels / adhesive weight | `axleFrac` (Flexity Bo′2Bo′ = 4/6) |
| Friction (Davis A/B/C) | `davisResistance()` N |
| MaxBrakeForce | brake notch × ~1.15 m/s² × mass, adhesion-capped |
| OreFriction / adhesion | `adhesionMu(weather, sanding)` |
| Pantograph / voltage | `pantographUp`, `lineVoltage` (TE=0 if down or &lt;500 V) |
| DirControl / reverser | `reverser` -1 / 0 / 1 — **no TE in Neutral** |
| Vigilance / deadman | `vigilanceTimer` / `deadmanOk` |
| Curve resistance | `curveResistance(curvature)` — 0.4 N/kN per degree of curve (AREMA-style), R ≥ 25 m |
| Adhesion vs speed | `adhesionAt(v)` — Curtius–Kniffler shape × weather μ |

Civil limits from ROW class: reserved ~70, street ~40, station ~25 km/h.

## Terrain & elevation

Heights from **SRTM 30 m** (vertical scale 1.0), corrected along every track by the cut/fill corridor in `src/game/Ground.ts`. Optional Cesium Ion World Imagery is textured onto ground chunks when a token is present. Optional Google Photorealistic 3D Tiles replace the OSM ground and buildings, while rails, OCS and stations stay.

Map / scenery data © OpenStreetMap contributors (ODbL). **No Google Street View, Apple Look Around, or map scrapes.** Photoreal tiles come only through the official Map Tiles API via Cesium ion, with on-screen attribution.

## Vehicle notes

ION: articulated 5-module Flexity Freedom (30.8 m × 2.65 m × 3.6 m, Bo′2Bo′) with procedural brushed/PBR tribute livery (no official logos). Module and truck positions are in `src/game/Clearances.ts` and the kinematics in `src/game/Articulation.ts`. Fan tribute; not GRT/GrandLinq art.

## Tests & build

```bash
npm test     # 66 headless checks: physics, ROW, signals, articulation swept path, terrain corridor
npm run build
```

## License / attribution

Map data © OpenStreetMap contributors (ODbL). Cesium Ion imagery © Cesium / Bing as provided by your Ion account when enabled. Photorealistic 3D Tiles © Google Maps and the data providers shown on screen, streamed via Cesium ion when enabled. Fan-made simulator — not an official GRT/GrandLinq/Keolis/Metrolinx/CN product.
