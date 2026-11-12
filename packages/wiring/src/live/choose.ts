/**
 * 操作が、図のどの画面・どの挙動かを決める（docs/27 §4.3・§4.6、D237・D243）
 */
import type { GraphV2, NodeV2 } from '@stack-atlas/schema';
import { behaviorView } from '../behavior-view.js';
import type { LivePartEvent } from './events.js';
import { matchRequests } from './match.js';
import type { LiveOperation } from './operations.js';
import { mostLiteral } from './route.js';

/** 画面の箱の、アドレスのパス（任意の meta.path。比べるだけに使う。道具が、ここを開くことはない） */
const screenPath = (n: NodeV2): string | undefined => {
  const p: unknown = n.meta?.path;
  return typeof p === 'string' && p.startsWith('/') ? p : undefined;
};

/**
 * いま開いているアドレスが、図のどの画面か。
 * - meta.path が合う画面（2 つ以上合えば、文字どおりの部分が多いもの）
 * - 合うものが無く、画面の箱が 1 つで、その箱に meta.path が無ければ、それ（アドレスを書いていない図）
 * - 決まらなければ screen は undefined で、candidates に画面の箱を全部返す（利用者が選ぶ）
 */
export function screenFor(
  graph: Pick<GraphV2, 'nodes'>,
  pathname: string,
): { screen?: string; candidates: string[] } {
  const screens = graph.nodes.filter((n) => n.kind === 'screen');
  const candidates = screens.map((n) => n.id);
  const hit = mostLiteral(screens, screenPath, pathname);
  if (hit) return { screen: hit.id, candidates };
  const only = screens.length === 1 ? screens[0]! : undefined;
  return only && screenPath(only) === undefined ? { screen: only.id, candidates } : { candidates };
}

/**
 * 部品の出来事が、図のどれかの挙動の始まりになるか（操作への区切り（OperationRecorder）に渡す。
 * ならない出来事は、記録中の操作を切らない）
 */
export function startsBehavior(graph: Pick<GraphV2, 'behaviors'>): (ev: LivePartEvent) => boolean {
  const starts = new Set(
    (graph.behaviors ?? []).flatMap((b) =>
      b.trigger.part === undefined ? [] : [`${b.trigger.action}\u0000${b.trigger.part}`],
    ),
  );
  return (ev) => ev.parts.some((p) => starts.has(`${ev.how}\u0000${p}`));
}

export interface LiveChoice {
  /** 選んだ挙動の id（始まりの合う挙動が無ければ undefined = 図に無い操作） */
  behavior?: string;
  /** 始まりの合う挙動の全部（選んだものが先頭。分岐で分かれる挙動は、ここに並ぶ） */
  candidates: string[];
  /** 選んだ挙動の、始まりの部品（開く操作なら無い） */
  part?: string;
  /** 選んだ挙動が、この操作の中で何回起きたか（matchRequests の runs。続けて打った入力の回数） */
  runs: number;
}

/**
 * - 画面を開いた操作: その画面の「開く」挙動
 * - 部品への操作: 出来事ごとに、当たった部品を内側から見て、その種類の操作から始まる挙動を持つ、いちばん内側の部品の挙動
 * - 合う挙動が 2 つ以上あるとき: 実際の通信と、いちばん多く合うもの → 食い違い（出なかった・図に無い）の少ないもの →
 *   あとの出来事（押す → 送信なら、送信） → 図に先に書かれたもの
 */
export function chooseBehavior(graph: GraphV2, op: LiveOperation): LiveChoice {
  const behaviors = graph.behaviors ?? [];
  /** 候補: 挙動の id、始まりの部品、優先の順（大きいほど先）、起きた回数 */
  const found: Array<{ id: string; part?: string; rank: number; runs: number }> = [];
  if (op.open) {
    const screen = op.open.screen;
    for (const b of behaviors)
      if (b.trigger.action === 'open' && screen !== undefined && b.screen === screen)
        found.push({ id: b.id, rank: 0, runs: 1 });
  }
  for (const [gi, g] of op.gestures.entries()) {
    for (const part of g.parts) {
      const hits = behaviors.filter((b) => b.trigger.action === g.how && b.trigger.part === part);
      if (hits.length === 0) continue;
      for (const b of hits) {
        const seen = found.find((f) => f.id === b.id);
        if (seen) {
          seen.runs++;
          seen.rank = gi;
        } else found.push({ id: b.id, part, rank: gi, runs: 1 });
      }
      break; // いちばん内側の、挙動を持つ部品だけ
    }
  }
  if (found.length === 0) return { candidates: [], runs: 0 };
  const scored = found.map((f, order) => {
    const view = behaviorView(graph, f.id);
    const v = view ? matchRequests(view, op.requests, f.runs) : undefined;
    return {
      ...f,
      order,
      score: v?.matched.length ?? 0,
      misses: v ? v.missing.length + v.extra.length : 0,
    };
  });
  scored.sort(
    (a, b) => b.score - a.score || a.misses - b.misses || b.rank - a.rank || a.order - b.order,
  );
  const top = scored[0]!;
  const choice: LiveChoice = {
    behavior: top.id,
    candidates: scored.map((s) => s.id),
    runs: top.runs,
  };
  if (top.part !== undefined) choice.part = top.part;
  return choice;
}

/** 見せる値打ちのある操作か: 始まりの合う挙動があるか、通信が出た（図に無い操作）。どちらも無い出来事は、出さない */
export const worthShowing = (op: LiveOperation, choice: LiveChoice): boolean =>
  choice.behavior !== undefined || op.requests.length > 0;
