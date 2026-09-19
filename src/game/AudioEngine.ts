/**
 * Web Audio cab sounds: inverter whine scales with load; flange/wheel roar on curves.
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
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume();
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

  doorClose() {
    this.ensure();
    const ctx = this.ctx!;
    const t0 = ctx.currentTime;
    const notes = [1318.5, 1046.5, 783.99];
    notes.forEach((freq, i) => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = 'sine';
      o.frequency.value = freq;
      const start = t0 + i * 0.22;
      g.gain.setValueAtTime(0.0001, start);
      g.gain.exponentialRampToValueAtTime(0.11, start + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, start + 0.18);
      o.connect(g).connect(ctx.destination);
      o.start(start);
      o.stop(start + 0.2);
    });
    const hissStart = t0 + 0.72;
    const dur = 0.85;
    const buf = ctx.createBuffer(1, Math.floor(ctx.sampleRate * dur), ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * 0.35;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 1800;
    bp.Q.value = 0.7;
    const hg = ctx.createGain();
    hg.gain.setValueAtTime(0.0001, hissStart);
    hg.gain.exponentialRampToValueAtTime(0.07, hissStart + 0.08);
    hg.gain.exponentialRampToValueAtTime(0.0001, hissStart + dur);
    src.connect(bp).connect(hg).connect(ctx.destination);
    src.start(hissStart);
    const clunkAt = hissStart + 0.78;
    const cl = ctx.createOscillator();
    const cg = ctx.createGain();
    cl.type = 'triangle';
    cl.frequency.setValueAtTime(140, clunkAt);
    cl.frequency.exponentialRampToValueAtTime(60, clunkAt + 0.08);
    cg.gain.setValueAtTime(0.09, clunkAt);
    cg.gain.exponentialRampToValueAtTime(0.0001, clunkAt + 0.1);
    cl.connect(cg).connect(ctx.destination);
    cl.start(clunkAt);
    cl.stop(clunkAt + 0.12);
  }

  doorOpen() {
    this.ensure();
    const ctx = this.ctx!;
    const t0 = ctx.currentTime;
    const dur = 0.55;
    const buf = ctx.createBuffer(1, Math.floor(ctx.sampleRate * dur), ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * 0.3;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 1400;
    bp.Q.value = 0.6;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.05, t0);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    src.connect(bp).connect(g).connect(ctx.destination);
    src.start(t0);
  }
}
