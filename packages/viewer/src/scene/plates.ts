/** 層の板・外枠・層ラベル */
import * as THREE from 'three';
import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import type { Layer } from '@stack-atlas/schema';
import { LAYER_GAP, layerY } from '../layout/plate';

export const DEFAULT_LAYER_COLOR = '#9ca3af';

export function createPlates(
  scene: THREE.Scene,
  layers: readonly Layer[],
  plate: { width: number; depth: number },
): THREE.Group[] {
  return layers.map((L, i) => {
    const color = L.color ?? DEFAULT_LAYER_COLOR;
    const g = new THREE.Group();
    const m = new THREE.Mesh(
      new THREE.BoxGeometry(plate.width, 0.06, plate.depth),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.055, depthWrite: false }),
    );
    g.add(m);
    g.add(
      new THREE.LineSegments(
        new THREE.EdgesGeometry(m.geometry),
        new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.35 }),
      ),
    );
    const lab = document.createElement('div');
    lab.className = 'pl';
    const b = document.createElement('b');
    b.style.color = color;
    b.textContent = `L${i} ${L.name}`;
    lab.append(b, L.source ?? '');
    const lo = new CSS2DObject(lab);
    lo.position.set(plate.width / 2, 0.2, plate.depth / 2);
    lo.center.set(1, 0);
    g.add(lo);
    scene.add(g);
    return g;
  });
}

export function positionPlates(
  plates: readonly THREE.Group[],
  explode: number,
  gap = LAYER_GAP,
): void {
  plates.forEach((p, i) => (p.position.y = layerY(i, plates.length, explode, gap) - 0.4));
}
