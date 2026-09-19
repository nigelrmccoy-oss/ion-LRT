# ION LRT Simulator **v1.3**

Playable browser / Electron cab simulator of the Waterloo Region **ION LRT** (GrandLinq / Keolis / GRT tribute), plus the **CN Waterloo Spur / WCR to Elmira** and **Kitchener–Guelph** heavy-rail routes.

Built with **Vite + TypeScript + Three.js**. No Blender/Unity. No backend.

## What’s new in v1.3

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
| Curve resistance | `curveResistance(curvature)` |

Civil limits from ROW class: reserved ~70, street ~40, station ~25 km/h.

## Terrain & elevation

Heights from **SRTM 30 m** (vertical scale 1.0). Optional Cesium Ion World Imagery textured onto ground chunks when a token is present.

Map / scenery data © OpenStreetMap contributors (ODbL). **No Google Street View, Apple Look Around, or proprietary map scrapes.**

## Vehicle notes

ION: 5-module Flexity-proportion LRV with rounded cabs and procedural brushed/PBR tribute livery (no official logos). Attribute: fan tribute; not GRT/GrandLinq art.

## Tests & build

```bash
npm test
npm run build
```

## License / attribution

Map data © OpenStreetMap contributors (ODbL). Cesium Ion imagery © Cesium / Bing as provided by your Ion account when enabled. Fan-made simulator — not an official GRT/GrandLinq/Keolis/Metrolinx/CN product.
