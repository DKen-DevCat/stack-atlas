/**
 * 自動レイアウト（層ごとの 2 次元配置）。
 *
 * 契約（docs/08-design-phase0-1.md §3.4）:
 * - 決定的（乱数を使わない）
 * - `fixed` のあるノードは動かさない
 * - 上の層から順に、子を親群の x の重心に置き、層内は footprint が重ならないよう押し広げる
 * - 全ノードが板（plate）の中に収まる。板は minPlateWidth × minPlateDepth を下回らない
 * - 板は中身に合わせて広がる（詰め込まない）。層ごとに目標の段数
 *   rows = clamp(ceil(sqrt(n / 6)), 1, 4)（n は画面以外のノード数）を決め、1 段 ceil(n / rows) 個を
 *   ラベル幅込みのピッチ（max(w, LABEL_W) + gap）で並べられる幅を求める。板の幅はその全層の最大。
 *   画面ノードは自分たちだけの段に 1 段 3 枚まで（6 枚で 2 段、12 枚で 4 段）。
 *   段が 4 段以上の層は段間 ROW_GAP を保ち、板の奥行きを 20 より広げる
 *
 * 実装メモ:
 * - 順序の揺らぎを避けるため、入力を id 昇順に正規化してから処理する（入力順・辺の順に依存しない）。
 * - 画面ノードは `screen` で指定する。指定がなければ footprint.w が SCREEN_MIN_W 以上のものとみなす（後方互換）。
 */

export interface LayoutNodeInput {
  id: string;
  /** 層のインデックス（0 が最上段） */
  layer: number;
  /** 板の平面上で占める大きさ。w は x 方向、d は z 方向 */
  footprint: { w: number; d: number };
  /** graph.json の position。あれば固定 */
  fixed?: { x: number; z: number };
  /** 画面ノードか（自分たちだけの段に 1 段 SCREENS_PER_ROW 枚まで並ぶ）。省略時は footprint.w ≥ 6 で判定 */
  screen?: boolean;
}

export interface LayoutEdgeInput {
  from: string;
  to: string;
}

export interface LayoutOptions {
  /** 板の最小幅（x）。既定 41 */
  minPlateWidth?: number;
  /** 板の最小奥行き（z）。既定 20 */
  minPlateDepth?: number;
  /** ノード間の最小間隔。既定 1.6 */
  gap?: number;
}

export interface LayoutResult {
  positions: Map<string, { x: number; z: number }>;
  /** すべての層で共通の板サイズ（中心が原点） */
  plate: { width: number; depth: number };
}

const SCREEN_MIN_W = 6;
/** ラベル（HTML）の想定幅。x 方向の占有幅は max(footprint.w, LABEL_W) とする */
export const LABEL_W = 4.5;
/** 同じ層で段を分ける際の z 方向の理想的な段間隔（ラベルの高さ分。3 段までは板の奥行き 20 に収まる） */
const ROW_GAP = 5.5;
/** 目標の段数の上限と、1 段あたりの目安（rows = ceil(sqrt(n / ROW_DIVISOR))） */
export const MAX_TARGET_ROWS = 4;
const ROW_DIVISOR = 6;
/** 画面ノードの 1 段あたりの最大枚数 */
export const SCREENS_PER_ROW = 3;
const MAX_RELAX_ITERATIONS = 50;
const EPS = 1e-9;

interface Row {
  /** ノードのインデックス（正規化後） */
  members: number[];
  /** members と同じ並びの x */
  xs: number[];
}

/** 画面以外のノードが n 個ある層の目標段数 */
export function targetRows(n: number): number {
  if (n <= 0) return 1;
  return Math.max(1, Math.min(MAX_TARGET_ROWS, Math.ceil(Math.sqrt(n / ROW_DIVISOR))));
}

