// たどる規則（docs/15 §3.5、docs/16 D43）。始点の項目から線と links を下流・上流にたどり、光る項目・箱・線・対応を集める
import {
  ancestorsOf,
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

/** 項目に付いている辺（下流なら in の項目は links、out の項目は線。上流は逆） */
function edgesOf(
  index: GraphIndex,
  state: VariantState,
  item: IndexedItem,
  dir: 'down' | 'up',
): Edge[] {
  const n = item.node;
  const useLinks = item.dir === (dir === 'down' ? 'in' : 'out');
  const found: Edge[] = [];
  if (useLinks) {
    for (const l of linksOf(index, state, n)) {
      if (!itemActive(index, state, l.from) || !itemActive(index, state, l.to)) continue;
      if ((dir === 'down' ? l.from : l.to) === item)
        found.push({ kind: 'link', node: n, link: l, src: l.from, tgt: l.to });
    }
  } else {
    const wires = (dir === 'down' ? index.wiresFrom : index.wiresTo).get(item.ref) ?? [];
    for (const w of wires)
      if (wireActive(index, state, w))
        found.push({ kind: 'wire', wire: w, src: w.from, tgt: w.to });
  }
  return found;
}

/**
 * 項目から出る辺。まず「その項目と、その子孫」に引かれた辺（値の全体はその部分も運ぶ）。
 * 無ければ最も近い祖先に引かれた辺を使い、相対パスで写す（mapAcross）
 */
export function edgesAt(
  index: GraphIndex,
  state: VariantState,
  item: IndexedItem,
  dir: 'down' | 'up',
): Edge[] {
  let found = edgesOf(index, state, item, dir);
  for (const d of item.node.items)
    if (isDescendantOf(d, item)) found = found.concat(edgesOf(index, state, d, dir));
  if (found.length) return found;
  for (const a of ancestorsOf(item).slice(1)) {
    found = edgesOf(index, state, a, dir);
    if (found.length) return found;
  }
  return [];
}

const anyIn = (set: Set<string> | undefined, lit: Set<string>) =>
  !!set && [...set].some((id) => lit.has(id));

/**
 * 1 回のたどり。`scope` は前の回で光った箱（戻りの絞り込みに使う）。null なら曖昧な戻りを全部切る（第 1 段）
 */
function traverseOnce(
  index: GraphIndex,
  state: VariantState,
  starts: IndexedItem[],
  opts: TraverseOptions,
  scope: Set<string> | null,
): Lit {
  const lit = emptyLit();
  const addItem = (it: IndexedItem) => {
    for (const a of ancestorsOf(it)) lit.items.add(a.ref);
    lit.boxes.add(it.node.id);
  };
  const addSeg = (e: Edge, from: IndexedItem, to: IndexedItem) => {
    const key = `${e.kind === 'wire' ? e.wire.key : 'L:' + e.node.id}|${from.ref}|${to.ref}`;
    const store = e.kind === 'wire' ? lit.wires : lit.links;
    if (store.has(key)) return;
    const seg: Segment =
      e.kind === 'wire'
        ? { key, kind: 'wire', wire: e.wire, from, to }
        : { key, kind: 'link', node: e.node, from, to };
    store.set(key, seg);
    lit.segs.push(seg);
  };
  for (const s of starts) addItem(s);

  // 複数から呼ばれる箱の戻りの線は、光っている呼び出し元へだけ。誰も光っていなければ全員へ。第 1 段では切る
  const replyAllowed = (w: IndexedWire) => {
    const rq = index.requesters.get(w.fromNode.id);
    if (!rq || rq.size <= 1) return true;
    if (scope === null) return false;
    return scope.has(w.toNode.id) || !anyIn(rq, scope);
  };
  // 複数へ戻す箱の行きの線を逆にたどるときも対称
  const callAllowedUp = (w: IndexedWire) => {
    const rp = index.repliers.get(w.toNode.id);
    if (!rp || rp.size <= 1) return true;
    if (scope === null) return false;
    return scope.has(w.fromNode.id) || !anyIn(rp, scope);
  };

  if (opts.down) {
    const q = [...starts];
    const seen = new Set(starts.map((s) => s.ref));
    while (q.length) {
      const it = q.shift()!;
      for (const e of edgesAt(index, state, it, 'down')) {
        if (e.kind === 'wire' && e.wire.reply && !replyAllowed(e.wire)) continue;
        const origin = isDescendantOf(e.src, it) ? e.src : it;
        const to = mapAcross(index, origin, e.src, e.tgt);
        addSeg(e, origin, to);
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
    while (q.length) {
      const it = q.shift()!;
      for (const e of edgesAt(index, state, it, 'up')) {
        if (e.kind === 'wire' && !e.wire.reply && !callAllowedUp(e.wire)) continue;
        const origin = isDescendantOf(e.tgt, it) ? e.tgt : it;
        const from = mapAcross(index, origin, e.tgt, e.src);
        addSeg(e, from, origin);
        addItem(origin);
        addItem(from);
        if (!seen.has(from.ref)) {
          seen.add(from.ref);
          q.push(from);
        }
      }
    }
  }
  return lit;
}

const sameSet = (a: Set<string>, b: Set<string>) =>
  a.size === b.size && [...a].every((x) => b.has(x));

/**
 * 始点からたどる。2 段（D43）: まず曖昧な戻り（複数から呼ばれる箱の reply）を切って範囲を求め、
 * その範囲を使って戻りを絞ったたどりを、光る箱が変わらなくなるまで繰り返す（単調に増えるので止まる）。
 * 途中の BFS の順序に依らない
 */
export function traverse(
  index: GraphIndex,
  state: VariantState,
  starts: IndexedItem[],
  opts: TraverseOptions,
): Lit {
  const active = starts.filter((s) => itemActive(index, state, s));
  let scope: Set<string> | null = null;
  let lit = traverseOnce(index, state, active, opts, scope);
  for (let i = 0; i <= index.nodes.size; i++) {
    scope = lit.boxes;
    const next = traverseOnce(index, state, active, opts, scope);
    if (sameSet(next.boxes, lit.boxes)) return next;
    lit = next;
  }
  return lit;
}
