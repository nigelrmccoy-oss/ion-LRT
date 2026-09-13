import * as THREE from 'three';
import { Elevation } from './elevation';
import { Track } from './Track';
import { TrainPhysics, type Weather } from './Physics';
import { WeatherFX } from './WeatherFX';
import { Input } from './Input';
import { AudioEngine } from './AudioEngine';
import { createFlexity, createDieselConsist } from './Vehicles';
import { TerrainSystem } from './Terrain';
import { StationSystem, type StationDef } from './Stations';
import { RowClassifier } from './Row';
import { SignalSystem, type SignalAspect } from './Signals';

export type RouteKey = 'ion_southbound' | 'ion_northbound' | 'elmira' | 'guelph';

type StationsFile = {
  routes: Record<string, {
    name: string;
    vehicle: string;
    track: string;
    reverse?: boolean;
    stations: StationDef[];
  }>;
};

export class Game {
  renderer: THREE.WebGLRenderer;
  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(70, 1, 0.1, 4000);
  elev = new Elevation();
  track!: Track;
  allTracks: Track[] = [];
  physics!: TrainPhysics;
  input: Input;
  audio = new AudioEngine();
  terrain!: TerrainSystem;
  stations = new StationSystem();
  row = new RowClassifier();
  signals = new SignalSystem();
  train!: THREE.Group;
  s = 0;
  camMode: 0 | 1 | 2 = 0; // cab / chase / trackside
  clock = new THREE.Clock();
  simClock = 8 * 3600;
  weather: Weather = 'dry';
  routeKey: RouteKey = 'ion_southbound';
  stats = { overspeed: 0, wheelslip: 0, stopAcc: [] as number[], started: 0, redLights: 0 };
  dwellUntil = 0;
  finished = false;
  running = false;
  private sun!: THREE.DirectionalLight;
  private hemi!: THREE.HemisphereLight;
  private keyTimer = new Map<string, number>();
  private hud: Record<string, HTMLElement>;
  private onEnd: ((html: string) => void) | null = null;
  private weatherFx: WeatherFX | null = null;
  private tod: 'day' | 'dusk' | 'night' = 'day';
  private windshield: HTMLElement | null = null;
  private lastAspectById = new Map<number, SignalAspect>();
  private activeLineKey: 'ion' | 'spur' | 'guelph' = 'ion';

