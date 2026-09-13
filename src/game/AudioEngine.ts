export class AudioEngine {
  private ctx: AudioContext | null = null;
  private slipOsc: OscillatorNode | null = null;
  private slipGain: GainNode | null = null;
  private motorGain: GainNode | null = null;
  private motorOsc: OscillatorNode | null = null;

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
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume();
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

  setMotor(speedMs: number, powerNotch: number) {
    if (!this.motorOsc || !this.motorGain || !this.ctx) return;
    this.motorOsc.frequency.setTargetAtTime(50 + Math.abs(speedMs) * 8 + powerNotch * 5, this.ctx.currentTime, 0.1);
    this.motorGain.gain.setTargetAtTime(Math.min(0.08, 0.01 + powerNotch * 0.008 + Math.abs(speedMs) * 0.002), this.ctx.currentTime, 0.1);
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

  /**
   * TTC-style door closing: 3 descending electronic chimes, then
   * pneumatic hiss and a latch clunk. (Tribute — not a TTC recording.)
   */
  doorClose() {
    this.ensure();
    const ctx = this.ctx!;
    const t0 = ctx.currentTime;
    const notes = [1318.5, 1046.5, 783.99]; // E6 C6 G5
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
    // pneumatic hiss
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
    // latch clunk
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
