/**
 * 層の板のサイズと層ごとの Y 座標、ノード配置（autoLayout への入力組み立て）。
 * three.js に依存しない。
 */
import type { GraphModel, ModelNode } from '../graph/model';
import { autoLayout, type LayoutEdgeInput, type LayoutNodeInput } from './auto';

/** 層の間隔（展開時） */
export const LAYER_GAP = 7.5;
/** 画面ノードの幅（3D 空間）。高さは 768:480 の比率 */
export const SCREEN_W = 6.4;
export const SCREEN_H = (SCREEN_W * 480) / 768;
/** 自動レイアウトで画面ノードが占める奥行き（傾き込み） */
export const SCREEN_FOOTPRINT = { w: 6.4, d: 4.2 } as const;

/** 展開時の層 i の Y（N 層を 0 を中心に並べ、index 0 が最上段） */
export function layerBaseY(i: number, count: number, gap = LAYER_GAP): number {
  return ((count - 1) / 2 - i) * gap;
}

/** explode（0 = 重ねる、1 = 展開）を反映した層の Y */
export function layerY(i: number, count: number, explode: number): number {
  return layerBaseY(i, count) * (0.07 + 0.93 * explode);
}

export interface SceneLayout {
  positions: ReadonlyMap<string, { x: number; z: number }>;
  plate: { width: number; depth: number };
}

export function footprintOf(n: ModelNode): { w: number; d: number } {
  if (n.isScreen) return { ...SCREEN_FOOTPRINT };
  return { w: n.kind.size[0], d: n.kind.size[2] };
}

export function computeSceneLayout(model: GraphModel): SceneLayout {
  const nodes: LayoutNodeInput[] = model.nodes.map((n) => {
    const input: LayoutNodeInput = { id: n.id, layer: n.layerIndex, footprint: footprintOf(n) };
    if (n.node.position) input.fixed = { x: n.node.position.x, z: n.node.position.z };
    return input;
  });
  const edges: LayoutEdgeInput[] = model.edges.map((e) => ({ from: e.from, to: e.to }));
  const res = autoLayout(nodes, edges, { minPlateWidth: 41, minPlateDepth: 20 });
  // 念のため: 配置されなかったノードは原点に置く（auto の契約上は起きない）
  const positions = new Map(res.positions);
  for (const n of model.nodes) if (!positions.has(n.id)) positions.set(n.id, { x: 0, z: 0 });
  return {
    positions,
    plate: { width: Math.max(41, res.plate.width), depth: Math.max(20, res.plate.depth) },
  };
}
