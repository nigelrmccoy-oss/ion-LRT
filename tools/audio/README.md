# Door SFX renderer

```
node tools/audio/build_door_sfx.mjs --out tools/audio/out
```

Writes WAV and OGG stems (mix, chime, mechanism) for the close and open
cycles. The algorithm lives in `src/game/DoorCycle.ts` and is the same one
the game plays. Output is CC0 original synthesis; see `out/ATTRIBUTION.md`
and `docs/DOOR-SFX.md`.
