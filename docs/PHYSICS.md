# ION LRT Sim — wheel–rail physics and terrain (v1.4.4)

All constants live in [`src/game/Physics.ts`](../src/game/Physics.ts) (vehicle/rail) and [`src/game/Track.ts`](../src/game/Track.ts) (profile). Status key as in [CLEARANCES.md](CLEARANCES.md): **Sourced** = read in the cited document, **Sibling** = published for another Flexity model, **ESTIMATE** = no public source; reasonable engineering value.

## Adhesion and creep

| Item | Value | Status | Source |
|---|---|---|---|
| Speed shape of μ | dry 7.5/(v+44)+0.161, wet/contaminated …+0.130 (v km/h), normalised to 1 at standstill | Sourced | Curtius & Kniffler (1943/44) as reproduced in J.-M. Allenbach, *Electric Traction – Base Principles*, fig. 3.15 (traction-electrique.ch ResuTE31e); formula text from coalstonewcastle.com.au adhesion page |
| Peak μ at standstill: dry 0.30 / wet 0.15 | 0.30 / 0.15 | Sourced (range) | C&K dry μ(0)=0.33; typical dry 0.2–0.4, wet clean rail 0.1–0.2 — RSSB *Managing Low Adhesion*, Integrail slip/slide glossary |
| Snow / ice μ | 0.10 | ESTIMATE | Inside the 0.05–0.15 range quoted for contaminated rail; no ION measurement |
| Wet leaves μ | 0.05 | Sourced (range) | 0.015–0.05 — RDG / Ingenia "Leaves on the line" |
| Sanded μ: dry 0.35, wet 0.25, snow 0.18, leaf 0.12 | — | ESTIMATE | Conservative fractions of the laboratory sanded peaks (dry 0.4–0.5, wet 0.3–0.4, leaf 0.1–0.2; Skipper, Univ. Sheffield PhD and *Wear* 2024, doi 10.1016/j.wear.2024.205278; Meierhofer 0.3–0.4) |
| Sand delay 1 s, fade 3 s | — | ESTIMATE | — |
| Creep-force curve | rise 2x/(1+x²), peak at x = s/s_c = 1, falling branch to μ∞/μ0 = 0.40 | Shape sourced, parameters partly ESTIMATE | μ∞/μ0 = A = 0.40 from Polach 2005, *Wear* 258, "Creep forces in simulations of traction vehicles running on adhesion limit" (dry and wet). The rising/falling functions are a simplification of Polach's model |
| Critical creep s_c: dry 1.5 %, wet 2.5 %, snow 3.5 %, leaf 4 % | — | ESTIMATE | Order of magnitude from Polach/Kalker; no ION data |
| Slip control holds 95 % (electric) / 85 % (diesel) of peak; WSP holds 90 % | — | ESTIMATE | Bombardier lists wheel-slip/slide control but no setpoints |
| Adhesive weight | 4/6 of mass (powered axles only) | ESTIMATE | Bo′2Bo′ with power trucks under end modules — Bombardier brochure 2011, Railway Gazette Oct 2011. Axle loads unpublished; module-length load split gives 0.655 |
| Rotating-mass factor | 1.08 | Sourced (range) | 1.06–1.10 for a complete train — Allenbach, fig. 3.13 |

## Brakes

| Item | Value | Status | Source |
|---|---|---|---|
| Service (B8) | 1.26 m/s² | Sibling | Bombardier FLEXITY Outlook (Innsbruck) data sheet. TCRP 13: service braking ≈ 3.0 mphps = 1.3 m/s² |
| Emergency total | 2.73 m/s² | Sibling | Same data sheet; DART criteria 4–6 mphps |
| Magnetic track brake | 1.47 m/s² (= emergency − service) | Sibling/derived | Bombardier lists a magnetic track brake on the Freedom, with no rate. Not adhesion-limited |
| Hold brake | 1.5 m/s² | ESTIMATE | — |

No ION/Freedom braking rate was found in any public document; the three rates above are from the sister Flexity Outlook and a TCRP cross-check.

## Resistance

