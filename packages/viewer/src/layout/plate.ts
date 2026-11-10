/**
 * 層の板のサイズと層ごとの Y 座標、ノード配置（autoLayout への入力組み立て）。
 * three.js に依存しない。
 */
import type { GraphModel, ModelNode } from '../graph/model';
import { autoLayout, type LayoutEdgeInput, type LayoutNodeInput } from './auto';

/** 層の間隔（展開時）の基準値。板の奥行きが 20 を超えると layerGapFor() で少し広げる */
export const LAYER_GAP = 7.5;
/** 板の最小の大きさ（プロトタイプの板） */
export const MIN_PLATE = { width: 41, depth: 20 } as const;

/** 板の奥行きに応じた層の間隔: 7.5 + 0.1 × max(0, depth − 20)（奥行きが広がっても線が読めるように） */
export function layerGapFor(plateDepth: number): number {
  return LAYER_GAP + 0.1 * Math.max(0, plateDepth - MIN_PLATE.depth);
}
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
export function layerY(i: number, count: number, explode: number, gap = LAYER_GAP): number {
  return layerBaseY(i, count, gap) * (0.07 + 0.93 * explode);
}

/**
 * シーンの大きさ（プロトタイプ = 板 41 × 20・4 層・層間 7.5 を 1 とする）。
 * カメラの視点リセット位置・霧・最大距離に掛ける
 */
export function sceneScaleFor(
  plate: { width: number; depth: number },
  layerCount: number,
  gap = LAYER_GAP,
): number {
  const span = Math.max(1, layerCount - 1) * gap;
  return Math.max(
    1,
    plate.width / MIN_PLATE.width,
    plate.depth / MIN_PLATE.depth,
    span / (3 * LAYER_GAP),
  );
}

export interface SceneLayout {
  positions: ReadonlyMap<string, { x: number; z: number }>;
  plate: { width: number; depth: number };
  /** 層の間隔（layerGapFor(plate.depth)） */
  layerGap: number;
}

/**
 * ラベル（HTML）の幅の見積もり（3D の単位）。11px の名前・9px 等幅の kind・余白を、
 * 視点リセット位置（sceneScale 1 で約 25px / 単位）で換算する。長い名前が隣と重ならないよう、
 * レイアウトの footprint.w はこれ以上にする（上限 LABEL_W_MAX）
 */
export const LABEL_W_MAX = 9;
const PX_PER_UNIT = 25;
export function labelWidthOf(name: string, kind: string): number {
  let px = 20 + 5.5 * kind.length + 5;
  for (const ch of name) px += ch.charCodeAt(0) > 0x2e7f ? 11 : 6.2; // 全角は 11px 程度
  return Math.min(LABEL_W_MAX, px / PX_PER_UNIT);
}

export function footprintOf(n: ModelNode): { w: number; d: number } {
  if (n.isScreen) return { ...SCREEN_FOOTPRINT };
  return { w: Math.max(n.kind.size[0], labelWidthOf(n.node.name, n.node.kind)), d: n.kind.size[2] };
}

export function computeSceneLayout(model: GraphModel): SceneLayout {
  const nodes: LayoutNodeInput[] = model.nodes.map((n) => {
    const input: LayoutNodeInput = {
      id: n.id,
      layer: n.layerIndex,
      footprint: footprintOf(n),
      screen: n.isScreen,
    };
    if (n.node.position) input.fixed = { x: n.node.position.x, z: n.node.position.z };
    return input;
  });
  const edges: LayoutEdgeInput[] = model.edges.map((e) => ({ from: e.from, to: e.to }));
  const res = autoLayout(nodes, edges, {
    minPlateWidth: MIN_PLATE.width,
    minPlateDepth: MIN_PLATE.depth,
  });
  // 念のため: 配置されなかったノードは原点に置く（auto の契約上は起きない）
  const positions = new Map(res.positions);
  for (const n of model.nodes) if (!positions.has(n.id)) positions.set(n.id, { x: 0, z: 0 });
  const plate = {
    width: Math.max(MIN_PLATE.width, res.plate.width),
    depth: Math.max(MIN_PLATE.depth, res.plate.depth),
  };
  return { positions, plate, layerGap: layerGapFor(plate.depth) };
}
