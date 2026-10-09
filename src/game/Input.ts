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
    this.edgeQueue.push(code);
  }
}
