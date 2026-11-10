// 畳む（docs/21 §2.2・§2.3。D125・D126・D128）: 包含の木の切り口から、見えている単位（箱と畳んだ箱）と線を v2 の graph の形で作る。
// 畳んだ graph は自分の索引を持ち、配置（layoutWiring）・切れた端（brokenEnds）は今の関数をそのまま呼べる。
// たどる規則（select）は全体の索引のまま。光るもの・球は、ここが返す表（箱 → 単位、全体の線 → 見えている線）で写す。
// 純関数・決定的（DOM 無し）。入力は変えない。見えている箱・1 本のままの線は、元の graph のオブジェクトをそのまま使う
import type { BrokenV2, GraphV2, NodeV2, PortV2, WireV2 } from '@stack-atlas/schema';
import type { Containment } from './containment.js';
import { openIn, type Cut } from './cut.js';
import { indexGraph, type GraphIndex, type IndexedWire } from './graph-index.js';
import { isForward } from './layout/model.js';
import { wireActive } from './links.js';
import type { LitSelection } from './select.js';
import { emptyLit, type Lit, type Segment } from './traverse.js';
import type { VariantState } from './variants.js';

/** 畳んだ箱 1 つ（入れ物 × 置き場） */
export interface FoldUnit {
  /** 畳んだ graph の中での箱の id（`fold:<入れ物の番号>:<置き場の番号>`。切り口に依らない） */
  id: string;
  /** 入れ物の id */
  container: string;
  /** 置き場のキー */
  slice: string;
  /** 中の箱の id（全体の graph の順。この置き場のものだけ） */
  boxes: string[];
  /** 入れ物の名前 */
  name: string;
  /** 入れ物の種類（`dir`・`group`） */
  kind: string;
  /** 中の箱の数（boxes.length） */
  count: number;
}

/** 単位の中に隠れた切れた線（両端が同じ畳んだ箱の中） */
export interface HiddenBroken {
  /** broken の件数 */
  count: number;
  /** いちばん重い level */
  level: BrokenV2['level'];
}

export interface FoldView {
  /** 全体の索引（たどるのはこちら） */
  source: GraphIndex;
  /**
   * 畳んだ graph（見えている箱・畳んだ箱・host の枠と、見えている線）。何も畳んでいなければ元の graph そのもの。
   * 畳んだときは `views`・`groups` を持たない（箱の id・項目の参照が畳んだ graph に無いことがある）。
   * views・groups・地図（projectMap）は全体の graph と `source` で使う
   */
  graph: GraphV2;
  /** 畳んだ graph の索引（配置・描画はこちら）。何も畳んでいなければ元の索引そのもの */
  index: GraphIndex;
  /** 畳んだ箱（id → 中身）。畳んだ graph に現れる順 */
  units: Map<string, FoldUnit>;
  /** 全体の箱（と host の枠）の id → 畳んだ graph での id（見えていれば自分、畳まれていれば畳んだ箱） */
  unitOf: Map<string, string>;
  /** 全体の線のキー → 見えている線のキー。単位の中に入って見えない線は null */
  lineOf: Map<string, string | null>;
  /** 見えている線のキー → 全体の線のキー（graph の順） */
  wiresOf: Map<string, string[]>;
  /** 畳んだ箱の id → その中に隠れた切れた線 */
  hiddenBroken: Map<string, HiddenBroken>;
  /** 開いている入れ物（正規の形） */
  open: Cut;
  /** 単位（見えている箱・畳んだ箱）の id → `▾ <名前>` に出す入れ物（いちばん内側の開いた入れ物）の id。根の直下の単位は持たない */
  crumbs: Map<string, string>;
  /**
   * 見えている線のキー → 層を決める線か（束は、中に isForward の線が 1 本でもあるか）。`layoutWiring` の `forward` に渡す
   * （`foldLayoutOptions`）。畳んだ箱の `out/_` は、参照（D53）かどうかを口から読めないため。何も畳んでいなければ空
   */
  forward: Map<string, boolean>;
  /** 畳んだ箱が 1 つでもあるか（false なら graph・index は元と同じもの） */
  folded: boolean;
}

