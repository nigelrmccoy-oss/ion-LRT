export class Input {
  keys = new Set<string>();
  mouseDX = 0;
  mouseDY = 0;
  lookYaw = 0;
  lookPitch = 0;
  pointerLocked = false;
  private canvas: HTMLCanvasElement;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    window.addEventListener('keydown', (e) => {
      this.keys.add(e.code);
      if (['Space', 'ArrowUp', 'ArrowDown'].includes(e.code)) e.preventDefault();
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    canvas.addEventListener('click', () => canvas.requestPointerLock());
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

  pressed(code: string) { return this.keys.has(code); }
}
