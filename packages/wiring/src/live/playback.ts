/**
 * 再生で、経路の段が、時間の軸のどこで光るか（docs/27 §4.3・§4.4）。
 * 実際に見えるのは、画面の側から受け口へ出る通信の段だけ（送った時刻と、返事が来た時刻）。ほかの段は、図に書かれた段で、
 * 見えた通信の前後に並べる:
 * - 最初の通信より前の段（押してから、送るまで）: 軸の始まり
 * - 通信の段より奥の段（受け口からデータの置き場まで）: その通信の「送ってから返るまで」の中に、行きは前半・戻りは後半に並べる
 * - 通信の段より手前の段（返ってから、画面に描くまで）: その通信の返事が来た時刻
 */
import type { BehaviorView } from '../behavior-view.js';
import type { LiveVerdict } from './match.js';
import type { LiveTimeline } from './timeline.js';

export interface StepTiming {
  /** StepView.index */
  index: number;
  /** 実際に見えた段（通信の段で、実際の通信が当たった） */
  observed: boolean;
  /** 行きが光る時刻・戻りが光る時刻（軸の上。光らない段は undefined） */
  sendAt?: number;
  backAt?: number;
  /** 当たった通信の id */
  request?: string;
  /** 図にあるが、実際には出なかった通信の段 */
  missing?: boolean;
}

export function stepTimings(
  view: BehaviorView,
  verdict: LiveVerdict,
  line: LiveTimeline,
): StepTiming[] {
  const out: StepTiming[] = [];
  /** いま中にいる通信（その段より奥の段を、この通信の中に並べる） */
  let anchor: { from: number; to: number; depth: number; inner: StepTiming[] } | undefined;
  /** 図の段を光らせる時刻（直前に見えた出来事の時刻） */
  let cursor = 0;
  const spread = () => {
    if (!anchor) return;
    const { from, to, inner } = anchor;
    const span = Math.max(0, to - from);
    const k = inner.length;
    inner.forEach((t, j) => {
      t.sendAt = from + (span * (j + 1)) / (2 * (k + 1));
      if (t.backAt !== undefined) t.backAt = to - (span * (j + 1)) / (2 * (k + 1));
    });
  };
  for (const step of view.steps) {
    const timing: StepTiming = { index: step.index, observed: false };
    if (step.request) {
      spread();
      anchor = undefined;
      const hit = verdict.matched.find((m) => m.step === step.index);
      const r = hit ? line.requests.find((x) => x.id === hit.request) : undefined;
      if (r) {
        timing.observed = true;
        timing.request = r.id;
        timing.sendAt = r.from;
        if (!r.pending) timing.backAt = r.to;
        anchor = { from: r.from, to: r.to, depth: step.depth, inner: [] };
        cursor = r.pending ? r.from : r.to;
      } else if (verdict.missing.includes(step.index)) timing.missing = true;
      out.push(timing);
      continue;
    }
    if (anchor && step.depth > anchor.depth) {
      // 受け口より奥: あとで、その通信の中に並べる（戻りの線があれば、戻りも光らせる）
      if (step.back.length) timing.backAt = anchor.to;
      anchor.inner.push(timing);
      out.push(timing);
      continue;
    }
    spread();
    anchor = undefined;
    timing.sendAt = cursor;
    if (step.back.length) timing.backAt = cursor;
    out.push(timing);
  }
  spread();
  return out;
}
