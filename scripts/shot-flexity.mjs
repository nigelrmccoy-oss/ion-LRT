/**
 * Headless studio shots of the v1.4.8 Flexity (side, 3/4, cab end, curve articulation).
 * Heavy: wrap with flock and a 15-minute cap. Kills its own static server on exit.
 */
import * as esbuild from 'esbuild';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const outDir = process.argv[2] || path.join(process.env.HOME || '.', 'lrt-physics-logs', 'flexity-shots');

const CHROME_CANDIDATES = [
  process.env.CHROME,
  path.join(process.env.HOME, '.cache/ms-playwright/chromium-1248/chrome-linux64/chrome'),
  path.join(process.env.HOME, '.cache/ms-playwright/chromium_headless_shell-1248/chrome-headless-shell-linux64/chrome-headless-shell'),
].filter(Boolean);

const pageJs = `
import * as THREE from 'three';
import { createFlexityArticulated } from './Vehicles.ts';
import { MODULES } from './Clearances.ts';

const TRUCKS = [4.7705, 15.4, 26.0295];

function layout(lrv, curveR) {
  // Module A leads: its local +z (and its nose) point toward +s. Chainage 0 is the
  // trailing nose of cab E; s = total is the leading nose of cab A.
  const total = MODULES.reduce((a, m) => a + m.len, 0);
  const place = (s) => {
    const s0 = s - total / 2; // centre the consist on the origin
    if (!curveR) return { x: 0, z: s0, yaw: 0 };
    const yaw = s0 / curveR;
    return { x: curveR * (1 - Math.cos(yaw)), z: curveR * Math.sin(yaw), yaw };
  };
  // Walk A→E starting at the leading nose (s = total) so cab A sits at +z, nose pointing +z.
  let acc = total;
  lrv.modules.forEach((g, i) => {
    acc -= MODULES[i].len / 2;
    const p = place(acc);
    g.position.set(p.x, 0, p.z);
    g.rotation.set(0, p.yaw, 0);
    acc -= MODULES[i].len / 2;
  });
  lrv.trucks.forEach((t, i) => {
    const p = place(total - TRUCKS[i]);
    t.position.set(p.x, 0, p.z);
    t.rotation.set(0, p.yaw, 0);
  });
  lrv.group.updateMatrixWorld(true);
}

function makeRenderer(w, h) {
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
  renderer.setSize(w, h, false);
  renderer.setPixelRatio(1);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  return renderer;
}

function makeScene() {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x8aa6c1);
  scene.fog = new THREE.Fog(0x8aa6c1, 40, 120);
  scene.add(new THREE.HemisphereLight(0xd8e6f5, 0x3d4a2e, 0.85));
  const sun = new THREE.DirectionalLight(0xfff4e0, 1.35);
  sun.position.set(12, 22, 8);
  scene.add(sun);
  const fill = new THREE.DirectionalLight(0xb8cce0, 0.4);
  fill.position.set(-18, 8, -10);
  scene.add(fill);
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(200, 200),
    new THREE.MeshStandardMaterial({ color: 0x6b734f, roughness: 0.95, metalness: 0 }),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -0.01;
  scene.add(ground);
  return scene;
}

window.__SHOTS__ = {};
window.__READY__ = false;

(async () => {
  const W = 1280, H = 720;
  const renderer = makeRenderer(W, H);
  const scene = makeScene();
  const lrv = createFlexityArticulated();
  scene.add(lrv.group);
  const cam = new THREE.PerspectiveCamera(42, W / H, 0.1, 200);
  const snap = () => {
    renderer.render(scene, cam);
    return renderer.domElement.toDataURL('image/png');
  };

  layout(lrv, 0);
  cam.up.set(0, 1, 0);
  cam.position.set(40, 4.2, 0);
  cam.lookAt(0, 1.6, 0);
  window.__SHOTS__.side = snap();

  cam.position.set(14, 4.2, 28);
  cam.lookAt(0, 1.5, 8);
  window.__SHOTS__.front34 = snap();

  cam.position.set(0.3, 1.7, 24);
  cam.lookAt(0, 1.4, 15.2);
  window.__SHOTS__.cabEnd = snap();

  layout(lrv, 32);
  cam.position.set(20, 8.5, 8);
  cam.lookAt(2.5, 1.5, 0);
  window.__SHOTS__.curve = snap();

  window.__READY__ = true;
  document.title = 'READY';
})().catch((e) => {
  window.__ERROR__ = String((e && e.stack) || e);
  document.title = 'ERROR';
  console.error(e);
});
`;

