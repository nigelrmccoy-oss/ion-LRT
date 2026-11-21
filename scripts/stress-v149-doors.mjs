/**
 * Door-cycle ↔ sound timing, interlock, and chime-pitch checks (G5–E5–C5).
 */
import * as esbuild from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

async function bundleEntry(entry, name) {
  const dir = await mkdtemp(path.join(tmpdir(), `ion-lrt-${name}-`));
  const outfile = path.join(dir, `${name}.mjs`);
  await esbuild.build({
    entryPoints: [entry],
    outfile,
    format: 'esm',
    platform: 'neutral',
    bundle: true,
    logLevel: 'silent',
  });
  const mod = await import(pathToFileURL(outfile).href + `?t=${Date.now()}`);
  return { mod, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

/** Goertzel magnitude of `freq` over a sample window. */
function goertzel(samples, sr, freq) {
  const n = samples.length;
  if (n < 8) return 0;
  const w = 2 * Math.PI * freq / sr;
  const coeff = 2 * Math.cos(w);
  let s0 = 0, s1 = 0, s2 = 0;
  for (let i = 0; i < n; i++) {
    s0 = samples[i] + coeff * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  return Math.sqrt(s1 * s1 + s2 * s2 - coeff * s1 * s2);
}

function sliceByTime(buf, sr, t0, t1) {
  const a = Math.max(0, Math.floor(t0 * sr));
  const b = Math.min(buf.length, Math.floor(t1 * sr));
  return buf.subarray(a, Math.max(a + 1, b));
}

function rms(buf) {
  let s = 0;
  for (let i = 0; i < buf.length; i++) s += buf[i] * buf[i];
  return Math.sqrt(s / Math.max(1, buf.length));
}

export async function v149DoorTests(assert) {
  const { mod, cleanup } = await bundleEntry(
    path.join(root, 'src/game/DoorCycle.ts'),
    'DoorCycle149',
  );
  const {
    DoorCycle,
    DOOR_SFX,
    closeThudS,
    closeLockedS,
    openDoneS,
    renderDoorSfx,
  } = mod;

  const dt = 1 / 30;

  // --- rest state ---
  {
    const d = new DoorCycle();
    assert('doors. rest phase is closed', d.phase === 'closed');
    assert('doors. rest is not interlocked', d.interlocked === false);
    assert('doors. rest visual is 0', d.visualOpen === 0);
    assert('doors. rest can open, cannot close', d.canOpen && !d.canClose);
    assert('doors. tick at rest is empty', d.tick(dt).length === 0);
  }

  // --- close sequence timing + interlock ---
  {
    const d = new DoorCycle();
    d.phase = 'open';
    const start = d.startClose();
    assert('doors. startClose fires close-chime', start === 'close-chime');
    assert('doors. close begins interlocked with doors still visually open',
      d.interlocked && d.phase === 'closing' && d.visualOpen === 1);
    assert('doors. cannot reopen or re-close mid-cycle', !d.canOpen && !d.canClose && d.startClose() === null);

    let sawMotion = false, sawThud = false, sawLock = false;
    let tMotion = null, tThud = null, tLock = null;
    let midVisual = null;
    const tEnd = closeLockedS() + 0.5;
    for (let t = 0; t < tEnd; t += dt) {
      const ev = d.tick(dt);
      const now = d.t;
      if (ev.includes('close-motion')) { sawMotion = true; tMotion = now; }
      if (ev.includes('close-thud')) { sawThud = true; tThud = now; }
      if (ev.includes('close-locked')) { sawLock = true; tLock = now; }
      if (tMotion && !tThud && midVisual == null && now > DOOR_SFX.closeMotionStartS + 0.6) {
        midVisual = d.visualOpen;
      }
      if (!tLock) {
        if (!d.interlocked) {
          assert('doors. stayed interlocked until lock', false, `unlocked early at t=${now.toFixed(3)}`);
          break;
        }
      }
    }
    assert('doors. close-motion fires', sawMotion);
    assert('doors. close-thud fires', sawThud);
    assert('doors. close-locked fires', sawLock);
    assert('doors. motion starts at closeMotionStartS (± dt)',
      tMotion != null && Math.abs(tMotion - DOOR_SFX.closeMotionStartS) <= dt + 1e-6,
      `t=${tMotion}`);
    assert('doors. thud at end of travel (± dt)',
      tThud != null && Math.abs(tThud - closeThudS()) <= dt + 1e-6,
      `t=${tThud}`);
    assert('doors. lock after thud (± dt)',
      tLock != null && Math.abs(tLock - closeLockedS()) <= dt + 1e-6,
      `t=${tLock}`);
    assert('doors. mid-close visual is between 0 and 1',
      midVisual != null && midVisual > 0.05 && midVisual < 0.95,
      `visual=${midVisual}`);
    assert('doors. chime leads the motion (motion after 2nd note)',
      DOOR_SFX.closeMotionStartS > DOOR_SFX.noteIntervalS * 2);
    assert('doors. motion starts while the last note is still ringing',
      DOOR_SFX.closeMotionStartS < DOOR_SFX.noteIntervalS * 2 + DOOR_SFX.lastNoteDurS);
    assert('doors. after lock: closed, free, visual 0',
      d.phase === 'closed' && !d.interlocked && d.visualOpen === 0);
  }

  // --- open sequence ---
  {
    const d = new DoorCycle();
    const start = d.startOpen();
    assert('doors. startOpen fires open-chime', start === 'open-chime');
    assert('doors. opening is interlocked from t=0', d.interlocked && d.phase === 'opening' && d.visualOpen === 0);

    let sawMotion = false, sawDone = false, tMotion = null, tDone = null;
    let midVisual = null;
    for (let t = 0; t < openDoneS() + 0.5; t += dt) {
      const ev = d.tick(dt);
      if (ev.includes('open-motion')) { sawMotion = true; tMotion = d.t; }
      if (ev.includes('open-done')) { sawDone = true; tDone = d.t; }
      if (tMotion && !tDone && midVisual == null && d.t > DOOR_SFX.openMotionStartS + 0.5) {
        midVisual = d.visualOpen;
      }
      if (!tDone && !d.interlocked) {
        assert('doors. stayed interlocked until open-done', false, `t=${d.t.toFixed(3)}`);
        break;
      }
    }
    assert('doors. open-motion fires', sawMotion);
    assert('doors. open-done fires', sawDone);
    assert('doors. open motion at openMotionStartS (± dt)',
      tMotion != null && Math.abs(tMotion - DOOR_SFX.openMotionStartS) <= dt + 1e-6,
      `t=${tMotion}`);
    assert('doors. open done at openDoneS (± dt)',
      tDone != null && Math.abs(tDone - openDoneS()) <= dt + 1e-6,
      `t=${tDone}`);
    assert('doors. mid-open visual is between 0 and 1',
      midVisual != null && midVisual > 0.05 && midVisual < 0.95,
      `visual=${midVisual}`);
    assert('doors. after open-done: open, still interlocked, visual 1',
      d.phase === 'open' && d.interlocked && Math.abs(d.visualOpen - 1) < 1e-9);
  }

  // --- physics interlock follows the cycle (same rule Game uses) ---
  {
    const { mod: Pmod, cleanup: cP } = await bundleEntry(
      path.join(root, 'src/game/Physics.ts'),
      'Physics149',
    );
    const p = new Pmod.TrainPhysics({
      massKg: Pmod.MASS_FLEXITY_KG,
      weather: 'dry',
      electric: true,
      axleFrac: Pmod.AXLE_FRAC_FLEXITY,
    });
    p.reverser = 1;
    p.powerNotch = 8;
    p.brakeNotch = 0;
    const d = new DoorCycle();
    d.phase = 'open';
    d.startClose();
    let teWhileClosing = 0;
    for (let t = 0; t < closeLockedS() - dt; t += dt) {
      d.tick(dt);
      p.doorsOpen = d.interlocked;
      p.doorPhase = d.phase;
      const r = p.step(dt, 0, 0);
      teWhileClosing = Math.max(teWhileClosing, Math.abs(r.te));
    }
    assert('doors. no tractive effort while closing (interlocked)', teWhileClosing === 0,
      `te=${teWhileClosing}`);
    assert('doors. banner during close is “Doors closing”',
      p.powerBlockedReason() === 'Doors closing');
    d.tick(dt * 4);
    p.doorsOpen = d.interlocked;
    p.doorPhase = d.phase;
    p.speed = 0;
    const r = p.step(dt, 0, 0);
    assert('doors. after lock, cycle is free and physics no longer reports doors',
      !d.interlocked && d.phase === 'closed' && p.powerBlockedReason() !== 'Doors closing'
      && p.powerBlockedReason() !== 'Doors open — close with T',
      `phase=${d.phase} reason=${p.powerBlockedReason()}`);
    // Give it a moment of power after unlock — should produce TE now that doors are locked
    p.holdBrake = false;
    p.brakeNotch = 0;
    p.powerNotch = 8;
    let te = 0;
    for (let i = 0; i < 30; i++) te = Math.max(te, Math.abs(p.step(dt, 0, 0).te));
    assert('doors. traction returns after close-locked', te > 0, `te=${te}`);
    await cP();
  }

  // --- published pitches, and the rendered chime matches them ---
  {
    const [g5, e5, c5] = DOOR_SFX.closeNotesHz;
    assert('doors. close notes are G5 E5 C5 (±0.5 Hz)',
      Math.abs(g5 - 783.991) < 0.5 && Math.abs(e5 - 659.255) < 0.5 && Math.abs(c5 - 523.251) < 0.5,
      JSON.stringify(DOOR_SFX.closeNotesHz));
    assert('doors. open note is G5 (±0.5 Hz)', Math.abs(DOOR_SFX.openNoteHz - 783.991) < 0.5);

    const close = renderDoorSfx('close', 44100);
    const open = renderDoorSfx('open', 44100);
    const sr = close.sampleRate;
    const win = 0.22;
    const peaks = DOOR_SFX.closeNotesHz.map((hz, i) => {
      const t0 = i * DOOR_SFX.noteIntervalS + 0.03;
      const sl = sliceByTime(close.chime, sr, t0, t0 + win);
      return {
        target: goertzel(sl, sr, hz),
        g5: goertzel(sl, sr, 783.991),
        e5: goertzel(sl, sr, 659.255),
        c5: goertzel(sl, sr, 523.251),
        // the old v1.1a voice started on E6 — must not be the intended pitch
        e6: goertzel(sl, sr, 1318.5),
      };
    });
    assert('doors. 1st close note is G5 (stronger than E5/C5/E6)',
      peaks[0].g5 > peaks[0].e5 && peaks[0].g5 > peaks[0].c5 && peaks[0].g5 > peaks[0].e6 * 2,
      JSON.stringify(peaks[0]));
    assert('doors. 2nd close note is E5 (stronger than G5/C5/E6)',
      peaks[1].e5 > peaks[1].g5 && peaks[1].e5 > peaks[1].c5 && peaks[1].e5 > peaks[1].e6 * 2,
      JSON.stringify(peaks[1]));
    assert('doors. 3rd close note is C5 (stronger than G5/E5/E6)',
      peaks[2].c5 > peaks[2].g5 && peaks[2].c5 > peaks[2].e5 && peaks[2].c5 > peaks[2].e6 * 2,
      JSON.stringify(peaks[2]));

    const openWin = sliceByTime(open.chime, sr, 0.02, 0.35);
    const openG = goertzel(openWin, sr, 783.991);
    const openE = goertzel(openWin, sr, 659.255);
    assert('doors. open chime is a single G5', openG > openE * 2, `G=${openG.toFixed(1)} E=${openE.toFixed(1)}`);

    // Mechanism energy should be near-silent during the chime lead, then rise when motion starts
    const pre = rms(sliceByTime(close.mech, sr, 0.05, 0.6));
    const mid = rms(sliceByTime(close.mech, sr, DOOR_SFX.closeMotionStartS + 0.2, DOOR_SFX.closeMotionStartS + 1.0));
    const thud = rms(sliceByTime(close.mech, sr, closeThudS() - 0.01, closeThudS() + 0.12));
    assert('doors. close mechanism is quiet during the chime lead', pre < mid * 0.45,
      `pre=${pre.toFixed(4)} mid=${mid.toFixed(4)}`);
    assert('doors. close mechanism is audible during the slide', mid > 0.005, `mid=${mid.toFixed(4)}`);
    assert('doors. seating thud is a distinct bump', thud > mid * 0.8, `thud=${thud.toFixed(4)} mid=${mid.toFixed(4)}`);

    const openPre = rms(sliceByTime(open.chime, sr, 0.0, 0.2));
    const openMech = rms(sliceByTime(open.mech, sr, DOOR_SFX.openMotionStartS + 0.2, DOOR_SFX.openMotionStartS + 1.0));
    assert('doors. open has a chime and a slide', openPre > 0.01 && openMech > 0.004,
      `chime=${openPre.toFixed(4)} mech=${openMech.toFixed(4)}`);

    // Deterministic render
    const close2 = renderDoorSfx('close', 44100);
    let same = close.mix.length === close2.mix.length;
    if (same) {
      for (let i = 0; i < close.mix.length; i++) {
        if (close.mix[i] !== close2.mix[i]) { same = false; break; }
      }
    }
    assert('doors. renderer is deterministic', same);
  }

  await cleanup();
}
