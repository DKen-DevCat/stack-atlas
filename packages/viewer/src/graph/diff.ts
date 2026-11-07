/**
 * 2 つの graph.json の差分（docs/09 §3.5 の `?prev=`）。
 * `packages/core/src/diff.ts` の diffGraphs と同じ規則（比較するフィールドは file / kind / layer / name / cache.badge、
 * エッジは from・to・kind の組で同一視）。ビューアは Node 専用コードを含む core に依存しないので、ここに小さく再実装する。
 */
import type { Edge, Graph, GraphNode } from '@stack-atlas/schema';

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

export const edgeKey = (e: Pick<Edge, 'from' | 'to' | 'kind'>) =>
  `${e.from}\u0000${e.to}\u0000${e.kind}`;

const COMPARED: Array<[string, (n: GraphNode) => unknown]> = [
  ['file', (n) => n.file],
  ['kind', (n) => n.kind],
  ['layer', (n) => n.layer],
  ['name', (n) => n.name],
  ['cache.badge', (n) => n.cache?.badge],
];

/** 変わったフィールドの日本語名（パネル・ツールチップ用） */
export const FIELD_LABELS: Readonly<Record<string, string>> = {
  file: 'ファイル',
  kind: '種類',
  layer: '層',
  name: '名前',
  'cache.badge': 'キャッシュ',
};

/** 変更ノードの説明（「名前: B → B2・ファイル: — → b.ts」） */
export function describeChange(
  prev: GraphNode | undefined,
  next: GraphNode | undefined,
  fields: readonly string[],
): string {
  const fmt = (v: unknown) => (v === undefined || v === null || v === '' ? '—' : String(v));
  return fields
    .map((f) => {
      const get = COMPARED.find(([k]) => k === f)?.[1];
      const label = FIELD_LABELS[f] ?? f;
      if (!get) return label;
      return `${label}: ${fmt(prev && get(prev))} → ${fmt(next && get(next))}`;
    })
    .join('・');
}

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

/** トップバーのピルの文言「差分 +A −R ~C」（ノード数） */
export function diffPillText(d: GraphDiff): string {
  return `差分 +${d.addedNodes.length} −${d.removedNodes.length} ~${d.changedNodes.length}`;
}

/** ピルのツールチップ（エッジの増減も含める） */
export function diffPillTitle(d: GraphDiff): string {
  return (
    `前回の graph.json との差分: ノード 追加 ${d.addedNodes.length}・削除 ${d.removedNodes.length}・変更 ${d.changedNodes.length}、` +
    `エッジ 追加 ${d.addedEdges.length}・削除 ${d.removedEdges.length}。クリックで色分けを切り替え`
  );
}

/** 描画用に引きやすくした差分（state.ts の computeVisuals が使う） */
export interface DiffMarks {
  added: ReadonlySet<string>;
  changed: ReadonlyMap<string, string[]>;
}

export function diffMarks(d: GraphDiff): DiffMarks {
  return {
    added: new Set(d.addedNodes),
    changed: new Map(d.changedNodes.map((c) => [c.id, c.fields])),
  };
}
