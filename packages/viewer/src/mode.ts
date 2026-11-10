/**
 * Viewer の見た目と選択の口（D111。docs/20 §7.7）。3D だけのページは地図が選択を持ち、見た目は閉包の赤と橙（computeVisuals）。
 * 2 面の地図は選択を持たず、配線図の選択を写したもの（linkedVisuals）だけで光らせる。Viewer は `if (this.embed)` で分けずに
 * この口を 1 つ持つ（見た目・始点の印・hover の効き・メモのキー）
 */
import type { MapLit } from '@stack-atlas/wiring';
import type { DiffMarks } from './graph/diff';
import type { GraphModel } from './graph/model';
import { linkedVisuals } from './split/visuals';
import { computeVisuals, type ViewState, type Visuals } from './state';

export interface ViewerMode {
  /** 2 面の地図（配線図の選択を写す） */
  readonly linked: boolean;
  /** 今の見た目 */
  visuals(model: GraphModel, state: ViewState, marks: DiffMarks | null): Visuals;
  /** 始点（白い輪）のノード。null は始点の印を使わない（3D だけのページ） */
  starts(): ReadonlySet<string> | null;
  /** true の間は hover を無視する（2 面でどちらかの面で選んでいる。docs/15 §3.6 の規則 1） */
  hoverLocked(): boolean;
  /** 選んでいるものがあるか（2 面は配線図の選択。空白のクリック・Esc で解くものが無ければ外へ渡さない） */
  selected(): boolean;
  /** メモのキー（3D だけのページはノードの id、2 面は projectMap の memoKey） */
  memoKey(id: string): string;
}

/** 3D だけのページ（今までどおり。選択は Viewer の state.selectedId） */
export const standaloneMode = (state: () => ViewState): ViewerMode => ({
  linked: false,
  visuals: computeVisuals,
  starts: () => null,
  hoverLocked: () => false,
  selected: () => state().selectedId !== null,
  memoKey: (id) => id,
});

const NONE: ReadonlySet<string> = new Set();

/** 2 面の地図（配線図の選択を写したもの。docs/20 §5.1 #6〜#8） */
export function linkedMode(embed: {
  lit(): MapLit | null;
  hoverLocked(): boolean;
  memoKey(id: string): string;
}): ViewerMode {
  return {
    linked: true,
    visuals: (model, state, marks) => linkedVisuals(model, state, marks, embed.lit()),
    starts: () => embed.lit()?.starts ?? NONE,
    hoverLocked: () => embed.hoverLocked(),
    selected: () => embed.lit() !== null,
    memoKey: (id) => embed.memoKey(id),
  };
}
