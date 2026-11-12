/**
 * 再生で、経路の段が、時間の軸のどこで光るか（docs/27 §4.3・§4.4）。
 * 実際に見えるのは、画面の側から受け口へ出る通信の段だけ（送った時刻と、返事が来た時刻）。ほかの段は、図に書かれた段で、
 * 見えた通信の前後に並べる:
 * - 最初の通信より前の段（押してから、送るまで）: 軸の始まり
 * - 通信の段より奥の段（受け口からデータの置き場まで）: その通信の「送ってから返るまで」の中に、行きは前半・戻りは後半に並べる
 * - 通信の段より手前の段（返ってから、画面に描くまで）: その通信の返事が来た時刻
 *
 * 光らせないもの（起きたと言えない段）:
 * - 返事が無かった通信（返らない・止めた・手元の外・失敗）の、奥の段と、そのあとの段（次に見えた通信まで）
 * - 出なかった通信の、奥の段と、そのあとの段（次に見えた通信まで）。条件つきで飛んだ通信は、奥の段だけ光らせない
 * 同時に呼ぶ所（parallel）は、どの列も、分かれる前の時刻から始まり、済んだら、いちばん遅い列の時刻に進む
 */
import type { BehaviorView, StepView } from '../behavior-view.js';
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

/** 段を光らせる時刻の進み（undefined = 起きたと言えないので、光らせない） */
interface Cursor {
  at: number | undefined;
  /** いま中にいる通信（その段より奥の段を、この通信の中に並べる。光らせないときは at が undefined） */
  anchor:
    { from: number; to: number; depth: number; inner: StepTiming[]; lit: boolean } | undefined;
}

export function stepTimings(
  view: BehaviorView,
  verdict: LiveVerdict,
  line: LiveTimeline,
): StepTiming[] {
  const out: StepTiming[] = [];
  const spread = (c: Cursor) => {
    const a = c.anchor;
    if (!a) return;
    const span = Math.max(0, a.to - a.from);
    const k = a.inner.length;
    a.inner.forEach((t, j) => {
      if (!a.lit) {
        delete t.sendAt;
        delete t.backAt;
        return;
      }
      t.sendAt = a.from + (span * (j + 1)) / (2 * (k + 1));
      if (t.backAt !== undefined) t.backAt = a.to - (span * (j + 1)) / (2 * (k + 1));
    });
    c.anchor = undefined;
  };

  const visit = (c: Cursor, step: StepView) => {
    const timing: StepTiming = { index: step.index, observed: false };
    out.push(timing);
    if (step.request) {
      spread(c);
      const hit = verdict.matched.find((m) => m.step === step.index);
      const r = hit ? line.requests.find((x) => x.id === hit.request) : undefined;
      if (r) {
        timing.observed = true;
        timing.request = r.id;
        timing.sendAt = r.from;
        const returned = !r.pending && !r.failed;
        if (returned) timing.backAt = r.to;
        c.anchor = { from: r.from, to: r.to, depth: step.depth, inner: [], lit: returned };
        c.at = returned ? r.to : undefined;
      } else {
        const skipped = verdict.skipped.includes(step.index);
        if (verdict.missing.includes(step.index)) timing.missing = true;
        c.anchor = { from: 0, to: 0, depth: step.depth, inner: [], lit: false };
        // 条件つきで飛んだ通信のあとは、続きの段を光らせる（飛ぶのは、図のとおり）
        if (!skipped) c.at = undefined;
      }
      return;
    }
    if (c.anchor && step.depth > c.anchor.depth) {
      // 受け口より奥: あとで、その通信の中に並べる（戻りの線があれば、戻りも光らせる）
      if (step.back.length) timing.backAt = c.anchor.to;
      c.anchor.inner.push(timing);
      return;
    }
    spread(c);
    if (c.at === undefined) return;
    timing.sendAt = c.at;
    if (step.back.length) timing.backAt = c.at;
  };

  let cursor: Cursor = { at: 0, anchor: undefined };
  /** いま中にいる、同時に呼ぶ所（分かれる前の時刻と、列ごとの終わりの時刻） */
  let group:
    | { id: number; lane: number; start: number | undefined; ends: Array<number | undefined> }
    | undefined;
  const closeLane = () => {
    if (!group) return;
    spread(cursor);
    group.ends.push(cursor.at);
  };
  const closeGroup = () => {
    if (!group) return;
    closeLane();
    const ends = group.ends;
    // どれかの列が起きたと言えなければ、そのあとも光らせない。言えれば、いちばん遅い列の時刻
    cursor = {
      at: ends.some((e) => e === undefined) ? undefined : Math.max(0, ...(ends as number[])),
      anchor: undefined,
    };
    group = undefined;
  };
  for (const step of view.steps) {
    const p = step.parallel;
    if (!p) {
      closeGroup();
      visit(cursor, step);
      continue;
    }
    if (!group || group.id !== p.group) {
      closeGroup();
      spread(cursor);
      group = { id: p.group, lane: p.lane, start: cursor.at, ends: [] };
      cursor = { at: group.start, anchor: undefined };
    } else if (group.lane !== p.lane) {
      closeLane();
      group.lane = p.lane;
      cursor = { at: group.start, anchor: undefined };
    }
    visit(cursor, step);
  }
  closeGroup();
  spread(cursor);
  return out;
}
