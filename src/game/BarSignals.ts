import * as THREE from 'three';
import type { SignalAspect } from './Signals';

/**
 * ION LRT white-bar signal aspects.
 * - Vertical bar: proceed (green)
 * - Horizontal bar: stop (red)
 * - Amber: ESTIMATE - no public source for diagonal/flashing aspect
 */
export type BarAspect = 'vertical' | 'horizontal' | 'amber';

/**
 * Map SignalAspect to BarAspect for ION LRT white-bar signals.
 * @param aspect - SignalAspect from SignalSystem
 * @returns BarAspect for rendering
 */
export function barAspectFor(aspect: SignalAspect): BarAspect {
  switch (aspect) {
    case 'green':
      return 'vertical';
    case 'red':
      return 'horizontal';
    case 'amber':
      return 'amber';
  }
}

/**
 * Create a train-facing ION white-bar signal mesh.
 * @param aspect - Initial BarAspect
 * @returns THREE.Group containing the signal mesh
 */
export function createBarSignal(aspect: BarAspect): THREE.Group {
  const group = new THREE.Group();
  group.name = 'bar-signal';

  // Signal post (ESTIMATE dimensions based on typical LRT signal height)
  const postGeometry = new THREE.CylinderGeometry(0.08, 0.08, 3.5, 8);
  const postMaterial = new THREE.MeshStandardMaterial({ color: 0x333333 });
  const post = new THREE.Mesh(postGeometry, postMaterial);
  post.position.y = 1.75; // Base at ground level
  post.rotation.x = Math.PI / 2;
  group.add(post);

  // Signal head (ESTIMATE dimensions)
  const headGeometry = new THREE.BoxGeometry(0.3, 0.3, 0.1);
  const head = new THREE.Mesh(headGeometry, new THREE.MeshStandardMaterial({ color: 0xffffff }));
  head.position.y = 3.3; // Top of post
  head.position.z = 0.15; // Extend forward from post
  group.add(head);

  // Bars (initially vertical)
  const barGeometry = new THREE.BoxGeometry(0.2, 0.02, 0.08);
  const barMaterial = new THREE.MeshStandardMaterial({ color: 0xffffff });
  const verticalBar = new THREE.Mesh(barGeometry, barMaterial);
  verticalBar.position.y = 3.3;
  verticalBar.position.z = 0.15;
  verticalBar.rotation.x = Math.PI / 2;
  group.add(verticalBar);

  const horizontalBar = new THREE.Mesh(barGeometry, barMaterial);
  horizontalBar.position.y = 3.3;
  horizontalBar.position.z = 0.15;
  horizontalBar.rotation.z = Math.PI / 2;
  group.add(horizontalBar);

  // Store references for aspect updates
  (group as any)._bars = {
    vertical: verticalBar,
    horizontal: horizontalBar,
    amber: null, // ESTIMATE: amber aspect not implemented
  };

  return group;
}

/**
 * Update the bar signal aspect.
 * @param signal - THREE.Group created by createBarSignal
 * @param aspect - New BarAspect
 */
export function updateBarSignal(signal: THREE.Group, aspect: BarAspect): void {
  const bars = (signal as any)._bars;
  if (!bars) return;

  // Hide all bars first
  bars.vertical.visible = false;
  bars.horizontal.visible = false;

  // Show the appropriate bar
  switch (aspect) {
    case 'vertical':
      bars.vertical.visible = true;
      break;
    case 'horizontal':
      bars.horizontal.visible = true;
      break;
    case 'amber':
      // ESTIMATE: amber aspect - could be flashing or diagonal
      // For now, show both bars crossed (diagonal ESTIMATE)
      bars.vertical.visible = true;
      bars.horizontal.visible = true;
      break;
  }
}
