// 2 面の地図（Phase 8-6）の見た目: 3D の地図に配線図の規則（docs/15 §3.6、D31）を当てる（純関数）。Q20 のモックの
// 「提案の規則」をそのまま本実装にしたもの（2026-11-10 にユーザーが決定。docs/20 §6）。
// 範囲は不透明度だけ（赤と橙の閉包を使わない）。光るのは配線図の選択を地図に写したもの（litOnMap）だけ（v1 の閉包は使わない。
// 8-1 で直した「共有の箱でほぼ全部が光る」が戻るため。docs/20 §5.1 #6）。沈んだノードはラベルも消す（CSS の .viewer.linked）。
// 選択が無いときの hover は、そのノードにつながる線を少し明るくするだけ（ほかを沈めない。配線図の hover と同じ強さ）
import { edgeKey, type MapLit } from '@stack-atlas/wiring';
import { NO_HIGHLIGHT } from '../graph/closure';
import type { DiffMarks } from '../graph/diff';
import type { GraphModel } from '../graph/model';
import { computeVisuals, type ViewState, type Visuals } from '../state';

/** 沈んだノードの不透明度は scene/nodes.ts の dim（0.12）。沈んだ線はこれ */
export const DIM_EDGE_OPACITY = 0.05;
/** 光っている線（範囲）の不透明度。色は通常の色のまま */
export const LIT_EDGE_OPACITY = 0.95;

export function linkedVisuals(
  model: GraphModel,
  state: ViewState,
  marks: DiffMarks | null,
  lit: MapLit | null,
): Visuals {
  // 層・kind の表示、キャッシュ、差分は今の規則のまま（hover と選択の閉包だけ外す）
  const base = computeVisuals(model, { ...state, hoverId: null, selectedId: null }, marks);
  if (!lit) {
    const hov = state.hoverId;
    if (!hov) return base;
    return {
      ...base,
      edges: base.edges.map((ev, i) => {
        const e = model.edges[i]!;
        return e.from === hov || e.to === hov
          ? { ...ev, opacity: Math.min(1, ev.opacity * 2.5) }
          : ev;
      }),
    };
  }
  const nodes = new Map(base.nodes);
  for (const [id, nv] of base.nodes) {
    nodes.set(id, {
      ...nv,
      visual: lit.nodes.has(id) ? 'normal' : 'dim',
      ringOpacity: lit.nodes.has(id) ? nv.ringOpacity : 0.15,
      diff: null,
    });
  }
  const edges = base.edges.map((ev, i) => {
    const e = model.edges[i]!;
    return {
      ...ev,
      opacity: lit.edges.has(edgeKey(e.from, e.to)) ? LIT_EDGE_OPACITY : DIM_EDGE_OPACITY,
    };
  });
  return { hl: NO_HIGHLIGHT, nodes, edges, ghostOpacity: Math.min(base.ghostOpacity, 0.06) };
}
