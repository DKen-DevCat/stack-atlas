// 【8-6 のモック（Q20）】3D の地図に配線図の規則（docs/15 §3.6、D31）を当てた見た目（純関数）。
// 範囲は不透明度だけ（赤と橙の閉包を使わない）。光るのは配線図の選択を地図に写したもの（litOnMap）だけ。
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

export function proposedVisuals(
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
