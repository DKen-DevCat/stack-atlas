// たどる規則（docs/15 §3.5、docs/16 D43）。始点の項目から線と links を下流・上流にたどり、光る項目・箱・線・対応を集める
import {
  isDescendantOf,
  type GraphIndex,
  type IndexedItem,
  type IndexedNode,
  type IndexedWire,
} from './graph-index.js';
import { linksOf, wireActive, type ResolvedLink } from './links.js';
import { itemActive, type VariantState } from './variants.js';

/** 光る 1 区間（線か、箱の中の対応）。親の単位の線を子からたどったときは from / to が子に写っている */
export interface Segment {
  key: string;
  kind: 'wire' | 'link';
  wire?: IndexedWire;
  /** kind link のときの箱 */
  node?: IndexedNode;
  from: IndexedItem;
  to: IndexedItem;
}

/** たどった結果 */
export interface Lit {
  /** 光る項目の ref（子が光れば親も光る） */
  items: Set<string>;
  /** 光る箱の id */
  boxes: Set<string>;
  wires: Map<string, Segment>;
  links: Map<string, Segment>;
  /** 追加された順 */
  segs: Segment[];
}

export interface TraverseOptions {
  up: boolean;
  down: boolean;
}

type Edge =
  | { kind: 'wire'; wire: IndexedWire; src: IndexedItem; tgt: IndexedItem }
  | { kind: 'link'; node: IndexedNode; link: ResolvedLink; src: IndexedItem; tgt: IndexedItem };

export function emptyLit(): Lit {
  return { items: new Set(), boxes: new Set(), wires: new Map(), links: new Map(), segs: [] };
}

/** b の内容を a に合併する（host の枠の「独立にたどって合併」に使う） */
export function mergeLit(a: Lit, b: Lit): Lit {
  for (const i of b.items) a.items.add(i);
  for (const x of b.boxes) a.boxes.add(x);
  for (const s of b.segs) {
    const store = s.kind === 'wire' ? a.wires : a.links;
    if (store.has(s.key)) continue;
    store.set(s.key, s);
    a.segs.push(s);
  }
  return a;
}

/**
 * 祖先の単位で引かれた辺を、子の項目から相手側に写す（親子の写し。docs/15 §3.4）。
 * 相手側に同じ相対パスの子があればそれ。無ければ末尾を削って段階的に粗くし、最後は辺の端（親）に落ちる
 */
export function mapAcross(
  index: GraphIndex,
  fromItem: IndexedItem,
  edgeSrc: IndexedItem,
  edgeTgt: IndexedItem,
): IndexedItem {
  if (fromItem === edgeSrc) return edgeTgt;
  const rel = fromItem.path.slice(edgeSrc.path.length + 1);
  if (!rel) return edgeTgt;
  const segs = rel.split('.');
  for (let k = segs.length; k > 0; k--) {
    const cand = index.items.get(
      `${edgeTgt.node.id}#${edgeTgt.port.id}/${edgeTgt.path}.${segs.slice(0, k).join('.')}`,
    );
    if (cand) return cand;
  }
  return edgeTgt;
}

/**
 * 1 つの分岐の状態での辺の表。たどりの間は状態が変わらないので、箱の links の解決と項目ごとの辺を覚えておく
 * （2 段のたどりは同じ項目を何回も見る。host の枠のクリックは箱ごとに traverse を呼ぶ）
 */
interface EdgeCache {
  /** 箱 id → links の辺（down: from の ref → 辺、up: to の ref → 辺。links の宣言順） */
  links: Map<string, { down: Map<string, Edge[]>; up: Map<string, Edge[]> }>;
  /** `<dir>|<ref>` → その項目に付いている辺 */
  own: Map<string, Edge[]>;
  /** `<dir>|<ref>` → edgesAt の結果 */
  at: Map<string, Edge[]>;
  /** 向き → 辺 → たどっている項目 → その 1 歩（写した相手と区間）。回をまたいで同じ区間を作り直さない */
  hops: { down: Map<Edge, Map<IndexedItem, Hop>>; up: Map<Edge, Map<IndexedItem, Hop>> };
}

/** 項目 it から辺 e を 1 歩たどった結果。origin は辺の手前側の端（it か、辺を持つ it の子孫）、other は写した相手 */
interface Hop {
  seg: Segment;
  origin: IndexedItem;
  other: IndexedItem;
}

/** 索引 → 状態のキー → 辺の表。索引は作ったあと変えない前提。状態は最近使った MAX_STATES 個だけ残す */
const edgeCaches = new WeakMap<GraphIndex, Map<string, EdgeCache>>();
const MAX_STATES = 16;

const stateKey = (state: VariantState) =>
  JSON.stringify(
    Object.keys(state)
      .sort()
      .map((k) => [k, state[k]]),
  );

