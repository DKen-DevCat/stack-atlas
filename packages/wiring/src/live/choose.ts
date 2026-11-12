/**
 * 操作が、図のどの挙動かを決める（docs/27 §4.3・§4.6、D237・D243）
 */
import type { GraphV2, NodeV2 } from '@stack-atlas/schema';
import { behaviorView } from '../behavior-view.js';
import { matchRequests } from './match.js';
import type { LiveOperation } from './operations.js';
import { pathMatches } from './route.js';

/** 画面の箱の、アドレスのパス（任意の meta.path。比べるだけに使う。道具が、ここを開くことはない） */
const screenPath = (n: NodeV2): string | undefined => {
  const p: unknown = n.meta?.path;
  return typeof p === 'string' && p.startsWith('/') ? p : undefined;
};

/**
 * いま開いているアドレスが、図のどの画面か。
 * meta.path が合う画面（2 つ以上合えば、文字どおりの部分が多いもの）。合うものが無ければ、画面の箱が 1 つのときだけ、それ。
 * 決まらなければ screen は undefined で、candidates に画面の箱を全部返す（利用者が選ぶ）
 */
export function screenFor(
  graph: Pick<GraphV2, 'nodes'>,
  pathname: string,
): { screen?: string; candidates: string[] } {
  const screens = graph.nodes.filter((n) => n.kind === 'screen');
  const candidates = screens.map((n) => n.id);
  const literal = (p: string) =>
    p.split('/').filter((s) => s !== '' && !/^\{[^{}]+\}$/.test(s)).length;
  let best: { id: string; literal: number } | undefined;
  for (const n of screens) {
    const p = screenPath(n);
    if (p === undefined || !pathMatches(p, pathname)) continue;
    if (!best || literal(p) > best.literal) best = { id: n.id, literal: literal(p) };
  }
  if (best) return { screen: best.id, candidates };
  return screens.length === 1 ? { screen: screens[0]!.id, candidates } : { candidates };
}

export interface LiveChoice {
  /** 選んだ挙動の id（始まりの合う挙動が無ければ undefined = 図に無い操作） */
  behavior?: string;
  /** 始まりの合う挙動の全部（選んだものが先頭。分岐で分かれる挙動は、ここに並ぶ） */
  candidates: string[];
  /** 選んだ挙動の、始まりの部品（開く操作なら無い） */
  part?: string;
}

/**
 * - 画面を開いた操作: その画面の「開く」挙動
 * - 部品への操作: 出来事ごとに、当たった部品を内側から見て、その種類の操作から始まる挙動を持つ、いちばん内側の部品の挙動
 * - 合う挙動が 2 つ以上あるとき: 実際に出た通信と、経路の通信の段が、いちばん多く合うもの。同じなら、あとの出来事（押す → 送信なら、送信）、
 *   それも同じなら、図に先に書かれたもの
 */
export function chooseBehavior(graph: GraphV2, op: LiveOperation): LiveChoice {
  const behaviors = graph.behaviors ?? [];
  /** 候補: 挙動の id、始まりの部品、優先の順（大きいほど先） */
  const found: Array<{ id: string; part?: string; rank: number }> = [];
  if (op.open) {
    const screen = op.open.screen;
    for (const b of behaviors)
      if (b.trigger.action === 'open' && screen !== undefined && b.screen === screen)
        found.push({ id: b.id, rank: 0 });
  }
  for (const [gi, g] of op.gestures.entries()) {
    for (const part of g.parts) {
      const hits = behaviors.filter((b) => b.trigger.action === g.how && b.trigger.part === part);
      if (hits.length === 0) continue;
      for (const b of hits)
        if (!found.some((f) => f.id === b.id)) found.push({ id: b.id, part, rank: gi });
      break; // いちばん内側の、挙動を持つ部品だけ
    }
  }
  if (found.length === 0) return { candidates: [] };
  const scored = found.map((f, order) => {
    const view = behaviorView(graph, f.id);
    return { ...f, order, score: view ? matchRequests(view, op.requests).matched.length : 0 };
  });
  scored.sort((a, b) => b.score - a.score || b.rank - a.rank || a.order - b.order);
  const top = scored[0]!;
  const choice: LiveChoice = { behavior: top.id, candidates: scored.map((s) => s.id) };
  if (top.part !== undefined) choice.part = top.part;
  return choice;
}

/** 見せる値打ちのある操作か: 始まりの合う挙動があるか、通信が出た（図に無い操作）。どちらも無い出来事は、出さない */
export const worthShowing = (op: LiveOperation, choice: LiveChoice): boolean =>
  choice.behavior !== undefined || op.requests.length > 0;
