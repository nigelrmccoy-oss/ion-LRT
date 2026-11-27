/**
 * Cab-camera occluder toggling: hide the opaque windscreen in cab view,
 * restore it (and the cab interior) for exterior cameras.
 */
import * as esbuild from 'esbuild';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as THREE from 'three';

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

function named(name) {
  const o = new THREE.Object3D();
  o.name = name;
  o.visible = true;
  return o;
}

export async function cabWindowTests(assert) {
  const { mod, cleanup } = await bundleEntry(path.join(root, 'src/game/CabCamera.ts'), 'CabCamera');
  const gameSrc = await readFile(path.join(root, 'src/game/Game.ts'), 'utf8');
  const blender = await readFile(path.join(root, 'tools/blender/build_flexity.py'), 'utf8');

  const {
    isCabViewOccluder, setCabCameraMeshVisibility, cabEyeLocal,
    CAB_EYE_X, CAB_EYE_BEHIND_NOSE_M,
  } = mod;

  try {
    assert(
      'CabWindow. lrvGlassFront in the Blender build is opaque (alpha 1.0) and nearly black — that is the black windscreen',
      /"glassFront": make_mat\("lrvGlassFront", \(0\.015, 0\.017, 0\.02\), 0\.0, 0\.48, alpha=1\.0\)/.test(blender)
        && /new_obj\("windscreen"/.test(blender),
    );
    assert(
      'CabWindow. isCabViewOccluder matches the GLB windscreen, dest sign, wipers, dash, seats, and joined cab groups',
      isCabViewOccluder('windscreen')
        && isCabViewOccluder('windscreen.001')
        && isCabViewOccluder('destSign')
        && isCabViewOccluder('destSign-A')
        && isCabViewOccluder('wiper-arm')
        && isCabViewOccluder('wiper-blade.002')
        && isCabViewOccluder('cab-dash')
        && isCabViewOccluder('seat-R')
        && isCabViewOccluder('module-A-cab-seat')
        && isCabViewOccluder('module-A-cab-interior')
        && isCabViewOccluder('module-A-cab-trim')
        && isCabViewOccluder('windows')
        && !isCabViewOccluder('cab-front')
        && !isCabViewOccluder('body')
        && !isCabViewOccluder('module-A-cab-lrvGlass')
        && !isCabViewOccluder('chin-number')
        && !isCabViewOccluder(''),
    );

    const lead = new THREE.Group();
    lead.name = 'module-A-cab';
    const parts = {
      windscreen: named('windscreen'),
      dest: named('destSign'),
      dash: named('cab-dash'),
      seatGroup: named('module-A-cab-seat'),
      trim: named('module-A-cab-trim'),
      front: named('cab-front'),
      body: named('body'),
      sideGlass: named('module-A-cab-lrvGlass'),
    };
    for (const o of Object.values(parts)) lead.add(o);

    setCabCameraMeshVisibility(lead, true);
    assert(
      'CabWindow. cab view hides windscreen, dest sign, dash, joined seats/trim; nose and side glass stay visible',
      parts.windscreen.visible === false
        && parts.dest.visible === false
        && parts.dash.visible === false
        && parts.seatGroup.visible === false
        && parts.trim.visible === false
        && parts.front.visible === true
        && parts.body.visible === true
        && parts.sideGlass.visible === true,
    );

    setCabCameraMeshVisibility(lead, false);
    assert(
      'CabWindow. chase/side view restores windscreen and cab interior to visible',
      parts.windscreen.visible
        && parts.dest.visible
        && parts.dash.visible
        && parts.seatGroup.visible
        && parts.trim.visible
        && parts.front.visible
        && parts.body.visible,
    );

    const eye = cabEyeLocal(6.436);
    assert(
      'CabWindow. eye is on the right, inboard of the ±0.42 wiper, and behind the nose',
      eye.x === CAB_EYE_X && CAB_EYE_X > 0 && CAB_EYE_X < 0.42
        && Math.abs(eye.z - (6.436 / 2 - CAB_EYE_BEHIND_NOSE_M)) < 1e-9
        && eye.y > 1.5 && eye.y < 2.2,
      `x=${eye.x} y=${eye.y.toFixed(3)} z=${eye.z.toFixed(3)}`,
    );

    assert(
      'CabWindow. Game.updateCamera toggles setCabCameraMeshVisibility and uses cabEyeLocal (and restores on camMode !== 0)',
      /setCabCameraMeshVisibility\(leadObj, this\.camMode === 0\)/.test(gameSrc)
        && /cabEyeLocal\(lead\.len\)/.test(gameSrc)
        && !/o\.visible = false/.test(gameSrc.match(/updateCamera[\s\S]*?placeSideCam/)?.[0] ?? ''),
    );
  } finally {
    await cleanup();
  }
}
