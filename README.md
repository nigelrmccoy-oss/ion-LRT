# ION LRT Simulator **v1.4.2**

Playable browser / Electron cab simulator of the Waterloo Region **ION LRT** (GrandLinq / Keolis / GRT tribute), plus the **CN Waterloo Spur / WCR to Elmira** and **Kitchener–Guelph** heavy-rail routes.

Built with **Vite + TypeScript + Three.js**. No Blender/Unity. No backend.

## What’s new in v1.4.2 (end-to-end drive simulations)

`npm test` now drives every route end to end, headless: ION SB, ION NB, WCR to Elmira and Kitchener–Guelph, each in both directions, in dry, rain and snow (24 runs). The Flexity runs the ION routes and the diesel runs the heavy-rail routes. A simple automatic driver obeys the posted limits (ROW, curve and station), traffic signals and grades. It stops at every platform, works the doors with the hold brake, and handles wheelslip with sanding. Results are in [`docs/DRIVE-SIM-RESULTS.md`](docs/DRIVE-SIM-RESULTS.md) (`node scripts/drive-sim.mjs --write`). The runs exposed these bugs, now fixed:

- **Red-light bookings at intersections entered on green**: every OSM signal node had its own phase, so heads 5–10 m apart at one intersection disagreed. Heads are now grouped into intersections that share a phase.
- **Red-light rule**: a violation is now booked only when the train crosses the stop line on red. Before, any red within ±18 m counted, even after the train had already passed. The next stop line is no longer hidden by the one just passed.
- **TSP**: a granted green extension is now held until the train clears the stop line. Before, it was withdrawn when the train sped up past 25 km/h, which cut the light to amber or red. An extension can also no longer turn an amber back to green.
- **Amber interval**: it is now sized for an LRV, from the approach speed and the downhill grade (ITE kinematic formula with a 1.0 m/s² brake). The fixed 4 s amber made red bookings unavoidable at 40 km/h on the King St descent.
- **Signal distances on couplets and curves**: signals are now enforced along the line actually driven. Distances measured on the reference centreline stalled and then jumped, so a stop line looked 33 m away for 4 s.
- **Speed limits**: limits are now posted like lineside boards, with no section shorter than 20 m. Before, heavy rail had 1 m long 40 km/h "islands" at OSM vertex kinks, and curve limits stepped in a 70→50→40→30 staircase every few metres.
- **Vigilance**: the timer only runs while moving. A 45 s station dwell used to trigger the penalty brake.
- **Diesel consist**: the coach no longer hangs 26 m off the start of the line, and the nose no longer sticks 7.6 m past the end.
- **Heavy-rail stations from OSM**: Kitchener was 353 m off, St. Jacobs 344 m, and the Elmira stop sat at the end of the track about 1 km past the station. The WCR Farmers' Market stop is added. Breslau (not in OSM) and Guelph (the line data ends about 300 m short of Guelph Central) are flagged in `stations.json`.

## What was new in v1.4.1 (QA fixes)

- **P0 reversed elevation**: `Track.fromGeoJSON(..., reverse)` now reverses the stored height profile along with the vertices. v1.4.0 put Conestoga's heights at Fairway on the reversed route. Every route is checked against the DEM in both directions (`npm test` section o).
- **Real directional ION tracks**: southbound and northbound now run on their own OSM lines (`public/data/ion-sb.geojson`, `ion-nb.geojson`, baked by `scripts/bake-ion-tracks.mjs` from the direction-tagged OSM ways). Northbound no longer runs on the southbound rails. Both lines are rendered with their own ballast, rails and contact wire. Where they run side by side, NB rail height is blended onto SB so the double track shares one formation.
- **Platforms from OSM**: all 32 ION stops sit on their real OSM platform (`public/data/platforms.json`), on the correct side for the direction of travel. Platforms are curved strip meshes that follow the track (no more 14 m drift off a curve) and are kept clear of the other line. The stopping mark is the centre of the platform.
- **Curve speed restriction**: the posted limit also includes a curve limit from TCRP Report 155: V = √((Eₐ+Eᵤ)·R / 11.8) with a 114 mm cant + cant-deficiency budget. R is measured over a ±30 m chord.
- **Hold (standstill) brake**: it engages when the car stops (and always while the doors are open), so the car no longer rolls back on grades. W is ignored while traction is interlocked, so it no longer clears the brake. The HUD shows `HOLD`.
- **Diesel cab camera**: the diesel model was rebuilt facing forward with a hollow, glazed cab. The eye now sits in the cab, not inside the long hood.
- **Smoother ride**: the vertical profile is smoothed the same way in both directions (forward and reversed heights match exactly). Grade sawtooth is removed. Superelevation ramps in and out at ≤ 1:400.
- **Roads**: the terrain is sunk under draped roads, so ground no longer bleeds through. Street-running roads stay below the rail head near Central, rails use `polygonOffset`, and shadow bias is tuned to remove acne.
- **P2 polish**: minimap no longer overlaps the HUD; key presses are queued, so taps between frames are not lost; the destination sign is hidden in cab view; doors visibly slide open on the platform side; Cesium credits are removed when photoreal loading fails; the HUD resets on every run.
- **Debug deep links** (see below).

