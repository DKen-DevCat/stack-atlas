// 名前付きの始点（graph の views。docs/15 §3.9、docs/18 §3.4）: 分岐を既定に戻してから view の variants を当て、
// start（箱・項目・線のどれか）から選択を始める
import type { ViewStart, ViewV2 } from '@stack-atlas/schema';
import type { GraphIndex } from './graph-index.js';
import type { Selection } from './select.js';
import { defaultState, withVariants, type VariantState } from './variants.js';

/**
 * view の start を選択にする。host の枠になる箱は枠のクリックと同じ（枠の中の箱ごとにたどる）、箱は箱、項目の参照は項目、
 * `{ from, to }` は線。解けなければ null（validate で止まる想定）
 */
export function viewSelection(index: GraphIndex, start: ViewStart): Selection | null {
  if (typeof start !== 'string') {
    const hit = index.wires.some((w) => w.wire.from === start.from && w.wire.to === start.to);
    return hit ? { kind: 'wire', from: start.from, to: start.to } : null;
  }
  if (index.hosts.has(start)) return { kind: 'host', id: start };
  if (index.nodes.has(start)) return { kind: 'box', id: start };
  if (index.items.has(start)) return { kind: 'item', ref: start };
  return null;
}

/** view を当てた状態（既定 ＋ view.variants）と選択 */
export function applyView(
  index: GraphIndex,
  view: Pick<ViewV2, 'start' | 'variants'>,
): { state: VariantState; selection: Selection | null } {
  return {
    state: withVariants(defaultState(index), view.variants),
    selection: viewSelection(index, view.start),
  };
}

/** id の view（無ければ undefined） */
export function findView(views: readonly ViewV2[] | undefined, id: string): ViewV2 | undefined {
  return views?.find((v) => v.id === id);
}
