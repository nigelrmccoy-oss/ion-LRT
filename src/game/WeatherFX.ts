import * as THREE from 'three';
import type { Weather } from './Physics';

const RAIN_COUNT = 1400;
const SNOW_COUNT = 900;

/** In-cab weather: particles follow camera + fog / windshield tint hooks. */
export class WeatherFX {
  group = new THREE.Group();
  private rain: THREE.Points | null = null;
  private snow: THREE.Points | null = null;
  private weather: Weather = 'dry';
  private velocities: Float32Array | null = null;

  constructor(private scene: THREE.Scene) {
    this.group.name = 'weatherFX';
    this.scene.add(this.group);
  }

  setWeather(w: Weather, tod: 'day' | 'dusk' | 'night' = 'day') {
    this.weather = w;
    void tod;
    this.clearParticles();
    if (w === 'rain') this.spawnRain();
    else if (w === 'snow') this.spawnSnow();
    this.applyAtmosphere();
  }

  private clearParticles() {
    if (this.rain) {
      this.group.remove(this.rain);
      this.rain.geometry.dispose();
      (this.rain.material as THREE.Material).dispose();
      this.rain = null;
    }
    if (this.snow) {
      this.group.remove(this.snow);
      this.snow.geometry.dispose();
      (this.snow.material as THREE.Material).dispose();
      this.snow = null;
    }
    this.velocities = null;
  }

  private spawnRain() {
    const positions = new Float32Array(RAIN_COUNT * 3);
    this.velocities = new Float32Array(RAIN_COUNT);
    for (let i = 0; i < RAIN_COUNT; i++) {
      positions[i * 3] = (Math.random() - 0.5) * 40;
      positions[i * 3 + 1] = Math.random() * 25;
      positions[i * 3 + 2] = (Math.random() - 0.5) * 40;
      this.velocities[i] = 18 + Math.random() * 14;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    const mat = new THREE.PointsMaterial({
      color: 0xa8c8e8,
      size: 0.08,
      transparent: true,
      opacity: 0.65,
      depthWrite: false,
      sizeAttenuation: true,
    });
    this.rain = new THREE.Points(geo, mat);
    this.rain.frustumCulled = false;
    this.group.add(this.rain);
  }

  private spawnSnow() {
    const positions = new Float32Array(SNOW_COUNT * 3);
    this.velocities = new Float32Array(SNOW_COUNT);
    for (let i = 0; i < SNOW_COUNT; i++) {
      positions[i * 3] = (Math.random() - 0.5) * 50;
      positions[i * 3 + 1] = Math.random() * 28;
      positions[i * 3 + 2] = (Math.random() - 0.5) * 50;
      this.velocities[i] = 1.2 + Math.random() * 2.2;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    const mat = new THREE.PointsMaterial({
      color: 0xffffff,
      size: 0.22,
      transparent: true,
      opacity: 0.9,
      depthWrite: false,
      sizeAttenuation: true,
    });
    this.snow = new THREE.Points(geo, mat);
    this.snow.frustumCulled = false;
    this.group.add(this.snow);
  }

  /** Call after Game.applyTod so weather overrides fog/background. */
  applyAtmosphere() {
    const fog = this.scene.fog as THREE.Fog | null;
    if (!fog) return;
    if (this.weather === 'rain') {
      // Wetter, darker fog
      const c = new THREE.Color(0x4a5a6e);
      this.scene.background = c.clone();
      fog.color.copy(c);
      fog.near = 180;
      fog.far = 1100;
    } else if (this.weather === 'snow') {
      // Brighter / whiter fog, muted contrast
      const c = new THREE.Color(0xc8d4e0);
      this.scene.background = c.clone();
      fog.color.copy(c);
      fog.near = 120;
      fog.far = 900;
    }
    // dry: leave applyTod values untouched
  }

  update(dt: number, camera: THREE.Camera) {
    this.group.position.copy(camera.position);
    const pts = this.rain || this.snow;
    if (!pts || !this.velocities) return;
    const pos = pts.geometry.attributes.position as THREE.BufferAttribute;
    const arr = pos.array as Float32Array;
    const n = this.velocities.length;
    const isRain = !!this.rain;
    const drift = isRain ? 0 : Math.sin(performance.now() * 0.001) * 0.4;
    for (let i = 0; i < n; i++) {
      arr[i * 3 + 1] -= this.velocities[i] * dt;
      if (!isRain) {
        arr[i * 3] += drift * dt * (0.5 + (i % 5) * 0.1);
      } else {
        arr[i * 3] += dt * 1.5; // slight wind slant
      }
      const yMin = isRain ? -2 : -1;
      const yMax = isRain ? 25 : 28;
      const span = isRain ? 40 : 50;
      if (arr[i * 3 + 1] < yMin) {
        arr[i * 3 + 1] = yMax;
        arr[i * 3] = (Math.random() - 0.5) * span;
        arr[i * 3 + 2] = (Math.random() - 0.5) * span;
      }
    }
    pos.needsUpdate = true;
  }

  dispose() {
    this.clearParticles();
    this.scene.remove(this.group);
  }
}