function edgeCacheOf(index: GraphIndex, state: VariantState): EdgeCache {
  let perState = edgeCaches.get(index);
  if (!perState) {
    perState = new Map();
    edgeCaches.set(index, perState);
  }
  const key = stateKey(state);
  const hit = perState.get(key);
  if (hit) {
    // 最近使った順にする
    perState.delete(key);
    perState.set(key, hit);
    return hit;
  }
  const cache: EdgeCache = {
    links: new Map(),
    own: new Map(),
    at: new Map(),
    hops: { down: new Map(), up: new Map() },
  };
  perState.set(key, cache);
  if (perState.size > MAX_STATES) perState.delete(perState.keys().next().value!);
  return cache;
}

function linkTable(index: GraphIndex, state: VariantState, cache: EdgeCache, n: IndexedNode) {
  let t = cache.links.get(n.id);
  if (t) return t;
  t = { down: new Map<string, Edge[]>(), up: new Map<string, Edge[]>() };
  const push = (m: Map<string, Edge[]>, ref: string, e: Edge) => {
    const arr = m.get(ref);
    if (arr) arr.push(e);
    else m.set(ref, [e]);
  };
  for (const l of linksOf(index, state, n)) {
    if (!itemActive(index, state, l.from) || !itemActive(index, state, l.to)) continue;
    const e: Edge = { kind: 'link', node: n, link: l, src: l.from, tgt: l.to };
    push(t.down, l.from.ref, e);
    push(t.up, l.to.ref, e);
  }
  cache.links.set(n.id, t);
  return t;
}

/** 項目に付いている辺（下流なら in の項目は links、out の項目は線。上流は逆） */
function edgesOf(
  index: GraphIndex,
  state: VariantState,
  cache: EdgeCache,
  item: IndexedItem,
  dir: 'down' | 'up',
): Edge[] {
  const key = `${dir}|${item.ref}`;
  const hit = cache.own.get(key);
  if (hit) return hit;
  const useLinks = item.dir === (dir === 'down' ? 'in' : 'out');
  let found: Edge[];
  if (useLinks) {
    const t = linkTable(index, state, cache, item.node);
    found = (dir === 'down' ? t.down : t.up).get(item.ref) ?? [];
  } else {
    found = [];
    const wires = (dir === 'down' ? index.wiresFrom : index.wiresTo).get(item.ref) ?? [];
    for (const w of wires)
      if (wireActive(index, state, w))
        found.push({ kind: 'wire', wire: w, src: w.from, tgt: w.to });
  }
  cache.own.set(key, found);
  return found;
}

/**
 * 項目から出る辺（docs/15 §3.5 の親子の写し）。
 * - 自分に辺がある項目: 自分の辺だけ（祖先の辺は使わない。改名の links を持つ子は親の links で写らない）
 * - 自分に辺が無い項目: 最も近い祖先に引かれた辺を、相対パスで写して使う（mapAcross）
 * どちらも、子孫に引かれた辺を足す（値の全体はその部分も運ぶ）。孫に改名があっても、中間の項目は祖先の辺で写る。
 * 結果は索引と状態ごとに覚えて共有するので、返った配列を書き換えない
 */
export function edgesAt(
  index: GraphIndex,
  state: VariantState,
  item: IndexedItem,
  dir: 'down' | 'up',
): Edge[] {
  return edgesAtCached(index, state, edgeCacheOf(index, state), item, dir);
}

function edgesAtCached(
  index: GraphIndex,
  state: VariantState,
  cache: EdgeCache,
  item: IndexedItem,
  dir: 'down' | 'up',
): Edge[] {
  const key = `${dir}|${item.ref}`;
  const hit = cache.at.get(key);
  if (hit) return hit;
  let found = edgesOf(index, state, cache, item, dir);
  if (!found.length) {
    for (let a = item.parent; a; a = a.parent) {
      found = edgesOf(index, state, cache, a, dir);
      if (found.length) break;
    }
  }
  for (const d of item.descendants) {
    const e = edgesOf(index, state, cache, d, dir);
    if (e.length) found = found.concat(e);
  }
  cache.at.set(key, found);
  return found;
}

/**
 * 項目 it から辺 e を 1 歩たどる。下流なら origin（it か、辺を持つ子孫）→ 写した相手、上流は逆向き。
 * 区間のキーは `<線のキー | L:箱>|<from>|<to>`
 */
function hopOf(
  index: GraphIndex,
  cache: EdgeCache,
  e: Edge,
  it: IndexedItem,
  dir: 'down' | 'up',
): Hop {
  const byEdge = cache.hops[dir];
  let m = byEdge.get(e);
  if (!m) {
    m = new Map();
    byEdge.set(e, m);
  }
  const hit = m.get(it);
  if (hit) return hit;
  const near = dir === 'down' ? e.src : e.tgt;
  const far = dir === 'down' ? e.tgt : e.src;
  const origin = isDescendantOf(near, it) ? near : it;
  const other = mapAcross(index, origin, near, far);
  const from = dir === 'down' ? origin : other;
  const to = dir === 'down' ? other : origin;
  const key = `${e.kind === 'wire' ? e.wire.key : 'L:' + e.node.id}|${from.ref}|${to.ref}`;
  const seg: Segment =
    e.kind === 'wire'
      ? { key, kind: 'wire', wire: e.wire, from, to }
      : { key, kind: 'link', node: e.node, from, to };
  const hop: Hop = { seg, origin, other };
  m.set(it, hop);
  return hop;
}

