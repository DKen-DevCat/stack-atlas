/**
 * 差分表示（?prev=）の 3D オブジェクト。
 * - 削除ノード: 灰色の半透明の箱（ゴースト）＋「削除」ラベル。ピッキングの対象にしない
 * - 削除エッジ: 灰色の破線（LineDashedMaterial）
 * - 追加・変更ノード: 緑・黄の輪郭（箱は EdgesGeometry、画面ノードはフレームの色）
 */
import * as THREE from 'three';
import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import type { Edge, GraphNode } from '@stack-atlas/schema';
import { FIELD_LABELS } from '../graph/diff';
import { kindMeta } from '../graph/kinds';
import type { ModelNode } from '../graph/model';
import { GHOST_SIZE } from '../layout/ghosts';
import { h } from '../ui/dom';
import { EDGE_POINTS, type SceneEdge } from './edges';
import type { BoxSceneNode, SceneNode } from './nodes';

export const DIFF_COLORS = { added: '#4ade80', changed: '#fbbf24', removed: '#9ca3af' } as const;

export interface GhostSceneNode extends BoxSceneNode {
  edges: THREE.LineSegments<THREE.EdgesGeometry, THREE.LineBasicMaterial>;
}

export function createGhosts(
  scene: THREE.Scene,
  prevNodes: ReadonlyMap<string, GraphNode>,
  placed: ReadonlyMap<string, { x: number; z: number; layerIndex: number }>,
): Map<string, GhostSceneNode> {
  const out = new Map<string, GhostSceneNode>();
  for (const [id, p] of placed) {
    const node = prevNodes.get(id);
    if (!node) continue;
    const meta = kindMeta(node.kind);
    const m: ModelNode = {
      id,
      node,
      layerIndex: p.layerIndex,
      kind: { ...meta, color: DIFF_COLORS.removed, size: GHOST_SIZE },
      isScreen: false,
      regions: [],
      out: [],
      inn: [],
    };
    const [sx, sy, sz] = GHOST_SIZE;
    const geo = new THREE.BoxGeometry(sx, sy, sz);
    const material = new THREE.MeshLambertMaterial({
      color: DIFF_COLORS.removed,
      transparent: true,
      opacity: 0.25,
      depthWrite: false,
    });
    const hit = new THREE.Mesh(geo, material);
    const edges = new THREE.LineSegments(
      new THREE.EdgesGeometry(geo),
      new THREE.LineBasicMaterial({ color: '#d1d5db', transparent: true, opacity: 0.5 }),
    );
    hit.add(edges);
    const memoBadge = h('span', { class: 'memo' });
    const label = h(
      'div',
      {
        class: 'nl ghost',
        title: `削除: 前回の graph.json にだけあるノード（${id}）`,
        attrs: { 'data-ghost-id': id },
      },
      h('span', { class: 'k' }, node.kind),
      node.name,
      h('span', { class: 'db removed' }, '削除'),
    );
    const lo = new CSS2DObject(label);
    lo.position.set(0, sy / 2, 0);
    hit.add(lo);
    scene.add(hit);
    out.set(id, {
      type: 'box',
      m,
      x: p.x,
      z: p.z,
      label,
      memoBadge,
      hit,
      material,
      half: sy / 2,
      edges,
    });
  }
  return out;
}

export function setGhostVisual(g: GhostSceneNode, opacity: number, layerVisible: boolean): void {
  g.hit.visible = opacity > 0 && layerVisible;
  g.material.opacity = opacity;
  g.edges.material.opacity = Math.min(1, opacity * 2);
  g.label.style.opacity = String(Math.min(1, opacity * 3));
}

/** 削除エッジ（両端が今のノードかゴーストのもの）を破線で作る */
export function createRemovedEdges(
  edges: readonly Edge[],
  lookup: (id: string) => SceneNode | undefined,
  scene: THREE.Scene,
): SceneEdge[] {
  const out: SceneEdge[] = [];
  for (const e of edges) {
    const from = lookup(e.from);
    const to = lookup(e.to);
    if (!from || !to) continue;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(EDGE_POINTS * 3), 3));
    const line = new THREE.Line(
      g,
      new THREE.LineDashedMaterial({
        color: DIFF_COLORS.removed,
        dashSize: 0.45,
        gapSize: 0.3,
        transparent: true,
        opacity: 0.25,
        depthWrite: false,
      }),
    );
    scene.add(line);
    out.push({ edge: e, index: -1, from, to, line });
  }
  return out;
}

/** updateEdgeGeometry のあとに呼ぶ（破線は線の長さが要る） */
export function refreshDashes(edges: readonly SceneEdge[]): void {
  for (const se of edges) se.line.computeLineDistances();
}

export function setRemovedEdgeVisual(
  se: SceneEdge,
  opacity: number,
  isVisible: (n: SceneNode) => boolean,
): void {
  se.line.visible = opacity > 0 && isVisible(se.from) && isVisible(se.to);
  se.line.material.opacity = Math.min(1, opacity * 2);
}

/** 追加・変更ノードのラベルに付ける印（表示は CSS で .nl.diff-added / .nl.diff-changed のときだけ） */
export function addDiffBadge(
  sn: SceneNode,
  mark: 'added' | 'changed',
  fields: string[] = [],
): void {
  const text = mark === 'added' ? '追加' : '変更';
  const title =
    mark === 'added'
      ? '追加: 前回の graph.json に無かったノード'
      : `変更: ${fields.map((f) => FIELD_LABELS[f] ?? f).join('・')}`;
  sn.label.append(h('span', { class: `db ${mark}`, title }, text));
}

const outlines = new WeakMap<
  SceneNode,
  THREE.LineSegments<THREE.EdgesGeometry, THREE.LineBasicMaterial>
>();

/** setNodeVisual のあとに呼ぶ。mark が null なら輪郭を消す */
export function applyDiffMark(sn: SceneNode, mark: 'added' | 'changed' | null): void {
  sn.label.classList.toggle('diff-added', mark === 'added');
  sn.label.classList.toggle('diff-changed', mark === 'changed');
  if (sn.type === 'screen') {
    if (mark) sn.frameMat.color.set(DIFF_COLORS[mark]);
    return;
  }
  let o = outlines.get(sn);
  if (!o && mark) {
    o = new THREE.LineSegments(
      new THREE.EdgesGeometry(sn.hit.geometry),
      new THREE.LineBasicMaterial({ color: DIFF_COLORS[mark] }),
    );
    o.scale.setScalar(1.04);
    sn.hit.add(o);
    outlines.set(sn, o);
  }
  if (o) {
    o.visible = !!mark;
    if (mark) o.material.color.set(DIFF_COLORS[mark]);
  }
}