/** 畳んだ箱の口（項目が `_` 1 つだけの in と out。今もある形） */
const foldPorts = (): PortV2[] => [
  { id: 'in', dir: 'in', items: [{ id: '_', name: '値', type: 'unknown', wireType: 'unknown' }] },
  { id: 'out', dir: 'out', items: [{ id: '_', name: '値', type: 'unknown', wireType: 'unknown' }] },
];

interface Bundle {
  wire: WireV2;
  /** 向きを決める線（isForward）の via を取ったか */
  forward: boolean;
  /** path → broken の添字 */
  broken: Map<string, number> | null;
  keys: string[];
}

/**
 * 切り口で畳んだ表示を作る。
 * - 畳んだ箱は「見えていて閉じている入れ物 × 置き場」ごとに 1 つ（中が 1 箱でも畳んだ箱）。graph の中では、中の最初の箱の位置に置く。
 *   runtime と host は中の最初の箱のもの（置き場が同じ箱は、既定では同じレーン・同じ host）
 * - 線: 両端の箱が見えていれば元の線のまま（1 本ずつ）。片方でも畳まれていれば（from の端, to の端, 戻りか）ごとに 1 本に束ねる。
 *   両端が同じ畳んだ箱に入った線は描かない（`lineOf` が null）
 * - 束の via は、束の中の向きを決める線（isForward）のうち graph の順で最初のもの。無ければ最初の線のもの。
 *   束の broken は path ごとに 1 つ（error があれば error）。束に when は付けない（止まっているかは `lineActive`）
 * - 木は入口で直す（無い親・循環）。切り口は正規の形に直す（知らない id・祖先が開いていない id は捨てる）
 * - `slice` に無い箱は、置き場のキーが空文字の 1 つの置き場として扱う
 */
