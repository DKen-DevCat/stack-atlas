// 切り口（docs/21 §2.1・§2.5。D124・D127）: 包含の木の「開いている入れ物」の集合。祖先が全部開いている入れ物・箱が見えている。
// 見えていて閉じている入れ物が畳んだ箱（fold.ts）。純関数・決定的。どの関数も入力を変えず、木は入口で直す（treeOf）
import type { GraphIndex } from './graph-index.js';
import { treeOf, type Containment, type Tree } from './containment.js';
import { laneIndexOf } from './layout/model.js';
import { LANES } from './layout/types.js';

/**
 * 切り口: 開いている入れ物の id の集合。正規の形（知っている入れ物だけ・祖先が全部開いているものだけ・木の宣言の順）で持つ。
 * 正規の形にするのは `normalizeCut`（この節の関数が返す切り口は、どれも正規の形）
 */
export type Cut = ReadonlySet<string>;

/** 置き場のキー: host の枠の中の箱は `h:<host の id>`、それ以外は `l:<レーンの id>` */
export const hostSlice = (hostId: string): string => `h:${hostId}`;
export const laneSlice = (laneId: string): string => `l:${laneId}`;

/**
 * 箱（枠を除く）→ 置き場のキー。既定は「host があれば host、無ければレーン」（配置のレーンと同じ関数で決める）。
 * 畳んだ箱は「入れ物 × 置き場」ごとに 1 つ（レーンと host の枠の規則を壊さないため）
 */
export function slicesOf(index: GraphIndex): Map<string, string> {
  const out = new Map<string, string>();
  for (const n of index.nodes.values()) {
    if (index.hosts.has(n.id)) continue;
    out.set(
      n.id,
      n.host ? hostSlice(n.host.id) : laneSlice(LANES[laneIndexOf(n.node.runtime)]!.id),
    );
  }
  return out;
}

/** 正規の形にする（木の索引から）。`open[i]` は入れ物 i が開いているか */
function normalizeIn(t: Tree, ids: Iterable<string>): Uint8Array {
  const open = new Uint8Array(t.ids.length);
  for (const id of ids) {
    const i = typeof id === 'string' ? t.ord.get(id) : undefined;
    if (i !== undefined) open[i] = 1;
  }
  // 浅い順（親が先）に見て、親が開いていないものを落とす
  for (const i of t.byDepth) {
    const p = t.parent[i]!;
    if (open[i] && p !== -1 && !open[p]) open[i] = 0;
  }
  return open;
}

const cutOf = (t: Tree, open: Uint8Array): Cut => new Set(t.ids.filter((_, i) => open[i]));

/** 木の索引と、正規の形の「開いているか」と切り口（fold.ts が使う。パッケージの外には出さない） */
export function openIn(
  c: Containment,
  ids: Iterable<string>,
): { tree: Tree; open: Uint8Array; cut: Cut } {
  const tree = treeOf(c);
  const open = normalizeIn(tree, ids);
  return { tree, open, cut: cutOf(tree, open) };
}

/**
 * 正規の形の切り口: 知っている入れ物の id だけ・祖先が全部開いているものだけを残し、木の宣言の順に並べる
 * （URL から読んだ `open` はここを通す。値は既知の id との照合にだけ使う）
 */
export function normalizeCut(c: Containment, ids: Iterable<string>): Cut {
  const { tree, open } = openIn(c, ids);
  return cutOf(tree, open);
}

/** 入れ物を 1 段開く。祖先が開いていない（見えていない）入れ物・知らない id なら、切り口は変わらない */
export function openContainer(c: Containment, cut: Cut, id: string): Cut {
  return normalizeCut(c, [...cut, id]);
}

/** 入れ物を畳む。その下で開いていたものは忘れる（開き直すと 1 段だけ開く） */
export function closeContainer(c: Containment, cut: Cut, id: string): Cut {
  const rest: string[] = [];
  for (const x of cut) if (x !== id) rest.push(x);
  return normalizeCut(c, rest);
}

/** その箱が全部見えるまで開く（箱の祖先を全部開く。ほかは変えない）。知らない箱・根の直下の箱は何もしない */
export function openTo(c: Containment, cut: Cut, boxes: Iterable<string>): Cut {
  const t = treeOf(c);
  const open = normalizeIn(t, cut);
  for (const b of boxes) {
    // 祖先がすでに開いていれば、その上も開いている（正規の形）ので止まる
    for (let i = t.boxParent.get(b) ?? -1; i !== -1 && !open[i]; i = t.parent[i]!) open[i] = 1;
  }
  return cutOf(t, open);
}

