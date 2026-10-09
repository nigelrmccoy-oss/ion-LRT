# ION LRT Sim — Clearances & dimensions (v1.4)

All geometry constants live in [`src/game/Clearances.ts`](../src/game/Clearances.ts). This table lists each value, where it is used, and its public source.

**Status key**
- **Sourced**: taken directly from the cited public document.
- **Proxy**: from a public Ontario standard for the *same vehicle family* or a comparable LRT, because no ION-specific public value was found.
- **Secondary**: from a non-authoritative page (fan site or forum) that cites an official study.
- **ESTIMATE**: no public source found. The value is a reasonable engineering assumption and should be replaced if a primary source turns up.

No source in this file is invented. If a URL is listed, the value was read from that document while preparing v1.4 (Oct 2026).

## Vehicle: Bombardier/Alstom Flexity Freedom, 5-module (ION fleet)

| Item | Value used | Status | Source |
|---|---|---|---|
| Length over couplers | 30.8 m | Sourced | Bombardier *FLEXITY Freedom* brochure (5-module: 30.8 m / 101′) — https://www.yumpu.com/en/document/view/36987300/flexity-freedom-brochure |
| Carbody width | 2.65 m | Sourced | Same brochure; Region of Waterloo *Stage 2 ION EPR* §4.2.1 ("each car … 30 m long and 2.65 m wide") — https://www.regionofwaterloo.ca/media/zaypxkjg/stage-2-ion-final-epr_section-4_access.pdf |
| Height (over TOR, panto down) | 3.6 m | Sourced | Bombardier brochure (3.6 m / 11′9¾″) |
| Min. horizontal curve | 25 m | Sourced | Bombardier brochure ("Horizontal curve 25 m"); Stage 2 ION EPR Table 4-2 (LRT centreline radius, minimum 25.0 m) |
| Modules / wheel arrangement | 5 modules, Bo′2Bo′ (power trucks under end modules, centre trailer truck) | Sourced | Railway Gazette 2011, "end modules would be powered" — https://www.railwaygazette.com/urban/2011/10/04/freedom-takes-flexity-to-the-north-american-tram-market/ ; UIC Bo′2Bo′ (secondary) — https://en.wikipedia.org/wiki/Bombardier_Flexity_Freedom |
| Module lengths A/B/C/D/E | 6.44 / 7.30 / 3.33 / 7.30 / 6.44 m | ESTIMATE | Proportions scaled to 30.8 m from Bombardier's dimensioned 5-module FLEXITY Outlook (Palermo) sheet: 6763/7670/3500/7670/6763 mm — https://www.yumpu.com/en/document/view/28819203/pdf-download-flexity-2-bombardier |
| Truck centres from nose | 4.77 / 15.40 / 26.03 m | ESTIMATE | Same Outlook sheet (5013 / 11170 / 11170 / 5013 mm), scaled |
| Truck wheelbase | 1.85 m | ESTIMATE | Typical low-floor LRV truck. Not published for Freedom |
| Floor height at doors | 0.33 m ATR | ESTIMATE | Flexity Outlook low-floor entrance is 310 mm ATR (same sheet). Freedom value not published |
| Max speed | 80 km/h | Sourced | Bombardier brochure |
| Supply | 750 V DC overhead | Sourced | Bombardier brochure; Wikipedia (Ion) |

## Stations / platforms (ION)

| Item | Value used | Status | Source |
|---|---|---|---|
| Platform length | 65 m | Sourced | Stage 2 ION EPR §4.2.2 / Table 4-3 ("generally 65 m … consistent with Stage 1 ION stations") |
| Platform width (single direction) | 3.5 m (min 2.5) | Sourced | Stage 2 ION EPR Table 4-3 |
| Platform height above TOR | 0.30 m | Proxy + Secondary | Hamilton LRT TPAP update (City of Hamilton PED16171, Flexity-class level boarding): "approximately 300mm high above rail level" — https://www.thepublicrecord.ca/wp-content/uploads/2016/07/2016-Jul-26-Light-Rail-Transit-LRT-Transit-Project-Assessment-Process-TPAP-Update-PED16171.pdf . The fan site lrt.daxack.ca says ION platforms are about 20 cm above track — http://lrt.daxack.ca/Cities/RegionOfWaterloo/index.html . No ION primary document was found. |
| Track CL → platform edge | 1.40 m | Proxy | Metrolinx *LRT Design Criteria Manual* DCM-LRT-001 §B1.6.2 ("Track centre line to edge of passenger platform dimension is 1400 mm"). This covers the same Flexity Freedom fleet on Eglinton/Finch — https://assets.metrolinx.com/image/upload/Documents/Engineering/LRT_Design_Criteria_Manual_DCM_LRT-001_REV01.pdf |
| Tactile edge strip | 0.61 m | Proxy | Metrolinx DCM ("tactile warning strip 610 mm wide") |

## Overhead contact system (ION)

| Item | Value used | Status | Source |
|---|---|---|---|
| Contact wire, street / mixed ROW | 5.5 m above TOR | Proxy (+ Secondary agreement) | Metrolinx DCM §C1.6.2 nominal heights: 5500 mm semi-exclusive/mixed. The Waterloo Region Connected forum, quoting the Region's LRT study, gives 5.5 m as normal pantograph height (4.9/5.7/6.1 m special cases, 4.0 m absolute minimum) — https://www.waterlooregionconnected.com/showthread.php?pid=19189 |
| Contact wire, reserved ROW at grade | 4.8 m | Proxy | Metrolinx DCM §C1.6.2 (4800 mm exclusive ROW at-grade/elevated) |
| System type | simple catenary (messenger and contact wire), 750 V DC | Secondary | Waterloo Region Connected forum post (user KevinT, 2018) ("dual wire with a contact wire suspended from a messenger wire") — https://www.waterlooregionconnected.com/showthread.php?pid=58290 . The AECOM CCE Awards 2020 PDF (https://www.canadianconsultingengineer.com/awards/pdfs/2020/B-02_AECOMWaterlooLRT.pdf) returned HTTP 500 when re-checked, so it is not relied on here |
| Pole offset from track CL | max(2.9 m, dynamic-envelope half-width + 0.3 m) | ESTIMATE | Envelope from vehicle data above plus the DCM 50 mm margin. Real ION pole offsets are not published |
| Pole spacing | 50 m | ESTIMATE | Typical urban catenary span |
| Contact wire stagger | ±0.2 m | ESTIMATE | Typical. The DCM defines stagger but gives no value in the text reviewed |