| Item | Value | Status | Source |
|---|---|---|---|
| Davis eq. 15 | R = 1.3 + 29/w + b·V + C·A·V²/(w·n) lb/ton, V mph | Sourced | Davis, *The Tractive Resistance of Electric Locomotives and Cars*, Gen. Electric Review, Oct 1926 (rosap.ntl.bts.gov/view/dot/79072) |
| Flexity: n = 6, b = 0.09 (single unit), C = 0.0024, A = 9.54 m² | ≈ 20 N/t standstill, 5.5 N/(m/s)², ≈ 5 kN at 80 km/h | Sourced coefficients, frontal area from Bombardier width × height | |
| Diesel + coach: n = 8, b = 0.045, C = 0.0024 / 0.00034, A ≈ 12.7 / 11.4 m² | ≈ 13 N/t, ≈ 8 N/(m/s)² | Coefficients sourced; vehicle areas ESTIMATE | |
| Curve resistance | 0.4 N/kN per degree (AREMA 0.8 lb/ton/°), D = 1746.4/R | Sourced | AREMA; cross-checked with Röckl 500/(R−30) N/kN (R = 100 m: 7.0 vs 7.1). Both are extrapolations below R ≈ 50 m (R = 25 m: 28 N/kN ≈ 15 kN on a 56 t car) — ESTIMATE there |
| Grade force | m·g·sinθ, grade = rise/run | — | — |

## Curves

TCRP Report 57 (*Track Design Handbook for LRT*, 2000) §3.2.5.2: Ea 100 mm desired / 150 mm absolute, Eu 75 mm (3 in) desired / **115 mm (4.5 in) absolute**, "equates to the 0.1 g limit"; §2.4.6.2: 0.1 g comfort, 0.03 g/s jerk (spirals). The sim posts the absolute limit (114 mm) with the TCRP 155 curve-speed formula V = √((Ea+Eu)·R/3.96) (mph, in, ft) = √(E[mm]·R[m]/11.8) km/h. Minimum radius 25 m: Bombardier brochure, Stage 2 ION EPR Table 4-2. v1.4.3's comment cited "TCRP 155 §3.2.4/3.2.6 3–4.5 in"; that wording could not be verified, so the comment now cites the TCRP 57 section that was read.

## Terrain

| Item | Value | Source |
|---|---|---|
| ION max grade | 6.0 % (min 0.5 %) | Stage 2 ION EPR §4, Table 4-2 (max set by traction and braking capability, weather included); LRV comparison chart 5–6 % (Wikipedia citing Metrolinx 2013) |
| Vertical curves | convex ≥ 122 m, concave ≥ 244 m | Transit Toronto, Flexity Freedom page |
| Sim design grade / cap | 4.5 % / 5 % | Kept: SRTM 30 m (45 m cells in this grid) cannot resolve the real ≤ 6 % pitches |

`node scripts/audit-terrain.mjs` results (v1.4.4, `~/lrt-physics-logs/terrain-audit-baseline.log` on nigian): max rail grade 4.91 % (SB), 4.79 % (NB), 4.54 % (Elmira), 4.80 % (Guelph); minimum vertical radius 562 m crest / 738 m sag; forward and reverse profiles agree at the same ground point; rail stays within −4.9 / +6.9 m of the SRTM surface (cut / fill = bridges and embankments). The raw SRTM gradient along the alignment is much rougher (99th percentile 8–14 % over 30 m; max 14–21 %): this is why the profile is smoothed and clamped rather than used directly. Train pitch comes from rail points at ±½ truck wheelbase (`Articulation.ts`), not from the terrain mesh.

## Known limitations

- Freedom-specific motor power, tractive effort, braking and axle loads are unpublished; the traction curve (62 kN / 320 kW) and the brake rates are estimates or sibling data, labelled as such.
- The ±10 m chord curvature (used for curve resistance and roll) sees OSM polyline-vertex wiggles: on 4 % of the ION length it implies more than 0.1 g at the posted speed (max 0.24 g). The posted curve limit uses a 60 m-base radius (about two car lengths), which stays below 0.08 g everywhere. Smoothing the OSM plan geometry would change platform and signal layout, so it was left alone.
- The emergency brake has no driver control; it is applied by the vigilance penalty only.
