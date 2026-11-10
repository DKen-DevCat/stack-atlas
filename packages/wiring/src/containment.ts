// 包含の木（docs/21 §2.1。D123）。配線図を畳む単位は、この木の切り口（cut.ts・fold.ts）。純関数・決定的（DOM 無し）。
// 木の形（Containment）は Phase 9 で graph.json から来る。`containmentOf` だけが今の項目（file・group・groups[]）から
// 木を作る関数で、Phase 9 で捨てる。畳む・写す関数は木の形だけを見る。
// 敵対的な入力: id はすべて Map のキーで持つ（`__proto__` をオブジェクトのキーにしない）。木をたどる所は再帰しない。
// 無い親・親の循環は `treeOf` が根の直下に付け直す（`cleanContainment` と同じ規則を 1 か所で持つ）
import type { GraphV2, GroupInfoV2, NodeV2 } from '@stack-atlas/schema';
import { clipName } from './project-map.js';

/** 入れ物（ディレクトリの段・group）。`kind` は開いた文字列（8-8 が作るのは `dir` と `group`） */
export interface Container {
  id: string;
  /** 表示名（親からの相対。子が 1 つの段をつぶしたものは `a/b/c`）。長さは地図と同じ上限 */
  name: string;
  kind: string;
  /** 親の入れ物の id。無ければ根の直下 */
  parent?: string;
  /** メモのキー（あれば、その入れ物にメモを書ける。group の値そのもの） */
  memo?: string;
}

/** 包含の木。`containers` の並びが宣言の順（単位の番号・`open` を書く順に使う）。JSON にできる形（Map を除けば） */
export interface Containment {
  containers: Map<string, Container>;
  /** 箱の id → 入れ物の id。根の直下の箱は持たない */
  parentOfBox: Map<string, string>;
}

/** ディレクトリの段の上限（それより深い所は、この段の入れ物に入れる） */
export const DIR_MAX_SEGMENTS = 32;

/**
 * file のディレクトリの段（最後の `/` より前。空の段と `.` は飛ばす）。DIR_MAX_SEGMENTS 個で打ち切る
 * （64,000 段のパスでも、読むのは最初の 32 段と最後の `/` を探す 1 回だけ）
 */
function dirSegments(file: unknown): string[] {
  if (typeof file !== 'string' || !file) return [];
  const end = file.lastIndexOf('/');
  const out: string[] = [];
  let i = 0;
  while (i < end && out.length < DIR_MAX_SEGMENTS) {
    let j = file.indexOf('/', i);
    if (j < 0 || j > end) j = end;
    if (j > i) {
      const seg = file.slice(i, j);
      if (seg !== '.') out.push(seg);
    }
    i = j + 1;
  }
  return out;
}

/** ディレクトリの段の木（つぶす前）。子は初めて現れた順 */
interface Dir {
  seg: string;
  up: Dir | null;
  dirs: Map<string, Dir>;
  children: Child[];
}
type Child = { dir: Dir } | { group: string; members: string[] } | { box: string };

/**
 * 今の graph の項目から包含の木を作る: 根 > ディレクトリの段 > group（中の箱が 2 つ以上）> 箱。
 * - 箱の置き場は `file` のディレクトリ（無ければ、1 箱だけの group の `groups[].file`。それも無ければ根の直下）。
 *   group の置き場は `groups[].file` のディレクトリ、無ければ中の箱の共通のディレクトリ
 * - 子が 1 つだけの段はつぶす（`a/b/c` で 1 つ。子が箱 1 つ・group 1 つだけの段は消えて、子が上に付く）
 * - id は `d:<根からのパス>`・`g:<group の値>`。箱・host の id と同じになったら、重ならなくなるまで末尾に `~` を足す
 * - host の枠になる箱は木に入れない
 * - 宣言の順は、根から深さ優先（子は、中の箱が graph に初めて現れた順）
 */
