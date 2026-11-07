/**
 * 層の割り当て（docs/09 §3.2）。
 * - 層の一覧 = `config.layers ?? DEFAULT_LAYERS`。抽出器が出した層のうち、そこに無い id は末尾に足す
 * - layer が無いノードは `layerOf[kind]`（`{...DEFAULT_LAYER_OF, ...kinds[k].layer, ...config.layerOf}`）
 * - kind が layerOf に無ければ警告を出して最後の層に置く
 * - layers に無い層 id を指しているノードはエラー
 */
import type { Layer, ValidationIssue } from '@stack-atlas/schema';
import {
  DEFAULT_LAYERS,
  DEFAULT_LAYER_OF,
  type PartialGraph,
  type StackAtlasConfig,
} from './types.js';
import { clone, issue } from './util.js';

export interface AssignLayersResult {
  graph: PartialGraph & { layers: Layer[] };
  issues: ValidationIssue[];
}

export function resolveLayers(graph: PartialGraph, config: StackAtlasConfig): Layer[] {
  const base = clone(config.layers?.length ? config.layers : DEFAULT_LAYERS);
  const ids = new Set(base.map((l) => l.id));
  for (const l of graph.layers ?? []) {
    if (!ids.has(l.id)) {
      base.push(clone(l));
      ids.add(l.id);
    }
  }
  return base;
}

/** kind → layer.id（既定 → config.kinds[k].layer → config.layerOf の順に上書き） */
export function resolveLayerOf(config: StackAtlasConfig): Record<string, string> {
  const fromKinds: Record<string, string> = {};
  for (const [k, def] of Object.entries(config.kinds ?? {})) {
    if (def && typeof def.layer === 'string') fromKinds[k] = def.layer;
  }
  return { ...DEFAULT_LAYER_OF, ...fromKinds, ...(config.layerOf ?? {}) };
}

export function assignLayers(graph: PartialGraph, config: StackAtlasConfig): AssignLayersResult {
  const layers = resolveLayers(graph, config);
  const layerIds = new Set(layers.map((l) => l.id));
  const layerOf = resolveLayerOf(config);
  const last = layers[layers.length - 1]!;
  const issues: ValidationIssue[] = [];

  const nodes = graph.nodes.map((n0, i) => {
    const n = clone(n0);
    if (!n.layer) {
      const mapped = n.kind !== undefined ? layerOf[n.kind] : undefined;
      if (mapped) n.layer = mapped;
      else {
        n.layer = last.id;
        issues.push(
          issue(
            'warning',
            `/nodes/${i}/layer`,
            `ノード "${n.id}" の kind "${n.kind ?? '(なし)'}" に対応する層がありません。最後の層 "${last.id}" に置きます（config.layerOf で指定できます）`,
          ),
        );
      }
    }
    if (!layerIds.has(n.layer)) {
      issues.push(
        issue(
          'error',
          `/nodes/${i}/layer`,
          `ノード "${n.id}" の層 "${n.layer}" が layers にありません（候補: ${[...layerIds].join(', ')}）`,
        ),
      );
    }
    return n;
  });

  return { graph: { ...clone(graph), layers, nodes }, issues };
}
