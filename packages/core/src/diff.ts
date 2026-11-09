/**
 * 2 つの graph.json の差分（docs/09 §3.5、`stack-atlas diff` とビューアの `?prev=`）。
 * v1 はノードとエッジ（diffGraphs）、v2 は箱・線・型・項目（diffGraphsV2）で比べる
 */
import type { Edge, Graph, GraphNode, GraphV2, ItemV2, NodeV2, WireV2 } from '@stack-atlas/schema';
import { edgeKey } from './merge.js';

export interface NodeChange {
  id: string;
  /** 変わったフィールド。`file` `kind` `layer` `name` `cache.badge` のいずれか */
  fields: string[];
}

export interface GraphDiff {
  addedNodes: string[];
  removedNodes: string[];
  addedEdges: Edge[];
  removedEdges: Edge[];
  changedNodes: NodeChange[];
}

const COMPARED: Array<[string, (n: GraphNode) => unknown]> = [
  ['file', (n) => n.file],
  ['kind', (n) => n.kind],
  ['layer', (n) => n.layer],
  ['name', (n) => n.name],
  ['cache.badge', (n) => n.cache?.badge],
];

export function diffGraphs(
  prev: Pick<Graph, 'nodes' | 'edges'>,
  next: Pick<Graph, 'nodes' | 'edges'>,
): GraphDiff {
  const p = new Map(prev.nodes.map((n) => [n.id, n]));
  const q = new Map(next.nodes.map((n) => [n.id, n]));
  const pe = new Map(prev.edges.map((e) => [edgeKey(e), e]));
  const qe = new Map(next.edges.map((e) => [edgeKey(e), e]));
  const changedNodes: NodeChange[] = [];
  for (const [id, b] of q) {
    const a = p.get(id);
    if (!a) continue;
    const fields = COMPARED.filter(([, get]) => get(a) !== get(b)).map(([f]) => f);
    if (fields.length) changedNodes.push({ id, fields });
  }
  return {
    addedNodes: [...q.keys()].filter((id) => !p.has(id)),
    removedNodes: [...p.keys()].filter((id) => !q.has(id)),
    addedEdges: [...qe].filter(([k]) => !pe.has(k)).map(([, e]) => e),
    removedEdges: [...pe].filter(([k]) => !qe.has(k)).map(([, e]) => e),
    changedNodes,
  };
}

export function isEmptyDiff(d: GraphDiff): boolean {
  return (
    !d.addedNodes.length &&
    !d.removedNodes.length &&
    !d.addedEdges.length &&
    !d.removedEdges.length &&
    !d.changedNodes.length
  );
}

// ---- graph.json v2（docs/16 §10: 箱・線・型・項目で比べる） ----

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

/** 箱の全項目の参照（入れ子を含む） */
function itemRefs(n: NodeV2): string[] {
  const out: string[] = [];
  for (const p of n.ports) {
    const walk = (items: ItemV2[] | undefined, prefix: string) => {
      for (const it of items ?? []) {
        const path = prefix + it.id;
        out.push(`${n.id}#${p.id}/${path}`);
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
    const ai = new Set(itemRefs(a));
    const bi = new Set(itemRefs(b));
    for (const r of bi) if (!ai.has(r)) addedItems.push(r);
    for (const r of ai) if (!bi.has(r)) removedItems.push(r);
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
