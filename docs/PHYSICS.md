# ION LRT Sim — wheel–rail physics and terrain (v1.4.5)

All constants live in [`src/game/Physics.ts`](../src/game/Physics.ts) (vehicle/rail) and [`src/game/Track.ts`](../src/game/Track.ts) (profile). Status key as in [CLEARANCES.md](CLEARANCES.md): **Sourced** = read in the cited document, **Sibling** = published for another Flexity model, **ESTIMATE** = no public source; reasonable engineering value.

## Adhesion and creep

| Item | Value | Status | Source |
|---|---|---|---|
| Speed shape of μ | dry 7.5/(v+44)+0.161, wet/contaminated …+0.130 (v km/h), normalised to 1 at standstill | Sourced | Curtius & Kniffler (1943/44) as reproduced in J.-M. Allenbach, *Electric Traction – Base Principles*, fig. 3.15 (traction-electrique.ch ResuTE31e); formula text from coalstonewcastle.com.au adhesion page |
| Peak μ at standstill: dry 0.30 / wet 0.22 | 0.30 / 0.22 | Sourced (range) | C&K dry μ(0)=0.33; typical dry 0.2–0.4 — RSSB *Managing Low Adhesion*, Integrail. **Wet raised 0.15 → 0.22 in v1.4.5** (≈ 0.14 at 70 km/h, was 0.098): tribometer-train wet ≈ 0.20 and Ontrak wet median 0.20 vs dry 0.31 (*Proc. IMechE Part F*, 2023, doi 10.1177/09544097231209483); "wet 0.25" in the classic adhesion literature (Advanced Steam Traction); FRA *A Survey of Wheel/Rail Friction* Table 1: design traction limits 0.17–0.20, braking 0.15 (Stockholm) / 0.09 (UK). 0.22 is the top of the design range, a deliberate design choice, not a measurement of ION |
| Snow / ice μ | 0.10 | ESTIMATE | Inside the 0.05–0.15 range quoted for contaminated rail; no ION measurement |
| Wet leaves μ | 0.05 | Sourced (range) | 0.015–0.05 — RDG / Ingenia "Leaves on the line" |
| Sanded μ: dry 0.35, wet 0.30, snow 0.18, leaf 0.12 | — | ESTIMATE | Conservative fractions of the laboratory sanded peaks (dry 0.4–0.5, wet 0.3–0.4, leaf 0.1–0.2; Skipper, Univ. Sheffield PhD and *Wear* 2024, doi 10.1016/j.wear.2024.205278; Meierhofer 0.3–0.4) |
| Sand delay 1 s, fade 3 s | — | ESTIMATE | — |
| Creep-force curve | rise 2x/(1+x²), peak at x = s/s_c = 1, falling branch to μ∞/μ0 = 0.40 | **Simplified Polach-style shape**; parameters ESTIMATE | This is **not** Polach's full model (no contact ellipse, spin or FASTSIM): only the asymptote μ∞/μ0 = A = 0.40 is taken from Polach 2005, *Wear* 258, "Creep forces in simulations of traction vehicles running on adhesion limit". The rising and falling functions are a simplification chosen to peak at s_c and tend to A |
| Critical creep s_c: dry 1.5 %, wet 2.5 %, snow 3.5 %, leaf 4 % | — | **ESTIMATE** | Order of magnitude from Polach/Kalker; **s_c is estimated**, there are no ION or Freedom measurements. It only sets where the peak sits, and slip control keeps the axles on the rising branch |
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
| Magnetic track brake on contaminated rail | × 0.6 (leaf, snow), × 0.8 (rain) | ESTIMATE | The brake does not use wheel–rail adhesion, but it needs clean rail head; leaves, snow and ice insulate it. The derating is a guess; the only qualitative source is the EN 16207 summary on railwaynews.net, which was not verified. Proc. IMechE Part F 2011, doi 10.1177/0954409711408375 treats the force as depending on the contact condition. Leaf emergency stop from 70 km/h: 86.8 m (v1.4.4) → 120.8 m |

