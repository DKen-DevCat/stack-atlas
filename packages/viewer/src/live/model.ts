/**
 * ライブの画面の状態（docs/27 §4.3・§4.4）。道具から届いた知らせを、操作に区切り、挙動を選び、図と照らし、再生の材料にする。
 * DOM も時計も持たない（時刻は渡された「いま」だけ）。区切るのは、ライブの画面の側だけ（events.ts の約束）
 */
import type { GraphV2, PartV2 } from '@stack-atlas/schema';
import {
  OperationRecorder,
  behaviorView,
  chooseBehavior,
  matchRequests,
  netChanges,
  startsBehavior,
  stepTimings,
  timelineOf,
  verdictLines,
  worthShowing,
  type BehaviorView,
  type LiveChange,
  type LiveChoice,
  type LiveMessage,
  type LiveOperation,
  type LiveRect,
  type LiveStatus,
  type LiveTimeline,
  type LiveValues,
  type LiveVerdict,
  type StepTiming,
} from '@stack-atlas/wiring';

/** 見せる 1 つの操作 */
export interface Played {
  /** 見せた順の番号（1 から） */
  n: number;
  op: LiveOperation;
  choice: LiveChoice;
  view?: BehaviorView;
  verdict?: LiveVerdict;
  timeline: LiveTimeline;
  timings: StepTiming[];
  /** 画面の変化の差（丸ごと描き直しても、増えた・消えた分だけ） */
  changes: Array<LiveChange & { at: number }>;
  /** 図との食い違い（検査の指摘と同じ書き方の文。写して、図を書いたエージェントに渡す） */
  lines: string[];
}

export const MODEL_LIMITS = { played: 50 } as const;

export class LiveModel {
  graph: GraphV2 | undefined;
  status: LiveStatus | undefined;
  /** いま開いている画面（道具が決めたもの。決まらなければ、利用者が選んだもの） */
  screen: string | undefined;
  /** 利用者が選んだ画面（道具が決められないときに使う） */
  chosenScreen: string | undefined;
  readonly played: Played[] = [];
  readonly values = new Map<string, LiveValues>();
  /** 部品の場所（id → 場所）。最後に届いたもの */
  rects = new Map<string, LiveRect>();
  private recorder = new OperationRecorder();
  private n = 0;

  /** 知らせを入れる。閉じて、見せることになった操作を返す */
  receive(msg: LiveMessage): Played[] {
    switch (msg.t) {
      case 'graph':
        this.graph = msg.graph;
        // 挙動の始まりにならない出来事は、記録中の操作を切らない（docs/27 §4.3）
        this.recorder = new OperationRecorder({ startsBehavior: startsBehavior(msg.graph) });
        return [];
      case 'status':
        this.status = msg.status;
        return [];
      case 'values':
        for (const v of msg.values) this.values.set(v.id, v);
        return [];
      case 'events': {
        const closed: LiveOperation[] = [];
        for (const raw of msg.events) {
          let ev = raw;
          if (ev.t === 'parts') {
            this.rects = new Map(ev.rects);
            continue;
          }
          if (ev.t === 'open') {
            this.screen = ev.screen;
            if (ev.screen === undefined && this.chosenScreen !== undefined)
              ev = { ...ev, screen: this.chosenScreen };
          }
          closed.push(...this.recorder.push(ev));
        }
        return this.settle(closed);
      }
    }
  }

  /** 時間が進んだ。静かになった操作を閉じて、見せることになったものを返す */
  tick(now: number): Played[] {
    return this.settle(this.recorder.tick(now));
  }

  /** いま記録している操作（まだ閉じていない） */
  get recording(): LiveOperation | undefined {
    return this.recorder.current;
  }

  /** 画面の箱の一覧 */
  screens(): string[] {
    return (this.graph?.nodes ?? []).filter((n) => n.kind === 'screen').map((n) => n.id);
  }

  /** この画面の挙動（画面が決まっていなければ、全部） */
  behaviors(): Array<{ id: string; name: string }> {
    const screen = this.screen ?? this.chosenScreen;
    return (this.graph?.behaviors ?? [])
      .filter((b) => screen === undefined || b.screen === screen)
      .map((b) => ({ id: b.id, name: b.name }));
  }

  part(id: string | undefined): PartV2 | undefined {
    return id === undefined ? undefined : this.graph?.parts?.find((p) => p.id === id);
  }

  /** 一覧から選んだ挙動（操作していないとき）の、見せる形 */
  view(id: string): BehaviorView | undefined {
    return this.graph ? behaviorView(this.graph, id) : undefined;
  }

  private settle(ops: readonly LiveOperation[]): Played[] {
    const graph = this.graph;
    if (!graph) return [];
    const out: Played[] = [];
    for (const op of ops) {
      const choice = chooseBehavior(graph, op);
      if (!worthShowing(op, choice)) continue;
      const view = choice.behavior ? behaviorView(graph, choice.behavior) : undefined;
      const verdict = view ? matchRequests(view, op.requests, choice.runs) : undefined;
      const timeline = timelineOf(op);
      const played: Played = {
        n: ++this.n,
        op,
        choice,
        timeline,
        timings: view && verdict ? stepTimings(view, verdict, timeline) : [],
        changes: netChanges(op.changes),
        lines: view && verdict ? verdictLines(view, verdict, op.requests) : [],
      };
      if (view) played.view = view;
      if (verdict) played.verdict = verdict;
      this.played.push(played);
      out.push(played);
    }
    while (this.played.length > MODEL_LIMITS.played) this.played.shift();
    return out;
  }
}
