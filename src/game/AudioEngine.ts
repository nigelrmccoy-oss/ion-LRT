import { renderDoorSfx } from './DoorCycle';

/**
 * Web Audio cab sounds: inverter whine scales with load; flange/wheel roar on curves.
 * Door chime + plug-door mechanism are a tribute synthesis (see DoorCycle.ts).
 */
export class AudioEngine {
  private ctx: AudioContext | null = null;
  private slipOsc: OscillatorNode | null = null;
  private slipGain: GainNode | null = null;
  private motorGain: GainNode | null = null;
  private motorOsc: OscillatorNode | null = null;
  private invOsc: OscillatorNode | null = null;
  private invGain: GainNode | null = null;
  private flangeGain: GainNode | null = null;
  private flangeSrc: AudioBufferSourceNode | null = null;
  private flangeFilter: BiquadFilterNode | null = null;
  private roarGain: GainNode | null = null;
  private roarSrc: AudioBufferSourceNode | null = null;
  private doorChimeGain: GainNode | null = null;
  private doorMechGain: GainNode | null = null;
  private doorMechFilter: BiquadFilterNode | null = null;
  private doorPanner: PannerNode | null = null;
  private doorBufs: {
    close?: { chime: AudioBuffer; mech: AudioBuffer };
    open?: { chime: AudioBuffer; mech: AudioBuffer };
  } = {};
  private doorPlaying: AudioBufferSourceNode[] = [];

