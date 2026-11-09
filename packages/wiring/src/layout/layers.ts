// 層（呼び出しの深さ。docs/18 §3.1 の 3）: 閉路は DFS の後退辺を外して切り、最長経路で層を付ける。
// 入ってくる線の無い箱は後続の層の最小値のすぐ左。どちらの線も無い箱は、層を決めない線（戻り・参照）の相手の隣、無ければ 0

/**
 * nodes に層を付ける。edges は層を決める線（u → v で u が左）、weak はどちらの線も無い箱の置き場だけに使う線。
 * 決定的: 同点は decl の順
 */
export function assignLayers<T>(
  nodes: readonly T[],
  edges: readonly (readonly [T, T])[],
  weak: readonly (readonly [T, T])[],
  decl: (t: T) => number,
): Map<T, number> {
  const order = [...nodes].sort((a, b) => decl(a) - decl(b));
  const succ = new Map<T, T[]>(order.map((n) => [n, []]));
  const seen = new Set<string>();
  const key = new Map(order.map((n, i) => [n, i]));
  for (const [u, v] of edges) {
    if (u === v || !succ.has(u) || !succ.has(v)) continue;
    const k = `${key.get(u)}>${key.get(v)}`;
    if (seen.has(k)) continue;
    seen.add(k);
    succ.get(u)!.push(v);
  }
  for (const list of succ.values()) list.sort((a, b) => decl(a) - decl(b));

  // DFS（宣言の順）。灰色の箱への辺は後退辺として外す
  const state = new Map<T, 0 | 1 | 2>(order.map((n) => [n, 0]));
  const dag = new Map<T, T[]>(order.map((n) => [n, []]));
  const post: T[] = [];
  for (const root of order) {
    if (state.get(root) !== 0) continue;
    const stack: [T, number][] = [[root, 0]];
    state.set(root, 1);
    while (stack.length) {
      const top = stack[stack.length - 1]!;
      const [u, i] = top;
      const list = succ.get(u)!;
      if (i < list.length) {
        top[1] = i + 1;
        const v = list[i]!;
        const s = state.get(v);
        if (s === 1) continue; // 後退辺
        dag.get(u)!.push(v);
        if (s === 0) {
          state.set(v, 1);
          stack.push([v, 0]);
        }
      } else {
        state.set(u, 2);
        post.push(u);
        stack.pop();
      }
    }
  }
  const preds = new Map<T, T[]>(order.map((n) => [n, []]));
  for (const [u, list] of dag) for (const v of list) preds.get(v)!.push(u);

  const layer = new Map<T, number>();
  for (let i = post.length - 1; i >= 0; i--) {
    const v = post[i]!;
    let l = 0;
    for (const u of preds.get(v)!) l = Math.max(l, (layer.get(u) ?? 0) + 1);
    layer.set(v, l);
  }
  // 入ってくる線の無い箱は、後続の層の最小値のすぐ左（列 0 に集めない）
  for (const v of order) {
    const out = dag.get(v)!;
    if (preds.get(v)!.length || !out.length) continue;
    layer.set(v, Math.min(...out.map((w) => layer.get(w)!)) - 1);
  }
  // どちらの線も無い箱: 層を決めない線の相手の隣
  const weakIn = new Map<T, T[]>();
  const weakOut = new Map<T, T[]>();
  for (const [u, v] of weak) {
    if (u === v || !succ.has(u) || !succ.has(v)) continue;
    (weakIn.get(v) ?? weakIn.set(v, []).get(v)!).push(u);
    (weakOut.get(u) ?? weakOut.set(u, []).get(u)!).push(v);
  }
  for (const v of order) {
    if (preds.get(v)!.length || dag.get(v)!.length) continue;
    const callers = (weakIn.get(v) ?? []).filter((u) => u !== v);
    const callees = (weakOut.get(v) ?? []).filter((u) => u !== v);
    if (callers.length) layer.set(v, Math.max(...callers.map((u) => layer.get(u)!)) + 1);
    else if (callees.length)
      layer.set(v, Math.max(0, Math.min(...callees.map((u) => layer.get(u)!)) - 1));
    else layer.set(v, 0);
  }
  // 空いた層を詰める
  const distinct = [...new Set(layer.values())].sort((a, b) => a - b);
  const rank = new Map(distinct.map((l, i) => [l, i]));
  for (const [v, l] of layer) layer.set(v, rank.get(l)!);
  return layer;
}
