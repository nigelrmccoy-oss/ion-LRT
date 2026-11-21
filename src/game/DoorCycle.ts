/**
 * ION / TTC-style door cycle: timings, interlock state, and a deterministic
 * PCM renderer for the chime + plug-door mechanism.
 *
 * The three-note close chime is a tribute synthesis of the well-known TTC
 * descending G–E–C tones (same key as ION, which uses the TTC streetcar
 * chime). Notes and phrasing come from public descriptions, not from any
 * copyrighted recording.
 *
 * Sources (notes / meaning, not audio):
 * - Toronto Railway Historical Association, “Rhythms On The Railway” (2022):
 *   electronic tone; single G on open; descending G–E–C on close; notes
 *   sustain into each other. Older subway variant was F–D–B♭, later raised
 *   a whole tone.
 * - Metro Wiki, “Toronto Subway”: door-close chime is G–E–C.
 * - SoundCloud notes on the former TTC-hosted reference tones: G, E, C
 *   downward (nomatteus, 2012).
 * - r/TTC (2022–2026): streetcars/LRT have a single-tone *soft close*
 *   (buttons still reopen) and a three-tone *full close* for departure
 *   (buttons locked out). This sim’s T key is a full close.
 * - Nicholas Philipson, “Ranking Door Chimes in Canada” (2024) and an
 *   O-Train video description: ION uses the same close chime, same key,
 *   as TTC streetcars (Flexity family).
 * - GRT “Riding the train”: ION doors open on the request button when the
 *   light is green; the operator commands the departure close.
 *
 * Timing of the physical plug/slide (lead after the chime, ~2 s travel) is
 * a reasoned estimate from public Flexity door behaviour and EN 14752-style
 * LRV door cycles — Bombardier leaflets do not publish a close time.
 */

export const DOOR_SFX = {
  /** Concert-pitch G5, E5, C5 (Hz). */
  closeNotesHz: [783.991, 659.255, 523.251] as const,
  openNoteHz: 783.991,
  /** Onset-to-onset of the three close notes. */
  noteIntervalS: 0.30,
  /** Each close note rings long enough to overlap the next. */
  noteDurS: 0.72,
  lastNoteDurS: 0.95,
  openNoteDurS: 0.65,
  /** Doors start moving after the three-tone is clearly underway. */
  closeMotionStartS: 0.85,
  closeMotionDurS: 2.00,
  /** Brief pause after the leaves seat before the interlock releases. */
  closeLockDelayS: 0.10,
  openMotionStartS: 0.22,
  openMotionDurS: 1.80,
  sampleRate: 44100,
  /** Deterministic noise seed so renders and tests match. */
  seed: 0x10d00d5,
} as const;

export type DoorPhase = 'closed' | 'opening' | 'open' | 'closing';
export type DoorEvent =
  | 'close-chime'
  | 'close-motion'
  | 'close-thud'
  | 'close-locked'
  | 'open-chime'
  | 'open-motion'
  | 'open-done';

export function closeThudS(): number {
  return DOOR_SFX.closeMotionStartS + DOOR_SFX.closeMotionDurS;
}

export function closeLockedS(): number {
  return closeThudS() + DOOR_SFX.closeLockDelayS;
}

export function openDoneS(): number {
  return DOOR_SFX.openMotionStartS + DOOR_SFX.openMotionDurS;
}

export function closeRenderS(): number {
  return closeLockedS() + 0.25;
}

export function openRenderS(): number {
  return openDoneS() + 0.25;
}

function easeInOut(x: number): number {
  const t = Math.min(1, Math.max(0, x));
  return t < 0.5 ? 2 * t * t : 1 - ((-2 * t + 2) ** 2) / 2;
}

export class DoorCycle {
  phase: DoorPhase = 'closed';
  /** Time in the current opening/closing phase (seconds). */
  t = 0;
  private fired = new Set<DoorEvent>();

  resetClosed() {
    this.phase = 'closed';
    this.t = 0;
    this.fired.clear();
  }

  /** Traction stays cut until the leaves are seated and the lock has dropped. */
  get interlocked(): boolean {
    return this.phase !== 'closed';
  }

  /** 0 = fully closed, 1 = fully open. */
  get visualOpen(): number {
    if (this.phase === 'open') return 1;
    if (this.phase === 'closed') return 0;
    if (this.phase === 'closing') {
      if (this.t <= DOOR_SFX.closeMotionStartS) return 1;
      const u = (this.t - DOOR_SFX.closeMotionStartS) / DOOR_SFX.closeMotionDurS;
      return 1 - easeInOut(u);
    }
    if (this.t <= DOOR_SFX.openMotionStartS) return 0;
    const u = (this.t - DOOR_SFX.openMotionStartS) / DOOR_SFX.openMotionDurS;
    return easeInOut(u);
  }

