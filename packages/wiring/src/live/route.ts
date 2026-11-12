/**
 * 通信と、図の受け口の照らし合わせ（docs/27 §4.3、D245）。
 * 受け口の書き方は `<メソッド> <パス>`。パスの中の変わる部分は、`{名前}` の形だけを読む（手順書が決めている書き方。
 * ほかの書き方は読まない。道具が何通りも読むと、特定の書き方への対応が入りこむ）
 */
import type { GraphV2 } from '@stack-atlas/schema';
import { nodeRoute } from '../behavior-view.js';

export interface RouteTemplate {
  method: string;
  path: string;
}

export const routeKey = (r: RouteTemplate): string => `${r.method} ${r.path}`;

const segments = (path: string): string[] =>
  (path.split(/[?#]/)[0] ?? '').split('/').filter((s) => s !== '');
const isSlot = (segment: string): boolean => /^\{[^{}]+\}$/.test(segment);
const decode = (segment: string): string => {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
};

/** パスが、受け口のパスの書き方に合うか。`{名前}` は、どの値とも合う。問い合わせの文字列は比べない */
export function pathMatches(template: string, pathname: string): boolean {
  const want = segments(template);
  const got = segments(pathname);
  if (want.length !== got.length) return false;
  return want.every((w, i) => isSlot(w) || decode(w) === decode(got[i]!));
}

/** 図の受け口（meta.route のある箱）の一覧。同じ書き方は 1 つ */
export function graphRoutes(graph: Pick<GraphV2, 'nodes'>): RouteTemplate[] {
  const seen = new Map<string, RouteTemplate>();
  for (const n of graph.nodes) {
    const r = nodeRoute(n);
    if (r && !seen.has(routeKey(r))) seen.set(routeKey(r), r);
  }
  return [...seen.values()];
}

/**
 * 通信に合う受け口。2 つ以上合うときは、文字どおりの部分が多いもの（`/items/new` と `/items/{id}` なら、前者）。
 * それも同じなら、先に書かれたもの
 */
export function findRoute(
  routes: readonly RouteTemplate[],
  method: string,
  pathname: string,
): RouteTemplate | undefined {
  const m = method.toUpperCase();
  let best: RouteTemplate | undefined;
  let bestLiteral = -1;
  for (const r of routes) {
    if (r.method !== m || !pathMatches(r.path, pathname)) continue;
    const literal = segments(r.path).filter((s) => !isSlot(s)).length;
    if (literal > bestLiteral) {
      best = r;
      bestLiteral = literal;
    }
  }
  return best;
}