export function foldView(
  index: GraphIndex,
  c: Containment,
  cut: Cut,
  slice: ReadonlyMap<string, string>,
): FoldView {
  const { tree: t, open, cut: openCut } = openIn(c, cut);

  // 入れ物 i を含む、いちばん上の閉じた入れ物（i 自身を含む）。祖先も自分も開いていれば -1。浅い順に決める
  const top = new Int32Array(t.ids.length).fill(-1);
  for (const i of t.byDepth) {
    const p = t.parent[i]!;
    top[i] = p !== -1 && top[p] !== -1 ? top[p]! : open[i] ? -1 : i;
  }

  const taken = new Set(index.nodes.keys());
  const sliceNo = new Map<string, number>();
  const units = new Map<string, FoldUnit>();
  const unitAt = new Map<number, Map<number, FoldUnit>>();
  const unitOf = new Map<string, string>();
  const crumbs = new Map<string, string>();
  const nodes: NodeV2[] = [];
  for (const n of index.nodes.values()) {
    if (index.hosts.has(n.id)) {
      unitOf.set(n.id, n.id);
      nodes.push(n.node);
      continue;
    }
    // 置き場の番号は、切り口に依らないように全部の箱で振る
    const key = slice.get(n.id) ?? '';
    let s = sliceNo.get(key);
    if (s === undefined) {
      s = sliceNo.size;
      sliceNo.set(key, s);
    }
    const p = t.boxParent.get(n.id) ?? -1;
    const u = p === -1 ? -1 : top[p]!;
    if (u === -1) {
      unitOf.set(n.id, n.id);
      nodes.push(n.node);
      if (p !== -1) crumbs.set(n.id, t.ids[p]!);
      continue;
    }
    let row = unitAt.get(u);
    if (!row) {
      row = new Map();
      unitAt.set(u, row);
    }
    let unit = row.get(s);
    if (!unit) {
      let id = `fold:${u}:${s}`;
      while (taken.has(id)) id += '~';
      const box = t.list[u]!;
      unit = {
        id,
        container: t.ids[u]!,
        slice: key,
        boxes: [],
        name: typeof box.name === 'string' && box.name ? box.name : t.ids[u]!,
        kind: typeof box.kind === 'string' ? box.kind : '',
        count: 0,
      };
      row.set(s, unit);
      units.set(id, unit);
      const up = t.parent[u]!;
      if (up !== -1) crumbs.set(id, t.ids[up]!);
      nodes.push({
        id,
        kind: 'fn',
        name: unit.name,
        runtime: n.node.runtime,
        ...(n.node.host === undefined ? {} : { host: n.node.host }),
        ports: foldPorts(),
      });
    }
    unit.boxes.push(n.id);
    unit.count++;
    unitOf.set(n.id, unit.id);
  }

  const lineOf = new Map<string, string | null>();
  const wiresOf = new Map<string, string[]>();
  const hiddenBroken = new Map<string, HiddenBroken>();
  if (units.size === 0) {
    for (const w of index.wires) {
      lineOf.set(w.key, w.key);
      wiresOf.set(w.key, [w.key]);
    }
    return {
      source: index,
      graph: index.graph,
      index,
      units,
      unitOf,
      lineOf,
      wiresOf,
      hiddenBroken,
      open: openCut,
      crumbs,
      forward: new Map(),
      folded: false,
    };
  }

  // 線。束は（from の端, to の端, 戻りか）ごと。graph の中では、束の最初の線の位置に置く
  const lines: { wire: WireV2; keys: string[]; bundle?: Bundle }[] = [];
  const bundles = new Map<string, Map<string, [Bundle | undefined, Bundle | undefined]>>();
  for (const w of index.wires) {
    const fu = unitOf.get(w.fromNode.id)!;
    const tu = unitOf.get(w.toNode.id)!;
    const fromFolded = fu !== w.fromNode.id;
    const toFolded = tu !== w.toNode.id;
    if (!fromFolded && !toFolded) {
      lines.push({ wire: w.wire, keys: [w.key] });
      continue;
    }
    if (fromFolded && fu === tu) {
      lineOf.set(w.key, null);
      for (const b of w.wire.broken ?? []) {
        const level = b.level === 'error' ? 'error' : 'warn';
        const cur = hiddenBroken.get(fu);
        if (!cur) hiddenBroken.set(fu, { count: 1, level });
        else {
          cur.count++;
          if (level === 'error') cur.level = 'error';
        }
      }
      continue;
    }
    const from = fromFolded ? `${fu}#out/_` : w.from.ref;
    const to = toFolded ? `${tu}#in/_` : w.to.ref;
    let byTo = bundles.get(from);
    if (!byTo) {
      byTo = new Map();
      bundles.set(from, byTo);
    }
    let pair = byTo.get(to);
    if (!pair) {
      pair = [undefined, undefined];
      byTo.set(to, pair);
    }
    const side = w.reply ? 1 : 0;
    let bundle = pair[side];
    const forward = isForward(w);
    if (!bundle) {
      bundle = {
        wire: { from, to, via: w.wire.via, ...(w.reply ? { reply: true } : {}) },
        forward,
        broken: null,
        keys: [],
      };
      pair[side] = bundle;
      lines.push({ wire: bundle.wire, keys: bundle.keys, bundle });
    } else if (forward && !bundle.forward) {
      bundle.wire.via = w.wire.via;
      bundle.forward = true;
    }
    bundle.keys.push(w.key);
    for (const b of w.wire.broken ?? []) {
      bundle.broken ??= new Map();
      const list = (bundle.wire.broken ??= []);
      const at = bundle.broken.get(b.path);
      if (at === undefined) {
        bundle.broken.set(b.path, list.length);
        list.push({ ...b });
      } else if (list[at]!.level !== 'error' && b.level === 'error') list[at] = { ...b };
    }
  }

  // views・groups は持たない（id が畳んだ graph に無いことがある）
  const src = index.graph;
  const graph: GraphV2 = {
    ...(src.$schema === undefined ? {} : { $schema: src.$schema }),
    version: src.version,
    ...(src.project === undefined ? {} : { project: src.project }),
    ...(src.types === undefined ? {} : { types: src.types }),
    nodes,
    wires: lines.map((l) => l.wire),
  };
  const folded = indexGraph(graph);
  // 線のキーは畳んだ索引が振ったもの（添字から作ると仮定しない）
  const forwardOf = new Map<string, boolean>();
  const sourceOf = new Map(index.wires.map((w) => [w.key, w]));
  lines.forEach((l, i) => {
    const key = folded.wires[i]!.key;
    wiresOf.set(key, l.keys);
    for (const k of l.keys) lineOf.set(k, key);
    forwardOf.set(key, l.bundle ? l.bundle.forward : isForward(sourceOf.get(l.keys[0]!)!));
  });
  return {
    source: index,
    graph,
    index: folded,
    units,
    unitOf,
    lineOf,
    wiresOf,
    hiddenBroken,
    open: openCut,
    crumbs,
    forward: forwardOf,
    folded: true,
  };
}