## Track geometry & envelopes

| Item | Value used | Status | Source |
|---|---|---|---|
| ION double-track centres (reserved ROW) | 3.72 m | Proxy | Metrolinx DCM §B1.3.2 / §B1.6.5 ("3720 mm minimum between tangent track centre lines") |
| Envelope → obstruction margin | 0.05 m | Proxy | Metrolinx DCM §B1.6.5 ("50 mm minimum between LRV Dynamic Envelope and any physical element") |
| LRV body sway allowance | 0.10 m each side | ESTIMATE | Not published |
| Swept-path overthrow | computed from module geometry (end-throw / mid-chord sag on radius R) | Derived | Formula in `envelopeHalfWidth()`. 1.90 m half-width at R = 25 m |
| Max design grade | 6 % (sim clamps DEM noise at 5 %) | Sourced | Stage 2 ION EPR Table 4-2 (max grade 6.0 %, min 0.5 %) |
| Tangent between curves | 14 m min / 65 m preferred | Sourced (documented only) | Stage 2 ION EPR Table 4-2 |
| LRT runningway between curbs | 4.8 m min / 5.5 m preferred | Sourced (documented only) | Stage 2 ION EPR Table 4-2 |
| Gauge | 1435 mm | Sourced | Bombardier brochure |
| Superelevation (ballasted reserved curves) | ≤ 0.10 m, ~⅔ of equilibrium for the civil limit; 0 in street running | ESTIMATE | Typical LRT practice. Metrolinx DCM gives run-off ratios but no cap value in the text reviewed |
| Formation / ballast section | ballast top half-width 1.6 m, formation half-width 3.2 m, depth 0.45 m | ESTIMATE | Typical NA LRT section |
| Cut / fill slopes | 2H:1V | ESTIMATE | Typical. No ION earthworks drawing is public |
| Bridge instead of embankment | fill ≥ 6 m | ESTIMATE | Sim rule |
| Elevated structure width | ~10 m (two tracks + walkways) | Sourced (documented only) | Stage 2 ION EPR §4.2.12 ("typical cross-section is just under 10 m wide") |

## Heavy rail: CN / GEXR Waterloo Spur, CN Guelph Sub (Kitchener–Guelph)

| Item | Value used | Status | Source |
|---|---|---|---|
| Main-track centres | 3.96 m (13 ft) | Sourced | Transport Canada *Standards Respecting Railway Clearances* TC E-05 §5.1 — https://tc.canada.ca/en/rail-transportation/standards/standards-respecting-railway-clearance |
| Structure beside track, from CL | 2.546 m (8′-4¼″) | Sourced | TC E-05 Diagram 1 (Railway Association of Canada PDF of the standard) — https://www.railcan.ca/wp-content/uploads/2017/05/Standard-Respecting-Railway-Clearances_EN.pdf |
| Vertical clearance over TOR (non-electrified) | 6.706 m (22′-0″); 7.010 m (23′-0″) construction | Sourced | TC E-05 Diagram 1 |
| Abutment/pier face from CL | 5.486 m (18′) without, 7.925 m (26′) with maintenance road | Sourced (documented only) | TC E-05 Diagram 1 |
| Curve allowance | +25.4 mm per degree of curve | Sourced (documented only) | TC E-05 §3.1(e) |
| Crossing gate mast offset | 2.546 m + 1.0 m from CL | Sourced + ESTIMATE margin | TC E-05 Diagram 1 + sim margin |
| Station platform (GO-style) | 0.127 m ATR, edge 1.632 m from CL | Proxy | Metrolinx *Level Boarding* guideline Part 1 (127 mm ATR; 1632 mm horizontal edge) — https://assets.metrolinx.com/image/upload/v1743532185/Documents/Engineering/Level_Boarding_Part_1_REV01.pdf ; GTS-3004 — https://assets.metrolinx.com/image/upload/Documents/Engineering/GTS-3004_2.pdf |

## Physics constants touched in v1.4

| Item | Value | Status | Source |
|---|---|---|---|
| Curve resistance | 0.8 lb/short-ton per degree of curve (≈ 0.4 N/kN per degree, D = 1746.4 / R[m]) | ESTIMATE (commonly cited AREMA rule of thumb; not checked against the AREMA manual, which is not public) | — |
| Adhesion vs speed | Curtius–Kniffler shape, normalised to the weather μ at standstill | ESTIMATE (textbook curve form) | — |

## Not applied (and why)

- **Real ION pole-by-pole positions, the kinematic envelope drawing, and Stage 1 design-criteria tables** (GrandLinq Project Agreement Schedule 15-2): not publicly posted. The Stage 1 Region documents found online do not include them.
- **Bridge/underpass clearances at specific ION structures** (e.g. the King St grade separation): not modelled, because the sim has no road-over-rail structures. The TC E-05 values above are the ones that apply to the CN/GEXR lines.
- **Geoid undulation for photoreal alignment** (−36 m, ESTIMATE): any remaining error is removed at run time by aligning the tiles to the rail height under the train.
