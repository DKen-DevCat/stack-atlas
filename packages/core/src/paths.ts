/**
 * API のパスの正規化と照合（docs/17 §7 #5）。もとは api-link の gateway.ts にあったもの。
 * 合流（join.ts）でも使うので core に移した（api-link は core に依存しているので、逆にすると循環する）。
 * api-link はここから再 export する。
 *
 * パスの形: API Gateway 形式（`/races/{id}`、greedy は `/{proxy+}`）にそろえて比べる。
 * Go の `{rest...}`、Express の `:id`、Next の `[id]` / `[...slug]` / `[[...slug]]` は normalizeRoutePath で直す。
 */

const GREEDY = /^\{.+\+\}$/;
const PARAM = /^\{.*\}$/;

/** route のキー（`GET /races/{id}` と `$default`）の最小の形 */
export interface RouteLike {
  routeKey: string;
  method: string;
  path: string;
}

/**
 * route のパス（`/races/{id}`、`/{proxy+}`）とクライアントのパス（`/races/{id}`）が合うか。
 * API Gateway と同じく greedy（`{proxy+}`）は 1 セグメント以上に当たる（`/races/{proxy+}` は `/races` に当たらない）
 */
export function pathMatches(routePath: string, clientPath: string): boolean {
  const rs = routePath.split('/').filter(Boolean);
  const cs = clientPath.split('/').filter(Boolean);
  for (let i = 0; i < rs.length; i++) {
    const r = rs[i]!;
    if (GREEDY.test(r)) return cs.length > i;
    const c = cs[i];
    if (c === undefined) return false;
    if (PARAM.test(r)) continue;
    if (r !== c) return false;
  }
  return rs.length === cs.length;
}

/** メソッドが合うか（route の ANY はどれにも合う） */
export function methodMatches(routeMethod: string, clientMethod: string): boolean {
  return routeMethod === 'ANY' || routeMethod === clientMethod;
}

/**
 * route の具体性。API Gateway は「リテラル → パラメータ → greedy → $default」の順で 1 本だけ選ぶので、
 * 同じ呼び出しに複数の route が合うときはこの値が最大のものだけを使う。
 * [$default でない, greedy でない, リテラルの数, メソッドが ANY でない] を辞書順に比べる
 */
export function routeSpecificity(r: RouteLike): number[] {
  const segs = r.path.split('/').filter(Boolean);
  return [
    r.routeKey === '$default' ? 0 : 1,
    segs.some((s) => GREEDY.test(s)) ? 0 : 1,
    segs.filter((s) => !PARAM.test(s)).length,
    r.method === 'ANY' ? 0 : 1,
  ];
}

/** 合った route のうち最も具体的なもの（同点なら全部） */
export function pickMostSpecific<T extends RouteLike>(routes: T[]): T[] {
  if (routes.length <= 1) return routes;
  const cmp = (a: number[], b: number[]) => {
    for (let i = 0; i < a.length; i++) if (a[i]! !== b[i]!) return a[i]! - b[i]!;
    return 0;
  };
  let best: number[] | undefined;
  for (const r of routes) {
    const s = routeSpecificity(r);
    if (!best || cmp(s, best) > 0) best = s;
  }
  return routes.filter((r) => cmp(routeSpecificity(r), best!) === 0);
}

/**
 * 末尾の / をそろえ、Go の `{rest...}` / Express の `:id` / `*` / Next の `[id]`・`[...slug]`・`[[...slug]]` を
 * API Gateway 形式にする
 */
export function normalizeRoutePath(p: string): string {
  let s = p
    .replace(/\[\[\.\.\.([^\]]+)\]\]/g, '{$1+}')
    .replace(/\[\.\.\.([^\]]+)\]/g, '{$1+}')
    .replace(/\[([^\]]+)\]/g, '{$1}')
    .replace(/\{([^}]*?)\.\.\.\}/g, '{$1+}')
    .replace(/\/:(\w+)/g, '/{$1}')
    .replace(/\/\*$/, '/{proxy+}');
  if (s.length > 1) s = s.replace(/\/+$/, '');
  return s || '/';
}

/** endpoint / meta.apiRoutes 用: 末尾スラッシュの違いと Go / Express / Next 形式のパラメータを許す */
export function apiPathMatches(routePath: string, clientPath: string): boolean {
  return pathMatches(normalizeRoutePath(routePath), normalizeRoutePath(clientPath));
}
