import * as THREE from 'three';
import type { SignalAspect } from './Signals';

/**
 * ION LRT white-bar signal aspects.
 * - Vertical bar: proceed (green)
 * - Horizontal bar: stop (red)
 * - Amber: ESTIMATE — no public source for a diagonal/flashing aspect
 */
export type BarAspect = 'vertical' | 'horizontal' | 'amber';

export type BarSignalGroup = THREE.Group & {
  userData: { bars: { vertical: THREE.Mesh; horizontal: THREE.Mesh } };
};

/** Map SignalAspect to BarAspect for ION LRT white-bar signals. */
export function barAspectFor(aspect: SignalAspect): BarAspect {
  switch (aspect) {
    case 'green': return 'vertical';
    case 'red': return 'horizontal';
    case 'amber': return 'amber';
  }
}

const BAR_ON = new THREE.MeshStandardMaterial({
  color: 0xf5f5f5, emissive: 0xe8e8e8, emissiveIntensity: 0.8, roughness: 0.35, metalness: 0.1,
});
const BAR_OFF = new THREE.MeshStandardMaterial({
  color: 0x2a2a2a, emissive: 0x000000, roughness: 0.7, metalness: 0.2,
});

/** Create a train-facing ION white-bar signal (local +Z is the lamp face). */
export function createBarSignal(aspect: BarAspect = 'horizontal'): THREE.Group {
  const group = new THREE.Group();
  group.name = 'bar-signal';

  const post = new THREE.Mesh(
    new THREE.CylinderGeometry(0.07, 0.08, 3.2, 8),
    new THREE.MeshStandardMaterial({ color: 0x333333, roughness: 0.7 }),
  );
  post.position.y = 1.6;
  group.add(post);

  const head = new THREE.Mesh(
    new THREE.BoxGeometry(0.36, 0.36, 0.1),
    new THREE.MeshStandardMaterial({ color: 0x1a1a1a, roughness: 0.6 }),
  );
  head.position.set(0, 3.25, 0.06);
  group.add(head);

  const verticalBar = new THREE.Mesh(new THREE.BoxGeometry(0.045, 0.26, 0.04), BAR_ON.clone());
  verticalBar.name = 'bar-vertical';
  verticalBar.position.set(0, 3.25, 0.12);
  group.add(verticalBar);

  const horizontalBar = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.045, 0.04), BAR_ON.clone());
  horizontalBar.name = 'bar-horizontal';
  horizontalBar.position.set(0, 3.25, 0.12);
  group.add(horizontalBar);

  group.userData.bars = { vertical: verticalBar, horizontal: horizontalBar };
  updateBarSignal(group, aspect);
  return group;
}

/** Update the bar signal aspect (vertical = proceed, horizontal = stop). */
export function updateBarSignal(signal: THREE.Group, aspect: BarAspect): void {
  const bars = signal.userData?.bars as { vertical: THREE.Mesh; horizontal: THREE.Mesh } | undefined;
  if (!bars) return;
  const showV = aspect === 'vertical' || aspect === 'amber';
  const showH = aspect === 'horizontal' || aspect === 'amber';
  bars.vertical.visible = showV;
  bars.horizontal.visible = showH;
  bars.vertical.material = showV ? BAR_ON : BAR_OFF;
  bars.horizontal.material = showH ? BAR_ON : BAR_OFF;
}