function cmpStr(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * 1 次元の押し広げ。t でソート済みの列を、隣との最小距離を保ちつつ
 * 元の位置からのずれの 2 乗和が最小になるように配置する（PAV 法）。
 * 各塊は元の目標位置の平均まわりに中央寄せされる。
 */
function resolve1D(ws: readonly number[], ts: readonly number[], gap: number): number[] {
  const n = ws.length;
  const cum = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    cum[i] = i === 0 ? 0 : cum[i - 1]! + (ws[i - 1]! + ws[i]!) / 2 + gap;
  }
  const stack: { a: number; b: number; sum: number; s: number }[] = [];
  for (let i = 0; i < n; i++) {
    const v = ts[i]! - cum[i]!;
    let cur = { a: i, b: i, sum: v, s: v };
    while (stack.length > 0 && stack[stack.length - 1]!.s > cur.s + EPS) {
      const prev = stack.pop()!;
      const sum = prev.sum + cur.sum;
      cur = { a: prev.a, b: cur.b, sum, s: sum / (cur.b - prev.a + 1) };
    }
    stack.push(cur);
  }
  const xs = new Array<number>(n);
  for (const c of stack) for (let i = c.a; i <= c.b; i++) xs[i] = cum[i]! + c.s;
  return xs;
}

export function autoLayout(
  nodes: readonly LayoutNodeInput[],
  edges: readonly LayoutEdgeInput[],
  opts: LayoutOptions = {},
): LayoutResult {
  const minW = opts.minPlateWidth ?? 41;
  const minD = opts.minPlateDepth ?? 20;
  const gap = opts.gap ?? 1.6;

  // 正規化: id 昇順、重複 id は最初のものだけ残す
  const seen = new Set<string>();
  const ns: LayoutNodeInput[] = [];
  for (const n of [...nodes].sort((a, b) => cmpStr(a.id, b.id))) {
    if (seen.has(n.id)) continue;
    seen.add(n.id);
    ns.push(n);
  }
  const N = ns.length;
  const indexOf = new Map<string, number>();
  ns.forEach((n, i) => indexOf.set(n.id, i));

  const adjSets: Set<number>[] = ns.map(() => new Set<number>());
  for (const e of edges) {
    const a = indexOf.get(e.from);
    const b = indexOf.get(e.to);
    if (a === undefined || b === undefined || a === b) continue;
    adjSets[a]!.add(b);
    adjSets[b]!.add(a);
  }
  const adj = adjSets.map((s) => [...s].sort((a, b) => a - b));

  const X = new Array<number>(N).fill(0);
  const Z = new Array<number>(N).fill(0);
  const placed = new Array<boolean>(N).fill(false);
  const isFixed = ns.map((n) => n.fixed !== undefined);
  ns.forEach((n, i) => {
    if (n.fixed) {
      X[i] = n.fixed.x;
      Z[i] = n.fixed.z;
      placed[i] = true;
    }
  });

  const W = (i: number) => Math.max(ns[i]!.footprint.w, LABEL_W);
  const D = (i: number) => ns[i]!.footprint.d;
  const screenFlags = ns.map((n) => n.screen ?? n.footprint.w >= SCREEN_MIN_W);
  const isScreen = (i: number) => screenFlags[i]!;

  const byLayer = new Map<number, number[]>();
  for (let i = 0; i < N; i++) {
    const l = ns[i]!.layer;
    const list = byLayer.get(l);
    if (list) list.push(i);
    else byLayer.set(l, [i]);
  }
  const layerOrder = [...byLayer.keys()].sort((a, b) => a - b);

  let maxItemW = 0;
  for (let i = 0; i < N; i++) if (!isFixed[i]) maxItemW = Math.max(maxItemW, W(i));
  /**
   * 層ごとに、目標の段数で並べたときの 1 段の幅（ラベル幅込みのピッチ）。
   * 画面は 1 段 SCREENS_PER_ROW 枚、それ以外は 1 段 ceil(n / targetRows(n)) 個
   */
  const rowWidth = (ids: number[], perRow: number): number => {
    if (ids.length === 0) return 0;
    const pitch = Math.max(...ids.map(W)) + gap;
    return perRow * pitch - gap;
  };
  const layerNeed = new Map<number, number>();
  for (const [layer, all] of byLayer) {
    const free = all.filter((i) => !isFixed[i]);
    const screens = free.filter(isScreen);
    const others = free.filter((i) => !isScreen(i));
    const perOthers = Math.ceil(others.length / targetRows(others.length));
    layerNeed.set(
      layer,
      Math.max(
        rowWidth(others, perOthers),
        rowWidth(screens, Math.min(SCREENS_PER_ROW, screens.length)),
      ),
    );
  }
  /** 1 段に収めたい幅（全層共通。どの層も目標の段数に収まるよう、中身に合わせて広げる） */
  const cap = Math.max(minW - 2 * gap, maxItemW, ...layerNeed.values());

  /** 段（row）を z 方向に積み、z = 0 を中心にして Z に書き込む */
  const assignRowZ = (rows: Row[]): void => {
    const depths = rows.map((r) => Math.max(0, ...r.members.map(D)));
    const sumD = depths.reduce((s, d) => s + d, 0);
    // 段が複数あるときは板の奥行きを使って段間を広げる（ラベルが同じ基線に並ばないように）
    // 4 段以上になる層は詰めずに ROW_GAP を保ち、板の奥行きのほうを広げる
    const rowGap =
      rows.length > 3
        ? ROW_GAP
        : rows.length > 1
          ? Math.max(gap, Math.min(ROW_GAP, (minD - 2 * gap - sumD) / (rows.length - 1)))
          : gap;
    const total = sumD + rowGap * Math.max(0, rows.length - 1);
    let z = -total / 2;
    rows.forEach((r, k) => {
      const zc = z + depths[k]! / 2;
      r.members.forEach((m, j) => {
        X[m] = r.xs[j]!;
        Z[m] = zc;
        placed[m] = true;
      });
      z += depths[k]! + rowGap;
    });
  };

  // ---- 最上段 ----
  const layoutTop = (free: number[], layer: number): Row[] => {
    // 最上段も目標の段数で折り返す（板が他の層のために広くても、1 段に詰め込みすぎない）
    const topCap = Math.max(minW - 2 * gap, maxItemW, layerNeed.get(layer) ?? 0);
    // 全体グラフでの連結成分
    const parent = ns.map((_, i) => i);
    const find = (a: number): number => {
      while (parent[a] !== a) {
        parent[a] = parent[parent[a]!]!;
        a = parent[a]!;
      }
      return a;
    };
    for (let a = 0; a < N; a++) {
      for (const b of adj[a]!) {
        const ra = find(a);
        const rb = find(b);
        if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb);
      }
    }
    const comps = new Map<number, number[]>();
    for (const i of free) {
      const r = find(i);
      const c = comps.get(r);
      if (c) c.push(i);
      else comps.set(r, [i]);
    }
    const compList = [...comps.values()].sort((a, b) => b.length - a.length || a[0]! - b[0]!);
    const inTop = new Set(free);

    // 成分ごとの並び（BFS 順を、ハブが中央に来るよう左右交互に並べ替える）
    const ordered: number[][] = compList.map((members) => {
      const remaining = new Set(members);
      const byDeg = [...members].sort((a, b) => adj[b]!.length - adj[a]!.length || a - b);
      const bfs: number[] = [];
      for (const start of byDeg) {
        if (!remaining.has(start)) continue;
        remaining.delete(start);
        const queue = [start];
        for (let h = 0; h < queue.length; h++) {
          const u = queue[h]!;
          bfs.push(u);
          for (const v of adj[u]!) {
            if (inTop.has(v) && remaining.has(v)) {
              remaining.delete(v);
              queue.push(v);
            }
          }
        }
      }
      const left: number[] = [];
      const right: number[] = [];
      bfs.forEach((id, k) => {
        if (k === 0) right.push(id);
        else if (k % 2 === 1) right.push(id);
        else left.push(id);
      });
      return [...left.reverse(), ...right];
    });

    // 板幅を超えたら次の段へ折り返す
    const rowsOf: { id: number; sp: number }[][] = [[]];
    let cur = 0;
    ordered.forEach((comp, ci) => {
      comp.forEach((id, k) => {
        const sp = ci > 0 && k === 0 ? 2 * gap : k > 0 ? gap : 0;
        const row = rowsOf[rowsOf.length - 1]!;
        const add = row.length === 0 ? 0 : sp;
        if (row.length > 0 && cur + add + W(id) > topCap + EPS) {
          rowsOf.push([{ id, sp: 0 }]);
          cur = W(id);
        } else {
          row.push({ id, sp: add });
          cur += add + W(id);
        }
      });
    });
    return rowsOf
      .filter((r) => r.length > 0)
      .map((r) => {
        const total = r.reduce((s, it) => s + it.sp + W(it.id), 0);
        let x = -total / 2;
        const xs = r.map((it) => {
          x += it.sp;
          const c = x + W(it.id) / 2;
          x += W(it.id);
          return c;
        });
        // 板が最上段の必要幅より広いときは、段を板の幅（上限 1.8 倍）まで広げて
        // ラベルの重なりを減らす（下の層は親の重心に置かれるので一緒に広がる）
        const spread = r.length > 1 ? Math.min(cap, total * 1.8) : total;
        if (spread > total + EPS) {
          const k = spread / total;
          for (let i = 0; i < xs.length; i++) xs[i] = xs[i]! * k;
        }
        return { members: r.map((it) => it.id), xs };
      });
  };

  // ---- 下の層 ----
  const layoutLower = (free: number[], layer: number): Row[] => {
    const target = new Map<number, number>();
    const orphan: number[] = [];
    let maxT = -Infinity;
    for (const i of free) {
      let sum = 0;
      let cnt = 0;
      for (const p of adj[i]!) {
        if (ns[p]!.layer < layer && placed[p]) {
          sum += X[p]!;
          cnt++;
        }
      }
      if (cnt === 0) orphan.push(i);
      else {
        const half = cap / 2 - W(i) / 2;
        const t = Math.max(-half, Math.min(half, sum / cnt));
        target.set(i, t);
        maxT = Math.max(maxT, t);
      }
    }
    for (const i of orphan) target.set(i, maxT === -Infinity ? 0 : maxT);
    const isOrphan = new Set(orphan);

    const widthOf = (xs: number[]) =>
      xs.reduce((s, i) => s + W(i), 0) + gap * Math.max(0, xs.length - 1);
    const screens = free.filter(isScreen);
    const others = free.filter((i) => !isScreen(i));
    const needSplit = widthOf(free) > cap || screens.length > SCREENS_PER_ROW;
    const groups =
      needSplit && screens.length > 0 && others.length > 0 ? [screens, others] : [free];

    const rows: Row[] = [];
    for (const g of groups) {
      const sorted = [...g].sort(
        (a, b) =>
          target.get(a)! - target.get(b)! ||
          Number(isOrphan.has(a)) - Number(isOrphan.has(b)) ||
          a - b,
      );
      // 段数 k: 目標の段数（画面は 1 段 3 枚まで）以上で、各段の幅の合計が cap に収まる最小値
      // （i mod k の振り分けで x の分布を保ち、段ごとに半ピッチずらして千鳥配置する）
      const isScreenGroup = sorted.length > 0 && sorted.every(isScreen);
      const kMin = isScreenGroup
        ? Math.ceil(sorted.length / SCREENS_PER_ROW)
        : targetRows(sorted.filter((i) => !isScreen(i)).length);
      let k = kMin;
      let buckets: number[][] = [];
      for (; ; k++) {
        buckets = Array.from({ length: k }, () => []);
        sorted.forEach((id, i) => buckets[i % k]!.push(id));
        if (k >= sorted.length || buckets.every((b) => widthOf(b) <= cap + EPS)) break;
      }
      const avgW = sorted.reduce((s, i) => s + W(i), 0) / Math.max(1, sorted.length);
      const half = (avgW + gap) / 2;
      for (const [bi, b] of buckets.entries()) {
        if (b.length === 0) continue;
        // 段ごとに半ピッチずつずらして千鳥にする（全段の平均は 0 なので重心は保たれる）
        const off = (bi - (k - 1) / 2) * half;
        const ws = b.map(W);
        let xs = resolve1D(
          ws,
          b.map((i) => target.get(i)! + off),
          gap,
        );
        const extent = (): [number, number] => {
          let lo = Infinity;
          let hi = -Infinity;
          b.forEach((id, j) => {
            lo = Math.min(lo, xs[j]! - W(id) / 2);
            hi = Math.max(hi, xs[j]! + W(id) / 2);
          });
          return [lo, hi];
        };
        let [lo, hi] = extent();
        if (hi - lo > cap + EPS) {
          // 親の下に置けずに段が板より広がった（親なしの塊が端に寄る等）。
          // 並び順は保ったまま目標位置を板の幅に線形に圧縮してから、もう一度押し広げる
          const inner = cap - (ws[0]! + ws[ws.length - 1]!) / 2;
          const span = Math.max(EPS, xs[xs.length - 1]! - xs[0]!);
          const c0 = -cap / 2 + ws[0]! / 2;
          const packed = resolve1D(
            ws,
            xs.map((x) => c0 + ((x - xs[0]!) / span) * inner),
            gap,
          );
          xs = packed;
          [lo, hi] = extent();
        }
        if (hi - lo <= cap + EPS) {
          const shift = lo < -cap / 2 ? -cap / 2 - lo : hi > cap / 2 ? cap / 2 - hi : 0;
          for (let j = 0; j < xs.length; j++) xs[j] = xs[j]! + shift;
        }
        rows.push({ members: b, xs });
      }
    }
    return rows;
  };

  // ---- 固定ノードとの衝突解消 ----
  const relax = (ids: number[]): void => {
    const m = gap / 2;
    for (let iter = 0; iter < MAX_RELAX_ITERATIONS; iter++) {
      const order = [...ids].sort((a, b) => X[a]! - W(a) / 2 - (X[b]! - W(b) / 2) || a - b);
      let moved = false;
      for (let ai = 0; ai < order.length; ai++) {
        const a = order[ai]!;
        for (let bi = ai + 1; bi < order.length; bi++) {
          const b = order[bi]!;
          if (X[b]! - W(b) / 2 >= X[a]! + W(a) / 2 + m) break;
          if (isFixed[a] && isFixed[b]) continue;
          const dx = X[b]! - X[a]!;
          const dz = Z[b]! - Z[a]!;
          const px = (W(a) + W(b)) / 2 + m - Math.abs(dx);
          const pz = (D(a) + D(b)) / 2 + m - Math.abs(dz);
          if (px <= 0 || pz <= 0) continue;
          moved = true;
          const useX = px <= pz;
          const amt = (useX ? px : pz) + 1e-6;
          const sign = (useX ? dx : dz) >= 0 ? 1 : -1;
          const fa = isFixed[a] ? 0 : isFixed[b] ? 1 : 0.5;
          const fb = isFixed[b] ? 0 : isFixed[a] ? 1 : 0.5;
          if (useX) {
            X[a] = X[a]! - sign * amt * fa;
            X[b] = X[b]! + sign * amt * fb;
          } else {
            Z[a] = Z[a]! - sign * amt * fa;
            Z[b] = Z[b]! + sign * amt * fb;
          }
        }
      }
      if (!moved) break;
    }
  };

  layerOrder.forEach((layer, li) => {
    const all = byLayer.get(layer)!;
    const free = all.filter((i) => !isFixed[i]);
    if (free.length === 0) return;
    const rows = li === 0 ? layoutTop(free, layer) : layoutLower(free, layer);
    assignRowZ(rows);
    if (free.length < all.length) relax(all);
  });

  // ---- 全体を x の中央に寄せる（固定ノードがあるときは動かさない）----
  if (N > 0 && !isFixed.some(Boolean)) {
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = 0; i < N; i++) {
      lo = Math.min(lo, X[i]! - W(i) / 2);
      hi = Math.max(hi, X[i]! + W(i) / 2);
    }
    const shift = -(lo + hi) / 2;
    for (let i = 0; i < N; i++) X[i] = X[i]! + shift;
  }

  // ---- 板サイズ（原点中心・全層共通）----
  let needX = 0;
  let needZ = 0;
  for (let i = 0; i < N; i++) {
    needX = Math.max(needX, Math.abs(X[i]!) + W(i) / 2);
    needZ = Math.max(needZ, Math.abs(Z[i]!) + D(i) / 2);
  }
  const positions = new Map<string, { x: number; z: number }>();
  for (let i = 0; i < N; i++) positions.set(ns[i]!.id, { x: X[i]!, z: Z[i]! });
  return {
    positions,
    plate: {
      width: Math.max(minW, 2 * needX + 2 * gap),
      depth: Math.max(minD, 2 * needZ + 2 * gap),
    },
  };
}