export function containmentOf(graph: GraphV2): Containment {
  const hostIds = new Set<string>();
  for (const n of graph.nodes) if (n.host !== undefined) hostIds.add(n.host);
  const boxes = graph.nodes.filter((n) => !hostIds.has(n.id));

  const groupInfo = new Map<string, GroupInfoV2>();
  for (const x of graph.groups ?? []) if (!groupInfo.has(x.id)) groupInfo.set(x.id, x);
  const groupOf = (n: NodeV2) => (typeof n.group === 'string' && n.group ? n.group : undefined);
  const members = new Map<string, NodeV2[]>();
  for (const n of boxes) {
    const group = groupOf(n);
    if (group === undefined) continue;
    const ms = members.get(group);
    if (ms) ms.push(n);
    else members.set(group, [n]);
  }

  const root: Dir = { seg: '', up: null, dirs: new Map(), children: [] };
  const dirAt = (segs: string[]): Dir => {
    let d = root;
    for (const s of segs) {
      let next = d.dirs.get(s);
      if (!next) {
        next = { seg: s, up: d, dirs: new Map(), children: [] };
        d.dirs.set(s, next);
        d.children.push({ dir: next });
      }
      d = next;
    }
    return d;
  };
  const commonDir = (ms: NodeV2[]): string[] => {
    const all = ms.map((m) => dirSegments(m.file));
    const out: string[] = [];
    for (let i = 0; ; i++) {
      const s = all[0]![i];
      if (s === undefined || all.some((a) => a[i] !== s)) return out;
      out.push(s);
    }
  };

  const placed = new Set<string>();
  for (const n of boxes) {
    const group = groupOf(n);
    const ms = group === undefined ? undefined : members.get(group);
    if (group !== undefined && ms && ms.length >= 2) {
      if (placed.has(group)) continue;
      placed.add(group);
      const file = groupInfo.get(group)?.file;
      const segs = file ? dirSegments(file) : commonDir(ms);
      dirAt(segs).children.push({ group, members: ms.map((m) => m.id) });
    } else {
      const file = n.file || (group === undefined ? undefined : groupInfo.get(group)?.file);
      dirAt(dirSegments(file)).children.push({ box: n.id });
    }
  }

  // つぶしながら、残った入れ物にだけ id を作る（段ごとに接頭の文字列を作らない）。再帰しない
  const containers = new Map<string, Container>();
  const parentOfBox = new Map<string, string>();
  const taken = new Set<string>();
  for (const n of graph.nodes) taken.add(n.id);
  const unique = (base: string) => {
    let id = base;
    while (taken.has(id)) id += '~';
    taken.add(id);
    return id;
  };
  interface Frame {
    dir: Dir;
    i: number;
    id: string | undefined;
  }
  const stack: Frame[] = [{ dir: root, i: 0, id: undefined }];
  while (stack.length) {
    const f = stack[stack.length - 1]!;
    if (f.i >= f.dir.children.length) {
      stack.pop();
      continue;
    }
    let child = f.dir.children[f.i++]!;
    while ('dir' in child && child.dir.children.length === 1) child = child.dir.children[0]!;
    const parent = f.id === undefined ? {} : { parent: f.id };
    if ('box' in child) {
      if (f.id !== undefined) parentOfBox.set(child.box, f.id);
    } else if ('group' in child) {
      const id = unique(`g:${child.group}`);
      const name = groupInfo.get(child.group)?.name;
      containers.set(id, {
        id,
        name: clipName(typeof name === 'string' && name ? name : child.group),
        kind: 'group',
        ...parent,
        memo: child.group,
      });
      for (const m of child.members) parentOfBox.set(m, id);
    } else {
      const rel: string[] = [];
      for (let d = child.dir; d !== f.dir && d.up; d = d.up) rel.push(d.seg);
      const full = [...rel];
      for (let d: Dir = f.dir; d.up; d = d.up) full.push(d.seg);
      const id = unique(`d:${full.reverse().join('/')}`);
      containers.set(id, { id, name: clipName(rel.reverse().join('/')), kind: 'dir', ...parent });
      stack.push({ dir: child.dir, i: 0, id });
    }
  }
  return { containers, parentOfBox };
}