/** 畳んだ索引の線（キー → 線）。view ごとに 1 回だけ作る */
const lineCache = new WeakMap<FoldView, Map<string, IndexedWire>>();
function linesOf(view: FoldView): Map<string, IndexedWire> {
  let m = lineCache.get(view);
  if (!m) {
    m = new Map(view.index.wires.map((w) => [w.key, w]));
    lineCache.set(view, m);
  }
  return m;
}

/**
 * 全体の索引の区間を、畳んだ索引の区間に写す。単位の中に入って見えない区間（線の両端が同じ畳んだ箱・畳んだ箱の中の対応）は null。
 * 見えている箱の側は同じ項目（子の項目に写した区間は子のまま）、畳んだ箱の側は口の `_`。何も畳んでいなければ元の区間そのもの。
 * 区間のキーは、たどる規則（traverse.ts）と同じ形（`<線のキー>|<from の ref>|<to の ref>`）
 */
export function segmentOn(view: FoldView, seg: Segment): Segment | null {
  if (!view.folded) return seg;
  // 区間のキーは全体の索引の中で一意で、写す先は view ごとに決まる。litOn・foldLengths・flowOn が同じ区間を何度も写すので覚える
  let memo = segCache.get(view);
  if (!memo) {
    memo = new Map();
    segCache.set(view, memo);
  }
  const hit = memo.get(seg.key);
  if (hit !== undefined) return hit;
  const out = mapSegment(view, seg);
  memo.set(seg.key, out);
  return out;
}

const segCache = new WeakMap<FoldView, Map<string, Segment | null>>();

function mapSegment(view: FoldView, seg: Segment): Segment | null {
  if (seg.kind === 'link' || !seg.wire) {
    const id = seg.node?.id ?? seg.from.node.id;
    if (view.unitOf.get(id) !== id) return null;
    const node = view.index.nodes.get(id);
    const from = view.index.items.get(seg.from.ref);
    const to = view.index.items.get(seg.to.ref);
    return node && from && to ? { key: seg.key, kind: 'link', node, from, to } : null;
  }
  const lineKey = view.lineOf.get(seg.wire.key);
  const line = lineKey ? linesOf(view).get(lineKey) : undefined;
  if (!line) return null;
  const fromId = seg.from.node.id;
  const toId = seg.to.node.id;
  const from = view.unitOf.get(fromId) === fromId ? view.index.items.get(seg.from.ref) : line.from;
  const to = view.unitOf.get(toId) === toId ? view.index.items.get(seg.to.ref) : line.to;
  if (!from || !to) return null;
  return { key: `${line.key}|${from.ref}|${to.ref}`, kind: 'wire', wire: line, from, to };
}

