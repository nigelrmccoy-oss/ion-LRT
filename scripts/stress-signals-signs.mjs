/**
 * Signals, wayside speed boards, road-signal yaw, next-limit HUD, and
 * Firefox find-as-you-type key capture.
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

export async function runSignalsSignsTests(assert) {
  console.log('  signals & signs + key-capture tests\n');

  const { mod: B, cleanup: cB } = await bundleEntry(path.join(root, 'src/game/BarSignals.ts'), 'BarSignals');
  const { mod: W, cleanup: cW } = await bundleEntry(path.join(root, 'src/game/WaysideSigns.ts'), 'WaysideSigns');
  const { mod: H, cleanup: cH } = await bundleEntry(path.join(root, 'src/game/CabHud.ts'), 'CabHudSigns');
  const { mod: I, cleanup: cI } = await bundleEntry(path.join(root, 'src/game/Input.ts'), 'InputCapture');
  const terrainSrc = await readFile(path.join(root, 'src/game/Terrain.ts'), 'utf8');
  const gameSrc = await readFile(path.join(root, 'src/game/Game.ts'), 'utf8');
  const inputSrc = await readFile(path.join(root, 'src/game/Input.ts'), 'utf8');

  const { barAspectFor, createBarSignal, updateBarSignal } = B;
  const { buildWaysideSigns, createSpeedBoardMesh, WAYSIDE_OFFSET_M } = W;
  const { formatNextLimit } = H;
  const { shouldPreventGameKey, GAME_KEY_CODES } = I;

  try {
    assert('F1. barAspectFor: green → vertical (proceed), red → horizontal (stop), amber → amber',
      barAspectFor('green') === 'vertical'
        && barAspectFor('red') === 'horizontal'
        && barAspectFor('amber') === 'amber');

    const sig = createBarSignal('horizontal');
    assert('F1. createBarSignal builds a named group with vertical and horizontal bars',
      sig.name === 'bar-signal'
        && !!sig.userData.bars?.vertical
        && !!sig.userData.bars?.horizontal
        && sig.userData.bars.horizontal.visible === true
        && sig.userData.bars.vertical.visible === false);

    updateBarSignal(sig, 'vertical');
    assert('F1. updateBarSignal(vertical) shows the vertical bar and hides the horizontal',
      sig.userData.bars.vertical.visible === true
        && sig.userData.bars.horizontal.visible === false);

    assert('F1. Terrain places reserved-row ION bar signals (barSignalMeshes + createBarSignal)',
      /barSignalMeshes/.test(terrainSrc)
        && /createBarSignal\('horizontal'\)/.test(terrainSrc)
        && /updateBarSignal\(bar, barAspectFor/.test(terrainSrc));

    assert('F1. Game wires wayside boards via terrain.buildWaysideSigns(this.track)',
      /this\.terrain\.buildWaysideSigns\(this\.track\)/.test(gameSrc));

    assert('F1. Road traffic-signal heading equals p.heading (not + π/2); OCS arm still uses + π/2',
      /heading = p\.heading; \/\/ face the road\/train axis/.test(terrainSrc)
        && !/heading = p\.heading \+ Math\.PI \/ 2/.test(terrainSrc)
        && /p\.heading \+ Math\.PI \/ 2/.test(terrainSrc));

    const board = createSpeedBoardMesh(50, false);
    assert('F1. createSpeedBoardMesh builds a post + named face',
      board.name === 'speed-board'
        && board.children.length >= 2
        && board.getObjectByName('speed-board-face') != null
        && WAYSIDE_OFFSET_M === 2.2);

    const parent = new THREE.Group();
    const track = {
      length: 1000,
      postedChanges() { return [{ s: 200, kmh: 40 }, { s: 500, kmh: 70 }]; },
      speedLimitKmh() { return 70; },
      sample(s) { return { x: 0, y: 0, z: s, heading: 0 }; },
    };
    const boards = buildWaysideSigns(track, parent);
    const advances = boards.filter((b) => b.advance);
    const limits = boards.filter((b) => !b.advance);
    assert('F1. buildWaysideSigns places a limit board at every posted change and an advance board on reductions',
      limits.length === 2
        && advances.length === 1
        && advances[0].speed === 40
        && parent.children.length === boards.length
        && Math.abs(parent.children[0].position.x - WAYSIDE_OFFSET_M) < 1e-9);

    assert('F1. formatNextLimit renders "50 km/h in 320 m" and returns "—" when either value is missing (Haywire)',
      formatNextLimit(50, 320) === '50 km/h in 320 m'
        && formatNextLimit(null, 100) === '—'
        && formatNextLimit(50, null) === '—'
        && formatNextLimit(undefined, undefined) === '—');

    assert('F1. Game updateHud suppresses next-limit values in Haywire',
      /const nxt = haywire \? null : this\.track\.nextLimitChange\(this\.s\)/.test(gameSrc)
        && /nextLimitKmh: haywire \? null : nextLimitKmh/.test(gameSrc));

    // Key capture (Firefox find-as-you-type / quick-find)
    const ev = (code, extra = {}) => ({ code, preventDefault() {}, ...extra });
    assert('Keys. GAME_KEY_CODES includes cab binds plus Slash and Quote',
      GAME_KEY_CODES.has('KeyW')
        && GAME_KEY_CODES.has('Space')
        && GAME_KEY_CODES.has('Slash')
        && GAME_KEY_CODES.has('Quote')
        && GAME_KEY_CODES.has('KeyC'));

    assert('Keys. while capturing, bound letters and / \' are preventDefault\'d',
      shouldPreventGameKey(ev('KeyW'), true)
        && shouldPreventGameKey(ev('Slash'), true)
        && shouldPreventGameKey(ev('Quote'), true)
        && shouldPreventGameKey(ev('Space'), true));

    assert('Keys. Ctrl/Meta, F5, F11, F12 are never blocked',
      !shouldPreventGameKey(ev('KeyW', { ctrlKey: true }), true)
        && !shouldPreventGameKey(ev('KeyR', { metaKey: true }), true)
        && !shouldPreventGameKey(ev('F5'), true)
        && !shouldPreventGameKey(ev('F11'), true)
        && !shouldPreventGameKey(ev('F12'), true));

    assert('Keys. focus in input/select/textarea is not captured',
      !shouldPreventGameKey(ev('KeyW', { target: { tagName: 'INPUT' } }), true)
        && !shouldPreventGameKey(ev('Slash', { target: { tagName: 'SELECT' } }), true)
        && !shouldPreventGameKey(ev('Quote', { target: { tagName: 'TEXTAREA' } }), true));

    assert('Keys. Space/arrows still capture when a run is not active; letters do not',
      shouldPreventGameKey(ev('Space'), false)
        && shouldPreventGameKey(ev('ArrowDown'), false)
        && !shouldPreventGameKey(ev('KeyW'), false)
        && !shouldPreventGameKey(ev('Slash'), false));

    assert('Keys. Input.ts uses shouldPreventGameKey; Game sets input.capturing on start and clears it on stop',
      /shouldPreventGameKey\(e, this\.capturing\)/.test(inputSrc)
        && /this\.input\.capturing = true/.test(gameSrc)
        && /this\.input\.capturing = false/.test(gameSrc));
  } finally {
    await cB();
    await cW();
    await cH();
    await cI();
  }
}