const anyIn = (set: Set<string> | undefined, lit: Set<string>) =>
  !!set && [...set].some((id) => lit.has(id));

/**
 * 1 回のたどり。`scope` は前の回で光った箱（戻りの絞り込みに使う）。null なら曖昧な戻りを全部切る（第 1 段）。
 * `scoped` は、曖昧な戻り（往復の相手が 2 つ以上の箱の線）に出会って scope を見たか（出会わなければ次の回も同じ結果になる）
 */
function traverseOnce(
  index: GraphIndex,
  state: VariantState,
  cache: EdgeCache,
  starts: IndexedItem[],
  opts: TraverseOptions,
  scope: Set<string> | null,
): { lit: Lit; scoped: boolean } {
  const lit = emptyLit();
  let scoped = false;
  const addItem = (it: IndexedItem) => {
    // 項目は必ず祖先ごと入れるので、入っていれば祖先も箱も入っている
    if (lit.items.has(it.ref)) return;
    for (let x: IndexedItem | null = it; x; x = x.parent) lit.items.add(x.ref);
    lit.boxes.add(it.node.id);
  };
  const addSeg = (seg: Segment) => {
    const store = seg.kind === 'wire' ? lit.wires : lit.links;
    if (store.has(seg.key)) return;
    store.set(seg.key, seg);
    lit.segs.push(seg);
  };
  for (const s of starts) addItem(s);

  // 複数から呼ばれる箱の戻りの線は、光っている呼び出し元へだけ。誰も光っていなければ全員へ。第 1 段では切る
  const replyAllowed = (w: IndexedWire) => {
    const rq = index.requesters.get(w.fromNode.id);
    if (!rq || rq.size <= 1) return true;
    scoped = true;
    if (scope === null) return false;
    return scope.has(w.toNode.id) || !anyIn(rq, scope);
  };
  // 複数へ戻す箱の行きの線を逆にたどるときも対称
  const callAllowedUp = (w: IndexedWire) => {
    const rp = index.repliers.get(w.toNode.id);
    if (!rp || rp.size <= 1) return true;
    scoped = true;
    if (scope === null) return false;
    return scope.has(w.fromNode.id) || !anyIn(rp, scope);
  };

  if (opts.down) {
    const q = [...starts];
    const seen = new Set(starts.map((s) => s.ref));
    for (let qi = 0; qi < q.length; qi++) {
      const it = q[qi]!;
      for (const e of edgesAtCached(index, state, cache, it, 'down')) {
        if (e.kind === 'wire' && e.wire.reply && !replyAllowed(e.wire)) continue;
        const { seg, origin, other: to } = hopOf(index, cache, e, it, 'down');
        addSeg(seg);
        addItem(origin);
        addItem(to);
        if (!seen.has(to.ref)) {
          seen.add(to.ref);
          q.push(to);
        }
      }
    }
  }
  if (opts.up) {
    const q = [...starts];
    const seen = new Set(starts.map((s) => s.ref));
    for (let qi = 0; qi < q.length; qi++) {
      const it = q[qi]!;
      for (const e of edgesAtCached(index, state, cache, it, 'up')) {
        if (e.kind === 'wire' && !e.wire.reply && !callAllowedUp(e.wire)) continue;
        const { seg, origin, other: from } = hopOf(index, cache, e, it, 'up');
        addSeg(seg);
        addItem(origin);
        addItem(from);
        if (!seen.has(from.ref)) {
          seen.add(from.ref);
          q.push(from);
        }
      }
    }
  }
  return { lit, scoped };
}

const sameSet = (a: Set<string>, b: Set<string>) =>
  a.size === b.size && [...a].every((x) => b.has(x));

/**
 * 始点からたどる。2 段（D43）: まず曖昧な戻り（複数から呼ばれる箱の reply）を切って範囲を求め、
 * その範囲を使って戻りを絞ったたどりを、光る箱が変わらなくなるまで繰り返す（単調に増えるので止まる）。
 * 途中の BFS の順序に依らない。第 1 段で曖昧な戻りに出会わなければ、その結果がそのまま答え（次の回も同じ判断になる）
 */
export function traverse(
  index: GraphIndex,
  state: VariantState,
  starts: IndexedItem[],
  opts: TraverseOptions,
): Lit {
  const active = starts.filter((s) => itemActive(index, state, s));
  const cache = edgeCacheOf(index, state);
  const first = traverseOnce(index, state, cache, active, opts, null);
  if (!first.scoped) return first.lit;
  let lit = first.lit;
  for (let i = 0; i <= index.nodes.size; i++) {
    const next = traverseOnce(index, state, cache, active, opts, lit.boxes).lit;
    if (sameSet(next.boxes, lit.boxes)) return next;
    lit = next;
  }
  return lit;
}
