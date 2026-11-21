/**
 * Headless screenshots of the v1.4.9 TCMS + traction-power panels (no game launch).
 * Usage: node scripts/shot-hud.mjs [outDir]
 * Kills its own static server and Chrome on exit.
 */
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const outDir = process.argv[2] || path.join(process.env.HOME || '.', 'lrt-physics-logs', 'hud-shots');

const CHROME_CANDIDATES = [
  process.env.CHROME,
  path.join(process.env.HOME, '.cache/ms-playwright/chromium-1248/chrome-linux64/chrome'),
  path.join(process.env.HOME, '.cache/ms-playwright/chromium_headless_shell-1248/chrome-headless-shell-linux64/chrome-headless-shell'),
].filter(Boolean);

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function cdp(wsUrl, fn) {
  const WS = globalThis.WebSocket;
  if (!WS) throw new Error('Node WebSocket is unavailable');
  const sock = new WS(wsUrl);
  await new Promise((resolve, reject) => {
    sock.addEventListener('open', resolve);
    sock.addEventListener('error', reject);
  });
  let id = 0;
  const pending = new Map();
  sock.addEventListener('message', (ev) => {
    const msg = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString());
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(JSON.stringify(msg.error)));
      else resolve(msg.result);
    }
  });
  const send = (method, params) => new Promise((resolve, reject) => {
    const i = ++id;
    pending.set(i, { resolve, reject });
    sock.send(JSON.stringify({ id: i, method, params }));
  });
  try {
    return await fn(send);
  } finally {
    sock.close();
  }
}

