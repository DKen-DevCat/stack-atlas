/** エッジの線（層またぎは直線、層内は中央を 1.2 持ち上げた弧） */
import * as THREE from 'three';
import type { Edge } from '@stack-atlas/schema';
import type { GraphModel } from '../graph/model';
import { edgeBaseStyle, type EdgeVisualState } from '../state';
import { anchorToward, type SceneNode } from './nodes';

const SEG = 14;
const ARC = 1.2;

export interface SceneEdge {
  edge: Edge;
  /** model.edges でのインデックス（Visuals.edges と対応） */
  index: number;
  from: SceneNode;
  to: SceneNode;
  line: THREE.Line<THREE.BufferGeometry, THREE.LineBasicMaterial>;
}

export function createSceneEdges(
  model: GraphModel,
  nodes: ReadonlyMap<string, SceneNode>,
  scene: THREE.Scene,
): SceneEdge[] {
  const out: SceneEdge[] = [];
  model.edges.forEach((e, index) => {
    const from = nodes.get(e.from);
    const to = nodes.get(e.to);
    if (!from || !to) return;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array((SEG + 1) * 3), 3));
    const st = edgeBaseStyle(model, e);
    const line = new THREE.Line(
      g,
      new THREE.LineBasicMaterial({
        color: st.color,
        transparent: true,
        opacity: st.opacity,
        depthWrite: false,
      }),
    );
    scene.add(line);
    out.push({ edge: e, index, from, to, line });
  });
  return out;
}

const tmp = new THREE.Vector3();

/** ノードの位置が変わったら呼ぶ（scene.updateMatrixWorld の後） */
export function updateEdgeGeometry(edges: readonly SceneEdge[]): void {
  for (const se of edges) {
    const pa = anchorToward(se.from, se.to);
    const pb = anchorToward(se.to, se.from);
    const attr = se.line.geometry.attributes.position as THREE.BufferAttribute;
    const arr = attr.array as Float32Array;
    const same = se.from.m.layerIndex === se.to.m.layerIndex;
    for (let i = 0; i <= SEG; i++) {
      const t = i / SEG;
      tmp.lerpVectors(pa, pb, t);
      if (same) tmp.y += Math.sin(Math.PI * t) * ARC;
      arr[i * 3] = tmp.x;
      arr[i * 3 + 1] = tmp.y;
      arr[i * 3 + 2] = tmp.z;
    }
    attr.needsUpdate = true;
    se.line.geometry.computeBoundingSphere();
  }
}

export function applyEdgeVisual(se: SceneEdge, v: EdgeVisualState): void {
  se.line.visible = v.visible;
  se.line.material.color.set(v.color);
  se.line.material.opacity = v.opacity;
}