  get canClose(): boolean {
    return this.phase === 'open';
  }

  get canOpen(): boolean {
    return this.phase === 'closed';
  }

  /** Begin a full (departure) close. Returns the start event, or null if ignored. */
  startClose(): DoorEvent | null {
    if (!this.canClose) return null;
    this.phase = 'closing';
    this.t = 0;
    this.fired.clear();
    this.fired.add('close-chime');
    return 'close-chime';
  }

  startOpen(): DoorEvent | null {
    if (!this.canOpen) return null;
    this.phase = 'opening';
    this.t = 0;
    this.fired.clear();
    this.fired.add('open-chime');
    return 'open-chime';
  }

  /** Advance the cycle. Returns any events that fire on this step. */
  tick(dt: number): DoorEvent[] {
    if (this.phase !== 'closing' && this.phase !== 'opening') return [];
    if (!(dt > 0)) return [];
    const prev = this.t;
    this.t += dt;
    const ev: DoorEvent[] = [];
    const cross = (name: DoorEvent, at: number) => {
      if (prev < at && this.t >= at && !this.fired.has(name)) {
        this.fired.add(name);
        ev.push(name);
      }
    };
    if (this.phase === 'closing') {
      cross('close-motion', DOOR_SFX.closeMotionStartS);
      cross('close-thud', closeThudS());
      cross('close-locked', closeLockedS());
      if (this.t >= closeLockedS()) this.phase = 'closed';
    } else {
      cross('open-motion', DOOR_SFX.openMotionStartS);
      cross('open-done', openDoneS());
      if (this.t >= openDoneS()) this.phase = 'open';
    }
    return ev;
  }
}

export type DoorStems = {
  chime: Float32Array;
  mech: Float32Array;
  mix: Float32Array;
  sampleRate: number;
};

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function envAD(t: number, attack: number, dur: number, release: number): number {
  if (t < 0 || t > dur) return 0;
  if (t < attack) return t / attack;
  const tail = dur - release;
  if (t > tail) return Math.max(0, 1 - (t - tail) / release);
  return 1;
}

/** Electronic chime voice: sine + modest harmonics, overlapping decay. */
function addChime(
  out: Float32Array,
  sr: number,
  t0: number,
  freq: number,
  dur: number,
  amp: number,
) {
  const attack = 0.016;
  const n = out.length;
  for (let i = 0; i < n; i++) {
    const t = i / sr - t0;
    if (t < 0 || t > dur) continue;
    let env: number;
    if (t < attack) env = t / attack;
    else {
      const u = t - attack;
      env = Math.exp(-2.4 * u) * 0.62 + Math.exp(-0.85 * u) * 0.38;
    }
    const ph = 2 * Math.PI * freq * t;
    const s = Math.sin(ph) + 0.18 * Math.sin(2 * ph) + 0.045 * Math.sin(3 * ph);
    out[i] += amp * env * s;
  }
}

function onePoleLp(prev: number, x: number, alpha: number): number {
  return prev + alpha * (x - prev);
}

/**
 * Render a full close or open to three stems (chime / mechanism / mix).
 * Mechanism = unlatch, electric plug-door slide, seating thud, lock click.
 */
