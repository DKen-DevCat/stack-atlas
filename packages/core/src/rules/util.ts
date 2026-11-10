import type { Cache, Graph, GraphNode } from '@stack-atlas/schema';

/** note に行を足す（同じ文がすでにあれば足さない） */
export function appendNote(cache: Cache, line: string): void {
  if (!cache.note) cache.note = line;
  else if (!cache.note.split('\n').includes(line)) cache.note = `${cache.note}\n${line}`;
}

export function incoming(graph: Graph, id: string, kind: string): GraphNode[] {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  return graph.edges
    .filter((e) => e.to === id && e.kind === kind)
    .map((e) => byId.get(e.from))
    .filter((n): n is GraphNode => n !== undefined);
}