const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>HUD shots</title>
  <link rel="stylesheet" href="./style.css" />
  <style>
    html,body{margin:0;background:#1a2230;height:100%;}
    #app{position:relative;width:1400px;height:700px;background:
      linear-gradient(180deg,#243044 0%,#1a2230 40%,#0b0e14 100%);}
    #hud{position:absolute;left:0;right:0;bottom:0;display:grid !important;}
    #minimap{background:#111;border-radius:6px}
  </style>
</head>
<body>
  <div id="app">
    <div id="hud">
      <canvas id="minimap" width="180" height="140"></canvas>
      <!-- panels injected from index.html structure by the shot script? inlined below -->
      PLACEHOLDER
    </div>
  </div>
  <script type="module" src="./shot.js"></script>
</body>
</html>
`;

const pageJs = `
function set(id, text) { const el = document.getElementById(id); if (el) el.textContent = text; }
function cls(id, c) { const el = document.getElementById(id); if (el) el.className = c; }

const states = {
  motoring() {
    set('speedVal','48'); document.getElementById('speedo').classList.remove('overspeed');
    set('limitVal','50'); set('atpMode','LOS'); cls('atpMode','atp-mode mode-los');
    set('signalVal','GREEN'); cls('signalLamp','signal-lamp aspect-green'); set('signalDist','120 m');
    set('nextStation','Allen  420 m  0:32'); set('powerVal','6'); set('brakeVal','0'); set('reverser','F');
    set('doors','Doors closed'); cls('doors','doors closed');
    set('panto','Panto up'); cls('panto','panto up');
    set('voltage','742 V'); set('elecVoltage','742 V'); cls('elecVoltage','elec-voltage band-nominal');
    set('elecBand','750 V nominal');
    const fill = document.getElementById('elecBarFill');
    if (fill) { fill.style.width = '52.6%'; fill.className = 'elec-bar-fill band-nominal'; }
    set('elecCurrent','+568 A'); set('elecPower','+421 kW'); cls('elecPower','elec-power motor');
    set('elecAux','40 kW est.'); set('elecDump','');
    set('elecSection','Waterloo Park – Grand River Hospital');
    set('elecTpss','Waterloo Park  0.6 km'); set('elecTpssNote','');
    cls('slip','lamp off'); cls('sand','lamp off'); cls('hornLamp','lamp off');
    set('lights','Lights auto'); set('vigVal','Vig 45s'); set('clock','08:14:22');
    set('rowVal','Street'); set('weatherVal','Dry'); set('ionVal','OSM / DEM');
    document.getElementById('block').classList.add('hidden');
  },
  regen() {
    set('speedVal','62'); document.getElementById('speedo').classList.remove('overspeed');
    set('limitVal','70'); set('atpMode','ATP'); cls('atpMode','atp-mode mode-atp');
    set('signalVal','—'); cls('signalLamp','signal-lamp aspect-none'); set('signalDist','—');
    set('nextStation','Block Line  1.1 km  1:05'); set('powerVal','0'); set('brakeVal','5'); set('reverser','F');
    set('doors','Doors closed'); cls('doors','doors closed');
    set('panto','Panto up'); cls('panto','panto up');
    set('voltage','918 V'); set('elecVoltage','918 V'); cls('elecVoltage','elec-voltage band-regen');
    set('elecBand','Regen (≤ 1000 V)');
    const fill = document.getElementById('elecBarFill');
    if (fill) { fill.style.width = '79.7%'; fill.className = 'elec-bar-fill band-regen'; }
    set('elecCurrent','-196 A'); set('elecPower','-180 kW'); cls('elecPower','elec-power regen');
    set('elecAux','40 kW est.'); set('elecDump','');
    set('elecSection','Overland – Block Line');
    set('elecTpss','Overland  0.4 km'); set('elecTpssNote','');
    cls('slip','lamp off'); cls('sand','lamp off'); cls('hornLamp','lamp off');
    set('lights','Lights on'); set('vigVal','Vig 45s'); set('clock','17:42:08');
    set('rowVal','Reserved'); set('weatherVal','Dry'); set('ionVal','OSM / DEM');
    document.getElementById('block').classList.add('hidden');
  },
  lowvolt() {
    set('speedVal','19'); document.getElementById('speedo').classList.add('overspeed');
    set('limitVal','25'); set('atpMode','ATP'); cls('atpMode','atp-mode mode-atp');
    set('signalVal','—'); cls('signalLamp','signal-lamp aspect-none'); set('signalDist','—');
    set('nextStation','Fairway  2.0 km'); set('powerVal','8'); set('brakeVal','0'); set('reverser','F');
    set('doors','Doors closed');
    set('panto','Panto up'); cls('panto','panto up');
    set('voltage','486 V'); set('elecVoltage','486 V'); cls('elecVoltage','elec-voltage band-undervoltage');
    set('elecBand','Below 500 V');
    const fill = document.getElementById('elecBarFill');
    if (fill) { fill.style.width = '13.2%'; fill.className = 'elec-bar-fill band-undervoltage'; }
    set('elecCurrent','+820 A'); set('elecPower','+398 kW'); cls('elecPower','elec-power motor');
    set('elecAux','40 kW est.'); set('elecDump','');
    set('elecSection','Overland – Fairway');
    set('elecTpss','Overland  1.5 km'); set('elecTpssNote','');
    cls('slip','lamp on'); cls('sand','lamp on'); cls('hornLamp','lamp off');
    set('lights','Lights on'); set('vigVal','Vig 12s'); set('clock','22:03:41');
    set('rowVal','Station'); set('weatherVal','Rain');
    const b = document.getElementById('block'); b.classList.remove('hidden');
    set('blockVal','Line voltage low');
  },
  doors() {
    set('speedVal','0'); document.getElementById('speedo').classList.remove('overspeed');
    set('limitVal','25'); set('atpMode','LOS'); cls('atpMode','atp-mode mode-los');
    set('signalVal','RED'); cls('signalLamp','signal-lamp aspect-red'); set('signalDist','18 m');
    set('nextStation','Kitchener City Hall  0 m'); set('powerVal','0'); set('brakeVal','0 HOLD'); set('reverser','F');
    set('doors','Doors OPEN RIGHT'); cls('doors','doors open');
    set('panto','Panto up'); cls('panto','panto up');
    set('voltage','748 V'); set('elecVoltage','748 V'); cls('elecVoltage','elec-voltage band-nominal');
    set('elecBand','750 V nominal');
    const fill = document.getElementById('elecBarFill');
    if (fill) { fill.style.width = '53.5%'; fill.className = 'elec-bar-fill band-nominal'; }
    set('elecCurrent','+53 A'); set('elecPower','+40 kW'); cls('elecPower','elec-power idle');
    set('elecAux','40 kW est.'); set('elecDump','');
    set('elecSection','Downtown Kitchener – Kitchener Market');
    set('elecTpss','Downtown Kitchener  180 m'); set('elecTpssNote',' (estimated site)');
    cls('slip','lamp off'); cls('sand','lamp off'); cls('hornLamp','lamp off');
    set('lights','Lights auto'); set('vigVal','Vig 45s'); set('clock','08:16:04');
    set('rowVal','Station'); set('weatherVal','Dry');
    const b = document.getElementById('block'); b.classList.remove('hidden');
    set('blockVal','Doors open — close with T');
  },
};

window.__APPLY__ = (name) => { (states[name] || states.motoring)(); return name; };
window.__READY__ = true;
`;

async function main() {
  await mkdir(outDir, { recursive: true });
  const indexSrc = await readFile(path.join(root, 'index.html'), 'utf8');
  const m = indexSrc.match(/<div id="tcms"[\s\S]*?<div id="endReport"/);
  if (!m) throw new Error('could not extract hud panels from index.html');
  const panels = m[0].replace(/\s*<div id="endReport"/, '');
  const page = html.replace('PLACEHOLDER', panels);

  const dir = await mkdtemp(path.join(tmpdir(), 'ion-lrt-hudshot-'));
  const userData = await mkdtemp(path.join(tmpdir(), 'ion-chrome-hud-'));
  await writeFile(path.join(dir, 'index.html'), page);
  await writeFile(path.join(dir, 'shot.js'), pageJs);
  const css = await readFile(path.join(root, 'src/style.css'));
  await writeFile(path.join(dir, 'style.css'), css);

  const server = createServer(async (req, res) => {
    const file = (req.url || '/').split('?')[0] === '/' ? '/index.html' : (req.url || '/').split('?')[0];
    const fp = path.join(dir, path.normalize(file).replace(/^[/\\]+/, ''));
    if (!fp.startsWith(dir)) { res.writeHead(403); res.end(); return; }
    try {
      const data = await readFile(fp);
      const typ = fp.endsWith('.js') ? 'text/javascript' : fp.endsWith('.css') ? 'text/css' : 'text/html';
      res.writeHead(200, { 'content-type': typ, 'cache-control': 'no-store' });
      res.end(data);
    } catch {
      res.writeHead(404); res.end('no');
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const url = `http://127.0.0.1:${port}/`;

  const exe = CHROME_CANDIDATES.find((p) => existsSync(p));
  if (!exe) throw new Error('No Chrome / headless shell found');

  const chrome = spawn(exe, [
    '--headless=new',
    '--no-sandbox',
    '--disable-gpu',
    '--use-angle=swiftshader',
    '--hide-scrollbars',
    `--window-size=1400,700`,
    `--user-data-dir=${userData}`,
    '--remote-debugging-port=0',
    '--remote-allow-origins=*',
    url,
  ], { stdio: ['ignore', 'pipe', 'pipe'] });

  const logs = [];
  const onLog = (d) => logs.push(d.toString());
  chrome.stderr.on('data', onLog);
  chrome.stdout.on('data', onLog);

  const cleanup = async () => {
    try { chrome.kill('SIGKILL'); } catch {}
    try { server.close(); } catch {}
    await rm(dir, { recursive: true, force: true }).catch(() => {});
    await rm(userData, { recursive: true, force: true }).catch(() => {});
  };

  try {
    let wsBrowser = null;
    for (let i = 0; i < 80; i++) {
      const blob = logs.join('');
      const m2 = blob.match(/DevTools listening on (ws:\\/\\/\\S+)/);
      if (m2) { wsBrowser = m2[1]; break; }
      if (chrome.exitCode != null) break;
      await sleep(50);
    }
    if (!wsBrowser) throw new Error('chrome did not open DevTools\\n' + logs.join('').slice(-2000));
    const dbgPort = Number(new URL(wsBrowser).port);
    let page = null;
    for (let i = 0; i < 40; i++) {
      const list = await fetch(`http://127.0.0.1:${dbgPort}/json/list`).then((r) => r.json());
      page = list.find((t) => t.type === 'page' && (t.url || '').includes(String(port))) || list.find((t) => t.type === 'page');
      if (page && page.webSocketDebuggerUrl) break;
      await sleep(100);
    }
    if (!page) throw new Error('no CDP page');

    await cdp(page.webSocketDebuggerUrl, async (send) => {
      await send('Runtime.enable');
      await send('Page.enable');
      await send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 700, deviceScaleFactor: 1, mobile: false });
      let ready = false;
      for (let i = 0; i < 80; i++) {
        const ev = await send('Runtime.evaluate', { expression: '!!window.__READY__', returnByValue: true });
        if (ev.result && ev.result.value) { ready = true; break; }
        await sleep(100);
      }
      if (!ready) throw new Error('hud shot page not ready\\n' + logs.join('').slice(-1000));

      for (const name of ['motoring', 'regen', 'lowvolt', 'doors']) {
        await send('Runtime.evaluate', { expression: `window.__APPLY__(${JSON.stringify(name)})`, returnByValue: true });
        await sleep(80);
        const shot = await send('Page.captureScreenshot', { format: 'png', fromSurface: true });
        const buf = Buffer.from(shot.data, 'base64');
        const fp = path.join(outDir, `hud-${name}.png`);
        await writeFile(fp, buf);
        console.log('wrote', fp, buf.length);
      }
    });
  } finally {
    await cleanup();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