## What was new in v1.4

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

### Debug URL parameters

These work with `npm run dev`, e.g. `http://localhost:5173/?route=ion_northbound&s=4200&cam=chase`. A link with `route=` skips the menu and starts the run directly.

| Param | Values | Meaning |
|---|---|---|
| `route` | `ion_southbound` · `ion_northbound` · `elmira` · `guelph` | Route to start |
| `s` | metres | Start chainage along the route |
| `cam` | `cab` · `chase` · `side` (or `0`–`2`) | Initial camera |
| `dir` | `f` · `r` | Reverser preset (forward / reverse) |
| `station` | station id from `stations.json` | Start at that station (instead of `s`) |
| `weather` | `dry` · `rain` · `snow` | Weather |
| `tod` | `day` · `dusk` · `night` | Time of day |
| `tutorial` | `0` · `1` | Show the controls tutorial |

## Controls

| Key | Action |
|-----|--------|
| R | Reverser **N → F → R** |
| W / ↑ | Power notch up |
| S / ↓ | Brake notch up |
| T | Doors (only when stopped; open on the platform side; hold brake applied while open) |
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

Civil limits from ROW class: reserved ~70, street ~40, station ~25 km/h. Each limit is also capped by the curve limit (TCRP 155, 114 mm budget, 10 km/h minimum). A hold brake of 1.5 m/s² equivalent is applied at standstill (< 0.3 km/h with doors open).

## Terrain & elevation

Heights from **SRTM 30 m** (vertical scale 1.0), corrected along every track by the cut/fill corridor in `src/game/Ground.ts`. Optional Cesium Ion World Imagery is textured onto ground chunks when a token is present. Optional Google Photorealistic 3D Tiles replace the OSM ground and buildings, while rails, OCS and stations stay.

Map / scenery data © OpenStreetMap contributors (ODbL). **No Google Street View, Apple Look Around, or map scrapes.** Photoreal tiles come only through the official Map Tiles API via Cesium ion, with on-screen attribution.

## Vehicle notes

ION: articulated 5-module Flexity Freedom (30.8 m × 2.65 m × 3.6 m, Bo′2Bo′) with procedural brushed/PBR tribute livery (no official logos). Module and truck positions are in `src/game/Clearances.ts` and the kinematics in `src/game/Articulation.ts`. Fan tribute; not GRT/GrandLinq art.

## Tests & build

```bash
npm test     # 183 headless checks incl. 24 end-to-end drive simulations (4 routes × 2 directions × dry/rain/snow)
node scripts/drive-sim.mjs --write   # drive sims only; writes docs/DRIVE-SIM-RESULTS.md
npm run build
node scripts/bake-ion-tracks.mjs   # re-bake ION SB/NB lines + OSM platforms (Overpass; raw response cached in scripts/raw/)
```

## License / attribution

Map data © OpenStreetMap contributors, available under the Open Database License (ODbL, https://www.openstreetmap.org/copyright). The ION track and platform geometry in `public/data/ion-*.geojson` and `platforms.json` is derived from OSM and is ODbL. Cesium Ion imagery © Cesium / Bing as provided by your Ion account when enabled. Photorealistic 3D Tiles © Google Maps and the data providers shown on screen, streamed via Cesium ion when enabled. Fan-made simulator — not an official GRT/GrandLinq/Keolis/Metrolinx/CN product.