### Jerk limits (v1.4.5)

v1.4.4 stepped every force in one frame (emergency 0 → −2.8 m/s² in 20 ms, a signal hold straight to notch 6, the final stop snapped to 0 at about −7.8 m/s²). Commands for traction, friction brake, track brake and hold brake now ramp in a shared time budget, and a stop follows v′ = −√(2·J·v) so deceleration reaches zero at rest with jerk J.

| Item | Value | Status | Source |
|---|---|---|---|
| Traction jerk | 1.34 m/s³ | Sourced | DART design criteria: 3.0 mphpsps. Inside the target range 0.8–1.5; RTD Denver 2024 §13.2.6.6 uses 2.0 m/s³ (+10 %) |
| Service-brake jerk | 1.2 m/s³ | Sourced | Yarra Trams braking specification §4.2.2.2 (≤ 1.2 m/s³); Megna et al., *Urban Rail Transit* 2022 (UNI ≤ 1.5 m/s³) |
| Emergency-brake jerk | 5 m/s³ | **ESTIMATE** | RTD says emergency braking is not jerk limited; EN 13452-1 §5.1.3 only defines a build-up time. Fast but not instant |
| Traction cut-out on emergency / interlock | immediate | Sourced | EN 13452-1 §5.1.3 |
| Overspeed penalty brake | service brake + traction cut at limit + 5 km/h, released at ≤ limit | **ESTIMATE** (margin) | No source found for the ION ATP margin; the margin is a placeholder |

Re-measured stops from 70 km/h on the flat: dry service 154.0 m (was 144.6), dry emergency 73.0 m (was 68.1), leaf service 260.4 m (was 257.2).

No ION/Freedom braking rate was found in any public document; the three rates above are from the sister Flexity Outlook and a TCRP cross-check.

## Speed limits and overspeed supervision (v1.4.5)

| Item | Value | Status | Source |
|---|---|---|---|
| Reserved ROW / street running / station | 70 / **50** / 25 km/h | Sourced (70, 50), ESTIMATE (25) | Wikipedia "Ion rapid transit": maximum operating speed 50 km/h along city streets and 70 km/h on railway rights of way (citing the Waterloo Region Record, 2017-12-19). v1.4.4 used an unsourced 40 for street running. The station value is an estimate |
| Vehicle maximum | 80 km/h (electric), 95 km/h (diesel) | as in v1.4.4 | — |
| Overspeed | penalty service brake and traction cut-out above limit + 5 km/h, latched until the speed is back at the limit; the vehicle maximum is supervised the same way (backstop 1.1 × vMax) | ATP-style behaviour; the +5 km/h margin is an **ESTIMATE** with no source | The HUD warning still shows at limit + 2 km/h. Signal amber intervals are sized for the street limit |

## Resistance

| Item | Value | Status | Source |
|---|---|---|---|
| Davis eq. 15 | R = 1.3 + 29/w + b·V + C·A·V²/(w·n) lb/ton, V mph | Sourced | Davis, *The Tractive Resistance of Electric Locomotives and Cars*, Gen. Electric Review, Oct 1926 (rosap.ntl.bts.gov/view/dot/79072) |
| Flexity: n = 6, b = 0.09 (single unit), C = 0.0024, A = 9.54 m² | ≈ 20 N/t standstill, 5.5 N/(m/s)², ≈ 5 kN at 80 km/h | Sourced coefficients, frontal area from Bombardier width × height | |
| Diesel + coach: n = 8, b = 0.045, C = 0.0024 / 0.00034, A ≈ 12.7 / 11.4 m² | ≈ 13 N/t, ≈ 8 N/(m/s)² | Coefficients sourced; vehicle areas ESTIMATE | |
| Curve resistance | 0.4 N/kN per degree (AREMA 0.8 lb/ton/°), D = 1746.4/R | Sourced | AREMA; cross-checked with Röckl 500/(R−30) N/kN (R = 100 m: 7.0 vs 7.1). Both are extrapolations below R ≈ 50 m (R = 25 m: 28 N/kN ≈ 15 kN on a 56 t car) — ESTIMATE there |
| Grade force | m·g·sinθ with grade = rise/run (tan θ): m·g·grade/√(1+grade²) | — | v1.4.4 stored sin θ in `Track.grade` and converted again; v1.4.5 stores true rise/run. Normal force is m·g·cosθ for traction and for brakes (v1.4.4 omitted it on the brake side) |

