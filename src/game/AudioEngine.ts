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
}
