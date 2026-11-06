export type TutorialStep = {
  id: string;
  title: string;
  body: string;
  /** Optional key code the player must press to advance */
  expectCode?: string;
};

const STORAGE_KEY = 'ion-lrt-tutorial-v13-done';

export const TUTORIAL_STEPS: TutorialStep[] = [
  {
    id: 'look',
    title: 'Look around',
    body: 'Click the canvas to capture the mouse, or use the right stick on an Xbox / standard gamepad. Esc (or the Menu/Start button) releases the pointer (again opens the menu).',
  },
  {
    id: 'reverser',
    title: 'Set reverser Forward',
    body: 'Press R (or LB / D-pad ←→ on a gamepad) until the HUD shows F (Neutral → Forward → Reverse). Power will not apply in Neutral.',
    expectCode: 'KeyR',
  },
  {
    id: 'doors',
    title: 'Doors stay closed',
    body: 'Doors start closed (needed for power). Only press T when stopped to open/close for station work. Confirm HUD shows Doors closed, then press Enter.',
    expectCode: 'Enter',
  },
  {
    id: 'power',
    title: 'Notch up power',
    body: 'Press W (or ↑ / D-pad ↑) to raise power notches, or pull the right trigger. S / ↓ / D-pad ↓ / left trigger applies brake. Hold Shift or B to sand if wheelslip.',
    expectCode: 'KeyW',
  },
  {
    id: 'done',
    title: 'Ready to roll',
    body: 'Pantograph stays up for ION (P or View toggles). Space / X = horn. C = camera (V / RB = side camera). H / Y = headlights — they switch on automatically at dusk and night. Wheel-slip control and automatic sanding are on; Shift / B still sands by hand. Use the minimap for next station / ETA.',
  },
];

export class TutorialController {
  active = false;
  stepIndex = 0;
  private root: HTMLElement | null = null;

  shouldAutoStart(): boolean {
    try {
      return localStorage.getItem(STORAGE_KEY) !== '1';
    } catch {
      return true;
    }
  }

  mount(parent: HTMLElement) {
    this.root = document.createElement('div');
    this.root.id = 'tutorial';
    this.root.className = 'hidden';
    parent.appendChild(this.root);
  }

  start() {
    this.active = true;
    this.stepIndex = 0;
    this.render();
  }

  skip() {
    this.active = false;
    try {
      localStorage.setItem(STORAGE_KEY, '1');
    } catch {
      /* ignore */
    }
    if (this.root) this.root.classList.add('hidden');
  }

  current(): TutorialStep | null {
    if (!this.active) return null;
    return TUTORIAL_STEPS[this.stepIndex] || null;
  }

  onKey(code: string) {
    const step = this.current();
    if (!step) return;
    if (step.expectCode && code !== step.expectCode) return;
    if (step.expectCode || code === 'Enter' || code === 'Space') {
      this.advance();
    }
  }

  advance() {
    this.stepIndex += 1;
    if (this.stepIndex >= TUTORIAL_STEPS.length) {
      this.skip();
      return;
    }
    this.render();
  }

  private render() {
    if (!this.root) return;
    const step = this.current();
    if (!step) {
      this.root.classList.add('hidden');
      return;
    }
    this.root.classList.remove('hidden');
    this.root.innerHTML = `
      <div class="tut-card">
        <div class="tut-kicker">Controls tutorial · ${this.stepIndex + 1}/${TUTORIAL_STEPS.length}</div>
        <h2>${step.title}</h2>
        <p>${step.body}</p>
        <div class="tut-actions">
          <button type="button" id="tutNext">${step.expectCode ? 'Waiting for key…' : 'Next'}</button>
          <button type="button" id="tutSkip" class="ghost">Skip tutorial</button>
        </div>
      </div>`;
    this.root.querySelector('#tutSkip')?.addEventListener('click', () => this.skip());
    this.root.querySelector('#tutNext')?.addEventListener('click', () => this.advance());
  }
}
