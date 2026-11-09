// 2 つの graph.json v2 の差分（docs/16 §10: 箱・線・型・項目で比べる）と、配線図に差分を描くための graph（docs/18 §3.4）。
// 2026-11-09（8-3c）: diffGraphsV2 / isEmptyDiffV2 を @stack-atlas/core から移した（ビューアは core に依存しない。D44）。
// core は wiring から再 export する（`stack-atlas diff` の結果は変わらない）
import type { GraphV2, ItemV2, NamedType, NodeV2, PortV2, WireV2 } from '@stack-atlas/schema';

export interface NodeChange {
  id: string;
  /** 変わったフィールド（v1 は `file` `kind` `layer` `name` `cache.badge`、v2 は GraphDiffV2.changedNodes を見る） */
  fields: string[];
}

/** 線の同一性は (from, to)（同じ (from, to) の線は 1 本。docs/16 §6） */
export interface WireRef {
  from: string;
  to: string;
  via: string;
}

export interface WireChange extends WireRef {
  /** 変わったフィールド。`via` `reply` `label` `when` のいずれか */
  fields: string[];
}

export interface GraphDiffV2 {
  addedNodes: string[];
  removedNodes: string[];
  /** 変わった箱。fields は `kind` `runtime` `name` `file` `host` `cache.badge` のいずれか */
  changedNodes: NodeChange[];
  addedWires: WireRef[];
  removedWires: WireRef[];
  changedWires: WireChange[];
  addedTypes: string[];
  removedTypes: string[];
  /** 両方にある箱の項目の増減（`<nodeId>#<portId>/<path>`）。足された・消えた箱の項目は数えない */
  addedItems: string[];
  removedItems: string[];
}

const COMPARED_V2: Array<[string, (n: NodeV2) => unknown]> = [
  ['kind', (n) => n.kind],
  ['runtime', (n) => n.runtime],
  ['name', (n) => n.name],
  ['file', (n) => n.file],
  ['host', (n) => n.host],
  ['cache.badge', (n) => n.cache?.badge],
];

const WIRE_COMPARED: Array<[string, (w: WireV2) => unknown]> = [
  ['via', (w) => w.via],
  ['reply', (w) => w.reply === true],
  ['label', (w) => w.label],
  ['when', (w) => (w.when ? JSON.stringify(w.when) : undefined)],
];

/** 箱の全項目（入れ子を含む）の参照 → 項目。検証していない graph（口の無い箱）でも落ちない */
function itemsOf(n: NodeV2): Map<string, ItemV2> {
  const out = new Map<string, ItemV2>();
  for (const p of n.ports ?? []) {
    const walk = (items: ItemV2[] | undefined, prefix: string) => {
      for (const it of items ?? []) {
        const path = prefix + it.id;
        out.set(`${n.id}#${p.id}/${path}`, it);
        walk(it.children, `${path}.`);
      }
    };
    walk(p.items, '');
  }
  return out;
}

const wireKey = (w: Pick<WireV2, 'from' | 'to'>) => `${w.from}\u0000${w.to}`;
const wireRef = (w: WireV2): WireRef => ({ from: w.from, to: w.to, via: w.via });