const html = `<!doctype html>
<meta charset="utf-8">
<title>flexity shots</title>
<style>html,body{margin:0;background:#111;color:#eee;font:14px sans-serif}</style>
<div>rendering…</div>
<script type="module" src="./shot.js"></script>
`;

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

async function main() {
  await mkdir(outDir, { recursive: true });
  const dir = await mkdtemp(path.join(tmpdir(), 'ion-lrt-shot-'));
  const userData = await mkdtemp(path.join(tmpdir(), 'ion-chrome-'));
  const threeEntry = path.join(root, 'node_modules/three/build/three.module.js');
  await esbuild.build({
    stdin: {
      contents: pageJs,
      resolveDir: path.join(root, 'src/game'),
      sourcefile: 'shot-flexity.ts',
      loader: 'ts',
    },
    outfile: path.join(dir, 'shot.js'),
    bundle: true,
    format: 'esm',
    platform: 'browser',
    alias: { three: threeEntry },
    logLevel: 'silent',
  });
  await writeFile(path.join(dir, 'index.html'), html);

  const server = createServer(async (req, res) => {
    const file = (req.url || '/').split('?')[0] === '/' ? '/index.html' : (req.url || '/').split('?')[0];
    const fp = path.join(dir, path.normalize(file).replace(/^[/\\]+/, ''));
    if (!fp.startsWith(dir)) { res.writeHead(403); res.end(); return; }
    try {
      const data = await readFile(fp);
      const typ = fp.endsWith('.js') ? 'text/javascript' : 'text/html';
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

  let dbgPort = 0;
  const chrome = spawn(exe, [
    '--headless=new',
    '--no-sandbox',
    '--disable-gpu',
    '--use-angle=swiftshader',
    '--hide-scrollbars',
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
      const m = blob.match(/DevTools listening on (ws:\/\/\S+)/);
      if (m) { wsBrowser = m[1]; break; }
      if (chrome.exitCode != null) break;
      await sleep(50);
    }
    if (!wsBrowser) throw new Error('chrome did not open DevTools\\n' + logs.join('').slice(-2000));
    dbgPort = Number(new URL(wsBrowser).port);
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
      let ready = false;
      let err = null;
      for (let i = 0; i < 80; i++) {
        const ev = await send('Runtime.evaluate', {
          expression: '({ready: !!window.__READY__, err: window.__ERROR__ || null})',
          returnByValue: true,
        });
        const v = ev.result && ev.result.value;
        if (v && v.err) { err = v.err; break; }
        if (v && v.ready) { ready = true; break; }
        await sleep(250);
      }
      if (!ready) throw new Error('render not ready: ' + (err || 'timeout'));
      for (const name of ['side', 'front34', 'cabEnd', 'curve']) {
        const ev = await send('Runtime.evaluate', {
          expression: `window.__SHOTS__.${name}`,
          returnByValue: true,
        });
        const dataUrl = ev.result && ev.result.value;
        if (!dataUrl || !String(dataUrl).startsWith('data:image/png;base64,')) {
          throw new Error('missing shot ' + name);
        }
        const buf = Buffer.from(String(dataUrl).split(',')[1], 'base64');
        const fp = path.join(outDir, `flexity-${name}.png`);
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