/**
 * 全体の索引でたどった光るもの（select・traverse の結果）を、畳んだ索引の語彙に写す。
 * - 光る箱: 見えている箱はそのまま、畳まれた箱は畳んだ箱
 * - 光る項目: 見えている箱の項目だけ。畳んだ箱の口（`_`）は、光る見えている線の端になったときだけ
 * - 区間: `segmentOn`（束に写った区間は 1 つにまとめる。単位の中の区間は無い）
 * - 始点: 箱は単位へ。畳まれた箱の項目が始点なら、その畳んだ箱を始点の箱にする。クリックした線が単位の中なら startSeg は無い
 * 何も畳んでいなければ、渡したものをそのまま返す
 */
export function litOn(view: FoldView, lit: LitSelection): LitSelection;
export function litOn(view: FoldView, lit: Lit): Lit;
export function litOn(view: FoldView, lit: Lit | LitSelection): Lit | LitSelection {
  if (!view.folded) return lit;
  const visible = (ref: string) => {
    const id = view.source.items.get(ref)?.node.id;
    return id !== undefined && view.unitOf.get(id) === id;
  };
  const unitOfRef = (ref: string) => {
    const id = view.source.items.get(ref)?.node.id;
    return id === undefined ? undefined : view.unitOf.get(id);
  };

  const out = emptyLit();
  for (const id of lit.boxes) {
    const u = view.unitOf.get(id);
    if (u !== undefined) out.boxes.add(u);
  }
  for (const ref of lit.items) if (visible(ref)) out.items.add(ref);
  const keyOf = new Map<string, string>();
  for (const s of lit.segs) {
    const f = segmentOn(view, s);
    if (!f) continue;
    keyOf.set(s.key, f.key);
    const store = f.kind === 'wire' ? out.wires : out.links;
    if (store.has(f.key)) continue;
    store.set(f.key, f);
    out.segs.push(f);
    if (f.kind === 'wire') {
      if (view.units.has(f.from.node.id)) out.items.add(f.from.ref);
      if (view.units.has(f.to.node.id)) out.items.add(f.to.ref);
    }
  }
  if (!('selection' in lit)) return out;

  const startBoxes = new Set<string>();
  for (const id of lit.startBoxes) {
    const u = view.unitOf.get(id);
    if (u !== undefined) startBoxes.add(u);
  }
  const startItems = new Set<string>();
  for (const ref of lit.startItems) {
    if (visible(ref)) startItems.add(ref);
    else {
      const u = unitOfRef(ref);
      if (u !== undefined) startBoxes.add(u);
    }
  }
  const flowStarts = new Set<string>();
  for (const ref of lit.flowStarts) if (visible(ref)) flowStarts.add(ref);
  const startSeg = lit.startSeg === undefined ? undefined : keyOf.get(lit.startSeg);
  return {
    ...out,
    selection: lit.selection,
    startBoxes,
    startItems,
    flowStarts,
    ...(startSeg === undefined ? {} : { startSeg }),
    flows: lit.flows,
  };
}

/**
 * 見えている線が、今の分岐の状態で存在するか。束は、中の線が 1 本でも存在すれば存在する（全部止まっていれば止まった線）。
 * 元の線のままの線は今の `wireActive` と同じ
 */
export function lineActive(view: FoldView, state: VariantState, lineKey: string): boolean {
  const keys = view.wiresOf.get(lineKey);
  if (!keys) return false;
  const wires = sourceWires(view);
  return keys.some((k) => {
    const w = wires.get(k);
    return !!w && wireActive(view.source, state, w);
  });
}

const sourceCache = new WeakMap<GraphIndex, Map<string, IndexedWire>>();
function sourceWires(view: FoldView): Map<string, IndexedWire> {
  let m = sourceCache.get(view.source);
  if (!m) {
    m = new Map(view.source.wires.map((w) => [w.key, w]));
    sourceCache.set(view.source, m);
  }
  return m;
}
