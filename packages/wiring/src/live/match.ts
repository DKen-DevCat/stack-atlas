/**
 * 図に書かれた通信と、実際に出た通信の照合（docs/27 §4.3、D245）。
 * 比べるのは、経路の段のうち、画面の側から受け口へ出る通信の段（behaviorView の request）と、操作の中の通信。
 * 図の通信の段 1 つにつき、合う実際の通信を 1 つ当てる。順番は問わない
 */
import type { BehaviorView } from '../behavior-view.js';
import type { LiveRequest } from './operations.js';
import { routeKey } from './route.js';

export interface LiveVerdict {
  /** 合ったもの: 経路の段（StepView.index）と、通信の id */
  matched: Array<{ step: number; request: string }>;
  /** 図にあるが、出なかった通信の段（StepView.index） */
  missing: number[];
  /** 図に無い通信の id（図より多く出た分も、ここ） */
  extra: string[];
  ok: boolean;
}

export function matchRequests(view: BehaviorView, requests: readonly LiveRequest[]): LiveVerdict {
  const free = requests.map((r) => ({ id: r.id, route: r.route, used: false }));
  const verdict: LiveVerdict = { matched: [], missing: [], extra: [], ok: true };
  for (const step of view.steps) {
    if (!step.request) continue;
    const key = routeKey(step.request);
    const hit = free.find((r) => !r.used && r.route === key);
    if (hit) {
      hit.used = true;
      verdict.matched.push({ step: step.index, request: hit.id });
    } else verdict.missing.push(step.index);
  }
  verdict.extra = free.filter((r) => !r.used).map((r) => r.id);
  verdict.ok = verdict.missing.length === 0 && verdict.extra.length === 0;
  return verdict;
}

/**
 * 食い違いを、検査の指摘と同じ書き方の文にする（利用者が写して、図を書いたエージェントに渡す）。合っていれば、空
 */
export function verdictLines(
  view: BehaviorView,
  verdict: LiveVerdict,
  requests: readonly LiveRequest[],
): string[] {
  const lines: string[] = [];
  for (const index of verdict.missing) {
    const step = view.steps[index];
    if (!step?.request) continue;
    lines.push(
      `[警告・挙動] 挙動 "${view.id}" の段 ${index + 1}: 図にある通信 ${routeKey(step.request)} が、実際の操作では出ませんでした`,
    );
  }
  for (const id of verdict.extra) {
    const r = requests.find((x) => x.id === id);
    if (!r) continue;
    lines.push(
      `[警告・挙動] 挙動 "${view.id}": 実際の操作で出た通信 ${r.route ?? `${r.method} ${r.path}`} が、図の経路にありません`,
    );
  }
  return lines;
}
