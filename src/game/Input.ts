/**
 * Keyboard + mouse + standard-mapping gamepad (Xbox / Chromium Gamepad API).
 * Discrete pad buttons are queued as the same key codes Game.handleCabKey already
 * understands, so pad and keyboard share one handler. Analog triggers set notches
 * only while past the deadzone (or more recently than the keyboard); otherwise the
 * keyboard remains the source of truth and releasing a trigger never yanks notches
 * back to zero under a keyboard driver.
 */
export const GAMEPAD_DEADZONE = 0.15;

/** Standard-mapping button indices (https://w3c.github.io/gamepad/#remapping). */
export const GP = {
  A: 0, B: 1, X: 2, Y: 3,
  LB: 4, RB: 5, LT: 6, RT: 7,
  VIEW: 8, MENU: 9,
  UP: 12, DOWN: 13, LEFT: 14, RIGHT: 15,
} as const;

export type NotchSource = 'keys' | 'pad';

type PadButton = { pressed: boolean; value: number };
type PadLike = {
  connected?: boolean;
  mapping: string;
  buttons: readonly PadButton[];
  axes: readonly number[];
};

export class Input {
  keys = new Set<string>();
  /**
   * Every physical keydown, in order. A queue (not a Set) so rapid presses between two
   * frames are all handled — at ~5 fps a Set collapsed W×7 into P3.
   */
  private edgeQueue: string[] = [];
  mouseDX = 0;
  mouseDY = 0;
  lookYaw = 0;
  lookPitch = 0;
  pointerLocked = false;
  private canvas: HTMLCanvasElement;

  /** Who last drove the power/brake notches: keyboard edges or analog triggers. */
  notchSource: NotchSource = 'keys';
  /** Analog-driven notches for this frame (null = leave keyboard notches alone). */
  padPowerNotch: number | null = null;
  padBrakeNotch: number | null = null;
  /** Held like Shift while B is down on a standard pad. */
  padSanding = false;
  /** Held like Space while X is down (horn edge is also queued). */
  padHorn = false;

  /** Previous button pressed flags for edge detection (per pad index, 16 buttons). */
  private prevButtons: boolean[] = [];
  /** Test double: when set, pollGamepads reads this instead of navigator.getGamepads(). */
  private testPads: (PadLike | null)[] | null = null;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    // Single document listener — works in Electron and browser
    document.addEventListener('keydown', (e) => {
      // auto-repeat is ignored; every real press is queued (capped so a stalled tab can't grow it)
      if (!e.repeat && this.edgeQueue.length < 64) this.edgeQueue.push(e.code);
      this.keys.add(e.code);
      if (['Space', 'ArrowUp', 'ArrowDown'].includes(e.code)) e.preventDefault();
    });
    document.addEventListener('keyup', (e) => this.keys.delete(e.code));