export function renderDoorSfx(kind: 'close' | 'open', sampleRate: number = DOOR_SFX.sampleRate): DoorStems {
  const dur = kind === 'close' ? closeRenderS() : openRenderS();
  const n = Math.max(1, Math.floor(sampleRate * dur));
  const chime = new Float32Array(n);
  const mech = new Float32Array(n);
  const rand = mulberry32(DOOR_SFX.seed + (kind === 'close' ? 1 : 2));

  if (kind === 'close') {
    const notes = DOOR_SFX.closeNotesHz;
    notes.forEach((hz, i) => {
      const isLast = i === notes.length - 1;
      addChime(
        chime,
        sampleRate,
        i * DOOR_SFX.noteIntervalS,
        hz,
        isLast ? DOOR_SFX.lastNoteDurS : DOOR_SFX.noteDurS,
        0.22,
      );
    });
  } else {
    addChime(chime, sampleRate, 0, DOOR_SFX.openNoteHz, DOOR_SFX.openNoteDurS, 0.2);
  }

  const motionStart = kind === 'close' ? DOOR_SFX.closeMotionStartS : DOOR_SFX.openMotionStartS;
  const motionDur = kind === 'close' ? DOOR_SFX.closeMotionDurS : DOOR_SFX.openMotionDurS;
  const thudAt = motionStart + motionDur;

  // One-pole states for coloured noise (rollers / air).
  let lp = 0, bp = 0, lp2 = 0;
  const motorHz0 = kind === 'close' ? 92 : 108;
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate;
    const local = t - motionStart;
    if (local >= -0.02 && local <= motionDur + 0.05) {
      const u = local / motionDur;
      const slideEnv = envAD(local, 0.08, motionDur, 0.16);
      const white = rand() * 2 - 1;
      lp = onePoleLp(lp, white, 0.12);
      bp = onePoleLp(bp, white - lp, 0.35);
      lp2 = onePoleLp(lp2, lp, 0.08);
      // Roller / track noise (mid band) + soft air
      const rollers = bp * 0.07 * slideEnv;
      const air = lp * 0.04 * slideEnv;
      // Electric actuator whir, pitch eases through the stroke
      const motHz = motorHz0 + 28 * Math.sin(Math.min(1, Math.max(0, u)) * Math.PI);
      const motPh = 2 * Math.PI * motHz * local;
      const whir = (Math.sign(Math.sin(motPh)) * 0.55 + Math.sin(motPh * 2) * 0.2) * 0.03 * slideEnv;
      mech[i] += rollers + air + whir;
    }
  }

  // Unlatch / plug-out pop at motion start
  addImpact(mech, sampleRate, motionStart, {
    sweepFrom: 240,
    sweepTo: 70,
    dur: 0.07,
    amp: 0.11,
    clickHz: 2100,
    clickAmp: 0.05,
    noiseAmp: 0.06,
    rand,
  });

  // Seating thud + latch (close is heavier; open is a soft end-stop)
  addImpact(mech, sampleRate, thudAt, {
    sweepFrom: kind === 'close' ? 190 : 150,
    sweepTo: kind === 'close' ? 48 : 70,
    dur: kind === 'close' ? 0.11 : 0.08,
    amp: kind === 'close' ? 0.2 : 0.11,
    clickHz: kind === 'close' ? 1800 : 1600,
    clickAmp: kind === 'close' ? 0.07 : 0.04,
    noiseAmp: kind === 'close' ? 0.08 : 0.04,
    rand,
  });

  if (kind === 'close') {
    // Interlock relay after the leaves are seated
    addImpact(mech, sampleRate, closeLockedS(), {
      sweepFrom: 900,
      sweepTo: 400,
      dur: 0.03,
      amp: 0.04,
      clickHz: 3200,
      clickAmp: 0.045,
      noiseAmp: 0.02,
      rand,
    });
  }

  const mix = new Float32Array(n);
  let peak = 1e-6;
  for (let i = 0; i < n; i++) {
    mix[i] = chime[i] + mech[i];
    const a = Math.abs(mix[i]);
    if (a > peak) peak = a;
  }
  // Leave a little headroom; don't rewrite stems so tests can measure raw chime.
  if (peak > 0.89) {
    const g = 0.89 / peak;
    for (let i = 0; i < n; i++) mix[i] *= g;
  }
  return { chime, mech, mix, sampleRate };
}

function addImpact(
  out: Float32Array,
  sr: number,
  t0: number,
  opts: {
    sweepFrom: number;
    sweepTo: number;
    dur: number;
    amp: number;
    clickHz: number;
    clickAmp: number;
    noiseAmp: number;
    rand: () => number;
  },
) {
  const n = out.length;
  for (let i = 0; i < n; i++) {
    const t = i / sr - t0;
    if (t < 0 || t > opts.dur) continue;
    const u = t / opts.dur;
    const env = Math.exp(-7 * u) * (1 - u * 0.3);
    const hz = opts.sweepFrom * Math.pow(opts.sweepTo / opts.sweepFrom, u);
    const ph = 2 * Math.PI * (opts.sweepFrom * t + (hz - opts.sweepFrom) * t * 0.5);
    const tri = 2 * Math.abs(2 * ((ph / (2 * Math.PI)) % 1) - 1) - 1;
    out[i] += opts.amp * env * tri;
    if (t < 0.018) {
      const cenv = 1 - t / 0.018;
      out[i] += opts.clickAmp * cenv * Math.sin(2 * Math.PI * opts.clickHz * t);
      out[i] += opts.noiseAmp * cenv * (opts.rand() * 2 - 1);
    }
  }
}