## Curves

TCRP Report 57 (*Track Design Handbook for LRT*, 2000) §3.2.5.2: Ea 100 mm desired / 150 mm absolute, Eu 75 mm (3 in) desired / **115 mm (4.5 in) absolute**, "equates to the 0.1 g limit"; §2.4.6.2: 0.1 g comfort, 0.03 g/s jerk (spirals). The sim posts the absolute limit (114 mm) with the TCRP 155 curve-speed formula V = √((Ea+Eu)·R/3.96) (mph, in, ft) = √(E[mm]·R[m]/11.8) km/h. Minimum radius 25 m: Bombardier brochure, Stage 2 ION EPR Table 4-2. v1.4.3's comment cited "TCRP 155 §3.2.4/3.2.6 3–4.5 in"; that wording could not be verified, so the comment now cites the TCRP 57 section that was read.

## Terrain

| Item | Value | Source |
|---|---|---|
| ION max grade | 6.0 % (min 0.5 %) | Stage 2 ION EPR §4, Table 4-2 (max set by traction and braking capability, weather included); LRV comparison chart 5–6 % (Wikipedia citing Metrolinx 2013) |
| Vertical curves | convex ≥ 122 m, concave ≥ 244 m | Transit Toronto, Flexity Freedom page |
| Sim design grade / cap | 4.5 % / 5 % | Kept: SRTM 30 m (45 m cells in this grid) cannot resolve the real ≤ 6 % pitches. From v1.4.5 the stored profile is projected onto 4.5 % (rise/run) after the final smoothing, so the cap and the data agree (v1.4.4: ≈ 300 m of SB up to 4.91 %) |

`node scripts/audit-terrain.mjs` results (v1.4.5): max rail grade 4.50 % on every route and direction, 0 m above 4.5 % (v1.4.4: 4.91 % SB, 4.79 % NB, 4.54 % spur, 4.80 % Guelph; 300 / 225 / 30 / 105 m above 4.5 %); minimum vertical radius 547 m crest / 738 m sag; forward and reverse profiles agree at the same ground point; rail stays within −4.9 / +6.9 m of the SRTM surface (cut / fill = bridges and embankments). The raw SRTM gradient along the alignment is much rougher (99th percentile 8–14 % over 30 m; max 14–21 %): this is why the profile is smoothed and clamped rather than used directly. Train pitch comes from rail points at ±½ truck wheelbase (`Articulation.ts`), not from the terrain mesh.

## Known limitations

- Freedom-specific motor power, tractive effort, braking and axle loads are unpublished; the traction curve (62 kN / 400 kW, the 4 × 100 kW of the Bombardier FLEXITY Outlook data sheet) and the brake rates are estimates or sibling data, labelled as such.
- The ±10 m chord curvature (used for curve resistance and roll) sees OSM polyline-vertex wiggles: on 4 % of the ION length it implies more than 0.1 g at the posted speed (max 0.24 g). The posted curve limit uses a 60 m-base radius (about two car lengths), which stays below 0.08 g everywhere. Smoothing the OSM plan geometry would change platform and signal layout, so it was left alone.
- The emergency brake has no driver control; it is applied by the vigilance penalty only.
- The overspeed margin (+ 5 km/h), the emergency jerk (5 m/s³), the rain track-brake factor (0.8) and the 0.22 wet μ are design choices, not measurements.
- The unverified secondary source for the track-brake contamination effect (EN 16207 via railwaynews.net) should be replaced with the standard itself.
