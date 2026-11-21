# Door sounds (TTC / ION tribute)

The cab sim plays an original synthesis of the ION door-close sequence, not a
recording. ION uses the same three-note close chime, in the same key, as TTC
streetcars (Flexity family). The T key starts a *full* (departure) close.

## Real sequence (from public descriptions)

1. **Warning / chime.** Two close modes exist on TTC streetcars:
   - *Soft close*: a single tone; door buttons and most sensors still reopen
     the leaf (used at signals or layovers).
   - *Full close*: the classic three-tone descending chime; buttons are locked
     out and the car is about to move. This is what T does in the sim.
2. **Pitches.** Public sources notate the close chime as **G–E–C** downward
   (concert G5–E5–C5 here: 783.99, 659.25, 523.25 Hz). An older subway
   variant was F–D–B♭, later raised a whole tone. The notes *sustain into
   each other*. A **single G** plays when the doors open.
3. **Motion.** After the chime is underway the electric plug/sliding doors
   unlatch, travel (~2 s in this model — Flexity leaflets do not publish a
   time), and seat against the seal with a thud. A short lock/interlock
   click follows; traction stays cut until that lock drops.
4. **ION practice.** GRT: press the door button when the lamp is green to
   board. The operator commands the departure close.

Sources (descriptions only — no audio was copied):

- Toronto Railway Historical Association, *Rhythms On The Railway* (Daniel
  Allen, 26 Dec 2022):
  https://www.trha.ca/rhythms-on-the-railway-notating-commonly-heard-sounds-on-railways-in-toronto-the-gta-and-southern-ontario/
- Metro Wiki, *Toronto Subway* (G–E–C close chime).
- SoundCloud notes on the former TTC-hosted reference tones (nomatteus,
  2012): notes are G, E, C downward.
- r/TTC threads on single-tone soft close vs three-tone full close
  (2022–2026).
- Nicholas Philipson, *Ranking Door Chimes in Canada* (26 Jun 2024): ION
  uses the TTC / Flexity close chime.
- YouTube description, *O-Train Door Closure Cycle Chimes* (Transittown,
  2023): ION “uses the same door closure chimes as the TTC streetcars in
  the exact same key.”
- Grand River Transit, *Riding the train*:
  https://www.grt.ca/rider-information/how-to-ride/riding-the-train/

## How the sim makes the sound

`src/game/DoorCycle.ts` holds the timings and a deterministic PCM renderer
(sine + light harmonics for the chime; coloured noise, a low actuator whir,
unlatch pop, seating thud, lock click for the mechanism).
`tools/audio/build_door_sfx.mjs` writes WAV/OGG for listening; the game
plays the same stems over Web Audio.

- **Cab view:** chime stays clear (in-car PA); mechanism is quieter and
  low-passed, and is spatialized at the platform-side doors mid-consist.
- **Chase / side camera:** mechanism is louder and brighter; the chime
  leaks more quietly from outside.

Licence of the rendered files: **CC0 1.0** (original synthesis, no
third-party samples). See `tools/audio/out/ATTRIBUTION.md`.

## Timings (seconds from T)

| Event | Close | Open |
| --- | --- | --- |
| Chime starts | 0.00 (G5–E5–C5, 0.30 s apart) | 0.00 (single G5) |
| Leaves start moving | 0.85 | 0.22 |
| Seated / end-stop | 2.85 | 2.02 |
| Interlock releases (close only) | 2.95 | (stays interlocked while open) |
