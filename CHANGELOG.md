# Changelog

## v1.4.9 — 2026-11-21

- **Driver TCMS + traction-power panel**: cab HUD with speed/limit, ATP/LOS mode, signal and distance,
  next stop + ETA, doors (incl. *Doors closing* / *opening*), notches, lamps; secondary 750 V DC panel
  (line voltage, current, kW, aux, regen dump, EN 50163 band, nearest substation). 12 OSM-mapped TPSS
  sites baked from OpenStreetMap.
- **Door SFX + plug-door cycle**: G–E–C close chime, opening/closing phases, interlock timing; the HUD
  shows the closing phase.
- **Persistent map cache**: 16 GB IndexedDB + Electron LRU for map tiles.
- **Terrain from lidar**: NRCan HRDEM 1 m DTM (CGVD2013) — 2 m corridor layer (ION ±300 m, OMSF,
  heavy rail ±120 m) over a 25 m base grid, cross-faded (no seams). Rendered terrain vs independent
  lidar points: RMSE 0.27 m (0.15 m beyond 25 m from rails); baked DEM RMSE 0.025 m.
- **Rail design profiles** (`track-design.json`): bridge decks kept from OSM bridge=yes (DSM-checked),
  platforms straight at ≤ 1 %, ION grade ≤ 6 % (Stage 2 EPR Table 4-2), vertical curves ≥ 300 m.
  Physics grade clamp raised to 7 % so the real 6 % sections are felt.
- Drive-sim auto-driver: amber decision now uses the steepest fall to the stop line and brake build-up.
- On-screen attribution: © OpenStreetMap contributors (ODbL), NRCan HRDEM (OGL-Canada).
