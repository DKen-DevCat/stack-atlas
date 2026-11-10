/**
 * 抽出器の出力（PartialGraph）のマージ（docs/09 §3.2）。
 * - ノード: id ごとに deep merge。先に出た値を残し、後続の抽出器は欠けているフィールドを埋める。
 *   配列は連結して重複排除（`screen.regions` は ref+x+y、`cache.rules` は値、`meta.extractors` は和集合で出現順）
 * - エッジ: (from, to, kind) で重複排除。label は最初に label を持っていたものを使う
 * - 層: 同じ id は最初の定義を使う。順番は出現順
 * - フロー: 同じ id は最初の定義を使う
 * - kinds: kind ごとにフィールド単位でマージ（先に出た値を残す）
 * - v2（言語アダプタの部分グラフ。docs/17 §3.1）: 箱は id で口・項目を合わせ、線は (from, to)、型は id で重複排除
 */
import type { Edge, Flow, Layer } from '@stack-atlas/schema';
import type { KindDefinition, PartialGraph, PartialNode } from './types.js';
import { clone, deepMerge } from './util.js';
import { mergePartialV2 } from './v2-parts.js';

export const edgeKey = (e: Pick<Edge, 'from' | 'to' | 'kind'>) =>
  `${e.from}\u0000${e.to}\u0000${e.kind}`;

export function mergeNodes(a: PartialNode, b: PartialNode): PartialNode {
  return deepMerge(a, b, { prefer: 'target' });
}

export function mergePartialGraphs(parts: PartialGraph[]): PartialGraph {
  const layers = new Map<string, Layer>();
  const nodes = new Map<string, PartialNode>();
  const edges = new Map<string, Edge>();
  const flows = new Map<string, Flow>();
  let hasLayers = false;
  let hasFlows = false;
  let kinds: Record<string, KindDefinition> | undefined;

  for (const part of parts) {
    if (part.layers) hasLayers = true;
    for (const l of part.layers ?? []) if (!layers.has(l.id)) layers.set(l.id, clone(l));

    for (const n of part.nodes) {
      const prev = nodes.get(n.id);
      nodes.set(n.id, prev ? mergeNodes(prev, n) : clone(n));
    }

    for (const e of part.edges) {
      const k = edgeKey(e);
      const prev = edges.get(k);
      if (!prev) edges.set(k, clone(e));
      else if (prev.label === undefined && e.label !== undefined) prev.label = e.label;
    }

    if (part.flows) hasFlows = true;
    for (const f of part.flows ?? []) if (!flows.has(f.id)) flows.set(f.id, clone(f));

    for (const [k, def] of Object.entries(part.kinds ?? {})) {
      kinds ??= {};
      kinds[k] = { ...clone(def), ...(kinds[k] ?? {}) };
    }
  }

  const out: PartialGraph = { nodes: [...nodes.values()], edges: [...edges.values()] };
  if (hasLayers) out.layers = [...layers.values()];
  if (hasFlows) out.flows = [...flows.values()];
  if (kinds) out.kinds = kinds;
  const v2 = mergePartialV2(parts.map((p) => p.v2));
  if (v2) out.v2 = v2;
  return out;
}
