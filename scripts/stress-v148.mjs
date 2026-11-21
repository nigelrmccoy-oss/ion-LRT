/**
 * v1.4.8 checks: procedural 5-module Flexity Freedom mesh + tribute livery hooks.
 * Geometry only — physics is unchanged from v1.4.7 / v1.4.6.
 */
import * as esbuild from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

async function bundleEntry(entry, name) {
  const dir = await mkdtemp(path.join(tmpdir(), `ion-lrt-${name}-`));
  const outfile = path.join(dir, `${name}.mjs`);
  await esbuild.build({
    entryPoints: [entry],
    outfile,
    format: 'esm',
    platform: 'neutral',
    bundle: true,
    logLevel: 'silent',
  });
  const mod = await import(pathToFileURL(outfile).href + `?t=${Date.now()}`);
  return { mod, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

function finiteVec(v) {
  return Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z);
}

export async function v148Tests(assert) {
  const THREE = await import('three');
  const { mod: V, cleanup } = await bundleEntry(path.join(root, 'src/game/Vehicles.ts'), 'Vehicles148');
  const { mod: C, cleanup: cC } = await bundleEntry(path.join(root, 'src/game/Clearances.ts'), 'Clear148');

  let lrv;
  try {
    lrv = V.createFlexityArticulated();
  } catch (err) {
    assert('v148. createFlexityArticulated does not throw in node', false, String(err));
    await cleanup(); await cC();
    return;
  }
  assert('v148. createFlexityArticulated does not throw in node', !!lrv);

  assert('v148. five named modules A–E', lrv.modules.length === 5
    && lrv.modules[0].name === 'module-A-cab'
    && lrv.modules[1].name === 'module-B'
    && lrv.modules[2].name === 'module-C-centre'
    && lrv.modules[3].name === 'module-D'
    && lrv.modules[4].name === 'module-E-cab');
  assert('v148. three trucks (power, trailer, power)', lrv.trucks.length === 3
    && lrv.trucks[0].name === 'truck-power'
    && lrv.trucks[1].name === 'truck-trailer'
    && lrv.trucks[2].name === 'truck-power');
  assert('v148. root group is named flexity', lrv.group.name === 'flexity');

  const doors = [];
  lrv.group.traverse((o) => { if (o.name === 'door') doors.push(o); });
  assert('v148. eight plug doors (4 per side, none on C)', doors.length === 8);
  const doorOk = doors.every((d) => Number.isFinite(d.userData.side)
    && Number.isFinite(d.userData.baseX) && Number.isFinite(d.userData.baseZ)
    && d.userData.baseX === d.position.x && d.userData.baseZ === d.position.z);
  assert('v148. each door has side/baseX/baseZ userData matching its rest pose', doorOk);

  const destA = lrv.modules[0].getObjectByName('destSign');
  const destE = lrv.modules[4].getObjectByName('destSign');
  assert('v148. destSign on both cabs', !!destA && !!destE);

  const pan = lrv.modules[2].getObjectByName('pantograph');
  const shoe = lrv.modules[2].getObjectByName('pantoShoe');
  assert('v148. pantograph + pantoShoe on centre module C', !!pan && !!shoe);

  let glass = 0;
  lrv.group.traverse((o) => {
    const mat = o.material;
    if (mat && mat.name === 'lrvGlass') glass++;
  });
  assert('v148. lrvGlass material present for interior lighting', glass > 0, `meshes=${glass}`);

  assert('v148. lamp anchors on cab A and cab E',
    !!lrv.modules[0].getObjectByName('lampAnchor-head-L')
    && !!lrv.modules[0].getObjectByName('lampAnchor-head-R')
    && !!lrv.modules[4].getObjectByName('lampAnchor-tail-L')
    && !!lrv.modules[4].getObjectByName('lampAnchor-tail-R'));

  // Modules are authored at the origin; Game.ts poses them on the track. Lay them
  // end-to-end here so the world AABB reflects the 30.8 m consist.
  const MODULES = C.MODULES;
  let acc = 0;
  lrv.modules.forEach((g, i) => {
    acc += MODULES[i].len / 2;
    g.position.set(0, 0, acc);
    acc += MODULES[i].len / 2;
  });
  C.TRUCK_FROM_NOSE_M.forEach((s, i) => {
    lrv.trucks[i].position.set(0, 0, s);
  });
  lrv.group.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(lrv.group);
  const size = box.getSize(new THREE.Vector3());
  // length ≈ 30.8 m (+ a few cm of coupler chin / bellows overhang)
  assert('v148. consist length ~30.8 m', size.z > 30.4 && size.z < 31.6, `z=${size.z.toFixed(3)}`);
  assert('v148. consist width ~2.65 m', size.x > 2.50 && size.x < 2.90, `x=${size.x.toFixed(3)}`);
  // body/fairings around 3.6 m; pantograph shoe sits at the street wire height (~5 m)
  assert('v148. body/fairing height reaches ~3.6 m', box.max.y > 3.45, `maxY=${box.max.y.toFixed(3)}`);
  assert('v148. no NaN in world bounding box', [size.x, size.y, size.z, box.min.x, box.max.y].every(Number.isFinite));

  assert('v148. Clearances still 5 modules totalling 30.8 m',
    MODULES.length === 5 && Math.abs(MODULES.reduce((s, m) => s + m.len, 0) - 30.8) < 1e-9);

  let meshes = 0;
  let nanPos = false;
  lrv.group.traverse((o) => {
    if (!o.isMesh) return;
    meshes++;
    const p = o.position;
    if (!finiteVec(p)) nanPos = true;
  });
  assert('v148. mesh positions are finite', !nanPos);
  assert('v148. draw-call budget: merged modules stay under 80 meshes', meshes < 80, `meshes=${meshes}`);

  // diesel unchanged
  const loco = V.createDieselConsist('wcr');
  loco.updateMatrixWorld(true);
  const eye = new THREE.Vector3(V.DIESEL_CAB_EYE.x, V.DIESEL_CAB_EYE.y, V.DIESEL_CAB_EYE.z);
  const cabBox = new THREE.Box3().setFromObject(loco.getObjectByName('cab'));
  assert('v148. diesel cab eye still inside the (hollow) cab', cabBox.containsPoint(eye));

  await cleanup();
  await cC();
}
