/**
 * 自動レイアウト（層ごとの 2 次元配置）。
 *
 * 契約（docs/08-design-phase0-1.md §3.4）:
 * - 決定的（乱数を使わない）
 * - `fixed` のあるノードは動かさない
 * - 上の層から順に、子を親群の x の重心に置き、層内は footprint が重ならないよう押し広げる
 * - 全ノードが板（plate）の中に収まる。板は minPlateWidth × minPlateDepth を下回らない
 *
 * ★ このファイルは現在スタブ（単純なグリッド配置）。別タスクで本実装に置き換える。
 */

export interface LayoutNodeInput {
  id: string;
  /** 層のインデックス（0 が最上段） */
  layer: number;
  /** 板の平面上で占める大きさ。w は x 方向、d は z 方向 */
  footprint: { w: number; d: number };
  /** graph.json の position。あれば固定 */
  fixed?: { x: number; z: number };
}

export interface LayoutEdgeInput {
  from: string;
  to: string;
}

export interface LayoutOptions {
  /** 板の最小幅（x）。既定 41 */
  minPlateWidth?: number;
  /** 板の最小奥行き（z）。既定 20 */
  minPlateDepth?: number;
  /** ノード間の最小間隔。既定 1.2 */
  gap?: number;
}

export interface LayoutResult {
  positions: Map<string, { x: number; z: number }>;
  /** すべての層で共通の板サイズ（中心が原点） */
  plate: { width: number; depth: number };
}

export function autoLayout(
  nodes: readonly LayoutNodeInput[],
  _edges: readonly LayoutEdgeInput[],
  opts: LayoutOptions = {},
): LayoutResult {
  const minW = opts.minPlateWidth ?? 41;
  const minD = opts.minPlateDepth ?? 20;
  const gap = opts.gap ?? 1.2;
  const positions = new Map<string, { x: number; z: number }>();
  const byLayer = new Map<number, LayoutNodeInput[]>();
  for (const n of nodes) {
    if (n.fixed) positions.set(n.id, { ...n.fixed });
    else (byLayer.get(n.layer) ?? byLayer.set(n.layer, []).get(n.layer)!).push(n);
  }
  let maxW = minW;
  for (const list of byLayer.values()) {
    let x = -minW / 2 + gap;
    let z = -minD / 2 + gap;
    let rowD = 0;
    for (const n of list) {
      if (x + n.footprint.w > minW / 2 && x > -minW / 2 + gap) {
        x = -minW / 2 + gap;
        z += rowD + gap;
        rowD = 0;
      }
      positions.set(n.id, { x: x + n.footprint.w / 2, z: z + n.footprint.d / 2 });
      x += n.footprint.w + gap;
      rowD = Math.max(rowD, n.footprint.d);
      maxW = Math.max(maxW, x + minW / 2);
    }
  }
  return { positions, plate: { width: maxW, depth: minD } };
}
