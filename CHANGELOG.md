# Changelog

## v1.5.0 — 2026-11-27

- **Cab view**: hide the opaque Flexity `windscreen` (`windscreen-glass` / `lrvGlassFront`, alpha 1)
  and cab-interior meshes in camMode 0, and place the seated right-hand eye at
  (0.28 m, floor + 1.62 m, 0.85 m behind the nose). The v1.4.9 eye sat behind that black glass.
- **Key capture**: while a run is active (and focus is not in an input/select/textarea), bound
  keys plus `/` and `'` call `preventDefault`, so Firefox find-as-you-type / quick-find cannot
  steal them. Ctrl/Meta, F5, F11 and F12 are left alone.
- **Braking** (ESTIMATE): service 1.3 m/s², emergency 2.8 m/s², emergency jerk 6 m/s³;
  regen fades out between 8 km/h and 2 km/h.
- **Haywire** scenario: no route speed-limit or vMax ATP penalty; HUD limit and next-limit show "—".
  Deep link `&scenario=haywire`. The 1.1× vMax backstop remains.
- **Road signals**: traffic-signal yaw follows the road/train axis (was 90° off). ION white-bar
  signals are placed on reserved ROW (vertical = proceed, horizontal = stop). Wayside speed boards
  are built at posted-limit changes, with advance boards on reductions. Next-limit HUD is wired.
- Wheel rumble follows speed; HVAC ambient; inverter is a sine (sawtooth only on the horn).
- Minimap shows the route, layout and upcoming stops.

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
