// 描く graph と配置（docs/18 §3.4）。DOM に触らない（単体テストできる）。
// 前が v2 なら、今の graph に前にしか無い箱・項目・線を足した graph を 1 回だけ配置する（選ぶ・たどるは今の索引）。
// 前の graph と比べられない・足した graph を配置できないときは、差分を外して今の graph だけで描き、警告を 1 件返す
import type { GraphV2, ValidationIssue } from '@stack-atlas/schema';
import {
  diffOverlayV2,
  indexGraph,
  layoutWiring,
  type DiffOverlayV2,
  type GraphIndex,
  type LayoutOptions,
  type WiringLayout,
} from '@stack-atlas/wiring';

export interface DrawPlan {
  /** 差分の印（前が無い・比べられないときは null） */
  overlay: DiffOverlayV2 | null;
  /** 描く graph の索引（差分があれば幽霊を足した graph、無ければ今の索引そのもの） */
  drawIndex: GraphIndex;
  layout: WiringLayout;
  /** 差分を外したときの警告（題名の横の警告の一覧に足す） */
  issue?: ValidationIssue;
}

type Layout = (index: GraphIndex, options?: LayoutOptions) => WiringLayout;

/**
 * 描く graph と配置を決める。今の graph の配置が投げる例外はそのまま投げる（配線図を描けない）。
 * `layout` はテストで差し替える用（既定は layoutWiring）
 */
export function planDraw(
  index: GraphIndex,
  graph: GraphV2,
  prev: GraphV2 | undefined,
  layout: Layout = layoutWiring,
): DrawPlan {
  let issue: ValidationIssue | undefined;
  if (prev) {
    try {
      const overlay = diffOverlayV2(prev, graph);
      const drawIndex = indexGraph(overlay.graph);
      // 切れた線の端は幽霊の項目に降りない（?prev= が無いときと同じ所。docs/18 §10.6）
      return {
        overlay,
        drawIndex,
        layout: layout(drawIndex, { ghostItems: overlay.ghost.items }),
      };
    } catch (e) {
      issue = {
        level: 'warning',
        path: 'prev',
        message: `前回の graph.json と比べられないため差分は表示しません: ${e instanceof Error ? e.message : String(e)}`,
      };
    }
  }
  return { overlay: null, drawIndex: index, layout: layout(index), ...(issue ? { issue } : {}) };
}
