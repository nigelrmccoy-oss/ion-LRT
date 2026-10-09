import { Game, type RouteKey } from './game/Game';
import type { Weather } from './game/Physics';

const canvas = document.getElementById('c') as HTMLCanvasElement;
const menu = document.getElementById('menu')!;
const hudEl = document.getElementById('hud')!;
const endReport = document.getElementById('endReport')!;
const routeSel = document.getElementById('route') as HTMLSelectElement;
const startSel = document.getElementById('startStation') as HTMLSelectElement;
const weatherSel = document.getElementById('weather') as HTMLSelectElement;
const todSel = document.getElementById('tod') as HTMLSelectElement;
const tutorialOpt = document.getElementById('tutorialOpt') as HTMLInputElement;
const startBtn = document.getElementById('startBtn') as HTMLButtonElement;
const photorealOpt = document.getElementById('photorealOpt') as HTMLInputElement;
const photorealNote = document.getElementById('photorealNote');
// Only a presence check — the token itself is never displayed or logged.
const hasIonToken = !!(import.meta.env.VITE_CESIUM_ION_TOKEN || '').trim();
const PHOTOREAL_KEY = 'ion-lrt-photoreal-v14';
if (!hasIonToken) {
  photorealOpt.checked = false;
  photorealOpt.disabled = true;
  if (photorealNote) photorealNote.textContent = 'Photoreal needs VITE_CESIUM_ION_TOKEN in .env.local — using OSM scenery.';
} else {
  try { photorealOpt.checked = localStorage.getItem(PHOTOREAL_KEY) === '1'; } catch { /* */ }
  photorealOpt.addEventListener('change', () => {
    try { localStorage.setItem(PHOTOREAL_KEY, photorealOpt.checked ? '1' : '0'); } catch { /* */ }
  });
}

const hud = {
  speedVal: document.getElementById('speedVal')!,
  powerVal: document.getElementById('powerVal')!,
  brakeVal: document.getElementById('brakeVal')!,
  nextStation: document.getElementById('nextStation')!,
  doors: document.getElementById('doors')!,
  panto: document.getElementById('panto')!,
  reverser: document.getElementById('reverser')!,
  voltage: document.getElementById('voltage')!,
  slip: document.getElementById('slip')!,
  clock: document.getElementById('clock')!,
  limitVal: document.getElementById('limitVal')!,
  weather: document.getElementById('weatherVal')!,
  rowVal: document.getElementById('rowVal')!,
  signalVal: document.getElementById('signalVal')!,
  blockVal: document.getElementById('blockVal')!,
  ionVal: document.getElementById('ionVal')!,
  vigVal: document.getElementById('vigVal')!,
};

let stationsData: any = null;
const game = new Game(canvas, hud);

async function initMenu() {
  stationsData = await (await fetch('./data/stations.json')).json();
  populateStations();
  routeSel.addEventListener('change', populateStations);
}

function populateStations() {
  const route = stationsData.routes[routeSel.value];
  startSel.innerHTML = '';
  for (const st of route.stations) {
    const opt = document.createElement('option');
    opt.value = st.id;
    opt.textContent = st.name;
    startSel.appendChild(opt);
  }
}

function showMenu() {
  game.stop();
  menu.classList.remove('hidden');
  hudEl.classList.add('hidden');
  endReport.classList.add('hidden');
  document.exitPointerLock?.();
}

/**
 * Debug / QA deep link: ?route=ion_southbound|ion_northbound|elmira|guelph
 *   &s=<chainage m> &cam=cab|chase|side (or 0|1|2) &dir=f|r &station=<id>
 *   &weather=dry|rain|snow &tod=day|dusk|night &tutorial=0|1
 * Starts the run immediately (no menu click). Never touches the Cesium token.
 */
function readDeepLink() {
  const q = new URLSearchParams(location.search);
  const route = q.get('route');
  if (!route) return null;
  const camRaw = (q.get('cam') || '').toLowerCase();
  const camMap: Record<string, 0 | 1 | 2> = { cab: 0, chase: 1, side: 2, trackside: 2, '0': 0, '1': 1, '2': 2 };
  const dirRaw = (q.get('dir') || '').toLowerCase();
  const sRaw = q.get('s');
  return {
    route,
    s: sRaw !== null && sRaw !== '' && Number.isFinite(Number(sRaw)) ? Number(sRaw) : undefined,
    cam: camRaw in camMap ? camMap[camRaw] : undefined,
    dir: dirRaw === 'f' || dirRaw === '1' ? 1 as const : dirRaw === 'r' || dirRaw === '-1' ? -1 as const : undefined,
    station: q.get('station') || undefined,
    weather: q.get('weather') || undefined,
    tod: q.get('tod') || undefined,
    tutorial: q.get('tutorial') === '1',
  };
}

async function startRun(extra: { startS?: number; cam?: 0 | 1 | 2; dir?: 1 | -1; runTutorial?: boolean } = {}) {
  menu.classList.add('hidden');
  endReport.classList.add('hidden');
  hudEl.classList.remove('hidden');
  // Clear prior tutorial skip only when checkbox on? keep localStorage; checkbox forces start
  if (tutorialOpt.checked) {
    try { localStorage.removeItem('ion-lrt-tutorial-v13-done'); } catch { /* */ }
  }
  await game.start({
    route: routeSel.value as RouteKey,
    startStationId: startSel.value,
    weather: weatherSel.value as Weather,
    tod: todSel.value as 'day' | 'dusk' | 'night',
    runTutorial: extra.runTutorial ?? tutorialOpt.checked,
    photoreal: hasIonToken && photorealOpt.checked,
    startS: extra.startS,
    cam: extra.cam,
    dir: extra.dir,
    onEnd: (html) => {
      endReport.innerHTML = html;
      endReport.classList.remove('hidden');
      hudEl.classList.add('hidden');
      document.getElementById('againBtn')?.addEventListener('click', showMenu);
    },
  });
  canvas.focus();
}

startBtn.addEventListener('click', () => { void startRun(); });

window.addEventListener('keydown', (e) => {
  if (e.code !== 'Escape') return;
  // First Esc: release pointer lock; second: menu
  if (document.pointerLockElement) {
    document.exitPointerLock();
    e.preventDefault();
    return;
  }
  showMenu();
});

initMenu()
  .then(() => {
    const dl = readDeepLink();
    if (!dl || !stationsData?.routes?.[dl.route]) return;
    routeSel.value = dl.route;
    populateStations();
    if (dl.station) startSel.value = dl.station;
    if (dl.weather) weatherSel.value = dl.weather;
    if (dl.tod) todSel.value = dl.tod;
    void startRun({ startS: dl.s, cam: dl.cam, dir: dl.dir, runTutorial: dl.tutorial });
  })
  .catch(console.error);
