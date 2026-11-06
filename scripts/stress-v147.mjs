/**
 * v1.4.7 checks: Xbox / standard-mapping gamepad via the Gamepad API.
 * Injects a fake pad through Input.setTestGamepads (no browser, no hardware).
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import esbuild from 'esbuild';
import { pathToFileURL } from 'node:url';
import fs from 'node:fs/promises';
import os from 'node:os';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function bundleInput() {
  const outfile = path.join(os.tmpdir(), `ion-input147-${process.pid}-${Date.now()}.mjs`);
  await esbuild.build({
    entryPoints: [path.join(root, 'src/game/Input.ts')],
    bundle: true, format: 'esm', platform: 'neutral', outfile, logLevel: 'silent',
  });
  const mod = await import(pathToFileURL(outfile).href);
  return { mod, cleanup: async () => { try { await fs.unlink(outfile); } catch {} } };
}

function blankPad() {
  return {
    connected: true,
    mapping: 'standard',
    buttons: Array.from({ length: 16 }, () => ({ pressed: false, value: 0 })),
    axes: [0, 0, 0, 0],
  };
}

export async function v147Tests(assert) {
  const listeners = {};
  const fakeDoc = {
    addEventListener: (t, fn) => { (listeners[t] ||= []).push(fn); },
    pointerLockElement: null,
  };
  const prevDoc = globalThis.document;
  const prevWin = globalThis.window;
  globalThis.document = fakeDoc;
  let escDispatched = 0;
  globalThis.window = {
    dispatchEvent: (ev) => {
      if (ev && ev.code === 'Escape') escDispatched++;
      (listeners[ev?.type] || []).forEach((fn) => { try { fn(ev); } catch {} });
      return true;
    },
  };

  const { mod: IN, cleanup } = await bundleInput();
  try {
    const canvas = { addEventListener() {}, tabIndex: 0, focus() {}, requestPointerLock() {} };
    const DZ = IN.GAMEPAD_DEADZONE;
    const GP = IN.GP;
    const mk = () => new IN.Input(canvas);
    const pollWith = (inp, mut) => {
      const p = blankPad();
      mut(p);
      inp.setTestGamepads([p]);
      inp.pollGamepads();
    };

    // non-standard ignored
    {
      const inp = mk();
      inp.setTestGamepads([{ connected: true, mapping: '', buttons: blankPad().buttons, axes: [0, 0, 0, 0] }]);
      inp.pollGamepads();
      assert('GP. non-standard mapping is ignored',
        inp.drainEdges().length === 0 && inp.padPowerNotch === null && inp.padBrakeNotch === null);
    }

    // deadzone + analog notches
    {
      const inp = mk();
      pollWith(inp, (p) => { p.buttons[GP.RT] = { pressed: false, value: DZ * 0.5 }; });
      assert('GP. RT below deadzone does not drive power', inp.padPowerNotch === null);

      pollWith(inp, (p) => { p.buttons[GP.RT] = { pressed: true, value: 0.5 }; });
      assert('GP. RT = 0.5 → power notch 4, brake 0', inp.padPowerNotch === 4 && inp.padBrakeNotch === 0, `${inp.padPowerNotch}`);

      pollWith(inp, (p) => { p.buttons[GP.RT] = { pressed: true, value: 1 }; });
      assert('GP. RT = 1 → power notch 8', inp.padPowerNotch === 8);

      pollWith(inp, (p) => { p.buttons[GP.LT] = { pressed: true, value: 0.25 }; });
      assert('GP. LT past deadzone → brake ≥ 1, power 0',
        inp.padBrakeNotch !== null && inp.padBrakeNotch >= 1 && inp.padPowerNotch === 0, `${inp.padBrakeNotch}`);

      pollWith(inp, (p) => { p.buttons[GP.LT] = { pressed: true, value: 1 }; });
      assert('GP. LT = 1 → brake notch 8', inp.padBrakeNotch === 8);

      pollWith(inp, (p) => {
        p.buttons[GP.RT] = { pressed: true, value: 1 };
        p.buttons[GP.LT] = { pressed: true, value: 1 };
      });
      assert('GP. RT+LT together → brake wins', inp.padPowerNotch === 0 && inp.padBrakeNotch === 8);

      pollWith(inp, () => {});
      assert('GP. triggers released → no analog suggestion (does not yank notches)',
        inp.padPowerNotch === null && inp.padBrakeNotch === null);
    }

    // button edges
    const edgeMap = [
      [GP.UP, 'KeyW', 'D-pad up → KeyW'],
      [GP.DOWN, 'KeyS', 'D-pad down → KeyS'],
      [GP.LB, 'KeyR', 'LB → KeyR'],
      [GP.LEFT, 'KeyR', 'D-pad left → KeyR'],
      [GP.RIGHT, 'KeyR', 'D-pad right → KeyR'],
      [GP.A, 'KeyT', 'A → KeyT (doors)'],
      [GP.X, 'Space', 'X → Space (horn)'],
      [GP.Y, 'KeyH', 'Y → KeyH (lights)'],
      [GP.RB, 'KeyV', 'RB → KeyV (side cam)'],
      [GP.VIEW, 'KeyP', 'View → KeyP (panto)'],
    ];
    for (const [bi, code, label] of edgeMap) {
      const inp = mk();
      pollWith(inp, () => {}); // prev all false
      pollWith(inp, (p) => { p.buttons[bi] = { pressed: true, value: 1 }; });
      const edges = inp.drainEdges();
      assert(`GP. edge: ${label}`, edges.includes(code), `${edges.join(',')}`);
      inp.pollGamepads(); // still held
      assert(`GP. hold does not re-fire: ${label}`, inp.drainEdges().length === 0);
    }

    // Menu → Escape
    {
      escDispatched = 0;
      const inp = mk();
      pollWith(inp, () => {});
      pollWith(inp, (p) => { p.buttons[GP.MENU] = { pressed: true, value: 1 }; });
      assert('GP. Menu/Start → Escape edge', inp.drainEdges().includes('Escape'));
      assert('GP. Menu/Start dispatches window Escape (pointer unlock / menu)', escDispatched >= 1, `esc=${escDispatched}`);
    }

    // holds
    {
      const inp = mk();
      pollWith(inp, (p) => {
        p.buttons[GP.B] = { pressed: true, value: 1 };
        p.buttons[GP.X] = { pressed: true, value: 1 };
      });
      assert('GP. B held → padSanding', inp.padSanding);
      assert('GP. X held → padHorn', inp.padHorn);
      pollWith(inp, () => {});
      assert('GP. B/X released clears holds', !inp.padSanding && !inp.padHorn);
    }

    // right stick look
    {
      const inp = mk();
      const yaw0 = inp.lookYaw, pitch0 = inp.lookPitch;
      pollWith(inp, (p) => { p.axes[2] = 1; p.axes[3] = -0.5; });
      inp.consumeLook();
      assert('GP. right stick deflects look', inp.lookYaw !== yaw0 && inp.lookPitch !== pitch0);
      const y2 = inp.lookYaw;
      pollWith(inp, (p) => { p.axes[2] = DZ * 0.5; });
      inp.consumeLook();
      assert('GP. right stick inside deadzone does not look', inp.lookYaw === y2);
    }

    // keyboard still works with idle pad
    {
      const inp = mk();
      pollWith(inp, () => {});
      inp.pushEdge('KeyW');
      inp.pushEdge('KeyS');
      inp.noteKeyboardNotch();
      const q = inp.drainEdges();
      assert('GP. keyboard edges still work with an idle pad attached',
        q.filter((c) => c === 'KeyW' || c === 'KeyS').length === 2, `${q}`);
      assert('GP. noteKeyboardNotch clears analog + sets source keys',
        inp.padPowerNotch === null && inp.notchSource === 'keys');
    }

    // coexistence
    {
      const inp = mk();
      pollWith(inp, (p) => { p.buttons[GP.RT] = { pressed: true, value: 1 }; });
      assert('GP. pad owns notches while RT is live', inp.notchSource === 'pad' && inp.padPowerNotch === 8);
      inp.noteKeyboardNotch();
      assert('GP. keyboard reclaim after noteKeyboardNotch',
        inp.notchSource === 'keys' && inp.padPowerNotch === null);
    }

    assert('GP. deadzone constant is 0.15', Math.abs(DZ - 0.15) < 1e-9, `${DZ}`);
  } finally {
    globalThis.document = prevDoc;
    globalThis.window = prevWin;
    await cleanup();
  }
}
