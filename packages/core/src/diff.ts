/**
 * 2 つの graph.json の差分（docs/09 §3.5、`stack-atlas diff` とビューアの `?prev=`）。
 * v1 はノードとエッジ（diffGraphs）、v2 は箱・線・型・項目（diffGraphsV2）で比べる。
 * 2026-11-09（8-3c）: v2 の差分は @stack-atlas/wiring に移した（ビューアの配線図も使う。ビューアは core に依存しない。D44）。
 * ここは再 export して、core の公開 API は変えない
 */
import type { Edge, Graph, GraphNode } from '@stack-atlas/schema';
import type { NodeChange } from '@stack-atlas/wiring';
import { edgeKey } from './merge.js';

export {
  diffGraphsV2,
  isEmptyDiffV2,
  type GraphDiffV2,
  type NodeChange,
  type WireRef,
  type WireChange,
} from '@stack-atlas/wiring';

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
