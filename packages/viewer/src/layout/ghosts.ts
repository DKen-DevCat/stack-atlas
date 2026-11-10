/**
 * 差分表示（?prev=）の削除ノード（ゴースト）の置き場所。three.js に依存しない。
 *
 * - まず前回の graph を自動レイアウトしたときの位置（position があればそれ）に置く
 * - 今の graph の同じ層のノード（とほかのゴースト）に重なるなら、x 方向に左右交互にずらして空きを探す
 */
import type { Graph } from '@stack-atlas/schema';
import { buildModel, type GraphModel } from '../graph/model';
import { computeSceneLayout, footprintOf } from './plate';

export interface GhostInput {
  id: string;
  /** 今の graph での層のインデックス */
  layerIndex: number;
  footprint: { w: number; d: number };
}

interface Rect {
  layer: number;
  x: number;
  z: number;
  w: number;
  d: number;
}

const GAP = 0.6;
/** ラベル（HTML）の想定幅。ラベル同士が重ならないよう x 方向はこれ以上の幅で判定する（auto.ts と同じ値） */
const LABEL_W = 4.5;
/** ゴーストのラベルは「削除」の印が付くぶん広い */
const GHOST_LABEL_W = 9;
const Z_MARGIN = 4;
const STEP = 1.2;
const MAX_TRIES = 200;

const overlaps = (a: Rect, b: Rect) =>
  a.layer === b.layer &&
  Math.abs(a.x - b.x) < (Math.max(a.w, LABEL_W) + Math.max(b.w, LABEL_W)) / 2 + GAP * 3 &&
  // 斜め上から見るので、奥行きが少し違うだけだとラベルが画面上で重なる。z は余分に空ける
  Math.abs(a.z - b.z) < (a.d + b.d) / 2 + Z_MARGIN;

/** ゴーストの footprint（ゴーストは画面ノードでも箱で描くので箱の大きさ） */
export const GHOST_SIZE = [2.2, 0.5, 1.4] as const;

/**
 * prev にあって model に無いノードを、model の層に割り当てて置く。
 * 層が今の graph に無いノードは返さない。
 */
export function placeGhosts(
  model: GraphModel,
  current: ReadonlyMap<string, { x: number; z: number }>,
  prev: Graph,
  removedIds: readonly string[],
): Map<string, { x: number; z: number; layerIndex: number }> {
  const layerIndex = new Map(model.layers.map((l, i) => [l.id, i]));
  const occupied: Rect[] = model.nodes.map((n) => {
    const p = current.get(n.id) ?? { x: 0, z: 0 };
    const f = footprintOf(n);
    return { layer: n.layerIndex, x: p.x, z: p.z, w: f.w, d: f.d };
  });
  const removed = new Set(removedIds);
  let prevPos: ReadonlyMap<string, { x: number; z: number }> = new Map();
  try {
    prevPos = computeSceneLayout(buildModel(prev)).positions;
  } catch {
    /* 前回の graph が崩れていても、原点から空きを探す */
  }
  const out = new Map<string, { x: number; z: number; layerIndex: number }>();
  for (const n of prev.nodes) {
    if (!removed.has(n.id) || out.has(n.id)) continue;
    const li = layerIndex.get(n.layer);
    if (li === undefined) continue;
    const start = prevPos.get(n.id) ?? { x: 0, z: 0 };
    const r: Rect = { layer: li, x: start.x, z: start.z, w: GHOST_LABEL_W, d: GHOST_SIZE[2] };
    for (let k = 0; k < MAX_TRIES && occupied.some((o) => overlaps(o, r)); k++) {
      // 0, +1, -1, +2, -2, ... ステップ
      const m = Math.ceil((k + 1) / 2) * (k % 2 === 0 ? 1 : -1);
      r.x = start.x + m * STEP;
    }
    occupied.push(r);
    out.set(n.id, { x: r.x, z: r.z, layerIndex: li });
  }
  return out;
}

/** 板がゴーストを含むよう、必要なら広げる */
export function plateWithGhosts(
  plate: { width: number; depth: number },
  ghosts: Iterable<{ x: number; z: number }>,
): { width: number; depth: number } {
  let { width, depth } = plate;
  for (const g of ghosts) {
    width = Math.max(width, 2 * (Math.abs(g.x) + GHOST_SIZE[0] / 2 + 1));
    depth = Math.max(depth, 2 * (Math.abs(g.z) + GHOST_SIZE[2] / 2 + 1));
  }
  return { width, depth };
}