export function diffGraphsV2(
  prev: Pick<GraphV2, 'nodes' | 'wires' | 'types'>,
  next: Pick<GraphV2, 'nodes' | 'wires' | 'types'>,
): GraphDiffV2 {
  const p = new Map(prev.nodes.map((n) => [n.id, n]));
  const q = new Map(next.nodes.map((n) => [n.id, n]));
  const changedNodes: NodeChange[] = [];
  const addedItems: string[] = [];
  const removedItems: string[] = [];
  for (const [id, b] of q) {
    const a = p.get(id);
    if (!a) continue;
    const fields = COMPARED_V2.filter(([, get]) => get(a) !== get(b)).map(([f]) => f);
    if (fields.length) changedNodes.push({ id, fields });
    const ai = itemsOf(a);
    const bi = itemsOf(b);
    for (const r of bi.keys()) if (!ai.has(r)) addedItems.push(r);
    for (const r of ai.keys()) if (!bi.has(r)) removedItems.push(r);
  }
  const pw = new Map(prev.wires.map((w) => [wireKey(w), w]));
  const qw = new Map(next.wires.map((w) => [wireKey(w), w]));
  const changedWires: WireChange[] = [];
  for (const [k, b] of qw) {
    const a = pw.get(k);
    if (!a) continue;
    const fields = WIRE_COMPARED.filter(([, get]) => get(a) !== get(b)).map(([f]) => f);
    if (fields.length) changedWires.push({ ...wireRef(b), fields });
  }
  const pt = new Set((prev.types ?? []).map((t) => t.id));
  const qt = new Set((next.types ?? []).map((t) => t.id));
  return {
    addedNodes: [...q.keys()].filter((id) => !p.has(id)),
    removedNodes: [...p.keys()].filter((id) => !q.has(id)),
    changedNodes,
    addedWires: [...qw].filter(([k]) => !pw.has(k)).map(([, w]) => wireRef(w)),
    removedWires: [...pw].filter(([k]) => !qw.has(k)).map(([, w]) => wireRef(w)),
    changedWires,
    addedTypes: [...qt].filter((id) => !pt.has(id)),
    removedTypes: [...pt].filter((id) => !qt.has(id)),
    addedItems,
    removedItems,
  };
}

export function isEmptyDiffV2(d: GraphDiffV2): boolean {
  return (
    !d.addedNodes.length &&
    !d.removedNodes.length &&
    !d.changedNodes.length &&
    !d.addedWires.length &&
    !d.removedWires.length &&
    !d.changedWires.length &&
    !d.addedTypes.length &&
    !d.removedTypes.length &&
    !d.addedItems.length &&
    !d.removedItems.length
  );
}

// ---- 配線図の差分（docs/18 §3.4） ----

/** 配線図に差分を描くための graph と印 */
export interface DiffOverlayV2 {
  /**
   * 今の graph に、前にしか無い箱・項目・線（幽霊）を足した graph。配置と描画はこれで 1 回だけ行う。
   * 今の graph の線は同じ順で先頭に並ぶので、線のキー（`w<i>`。IndexedWire.key）は今の graph の索引と同じ。
   * 選ぶ・たどるは今の graph の索引で行う（幽霊は光らない）
   */
  graph: GraphV2;
  diff: GraphDiffV2;
  /** 前にしか無いもの: 箱 id、項目の参照（今もある箱の中の消えた項目）、線のキー（graph の索引の IndexedWire.key） */
  ghost: { nodes: Set<string>; items: Set<string>; wires: Set<string> };
  /** 今にしか無いもの: 箱 id、項目の参照（前もあった箱の中の足された項目）、線のキー */
  added: { nodes: Set<string>; items: Set<string>; wires: Set<string> };
  /** 両方にある項目のうち `type` か `wireType` が変わったもの */
  changed: Set<string>;
}

/** 今の項目の並びに、前にしか無い項目を足す（同じ id の項目は子を再帰で足す）。今の graph のオブジェクトは変えない */
function mergeItems(cur: ItemV2[], prev: ItemV2[]): ItemV2[] {
  const prevById = new Map(prev.map((it) => [it.id, it]));
  const curIds = new Set(cur.map((it) => it.id));
  const out = cur.map((it) => {
    const a = prevById.get(it.id);
    if (!a?.children?.length) return it;
    return { ...it, children: mergeItems(it.children ?? [], a.children) };
  });
  for (const a of prev) if (!curIds.has(a.id)) out.push(a);
  return out;
}

