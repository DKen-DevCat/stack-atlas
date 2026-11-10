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
 * 正規化・照合するパスの長さの上限（文字数）。これより長いパス（コードの文字列から読んだ、壊れた・悪意のある入力）は
 * 正規化も照合もしない（呼ぶ側で 1 回だけ警告する。正規表現は線形にしてあるが、照合の総量を抑える）
 */
export const MAX_ROUTE_PATH = 2048;

/** パスが長すぎて正規化・照合しないか（MAX_ROUTE_PATH） */
export const isRoutePathTooLong = (p: string) => p.length > MAX_ROUTE_PATH;

/**
 * normalizeRoutePath の書き換え（長さの上限なし）。正規表現はどれも線形: 角括弧・波括弧の中身の文字クラスから
 * 開き括弧も除く（`[` が多くて `]` が無い入力で、開きの位置ごとに末尾まで読み直す二次の走査にならない）。
 * 末尾の `/` は正規表現ではなく後ろから数えて落とす（`/\/+$/` は `/` の長い並びで二次になる）
 */
export function rewriteRoutePath(p: string): string {
  let s = p
    .replace(/\[\[\.\.\.([^\][]+)\]\]/g, '{$1+}')
    .replace(/\[\.\.\.([^\][]+)\]/g, '{$1+}')
    .replace(/\[([^\][]+)\]/g, '{$1}')
    .replace(/\{([^{}]*)\}/g, (m, inner: string) =>
      inner.endsWith('...') ? `{${inner.slice(0, -3)}+}` : m,
    )
    .replace(/\/:(\w+)/g, '/{$1}')
    .replace(/\/\*$/, '/{proxy+}');
  if (s.length > 1) {
    let end = s.length;
    while (end > 0 && s.charCodeAt(end - 1) === 0x2f /* / */) end--;
    s = s.slice(0, end);
  }
  return s || '/';
}

/**
 * 末尾の / をそろえ、Go の `{rest...}` / Express の `:id` / `*` / Next の `[id]`・`[...slug]`・`[[...slug]]` を
 * API Gateway 形式にする。MAX_ROUTE_PATH より長いパスはそのまま返す
 */
export function normalizeRoutePath(p: string): string {
  return isRoutePathTooLong(p) ? p : rewriteRoutePath(p);
}

/**
 * endpoint / meta.apiRoutes 用: 末尾スラッシュの違いと Go / Express / Next 形式のパラメータを許す。
 * どちらかが MAX_ROUTE_PATH より長ければ合わない
 */
export function apiPathMatches(routePath: string, clientPath: string): boolean {
  if (isRoutePathTooLong(routePath) || isRoutePathTooLong(clientPath)) return false;
  return pathMatches(normalizeRoutePath(routePath), normalizeRoutePath(clientPath));
}
