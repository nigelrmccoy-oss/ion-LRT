import * as THREE from 'three';
import { Elevation } from './elevation';
import { Track } from './Track';
import { TrainPhysics, type Weather, MASS_FLEXITY_KG, MASS_WCR_KG, MASS_CN_KG, AXLE_FRAC_FLEXITY, AXLE_FRAC_WCR, AXLE_FRAC_CN } from './Physics';
import { WeatherFX } from './WeatherFX';
import { Input } from './Input';
import { AudioEngine } from './AudioEngine';
import { createFlexityArticulated, createDieselConsist, type ArticulatedLRV } from './Vehicles';
import { poseConsist, superelevationFor, buildCantProfile, type ConsistPose } from './Articulation';
import { TRUCK_FROM_NOSE_M, LRV_LENGTH_M, LRV_FLOOR_ATR_M } from './Clearances';
import { DIESEL_CAB_EYE, DIESEL_CONSIST_FRONT_M, DIESEL_CONSIST_REAR_M } from './Vehicles';
import type { OsmPlatform } from './PlatformLayout';
import { PhotorealTiles } from './PhotorealTiles';
import { TerrainSystem } from './Terrain';
import { StationSystem, type StationDef } from './Stations';
import { RowClassifier } from './Row';
import { SignalSystem, type SignalAspect } from './Signals';
import { nextReverser, reverserLabel } from './reverser';
import { CesiumIonImagery } from './CesiumIon';
import { TutorialController } from './Tutorial';
import { Minimap, etaSeconds, formatEta } from './Minimap';

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
  ion = new CesiumIonImagery();
  tutorial = new TutorialController();
  minimap: Minimap | null = null;
  train!: THREE.Group;
  /** Articulated Flexity (null for diesel consists). */
  lrv: ArticulatedLRV | null = null;
  pose: ConsistPose | null = null;
  photoreal = new PhotorealTiles();
  private camQ = new THREE.Quaternion();
  private tmpE = new THREE.Euler();
  s = 0;
  camMode: 0 | 1 | 2 = 0;
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
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.camera.near = 10;
    this.sun.shadow.camera.far = 400;
    this.sun.shadow.camera.left = -80;
    this.sun.shadow.camera.right = 80;
    this.sun.shadow.camera.top = 80;
    this.sun.shadow.camera.bottom = -80;
    // Shadow-acne fix (banding on LRV roofs): small depth bias + normal-offset bias
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.04;
    this.scene.add(this.sun);

    const miniEl = document.getElementById('minimap') as HTMLCanvasElement | null;
    if (miniEl) this.minimap = new Minimap(miniEl);
    const app = document.getElementById('app');
    if (app) this.tutorial.mount(app);
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
    runTutorial?: boolean;
    /** Try Google Photorealistic 3D Tiles via Cesium ion (needs token; falls back to OSM). */
    photoreal?: boolean;
    /** Debug: start at this chainage (m, centre truck) instead of the station. */
    startS?: number;
    /** Debug: initial camera 0 cab / 1 chase / 2 trackside. */
    cam?: 0 | 1 | 2;
    /** Debug: initial reverser (1 forward, −1 reverse). */
    dir?: 1 | -1;
  }) {
    this.onEnd = opts.onEnd;
    this.routeKey = opts.route;
    this.weather = opts.weather;
    this.finished = false;
    this.running = true;
    if (this.terrain) this.scene.remove(this.terrain.group);
    this.scene.remove(this.stations.group);
    if (this.train) this.scene.remove(this.train);
    this.stats = { overspeed: 0, wheelslip: 0, stopAcc: [], started: performance.now(), redLights: 0 };
    this.lastAspectById.clear();
    this.resetHud();
    this.tod = opts.tod;
    this.applyTod(opts.tod);
    this.setupWeather(opts.weather);

    // Cesium Ion optional — never log the token
    await this.ion.init();

    await this.elev.load();
    await this.row.load();
    await this.signals.load();
    this.signals.redViolations = 0;

    this.terrain = new TerrainSystem(this.elev);
    this.terrain.setIonImagery(this.ion);
    await this.terrain.loadScenery();
    this.terrain.setRowClassifier(this.row);
    this.terrain.setSignalDefs(this.signals.signals);
    this.terrain.setCrossingDefs(this.signals.crossings);
    this.scene.add(this.terrain.group);
    this.terrain.setWet(this.weather === 'rain');

    const elevMeta = this.elev.meta;
    const stationsData = (await (await fetch('./data/stations.json')).json()) as StationsFile;
    const route = stationsData.routes[opts.route];

    // Reference ION centreline: ROW segments, signals and OCS data are keyed to its chainage.
    // Not rendered — trains run on the real direction-specific OSM lines below.
    const ion = await Track.fromGeoJSON('./data/ion-track.geojson', this.elev, elevMeta.track_profiles.ion, 'ION reference', false);
    const ionSb = await Track.fromGeoJSON('./data/ion-sb.geojson', this.elev, undefined, 'ION LRT southbound', false);
    const ionNb = await Track.fromGeoJSON('./data/ion-nb.geojson', this.elev, undefined, 'ION LRT northbound', false);
    ionNb.blendHeightsToward(ionSb); // shared formation on double track
    for (const t of [ionSb, ionNb]) {
      t.buildRefMap(ion);
      t.rowLookup = (s, near) => this.row.at(t.refS(s), near, 0);
    }
    const spur = await Track.fromGeoJSON('./data/waterloo-spur.geojson', this.elev, elevMeta.track_profiles.spur, 'Waterloo Spur', false);
    const guelph = await Track.fromGeoJSON('./data/guelph-sub.geojson', this.elev, elevMeta.track_profiles.guelph, 'Guelph Sub', false);
    this.allTracks = [ionSb, ionNb, spur, guelph];
    this.ionLines = [ionSb, ionNb];
    // Cut/fill corridors first so the heightfield is corrected before any mesh is draped
    this.terrain.setCorridors(this.allTracks);
    for (const t of this.allTracks) this.terrain.buildRails(t);

    const reverse = !!route.reverse;
    const trackFile = route.track || 'ion-sb.geojson';
    const byFile: Record<string, Track> = {
      'ion-sb.geojson': ionSb, 'ion-nb.geojson': ionNb, 'waterloo-spur.geojson': spur, 'guelph-sub.geojson': guelph,
    };
    let profile: number[] | undefined;
    if (trackFile.includes('spur')) profile = elevMeta.track_profiles.spur;
    if (trackFile.includes('guelph')) profile = elevMeta.track_profiles.guelph;
    if (trackFile === 'ion-track.geojson') profile = elevMeta.track_profiles.ion;
    this.track = !reverse && byFile[trackFile]
      ? byFile[trackFile]
      : await Track.fromGeoJSON(`./data/${trackFile}`, this.elev, profile, route.name, reverse);
    this.track.name = route.name.includes('ION') || trackFile.includes('ion') ? `ION ${route.name}` : route.name;

    if (trackFile.includes('spur')) this.activeLineKey = 'spur';
    else if (trackFile.includes('guelph')) this.activeLineKey = 'guelph';
    else this.activeLineKey = 'ion';

    // Path length may change after elevation smooth/densify — refresh station chainage
    for (const st of route.stations) {
      if (typeof st.lat === 'number' && typeof st.lon === 'number') {
        st.distance_m = Math.round(this.track.nearestS(st.lon, st.lat));
      }
    }
    let platforms: OsmPlatform[] = [];
    try {
      platforms = ((await (await fetch('./data/platforms.json')).json()) as { platforms: OsmPlatform[] }).platforms;
    } catch { platforms = []; }
    this.stations.build(route.stations, this.track, this.elev, {
      heavyRail: !trackFile.includes('ion'),
      groundAt: (x, z) => this.terrain.ground.exactHeight(x, z),
      platforms,
      otherTracks: this.allTracks.filter((t) => t !== this.track),
    });
    // Cant with spiral run-off (no instant sign flip at reverse-curve inflections)
    this.cantFn = buildCantProfile(this.track.length, this.rawCantAt);
    this.scene.add(this.stations.group);

    const electric = route.vehicle === 'flexity';
    const dieselWcr = opts.route === 'elmira';
    this.physics = new TrainPhysics({
      massKg: electric ? MASS_FLEXITY_KG : (dieselWcr ? MASS_WCR_KG : MASS_CN_KG),
      weather: opts.weather,
      electric,
      axleFrac: electric ? AXLE_FRAC_FLEXITY : (dieselWcr ? AXLE_FRAC_WCR : AXLE_FRAC_CN),
    });
    // Start Neutral (safe); R advances N→F→R. Doors closed, panto up, voltage OK.
    this.physics.reverser = 0;
    this.physics.doorsOpen = false;
    this.physics.pantographUp = electric;
    this.physics.lineVoltage = 750;
    this.physics.resetVigilance();

    if (this.train) this.scene.remove(this.train);
    if (electric) {
      this.lrv = createFlexityArticulated();
      this.train = this.lrv.group;
    } else {
      this.lrv = null;
      this.train = createDieselConsist(opts.route === 'elmira' ? 'wcr' : 'cn');
    }
    this.scene.add(this.train);

    this.terrain.buildTrafficSignals([ionSb, ionNb]);
    // enforce traffic signals along the line actually driven (not the reference chainage)
    this.signals.setLine(this.activeLineKey === 'ion' ? this.track : null, 40,
      (s) => this.track.speedLimitKmh(Math.max(0, Math.min(this.track.length, s)), false));
    this.terrain.buildCrossings({ ion, spur, guelph });

    // Photoreal scenery (optional): Google Photorealistic 3D Tiles through Cesium ion
    this.scene.remove(this.photoreal.root);
    this.photoreal.dispose();
    this.terrain.setPhotorealMode(false);
    this.photoreal.onFailure = () => {
      this.terrain.setPhotorealMode(false);
      this.photoreal.showAttribution(false); // no Google credit once tiles are gone
    };
    if (opts.photoreal) {
      const ok = await this.photoreal.init(this.camera, this.renderer, this.elev.baseElev);
      if (ok) {
        this.scene.add(this.photoreal.root);
        this.terrain.setPhotorealMode(true);
      }
    }
    this.photoreal.showAttribution(!!opts.photoreal);

    const startSt = route.stations.find((s) => s.id === opts.startStationId) || route.stations[0];
    // s = chainage of the centre (trailer) truck; keep both noses on the rails
    this.s = this.clampS(Number.isFinite(opts.startS) ? (opts.startS as number) : startSt.distance_m);
    if (opts.cam !== undefined) this.camMode = opts.cam;
    if (opts.dir) this.physics.reverser = opts.dir;
    this.setDoorsVisual(false);
    this.physics.speed = 0;
    // Short dwell; cleared early once reverser is Forward
    this.dwellUntil = this.clock.elapsedTime + 0.75;

    if (opts.runTutorial !== false && this.tutorial.shouldAutoStart()) {
      this.tutorial.start();
    } else {
      this.tutorial.skip();
    }

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

  private handleInput(_dt: number) {
    const edgeKeys = new Set(['KeyR', 'KeyT', 'KeyW', 'KeyS', 'ArrowUp', 'ArrowDown', 'Enter', 'Space', 'KeyP', 'KeyC']);
    // every press in arrival order (queue) — none lost at low frame rates
    for (const code of this.input.drainEdges()) {
      if (!edgeKeys.has(code)) continue;
      this.tutorial.onKey(code);
      this.handleCabKey(code);
    }
    this.physics.sanding = this.input.pressed('ShiftLeft') || this.input.pressed('ShiftRight');
    this.input.consumeLook();
  }

  private handleCabKey(code: string) {
    if (code === 'KeyW' || code === 'ArrowUp') {
      // Traction interlocked (doors / neutral / vigilance / panto): W must not release the
      // brake — v1.4.0 cleared B4 here and the car rolled back with the doors open.
      if (this.physics.powerBlockedReason()) {
        this.physics.resetVigilance();
        this.audio.ensure();
        return;
      }
      this.physics.brakeNotch = 0;
      this.physics.powerNotch = Math.min(8, this.physics.powerNotch + 1);
      this.physics.resetVigilance();
      this.audio.ensure();
      if (this.physics.reverser === 1) this.dwellUntil = 0;
    }
    if (code === 'KeyS' || code === 'ArrowDown') {
      this.physics.powerNotch = 0;
      this.physics.brakeNotch = Math.min(8, this.physics.brakeNotch + 1);
      this.physics.resetVigilance();
    }
    if (code === 'KeyR') {
      this.physics.reverser = nextReverser(this.physics.reverser);
      this.physics.resetVigilance();
      if (this.physics.reverser === 1) this.dwellUntil = 0;
    }
    if (code === 'KeyT') {
      if (this.physics.doorsOpen) {
        // closing is always allowed (the hold brake keeps the car stopped meanwhile)
        this.physics.doorsOpen = false;
        this.audio.doorClose();
        this.setDoorsVisual(false);
      } else if (Math.abs(this.physics.speed) < 0.3) {
        this.physics.doorsOpen = true;
        this.physics.powerNotch = 0;
        this.physics.holdBrake = true;
        this.audio.doorOpen();
        this.setDoorsVisual(true);
      }
      this.physics.resetVigilance();
    }
    if (code === 'KeyP' && this.physics.electric) {
      this.physics.pantographUp = !this.physics.pantographUp;
      const pan = this.train.getObjectByName('pantograph');
      if (pan) pan.visible = this.physics.pantographUp;
      this.physics.resetVigilance();
    }
    if (code === 'Space') this.audio.horn();
    if (code === 'KeyC') this.camMode = ((this.camMode + 1) % 3) as 0 | 1 | 2;
  }

  /** Chainage limits so the whole consist stays between the bumpers. */
  private sLimits(): [number, number] {
    // v1.4.1 used [0, length] for the diesel: the coach hung 26 m off the start of the line
    // and the nose 7.6 m past the end. Both consists now stay between the bumpers.
    const ahead = this.lrv ? TRUCK_FROM_NOSE_M[1] : DIESEL_CONSIST_FRONT_M;
    const behind = this.lrv ? LRV_LENGTH_M - ahead : DIESEL_CONSIST_REAR_M;
    return [Math.min(behind + 0.5, this.track.length / 2), Math.max(this.track.length / 2, this.track.length - ahead - 0.5)];
  }

  private clampS(s: number) {
    const [lo, hi] = this.sLimits();
    return Math.min(hi, Math.max(lo, s));
  }

  /** Platform side (+1 right / −1 left of travel) at the nearest station, else right. */
  private doorSide(): 1 | -1 {
    const st = this.stations.nearStation(this.s, 80);
    return st?.platformSide ?? 1;
  }

  /** Animate the plug doors: slide open on the platform side only. */
  private setDoorsVisual(open: boolean) {
    if (!this.lrv) return;
    const side = this.doorSide();
    // vehicle "left" in module space is +x (forward = +z); right of travel = −x
    const sideX = side > 0 ? -1 : 1;
    for (const m of this.lrv.modules) {
      m.traverse((o) => {
        if (o.name !== 'door') return;
        const u = o.userData as { side: number; baseX: number; baseZ: number };
        const isOpen = open && u.side === sideX;
        o.position.x = u.baseX + (isOpen ? u.side * 0.09 : 0);
        o.position.z = u.baseZ + (isOpen ? 0.72 : 0);
      });
    }
  }

  private ionLines: Track[] = [];
  private cantFn: ((s: number) => number) | null = null;

  private cantAt = (s: number): number => {
    if (this.cantFn) return this.cantFn(Math.max(0, Math.min(this.track.length, s)));
    return this.rawCantAt(s);
  };

  private rawCantAt = (s: number): number => {
    const p = this.track.sample(Math.max(0, Math.min(this.track.length, s)));
    const near = !!this.stations.nearStation(s, 60);
    const row = this.track.rowClassAt(Math.max(0, Math.min(this.track.length, s)), near);
    const v = this.track.speedLimitKmh(Math.max(0, Math.min(this.track.length, s)), near) / 3.6;
    return superelevationFor(p.curvSigned ?? 0, v, row === 'reserved' || this.activeLineKey !== 'ion');
  };

  /** Place every articulated module / truck from the track spline. */
  private placeConsist() {
    if (!this.lrv) return null;
    const pose = poseConsist(this.track, this.s, 1, this.cantAt);
    this.pose = pose;
    pose.modules.forEach((m, i) => {
      const g = this.lrv!.modules[i];
      g.position.set(m.pos.x, m.pos.y, m.pos.z);
      g.rotation.order = 'YXZ';
      g.rotation.set(-m.pitch, m.yaw, -m.roll);
    });
    pose.trucks.forEach((t, i) => {
      const g = this.lrv!.trucks[i];
      g.position.set(t.pos.x, t.pos.y, t.pos.z);
      g.rotation.set(0, t.yaw, 0);
    });
    // Pantograph head follows the local contact-wire height (ION only)
    const shoe = this.lrv.modules[2].getObjectByName('pantoShoe');
    if (shoe && this.activeLineKey === 'ion') shoe.position.y = this.terrain.wireHeightAt(this.ionForwardS());
    return pose;
  }

  /** Chainage on the reference ION line (ROW / signals / OCS are keyed to it). */
  private ionForwardS(): number {
    if (this.activeLineKey !== 'ion') return this.s;
    return this.track.refS(this.s);
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

    const dir: 1 | -1 =
      this.physics.reverser === 0
        ? (this.physics.speed >= 0 ? 1 : -1)
        : this.physics.reverser;
    // ROW bands are keyed by the reference chainage; signals by the driven line (setLine)
    const refSNow = this.ionForwardS();
    const inStreet =
      this.activeLineKey === 'ion' &&
      (rowInfo === 'street' || (rowInfo === 'station' && this.row.isStreetBand(refSNow)));

    const enf = this.signals.updateEnforcement({
      tSec: this.simClock,
      trainS: this.s,
      speedKmh: this.physics.speedKmh(),
      direction: dir,
      inStreetRow: inStreet,
      dt,
    });
    this.stats.redLights = this.signals.redViolations;

    if (enf.hold && inStreet) {
      this.physics.powerNotch = 0;
      this.physics.brakeNotch = Math.max(this.physics.brakeNotch, 6);
    }

    // Brief start dwell — cancel once Forward is selected
    if (this.clock.elapsedTime < this.dwellUntil && this.physics.reverser !== 1) {
      this.physics.speed = 0;
      this.physics.powerNotch = 0;
    }

    this.physics.step(dt, sample.grade, sample.curvature);
    const ds = this.physics.speed * dt;
    const [sLo, sHi] = this.sLimits();
    this.s = THREE.MathUtils.clamp(this.s + ds, sLo, sHi);
    // Only kill speed when driving *into* the bumper (past the end against the buffer).
    // Allow forward departure from the terminus; do not zero just because s is at the limit.
    if (this.s <= sLo && this.physics.speed < 0) this.physics.speed = 0;
    if (this.s >= sHi && this.physics.speed > 0) this.physics.speed = 0;
    if (!Number.isFinite(this.physics.speed)) this.physics.speed = 0;
    if (!Number.isFinite(this.s)) this.s = 0;

    if (this.physics.speedKmh() > limit + 2) this.stats.overspeed += dt;
    if (this.physics.wheelslip) this.stats.wheelslip += dt;
    this.audio.setWheelslip(this.physics.wheelslip);
    this.audio.setMotor(this.physics.speed, this.physics.powerNotch);
    this.audio.setCurveNoise(this.physics.speed, sample.curvature);

    const p = this.track.sample(this.s);
    if (this.lrv) {
      this.placeConsist();
    } else {
      this.train.position.set(p.x, p.y, p.z);
      this.train.rotation.order = 'YXZ';
      this.train.rotation.y = p.heading + (this.physics.reverser < 0 ? Math.PI : 0);
      this.train.rotation.x = -Math.atan(p.grade);
    }

    this.updateCamera(p);
    this.photoreal.update(this.camera, this.renderer, p);
    this.terrain.update(p.x, p.z, this.allTracks);
    this.sun.position.set(p.x + 60, p.y + 100, p.z + 30);
    this.sun.target.position.set(p.x, p.y, p.z);
    this.sun.target.updateMatrixWorld();

    this.lastAspectById.clear();
    if (this.activeLineKey === 'ion') {
      for (const sig of this.signals.lineSignals) {
        if (Math.abs(sig.s_ion - this.s) > 250) continue;
        const asp = this.signals.aspectFor(
          sig,
          this.simClock,
          this.s,
          this.physics.speedKmh(),
          dir,
          0,
        );
        this.lastAspectById.set(sig.id, asp);
      }
    }
    this.terrain.updateSignalAspects((id) => this.lastAspectById.get(id) ?? null);

    const activeX = new Set<number>();
    if (this.activeLineKey !== 'ion') {
      for (const c of this.signals.crossings) {
        if (this.signals.crossingActive(c, this.s, this.activeLineKey)) activeX.add(c.id);
      }
    }
    this.terrain.updateCrossingGates(activeX, this.simClock);

    this.weatherFx?.update(dt, this.camera);
    this.updateHud(limit, rowInfo, enf.aspect, p.heading);
    this.renderer.render(this.scene, this.camera);

    if (this.s > this.sLimits()[1] - 8 && Math.abs(this.physics.speed) < 0.5) {
      this.finish();
    }
  };

  private updateCamera(p: { x: number; y: number; z: number; heading: number }) {
    if (this.lrv && this.pose) {
      const lead = this.pose.modules[0];
      const leadObj = this.lrv.modules[0];
      const dest = leadObj.getObjectByName('destSign');
      if (dest) dest.visible = this.camMode !== 0; // exterior sign would black out the cab view
      if (this.camMode === 0) {
        // Driver's eye in cab A: ~1.6 m behind the nose, seated eye ≈ floor + 1.9 m
        const eye = new THREE.Vector3(0.35, LRV_FLOOR_ATR_M + 1.9, lead.len / 2 - 1.6);
        leadObj.updateMatrixWorld();
        this.camera.position.copy(eye.applyMatrix4(leadObj.matrixWorld));
        this.tmpE.set(this.input.lookPitch, Math.PI + this.input.lookYaw, 0, 'YXZ');
        this.camQ.setFromEuler(this.tmpE);
        this.camera.quaternion.copy(leadObj.quaternion).multiply(this.camQ);
      } else if (this.camMode === 1) {
        // Chase cam: follows the lead module from behind/above
        const fx = lead.fwd.x, fz = lead.fwd.z;
        this.camera.position.set(lead.pos.x - fx * 26, lead.pos.y + 8, lead.pos.z - fz * 26);
        this.camera.lookAt(lead.pos.x + fx * 6, lead.pos.y + 2, lead.pos.z + fz * 6);
      } else {
        const mid = this.pose.modules[2];
        const fx = mid.fwd.x, fz = mid.fwd.z;
        this.camera.position.set(mid.pos.x - fz * 18, mid.pos.y + 4, mid.pos.z + fx * 18);
        this.camera.lookAt(mid.pos.x, mid.pos.y + 2, mid.pos.z);
      }
      return;
    }
    if (this.camMode === 0) {
      // Driver's eye in the loco cab window (model-local, forward = +z), see Vehicles.DIESEL_CAB_EYE.
      // v1.4.0 put the eye 7.5 m *behind* the reference inside the long hood → solid colour.
      this.train.updateMatrixWorld();
      const eye = new THREE.Vector3(DIESEL_CAB_EYE.x, DIESEL_CAB_EYE.y, DIESEL_CAB_EYE.z);
      this.camera.position.copy(eye.applyMatrix4(this.train.matrixWorld));
      this.tmpE.set(this.input.lookPitch, Math.PI + this.input.lookYaw, 0, 'YXZ');
      this.camQ.setFromEuler(this.tmpE);
      this.camera.quaternion.copy(this.train.quaternion).multiply(this.camQ);
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

  private updateHud(limit: number, row: string, aspect: SignalAspect | null, heading: number) {
    this.hud.speedVal.textContent = String(Math.round(this.physics.speedKmh()));
    this.hud.powerVal.textContent = String(this.physics.powerNotch);
    this.hud.brakeVal.textContent = String(this.physics.brakeNotch) + (this.physics.holdBrake ? ' HOLD' : '');
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
    const distM = next ? Math.max(0, next.distance_m - this.s) : 0;
    const eta = next ? etaSeconds(distM, this.physics.speed) : null;
    this.hud.nextStation.textContent = next
      ? `${next.name} · ${Math.round(distM)} m · ETA ${formatEta(eta)}`
      : 'End of line';
    this.hud.doors.textContent = this.physics.doorsOpen ? 'Doors OPEN' : 'Doors closed';
    this.hud.panto.textContent = this.physics.electric ? (this.physics.pantographUp ? 'Panto up' : 'Panto down') : 'Diesel';
    this.hud.reverser.textContent = reverserLabel(this.physics.reverser);
    this.hud.voltage.textContent = this.physics.electric ? `${this.physics.lineVoltage} V` : '—';
    this.hud.slip.className = 'lamp ' + (this.physics.wheelslip ? 'on' : 'off');
    if (this.hud.blockVal) {
      const reason = this.physics.powerBlockedReason();
      this.hud.blockVal.textContent = reason || '';
      this.hud.blockVal.parentElement?.classList.toggle('hidden', !reason);
    }
    if (this.hud.ionVal) {
      const st = this.photoreal.status;
      this.hud.ionVal.textContent =
        st === 'ready' || st === 'loading' ? 'Google 3D Tiles' : st === 'error' ? 'OSM (3D tiles failed)' : this.ion.hudLabel();
    }
    if (this.hud.vigVal) {
      const v = Math.max(0, Math.ceil(this.physics.vigilanceTimer));
      this.hud.vigVal.textContent = this.physics.deadmanOk ? `Vig ${v}s` : 'VIG FAIL';
    }
    const h = Math.floor(this.simClock / 3600) % 24;
    const m = Math.floor((this.simClock % 3600) / 60);
    const sec = Math.floor(this.simClock % 60);
    this.hud.clock.textContent = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;

    this.minimap?.draw({
      track: this.track,
      stations: this.stations.stations,
      s: this.s,
      heading,
    });
  }

  /** Blank the HUD while a route loads (no stale values from the previous run). */
  private resetHud() {
    const dash = (el?: HTMLElement) => { if (el) el.textContent = '—'; };
    for (const k of ['speedVal', 'powerVal', 'brakeVal', 'limitVal', 'signalVal', 'clock', 'voltage', 'reverser', 'rowVal', 'vigVal']) dash(this.hud[k]);
    if (this.hud.speedVal) this.hud.speedVal.textContent = '0';
    if (this.hud.nextStation) this.hud.nextStation.textContent = 'Loading route…';
    if (this.hud.doors) this.hud.doors.textContent = '';
    if (this.hud.panto) this.hud.panto.textContent = '';
    if (this.hud.slip) this.hud.slip.className = 'lamp off';
    if (this.hud.blockVal) {
      this.hud.blockVal.textContent = '';
      this.hud.blockVal.parentElement?.classList.add('hidden');
    }
  }

  stop() {
    this.running = false;
    this.photoreal.showAttribution(false);
    this.tutorial.skip();
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
        <li>Elapsed: ${(elapsed / 60).toFixed(1)} min</li>
      </ul>
      <button id="againBtn" type="button">Back to menu</button>`;
    this.onEnd?.(html);
  }
}