function withRemovedItems(cur: NodeV2, prev: NodeV2): NodeV2 {
  const curPorts = new Map(cur.ports.map((p) => [p.id, p]));
  const ports: PortV2[] = cur.ports.map((p) => {
    const a = (prev.ports ?? []).find((x) => x.id === p.id);
    return a ? { ...p, items: mergeItems(p.items, a.items ?? []) } : p;
  });
  for (const a of prev.ports ?? []) if (!curPorts.has(a.id)) ports.push(a);
  return { ...cur, ports };
}

/**
 * 前の graph（v2）との差分を配線図に描く準備をする（docs/18 §3.4）。
 * - 前にしか無い箱は幽霊の箱として足す（画面の HTML は読まないので `screen.html` を外す。host は、今の host の枠か
 *   幽霊の箱を指すときだけ残す。今は枠でない箱が幽霊の中身で枠に変わらないように）
 * - 今もある箱には、前にしか無い項目（口ごと消えたものも）を足す
 * - 前にしか無い線は、両端が足した graph で解けるものだけ足す（`broken` と `route` は外す。切れた線は今の graph の事実だけ描く）
 */
export function diffOverlayV2(prev: GraphV2, next: GraphV2): DiffOverlayV2 {
  const diff = diffGraphsV2(prev, next);
  const prevById = new Map(prev.nodes.map((n) => [n.id, n]));
  const curIds = new Set(next.nodes.map((n) => n.id));
  const curHosts = new Set(next.nodes.flatMap((n) => (n.host === undefined ? [] : [n.host])));
  const ghostIds = new Set(prev.nodes.filter((n) => !curIds.has(n.id)).map((n) => n.id));

  const nodes: NodeV2[] = next.nodes.map((n) => {
    const a = prevById.get(n.id);
    return a ? withRemovedItems(n, a) : n;
  });
  for (const a of prev.nodes) {
    if (curIds.has(a.id)) continue;
    const g: NodeV2 = { ...a, ports: a.ports ?? [] };
    if (g.host !== undefined && !curHosts.has(g.host) && !ghostIds.has(g.host)) delete g.host;
    if (g.screen) {
      const screen = { ...g.screen };
      delete screen.html;
      g.screen = screen;
    }
    delete g.position;
    nodes.push(g);
  }

  const refs = new Set<string>();
  for (const n of nodes) for (const r of itemsOf(n).keys()) refs.add(r);
  const curWireKeys = new Set(next.wires.map(wireKey));
  const prevWireKeys = new Set(prev.wires.map(wireKey));
  const wires: WireV2[] = [...next.wires];
  const ghostWires = new Set<string>();
  const seen = new Set<string>();
  for (const w of prev.wires) {
    const k = wireKey(w);
    if (curWireKeys.has(k) || seen.has(k) || !refs.has(w.from) || !refs.has(w.to)) continue;
    seen.add(k);
    const ghost: WireV2 = { ...w };
    delete ghost.broken;
    delete ghost.route;
    ghostWires.add(`w${wires.length}`);
    wires.push(ghost);
  }

  const curTypes = new Set((next.types ?? []).map((t) => t.id));
  const types: NamedType[] = [
    ...(next.types ?? []),
    ...(prev.types ?? []).filter((t) => !curTypes.has(t.id)),
  ];

  const changed = new Set<string>();
  for (const b of next.nodes) {
    const a = prevById.get(b.id);
    if (!a) continue;
    const ai = itemsOf(a);
    for (const [ref, it] of itemsOf(b)) {
      const x = ai.get(ref);
      if (x && (x.type !== it.type || x.wireType !== it.wireType)) changed.add(ref);
    }
  }

  const graph: GraphV2 = { ...next, nodes, wires };
  if (types.length) graph.types = types;
  return {
    graph,
    diff,
    ghost: { nodes: ghostIds, items: new Set(diff.removedItems), wires: ghostWires },
    added: {
      nodes: new Set(diff.addedNodes),
      items: new Set(diff.addedItems),
      wires: new Set(next.wires.flatMap((w, i) => (prevWireKeys.has(wireKey(w)) ? [] : [`w${i}`]))),
    },
    changed,
  };
}