  constructor(canvas: HTMLCanvasElement, hud: Record<string, HTMLElement>) {
    this.hud = hud;
    this.windshield = document.getElementById('windshield');
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 1.75));
    this.renderer.setSize(innerWidth, innerHeight);
    this.renderer.shadowMap.enabled = true;
    this.input = new Input(canvas);
    window.addEventListener('resize', () => this.onResize());
    this.scene.background = new THREE.Color(0x87a7c9);
    this.scene.fog = new THREE.Fog(0x87a7c9, 400, 2200);
    this.hemi = new THREE.HemisphereLight(0xbcd4f0, 0x3d4a2e, 0.7);
    this.scene.add(this.hemi);
    this.sun = new THREE.DirectionalLight(0xfff2d6, 1.1);
    this.sun.position.set(80, 120, 40);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(1024, 1024);
    this.sun.shadow.camera.near = 10;
    this.sun.shadow.camera.far = 400;
    this.sun.shadow.camera.left = -80;
    this.sun.shadow.camera.right = 80;
    this.sun.shadow.camera.top = 80;
    this.sun.shadow.camera.bottom = -80;
    this.scene.add(this.sun);
  }

  onResize() {
    this.camera.aspect = innerWidth / innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(innerWidth, innerHeight);
  }

  async start(opts: {
    route: RouteKey;
    startStationId: string;
    weather: Weather;
    tod: 'day' | 'dusk' | 'night';
    onEnd: (html: string) => void;
  }) {
    this.onEnd = opts.onEnd;
    this.routeKey = opts.route;
    this.weather = opts.weather;
    this.finished = false;
    this.running = true;
    // Clear previous world on restart
    if (this.terrain) this.scene.remove(this.terrain.group);
    this.scene.remove(this.stations.group);
    if (this.train) this.scene.remove(this.train);
    this.stats = { overspeed: 0, wheelslip: 0, stopAcc: [], started: performance.now(), redLights: 0 };
    this.lastAspectById.clear();
    this.tod = opts.tod;
    this.applyTod(opts.tod);
    this.setupWeather(opts.weather);

    await this.elev.load();
    await this.row.load();
    await this.signals.load();
    this.signals.redViolations = 0;

    this.terrain = new TerrainSystem(this.elev);
    await this.terrain.loadScenery();
    this.terrain.setRowClassifier(this.row);
    this.terrain.setSignalDefs(this.signals.signals);
    this.terrain.setCrossingDefs(this.signals.crossings);
    this.scene.add(this.terrain.group);
    this.terrain.setWet(this.weather === 'rain');

    const elevMeta = this.elev.meta;
    const stationsData = (await (await fetch('./data/stations.json')).json()) as StationsFile;
    const route = stationsData.routes[opts.route];

    // Load all tracks for scenery visibility
    const ion = await Track.fromGeoJSON('./data/ion-track.geojson', this.elev, elevMeta.track_profiles.ion, 'ION LRT', false);
    const spur = await Track.fromGeoJSON('./data/waterloo-spur.geojson', this.elev, elevMeta.track_profiles.spur, 'Waterloo Spur', false);
    const guelph = await Track.fromGeoJSON('./data/guelph-sub.geojson', this.elev, elevMeta.track_profiles.guelph, 'Guelph Sub', false);
    // Attach OSM ROW lookup to ION (both directions use same samples; reverse remaps s)
    ion.rowLookup = (s, near) => this.row.at(s, near, 0);
    this.allTracks = [ion, spur, guelph];
    for (const t of this.allTracks) this.terrain.buildRails(t);

    const reverse = !!route.reverse;
    const trackFile = route.track || 'ion-track.geojson';
    let profile = elevMeta.track_profiles.ion;
    if (trackFile.includes('spur')) profile = elevMeta.track_profiles.spur;
    if (trackFile.includes('guelph')) profile = elevMeta.track_profiles.guelph;
    this.track = await Track.fromGeoJSON(`./data/${trackFile}`, this.elev, profile, route.name, reverse);

    if (trackFile.includes('spur')) this.activeLineKey = 'spur';
    else if (trackFile.includes('guelph')) this.activeLineKey = 'guelph';
    else this.activeLineKey = 'ion';

    // ROW lookup for active ION track (map reverse distance)
    if (this.activeLineKey === 'ion') {
      const ionLen = ion.length;
      this.track.rowLookup = (s, near) => {
        const sFwd = reverse ? ionLen - s : s;
        return this.row.at(sFwd, near, 0);
      };
    }

    this.stations.build(route.stations, this.track, this.elev);
    this.scene.add(this.stations.group);

    const electric = route.vehicle === 'flexity';
    this.physics = new TrainPhysics({
      massKg: electric ? 50000 : 80000,
      weather: opts.weather,
      electric,
    });
    this.physics.reverser = 0;
    this.physics.pantographUp = electric;

    if (this.train) this.scene.remove(this.train);
    this.train = electric ? createFlexity() : createDieselConsist(opts.route === 'elmira' ? 'wcr' : 'cn');
    this.scene.add(this.train);

    // Build signals / crossings visuals after elev ready
    this.terrain.buildTrafficSignals(this.activeLineKey === 'ion' ? ion : null);
    this.terrain.buildCrossings();

    const startSt = route.stations.find((s) => s.id === opts.startStationId) || route.stations[0];
    this.s = Math.min(this.track.length - 1, Math.max(0, startSt.distance_m));
    this.physics.speed = 0;
    this.dwellUntil = this.clock.elapsedTime + 2;

    this.clock.start();
    this.loop();
  }

  applyTod(tod: 'day' | 'dusk' | 'night') {
    if (tod === 'day') {
      this.scene.background = new THREE.Color(0x87a7c9);
      this.scene.fog = new THREE.Fog(0x87a7c9, 500, 2400);
      this.hemi.intensity = 0.75;
      this.sun.intensity = 1.15;
      this.simClock = 10 * 3600;
    } else if (tod === 'dusk') {
      this.scene.background = new THREE.Color(0xc47b5a);
      this.scene.fog = new THREE.Fog(0xc47b5a, 400, 1800);
      this.hemi.intensity = 0.4;
      this.sun.intensity = 0.7;
      this.sun.color.set(0xff9955);
      this.simClock = 19 * 3600;
    } else {
      this.scene.background = new THREE.Color(0x0a1020);
      this.scene.fog = new THREE.Fog(0x0a1020, 200, 1200);
      this.hemi.intensity = 0.15;
      this.sun.intensity = 0.05;
      this.simClock = 22 * 3600;
    }
  }


  private setupWeather(w: Weather) {
    if (this.weatherFx) {
      this.weatherFx.dispose();
      this.weatherFx = null;
    }
    this.weatherFx = new WeatherFX(this.scene);
    this.weatherFx.setWeather(w, this.tod);
    if (this.terrain) this.terrain.setWet(w === 'rain');
    if (this.windshield) {
      this.windshield.className = w === 'rain' ? 'wet' : w === 'snow' ? 'frost' : '';
    }
  }

  private edge(code: string, interval = 0.2) {
    if (!this.input.pressed(code)) return false;
    const t = this.clock.elapsedTime;
    const last = this.keyTimer.get(code) || 0;
    if (t - last < interval) return false;
    this.keyTimer.set(code, t);
    return true;
  }

  private handleInput(dt: number) {
    if (this.edge('KeyW') || this.edge('ArrowUp')) {
      this.physics.brakeNotch = 0;
      this.physics.powerNotch = Math.min(8, this.physics.powerNotch + 1);
      this.physics.resetVigilance();
      this.audio.ensure();
    }
    if (this.edge('KeyS') || this.edge('ArrowDown')) {
      this.physics.powerNotch = 0;
      this.physics.brakeNotch = Math.min(8, this.physics.brakeNotch + 1);
      this.physics.resetVigilance();
    }
    if (this.edge('KeyR')) {
      const order: Array<-1 | 0 | 1> = [1, 0, -1];
      const i = order.indexOf(this.physics.reverser);
      this.physics.reverser = order[(i + 1) % 3];
    }
    if (this.edge('KeyT')) {
      if (Math.abs(this.physics.speed) < 0.3) {
        this.physics.doorsOpen = !this.physics.doorsOpen;
        if (this.physics.doorsOpen) this.physics.powerNotch = 0;
      }
    }
    if (this.edge('KeyP') && this.physics.electric) {
      this.physics.pantographUp = !this.physics.pantographUp;
      const pan = this.train.getObjectByName('pantograph');
      if (pan) pan.visible = this.physics.pantographUp;
    }
    this.physics.sanding = this.input.pressed('ShiftLeft') || this.input.pressed('ShiftRight');
    if (this.edge('Space', 0.5)) this.audio.horn();
    if (this.edge('KeyC', 0.3)) this.camMode = ((this.camMode + 1) % 3) as 0 | 1 | 2;
    this.input.consumeLook();
  }

  private ionForwardS(): number {
    if (this.activeLineKey !== 'ion') return this.s;
    // northbound is reverse of baked southbound alignment
    if (this.routeKey === 'ion_northbound') return this.track.length - this.s;
    return this.s;
  }

  private loop = () => {
    if (this.finished || !this.running) return;
    requestAnimationFrame(this.loop);
    const dt = Math.min(0.05, this.clock.getDelta());
    this.handleInput(dt);
    this.simClock += dt;

    const near = this.stations.nearStation(this.s, 60);
    const rowInfo = this.track.rowClassAt(this.s, !!near);
    const limit = this.track.speedLimitKmh(this.s, !!near);
    const sample = this.track.sample(this.s);

    // Traffic-signal enforcement (ION street sections)
    const dir: 1 | -1 =
      this.physics.reverser === 0
        ? (this.physics.speed >= 0 ? 1 : -1)
        : this.physics.reverser;
    // For reverse ION, signal s_ion is on forward alignment — map train position
    const enforceS = this.activeLineKey === 'ion' ? this.ionForwardS() : this.s;
    const enforceDir: 1 | -1 =
      this.routeKey === 'ion_northbound' ? ((-dir) as 1 | -1) : dir;

    const inStreet =
      this.activeLineKey === 'ion' &&
      (rowInfo === 'street' || (rowInfo === 'station' && this.row.isStreetBand(enforceS)));

    const enf = this.signals.updateEnforcement({
      tSec: this.simClock,
      trainS: enforceS,
      speedKmh: this.physics.speedKmh(),
      direction: enforceDir,
      inStreetRow: inStreet,
      dt,
    });
    this.stats.redLights = this.signals.redViolations;

    // Soft hold on red: force brake / cut power when close
    if (enf.hold && inStreet) {
      this.physics.powerNotch = 0;
      this.physics.brakeNotch = Math.max(this.physics.brakeNotch, 6);
    }

    // Auto-hold during dwell at start
    if (this.clock.elapsedTime < this.dwellUntil) {
      this.physics.speed = 0;
      this.physics.powerNotch = 0;
    }

    this.physics.step(dt, sample.grade, sample.curvature);
    this.s = THREE.MathUtils.clamp(this.s + this.physics.speed * dt, 0, this.track.length);
    if (this.s <= 0 || this.s >= this.track.length) {
      this.physics.speed = 0;
    }

    if (this.physics.speedKmh() > limit + 2) this.stats.overspeed += dt;
    if (this.physics.wheelslip) this.stats.wheelslip += dt;
    this.audio.setWheelslip(this.physics.wheelslip);
    this.audio.setMotor(this.physics.speed, this.physics.powerNotch);

    const p = this.track.sample(this.s);
    this.train.position.set(p.x, p.y, p.z);
    this.train.rotation.order = 'YXZ';
    this.train.rotation.y = p.heading + (this.physics.reverser < 0 ? Math.PI : 0);
    this.train.rotation.x = -Math.atan(p.grade);

    this.updateCamera(p);
    this.terrain.update(p.x, p.z, this.allTracks);
    this.sun.position.set(p.x + 60, p.y + 100, p.z + 30);
    this.sun.target.position.set(p.x, p.y, p.z);
    this.sun.target.updateMatrixWorld();

    // Update signal lamp colours (nearby street signals)
    this.lastAspectById.clear();
    if (this.activeLineKey === 'ion') {
      for (const sig of this.signals.signals) {
        if (Math.abs(sig.s_ion - enforceS) > 250) continue;
        const asp = this.signals.aspectFor(
          sig,
          this.simClock,
          enforceS,
          this.physics.speedKmh(),
          enforceDir || 1,
          0,
        );
        this.lastAspectById.set(sig.id, asp);
      }
    }
    this.terrain.updateSignalAspects((id) => this.lastAspectById.get(id) ?? null);

    // Crossing gates on heavy-rail routes
    const activeX = new Set<number>();
    if (this.activeLineKey !== 'ion') {
      for (const c of this.signals.crossings) {
        if (this.signals.crossingActive(c, this.s, this.activeLineKey)) activeX.add(c.id);
      }
    }
    this.terrain.updateCrossingGates(activeX, this.simClock);

    this.weatherFx?.update(dt, this.camera);
    this.updateHud(limit, rowInfo, enf.aspect);
    this.renderer.render(this.scene, this.camera);

    if (this.s > this.track.length - 8 && Math.abs(this.physics.speed) < 0.5) {
      this.finish();
    }
  };

  private updateCamera(p: { x: number; y: number; z: number; heading: number }) {
    const cabHeight = this.physics.electric ? 2.4 : 3.2;
    const cabForward = this.physics.electric ? -14.5 : -7.5;
    if (this.camMode === 0) {
      const hx = Math.sin(p.heading), hz = Math.cos(p.heading);
      const cx = p.x + hx * cabForward;
      const cz = p.z + hz * cabForward;
      this.camera.position.set(cx, p.y + cabHeight, cz);
      this.camera.rotation.order = 'YXZ';
      this.camera.rotation.y = p.heading + Math.PI + this.input.lookYaw;
      this.camera.rotation.x = this.input.lookPitch;
      this.camera.rotation.z = 0;
    } else if (this.camMode === 1) {
      const hx = Math.sin(p.heading), hz = Math.cos(p.heading);
      this.camera.position.set(p.x - hx * 28, p.y + 8, p.z - hz * 28);
      this.camera.lookAt(p.x, p.y + 2, p.z);
    } else {
      const hx = Math.sin(p.heading), hz = Math.cos(p.heading);
      this.camera.position.set(p.x - hz * 18, p.y + 4, p.z + hx * 18);
      this.camera.lookAt(p.x, p.y + 2, p.z);
    }
  }

  private updateHud(limit: number, row: string, aspect: SignalAspect | null) {
    this.hud.speedVal.textContent = String(Math.round(this.physics.speedKmh()));
    this.hud.powerVal.textContent = String(this.physics.powerNotch);
    this.hud.brakeVal.textContent = String(this.physics.brakeNotch);
    this.hud.limitVal.textContent = String(limit);
    if (this.hud.weather) {
      const label = this.weather === 'dry' ? 'Dry' : this.weather === 'rain' ? 'Rain' : 'Snow';
      this.hud.weather.textContent = label;
    }
    if (this.hud.rowVal) {
      const label = row === 'street' ? 'Street' : row === 'station' ? 'Station' : 'Reserved';
      this.hud.rowVal.textContent = label;
    }
    if (this.hud.signalVal) {
      this.hud.signalVal.textContent = aspect ? aspect.toUpperCase() : '—';
    }
    const next = this.stations.nextStation(this.s);
    this.hud.nextStation.textContent = next ? `${next.name} (${Math.max(0, Math.round(next.distance_m - this.s))} m)` : 'End of line';
    this.hud.doors.textContent = this.physics.doorsOpen ? 'Doors OPEN' : 'Doors closed';
    this.hud.panto.textContent = this.physics.electric ? (this.physics.pantographUp ? 'Panto up' : 'Panto down') : 'Diesel';
    this.hud.reverser.textContent = this.physics.reverser > 0 ? 'F' : this.physics.reverser < 0 ? 'R' : 'N';
    this.hud.voltage.textContent = this.physics.electric ? `${this.physics.lineVoltage} V` : '—';
    this.hud.slip.className = 'lamp ' + (this.physics.wheelslip ? 'on' : 'off');
    const h = Math.floor(this.simClock / 3600) % 24;
    const m = Math.floor((this.simClock % 3600) / 60);
    const sec = Math.floor(this.simClock % 60);
    this.hud.clock.textContent = `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}`;
  }

  stop() {
    this.running = false;
    if (this.windshield) this.windshield.className = '';
  }

  private finish() {
    this.running = false;
    this.finished = true;
    this.audio.setWheelslip(false);
    const elapsed = (performance.now() - this.stats.started) / 1000;
    const last = this.stations.stations[this.stations.stations.length - 1];
    const stopErr = Math.abs(this.s - last.distance_m);
    this.stats.stopAcc.push(stopErr);
    const html = `<h1>End of run</h1>
      <p>${this.track.name}</p>
      <ul>
        <li>Stop accuracy at terminus: ${stopErr.toFixed(1)} m</li>
        <li>Time over speed limit: ${this.stats.overspeed.toFixed(1)} s</li>
        <li>Wheelslip time: ${this.stats.wheelslip.toFixed(1)} s</li>
        <li>Red-signal violations: ${this.stats.redLights}</li>
        <li>Elapsed: ${(elapsed/60).toFixed(1)} min</li>
      </ul>
      <button id="againBtn" type="button">Back to menu</button>`;
    this.onEnd?.(html);
  }
}
