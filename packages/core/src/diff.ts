/** 2 つの graph.json の差分（docs/09 §3.5、`stack-atlas diff` とビューアの `?prev=`） */
import type { Edge, Graph, GraphNode } from '@stack-atlas/schema';
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