/**
 * 箱を全部含む、いちばん内側の開いた入れ物の id。無ければ undefined（箱が空・根の直下の箱を含む・知らない箱を含む・
 * 共通の祖先が無い・共通の祖先がどれも開いていない）
 */
export function innermostOpen(
  c: Containment,
  cut: Cut,
  boxes: Iterable<string>,
): string | undefined {
  const t = treeOf(c);
  const open = normalizeIn(t, cut);
  let a: number | undefined;
  for (const box of boxes) {
    let b = t.boxParent.get(box) ?? -1;
    if (a === undefined) {
      a = b;
      continue;
    }
    while (a !== b && a !== -1 && b !== -1) {
      if (t.depth[a]! >= t.depth[b]!) a = t.parent[a]!;
      else b = t.parent[b]!;
    }
    if (a !== b) a = -1;
    if (a === -1) return undefined;
  }
  if (a === undefined) return undefined;
  // 正規の形では、開いている入れ物の祖先は全部開いている
  while (a !== -1 && !open[a]) a = t.parent[a]!;
  return a === -1 ? undefined : t.ids[a];
}

export interface InitialCutOptions {
  /** 見える単位の上限（既定 24） */
  max?: number;
  /** 見える単位の下限（これ未満なら、上限を超えても 1 段だけ開く。既定 4） */
  min?: number;
}

/**
 * 初めの切り口（docs/21 §2.5）: 全部畳んだ所から 1 段ずつ（見えている入れ物を全部）開き、見える単位（箱と畳んだ箱）が
 * `max` を超える手前で止まる。止まった所で見える単位が `min` 未満なら、上限を超えても 1 段だけ開く
 * （根の下が大きい段 1 つだけの graph が 1〜3 個の畳んだ箱で開かないように）。
 * 畳んだ箱は「入れ物 × 置き場」ごとに数える。置き場の数 × 入れ物の数に比例
 */
export function initialCut(
  c: Containment,
  index: GraphIndex,
  slice: ReadonlyMap<string, string>,
  opts: InitialCutOptions = {},
): Cut {
  const max = opts.max ?? 24;
  const min = opts.min ?? 4;
  const t = treeOf(c);
  const n = t.ids.length;

  // 入れ物ごとの「下にある箱の置き場の種類の数」（= 畳んだときの箱の数）。置き場ごとに印を付けながら祖先へ上がる
  const sliceNo = new Map<string, number>();
  const stamp = new Int32Array(n).fill(-1);
  const units = new Int32Array(n);
  const bySlice: number[][] = [];
  const boxesAt: number[] = [];
  for (const node of index.nodes.values()) {
    if (index.hosts.has(node.id)) continue;
    const p = t.boxParent.get(node.id) ?? -1;
    const d = p === -1 ? 0 : t.depth[p]! + 1;
    boxesAt[d] = (boxesAt[d] ?? 0) + 1;
    if (p === -1) continue;
    const key = slice.get(node.id) ?? '';
    let s = sliceNo.get(key);
    if (s === undefined) {
      s = sliceNo.size;
      sliceNo.set(key, s);
      bySlice.push([]);
    }
    bySlice[s]!.push(p);
  }
  bySlice.forEach((parents, s) => {
    for (const p of parents) {
      for (let i = p; i !== -1 && stamp[i] !== s; i = t.parent[i]!) {
        stamp[i] = s;
        units[i]!++;
      }
    }
  });
  const unitsAt: number[] = [];
  let levels = 0;
  for (let i = 0; i < n; i++) {
    const d = t.depth[i]!;
    unitsAt[d] = (unitsAt[d] ?? 0) + units[i]!;
    levels = Math.max(levels, d + 1);
  }
  // 深さ k 未満の入れ物を全部開いたときに見える単位: 深さ k までの箱 ＋ 深さ k の入れ物の畳んだ箱
  const shown: number[] = [];
  let boxes = 0;
  for (let k = 0; k <= levels; k++) {
    boxes += boxesAt[k] ?? 0;
    shown[k] = boxes + (unitsAt[k] ?? 0);
  }

  let k = 0;
  while (k < levels) {
    if (shown[k + 1]! <= max) {
      k++;
      continue;
    }
    if (shown[k]! < min) k++;
    break;
  }
  return new Set(t.ids.filter((_, i) => t.depth[i]! < k));
}