  ensure() {
    if (!this.ctx) {
      this.ctx = new AudioContext();
      this.motorGain = this.ctx.createGain();
      this.motorGain.gain.value = 0;
      this.motorOsc = this.ctx.createOscillator();
      this.motorOsc.type = 'sawtooth';
      this.motorOsc.frequency.value = 60;
      this.motorOsc.connect(this.motorGain).connect(this.ctx.destination);
      this.motorOsc.start();

      // Inverter / traction whine (higher pitch, load-sensitive)
      this.invGain = this.ctx.createGain();
      this.invGain.gain.value = 0;
      this.invOsc = this.ctx.createOscillator();
      this.invOsc.type = 'sine';
      this.invOsc.frequency.value = 480;
      const invShaper = this.ctx.createBiquadFilter();
      invShaper.type = 'bandpass';
      invShaper.frequency.value = 900;
      invShaper.Q.value = 4;
      this.invOsc.connect(invShaper).connect(this.invGain).connect(this.ctx.destination);
      this.invOsc.start();

      this.startNoiseLoops();
      this.startDoorBus();
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume();
  }

  private startDoorBus() {
    const ctx = this.ctx!;
    this.doorChimeGain = ctx.createGain();
    this.doorChimeGain.gain.value = 0.9;
    this.doorChimeGain.connect(ctx.destination);

    this.doorMechFilter = ctx.createBiquadFilter();
    this.doorMechFilter.type = 'lowpass';
    this.doorMechFilter.frequency.value = 8000;
    this.doorMechFilter.Q.value = 0.7;
    this.doorPanner = ctx.createPanner();
    this.doorPanner.panningModel = 'equalpower';
    this.doorPanner.distanceModel = 'inverse';
    this.doorPanner.refDistance = 6;
    this.doorPanner.maxDistance = 80;
    this.doorPanner.rolloffFactor = 1.1;
    this.doorMechGain = ctx.createGain();
    this.doorMechGain.gain.value = 0.4;
    this.doorMechGain
      .connect(this.doorMechFilter)
      .connect(this.doorPanner)
      .connect(ctx.destination);

    this.cacheDoorBuffers();
  }

  private cacheDoorBuffers() {
    const ctx = this.ctx!;
    const toBuf = (data: Float32Array, sr: number) => {
      const buf = ctx.createBuffer(1, data.length, sr);
      buf.copyToChannel(data, 0);
      return buf;
    };
    for (const kind of ['close', 'open'] as const) {
      const stems = renderDoorSfx(kind, ctx.sampleRate);
      this.doorBufs[kind] = {
        chime: toBuf(stems.chime, stems.sampleRate),
        mech: toBuf(stems.mech, stems.sampleRate),
      };
    }
  }

  /**
   * Place the listener at the camera and balance cab vs exterior door levels.
   * Cab: the PA chime stays clear; the mechanism is quieter and muffled (doors
   * are down the consist). Exterior / platform side-cam: mechanism is louder.
   */
  setListener(
    camMode: 0 | 1 | 2,
    pos: { x: number; y: number; z: number },
    fwd: { x: number; y: number; z: number },
    up: { x: number; y: number; z: number },
    doorPos?: { x: number; y: number; z: number },
  ) {
    if (!this.ctx) return;
    const l = this.ctx.listener;
    const t = this.ctx.currentTime;
    if (l.positionX) {
      l.positionX.setTargetAtTime(pos.x, t, 0.05);
      l.positionY.setTargetAtTime(pos.y, t, 0.05);
      l.positionZ.setTargetAtTime(pos.z, t, 0.05);
      l.forwardX.setTargetAtTime(fwd.x, t, 0.05);
      l.forwardY.setTargetAtTime(fwd.y, t, 0.05);
      l.forwardZ.setTargetAtTime(fwd.z, t, 0.05);
      l.upX.setTargetAtTime(up.x, t, 0.05);
      l.upY.setTargetAtTime(up.y, t, 0.05);
      l.upZ.setTargetAtTime(up.z, t, 0.05);
    }
    if (this.doorPanner && doorPos && this.doorPanner.positionX) {
      this.doorPanner.positionX.setTargetAtTime(doorPos.x, t, 0.08);
      this.doorPanner.positionY.setTargetAtTime(doorPos.y, t, 0.08);
      this.doorPanner.positionZ.setTargetAtTime(doorPos.z, t, 0.08);
    }
    if (!this.doorChimeGain || !this.doorMechGain || !this.doorMechFilter) return;
    // 0 = cab, 1 = chase, 2 = trackside / platform
    const chime = camMode === 0 ? 0.95 : camMode === 1 ? 0.42 : 0.72;
    const mech = camMode === 0 ? 0.32 : camMode === 1 ? 1.0 : 1.15;
    const lp = camMode === 0 ? 2800 : 14000;
    this.doorChimeGain.gain.setTargetAtTime(chime, t, 0.08);
    this.doorMechGain.gain.setTargetAtTime(mech, t, 0.08);
    this.doorMechFilter.frequency.setTargetAtTime(lp, t, 0.08);
  }

  private playDoor(kind: 'close' | 'open') {
    this.ensure();
    const ctx = this.ctx!;
    const bufs = this.doorBufs[kind];
    if (!bufs || !this.doorChimeGain || !this.doorMechGain) return;
    for (const s of this.doorPlaying) {
      try { s.stop(); } catch { /* already ended */ }
    }
    this.doorPlaying = [];
    const start = (buf: AudioBuffer, dest: AudioNode) => {
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.connect(dest);
      src.start();
      src.onended = () => {
        this.doorPlaying = this.doorPlaying.filter((x) => x !== src);
      };
      this.doorPlaying.push(src);
    };
    start(bufs.chime, this.doorChimeGain);
    start(bufs.mech, this.doorMechGain);
  }

  private noiseBuffer(seconds: number): AudioBuffer {
    const ctx = this.ctx!;
    const buf = ctx.createBuffer(1, Math.floor(ctx.sampleRate * seconds), ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    return buf;
  }

  private startNoiseLoops() {
    const ctx = this.ctx!;
    // Flange screech (band-passed noise)
    this.flangeGain = ctx.createGain();
    this.flangeGain.gain.value = 0;
    this.flangeFilter = ctx.createBiquadFilter();
    this.flangeFilter.type = 'bandpass';
    this.flangeFilter.frequency.value = 2200;
    this.flangeFilter.Q.value = 6;
    this.flangeSrc = ctx.createBufferSource();
    this.flangeSrc.buffer = this.noiseBuffer(2);
    this.flangeSrc.loop = true;
    this.flangeSrc.connect(this.flangeFilter).connect(this.flangeGain).connect(ctx.destination);
    this.flangeSrc.start();

    // Wheel roar (low rumble)
    this.roarGain = ctx.createGain();
    this.roarGain.gain.value = 0;
    const roarLp = ctx.createBiquadFilter();
    roarLp.type = 'lowpass';
    roarLp.frequency.value = 280;
    this.roarSrc = ctx.createBufferSource();
    this.roarSrc.buffer = this.noiseBuffer(2.5);
    this.roarSrc.loop = true;
    this.roarSrc.connect(roarLp).connect(this.roarGain).connect(ctx.destination);
    this.roarSrc.start();
  }

  horn() {
    this.ensure();
    const ctx = this.ctx!;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = 'sawtooth';
    o.frequency.value = 420;
    g.gain.value = 0.12;
    o.connect(g).connect(ctx.destination);
    o.start();
    g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.7);
    o.stop(ctx.currentTime + 0.75);
  }

  /** Motor + inverter: whine rises with notch and speed (load proxy). */
  setMotor(speedMs: number, powerNotch: number) {
    if (!this.motorOsc || !this.motorGain || !this.ctx) return;
    const load = Math.min(1, powerNotch / 8);
    const v = Math.abs(speedMs);
    this.motorOsc.frequency.setTargetAtTime(50 + v * 8 + powerNotch * 5, this.ctx.currentTime, 0.1);
    this.motorGain.gain.setTargetAtTime(
      Math.min(0.08, 0.01 + powerNotch * 0.008 + v * 0.002),
      this.ctx.currentTime,
      0.1,
    );
    if (this.invOsc && this.invGain) {
      // Inverter whine: idle ~400 Hz, climbs with load and road speed
      const invHz = 400 + load * 900 + v * 22;
      this.invOsc.frequency.setTargetAtTime(invHz, this.ctx.currentTime, 0.08);
      const invVol = load < 0.05 ? 0.004 + v * 0.0004 : 0.01 + load * 0.045 + v * 0.001;
      this.invGain.gain.setTargetAtTime(Math.min(0.07, invVol), this.ctx.currentTime, 0.1);
    }
  }

  /** Flange screech + wheel roar from curvature (1/R) and speed. */
  setCurveNoise(speedMs: number, curvature: number) {
    if (!this.ctx || !this.flangeGain || !this.roarGain) return;
    const v = Math.abs(speedMs);
    const c = Math.abs(curvature);
    const onCurve = c > 0.0015 && v > 2;
    const sharp = Math.min(1, (c - 0.0015) / 0.006);
    const flange = onCurve ? sharp * Math.min(1, v / 12) * 0.055 : 0;
    const roar = Math.min(0.04, v * 0.0018 + (onCurve ? sharp * 0.015 : 0));
    this.flangeGain.gain.setTargetAtTime(flange, this.ctx.currentTime, 0.12);
    this.roarGain.gain.setTargetAtTime(roar, this.ctx.currentTime, 0.15);
    if (this.flangeFilter && onCurve) {
      this.flangeFilter.frequency.setTargetAtTime(1800 + sharp * 900, this.ctx.currentTime, 0.1);
    }
  }

  setWheelslip(on: boolean) {
    this.ensure();
    const ctx = this.ctx!;
    if (on && !this.slipOsc) {
      this.slipOsc = ctx.createOscillator();
      this.slipGain = ctx.createGain();
      this.slipOsc.type = 'square';
      this.slipOsc.frequency.value = 90;
      this.slipGain.gain.value = 0.04;
      this.slipOsc.connect(this.slipGain).connect(ctx.destination);
      this.slipOsc.start();
    }
    if (!on && this.slipOsc) {
      this.slipOsc.stop();
      this.slipOsc.disconnect();
      this.slipOsc = null;
      this.slipGain = null;
    }
  }

  /** Full-close sequence: G–E–C chime, then plug-door slide, thud, lock. */
  doorClose() {
    this.playDoor('close');
  }

  /** Open sequence: single G chime, unlatch, slide, soft end-stop. */
  doorOpen() {
    this.playDoor('open');
  }
}
