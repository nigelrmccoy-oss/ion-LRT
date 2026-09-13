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
const startBtn = document.getElementById('startBtn') as HTMLButtonElement;

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

startBtn.addEventListener('click', async () => {
  menu.classList.add('hidden');
  endReport.classList.add('hidden');
  hudEl.classList.remove('hidden');
  await game.start({
    route: routeSel.value as RouteKey,
    startStationId: startSel.value,
    weather: weatherSel.value as Weather,
    tod: todSel.value as 'day' | 'dusk' | 'night',
    onEnd: (html) => {
      endReport.innerHTML = html;
      endReport.classList.remove('hidden');
      hudEl.classList.add('hidden');
      document.getElementById('againBtn')?.addEventListener('click', showMenu);
    },
  });
});

window.addEventListener('keydown', (e) => {
  if (e.code === 'Escape') showMenu();
});

initMenu().catch(console.error);