/** 木の索引（直した親・深さ）。入れ物は宣言の順の番号で持つ。cut.ts・fold.ts が使う（パッケージの外には出さない） */
export interface Tree {
  ids: string[];
  ord: Map<string, number>;
  list: Container[];
  /** 親の番号。根の直下は -1（無い親・自分自身・循環は -1 に直す） */
  parent: number[];
  /** 根の直下が 0 */
  depth: number[];
  /** 浅い順（同じ深さは宣言の順）。親が必ず先に来る */
  byDepth: number[];
  /** 箱の id → 入れ物の番号（知らない入れ物を指すものは持たない = 根の直下） */
  boxParent: Map<string, number>;
}

/**
 * 木の索引を作る。親の循環は、輪の中で宣言の順が最初の入れ物を根の直下に付け直して切る。
 * 入れ物と箱の数に比例（深さに依らない。再帰しない）
 */
export function treeOf(c: Containment): Tree {
  const ids = [...c.containers.keys()];
  const list = [...c.containers.values()];
  const ord = new Map(ids.map((id, i) => [id, i]));
  const n = ids.length;
  const parent = list.map((x, i) => {
    const p = typeof x.parent === 'string' ? ord.get(x.parent) : undefined;
    return p === undefined || p === i ? -1 : p;
  });

  const state = new Uint8Array(n); // 0 まだ、1 今たどっている道の上、2 済み
  for (let i = 0; i < n; i++) {
    if (state[i]) continue;
    const path: number[] = [];
    let x = i;
    while (x !== -1 && state[x] === 0) {
      state[x] = 1;
      path.push(x);
      x = parent[x]!;
    }
    if (x !== -1 && state[x] === 1) {
      let first = x;
      for (let k = path.indexOf(x); k < path.length; k++) first = Math.min(first, path[k]!);
      parent[first] = -1;
    }
    for (const p of path) state[p] = 2;
  }

  const depth = new Array<number>(n).fill(-1);
  for (let i = 0; i < n; i++) {
    if (depth[i] !== -1) continue;
    const path: number[] = [];
    let x = i;
    while (x !== -1 && depth[x] === -1) {
      path.push(x);
      x = parent[x]!;
    }
    let d = x === -1 ? 0 : depth[x]! + 1;
    for (let k = path.length - 1; k >= 0; k--) depth[path[k]!] = d++;
  }
  const count: number[] = [];
  for (const d of depth) count[d] = (count[d] ?? 0) + 1;
  const start: number[] = [];
  let at = 0;
  for (let d = 0; d < count.length; d++) {
    start[d] = at;
    at += count[d] ?? 0;
  }
  const byDepth = new Array<number>(n);
  for (let i = 0; i < n; i++) byDepth[start[depth[i]!]!++] = i;

  const boxParent = new Map<string, number>();
  for (const [box, id] of c.parentOfBox) {
    const p = ord.get(id);
    if (p !== undefined) boxParent.set(box, p);
  }
  return { ids, ord, list, parent, depth, byDepth, boxParent };
}

/**
 * 直した木を返す（入力は変えない）: 無い親・自分自身・親の循環は根の直下に付け直す。`boxes` に無い箱と、
 * 無い入れ物を指す箱は外す。表示名は地図と同じ上限に収める。入れ物の id は Map のキーを正にする
 */
export function cleanContainment(c: Containment, boxes: Iterable<string>): Containment {
  const t = treeOf(c);
  const known = new Set(boxes);
  const containers = new Map<string, Container>();
  t.list.forEach((x, i) => {
    const id = t.ids[i]!;
    const p = t.parent[i]!;
    containers.set(id, {
      id,
      name: clipName(typeof x.name === 'string' && x.name ? x.name : id),
      kind: typeof x.kind === 'string' ? x.kind : '',
      ...(p === -1 ? {} : { parent: t.ids[p]! }),
      ...(typeof x.memo === 'string' ? { memo: x.memo } : {}),
    });
  });
  const parentOfBox = new Map<string, string>();
  for (const [box, p] of t.boxParent) if (known.has(box)) parentOfBox.set(box, t.ids[p]!);
  return { containers, parentOfBox };
}