    canvas.tabIndex = 0;
    canvas.addEventListener('click', () => {
      canvas.focus();
      void canvas.requestPointerLock();
    });
    document.addEventListener('pointerlockchange', () => {
      this.pointerLocked = document.pointerLockElement === canvas;
    });
    document.addEventListener('mousemove', (e) => {
      if (!this.pointerLocked) return;
      this.mouseDX += e.movementX;
      this.mouseDY += e.movementY;
    });
  }

  /** Inject fake gamepads for headless tests (null = use navigator.getGamepads). */
  setTestGamepads(pads: (PadLike | null)[] | null) {
    this.testPads = pads;
    if (!pads) this.prevButtons = [];
  }

  /** Mark keyboard as the notch source (call when W/S/arrows are handled). */
  noteKeyboardNotch() {
    this.notchSource = 'keys';
    this.padPowerNotch = null;
    this.padBrakeNotch = null;
  }

  /**
   * Poll the first connected standard-mapping gamepad. Queues key-code edges for
   * discrete buttons, writes analog notch suggestions, adds right-stick look delta.
   * Safe to call every frame; no-ops when no pad is present.
   */
  pollGamepads() {
    this.padPowerNotch = null;
    this.padBrakeNotch = null;
    this.padSanding = false;
    this.padHorn = false;

    const pads = this.testPads
      ?? (typeof navigator !== 'undefined' && typeof navigator.getGamepads === 'function'
        ? navigator.getGamepads()
        : []);
    let pad: PadLike | null = null;
    for (let i = 0; i < pads.length; i++) {
      const p = pads[i];
      if (p && p.mapping === 'standard' && p.connected !== false) { pad = p; break; }
    }
    if (!pad) {
      this.prevButtons = [];
      return;
    }

    const btn = (i: number): PadButton => pad!.buttons[i] ?? { pressed: false, value: 0 };
    const axis = (i: number) => {
      const v = pad!.axes[i] ?? 0;
      return Math.abs(v) < GAMEPAD_DEADZONE ? 0 : v;
    };
    const value = (i: number) => {
      // Triggers are buttons with .value in [0,1] on the standard mapping
      const b = btn(i);
      const v = typeof b.value === 'number' ? b.value : (b.pressed ? 1 : 0);
      return v < GAMEPAD_DEADZONE ? 0 : v;
    };
    const pressed = (i: number) => {
      const b = btn(i);
      // analog triggers past deadzone count as pressed for hold actions
      if (i === GP.LT || i === GP.RT) return value(i) > 0;
      return !!b.pressed || (typeof b.value === 'number' && b.value > 0.5);
    };

    const now: boolean[] = [];
    for (let i = 0; i < 16; i++) now[i] = pressed(i);
    const was = this.prevButtons;
    const edge = (i: number) => now[i] && !was[i];

    // Discrete → same codes as the keyboard so Game.handleCabKey stays the single path
    if (edge(GP.UP)) this.pushEdge('KeyW');
    if (edge(GP.DOWN)) this.pushEdge('KeyS');
    if (edge(GP.LB) || edge(GP.LEFT) || edge(GP.RIGHT)) this.pushEdge('KeyR');
    if (edge(GP.A)) this.pushEdge('KeyT');
    if (edge(GP.X)) this.pushEdge('Space');
    if (edge(GP.Y)) this.pushEdge('KeyH');
    if (edge(GP.RB)) this.pushEdge('KeyV');
    if (edge(GP.VIEW)) this.pushEdge('KeyP');
    if (edge(GP.MENU)) {
      this.pushEdge('Escape');
      // main.ts listens on window for Escape (pointer unlock / menu)
      try {
        // Prefer a real KeyboardEvent so main.ts's Escape listener runs in the browser.
        // Node tests stub window.dispatchEvent and accept a plain { type, code } object.
        const ev = typeof KeyboardEvent === 'function'
          ? new KeyboardEvent('keydown', { code: 'Escape', bubbles: true })
          : ({ type: 'keydown', code: 'Escape' } as unknown as Event);
        window.dispatchEvent(ev);
      } catch { /* ignore */ }
    }
    this.prevButtons = now;

    this.padSanding = now[GP.B];
    this.padHorn = now[GP.X];

    // Analog triggers → notches. Brake wins if both are past the deadzone (safety).
    const rt = value(GP.RT);
    const lt = value(GP.LT);
    if (rt > 0 || lt > 0) {
      this.notchSource = 'pad';
      if (lt > 0) {
        this.padBrakeNotch = Math.max(1, Math.min(8, Math.round(lt * 8)));
        this.padPowerNotch = 0;
      } else {
        this.padPowerNotch = Math.max(1, Math.min(8, Math.round(rt * 8)));
        this.padBrakeNotch = 0;
      }
    }
    // When triggers are released we leave notches where they are and keep notchSource;
    // the next keyboard W/S calls noteKeyboardNotch() and takes over.

    // Right stick look (same units as mouse: accumulate into mouseDX/DY for consumeLook)
    const rx = axis(2);
    const ry = axis(3);
    // ~scale so full deflection ≈ a brisk mouse sweep per frame at 60 fps
    const stickSens = 14;
    this.mouseDX += rx * stickSens;
    this.mouseDY += ry * stickSens;
  }

  consumeLook() {
    const sens = 0.0022;
    this.lookYaw -= this.mouseDX * sens;
    this.lookPitch -= this.mouseDY * sens;
    this.lookPitch = Math.max(-1.2, Math.min(1.2, this.lookPitch));
    this.mouseDX = 0;
    this.mouseDY = 0;
  }

  pressed(code: string) {
    return this.keys.has(code);
  }

  /** True once per physical keydown (removes the oldest queued press of `code`). */
  consumeEdge(code: string) {
    const i = this.edgeQueue.indexOf(code);
    if (i < 0) return false;
    this.edgeQueue.splice(i, 1);
    return true;
  }

  /** All queued key presses since the last call, oldest first. */
  drainEdges(): string[] {
    const q = this.edgeQueue;
    this.edgeQueue = [];
    return q;
  }

  /** Test/debug hook: inject a key press. */
  pushEdge(code: string) {
    if (this.edgeQueue.length < 64) this.edgeQueue.push(code);
  }
}
