/** レイキャストでノードを拾う。画面ノードは UV → スクショ座標 → regions */
import * as THREE from 'three';
import { CH, CW } from '../screen/texture';
import type { SceneNode } from './nodes';

const ray = new THREE.Raycaster();
const ptr = new THREE.Vector2();

export function pickNode(
  clientX: number,
  clientY: number,
  dom: HTMLElement,
  camera: THREE.Camera,
  nodes: ReadonlyMap<string, SceneNode>,
  isNodeVisible: (id: string) => boolean,
): string | null {
  const r = dom.getBoundingClientRect();
  ptr.set(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
  ray.setFromCamera(ptr, camera);
  const list: THREE.Object3D[] = [];
  for (const n of nodes.values()) if (isNodeVisible(n.m.id)) list.push(n.hit);
  const h = ray.intersectObjects(list, false)[0];
  if (!h) return null;
  const id = h.object.userData.id as string;
  const n = nodes.get(id);
  if (!n) return null;
  if (n.type === 'screen' && h.uv) {
    const ref = n.screen.regionAt(h.uv.x * CW, (1 - h.uv.y) * CH, isNodeVisible);
    if (ref) return ref;
  }
  return id;
}
