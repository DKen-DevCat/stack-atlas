/**
 * GraphModel: graph.json を描画・ハイライト用に引きやすくしたもの。
 * DOM・three.js に依存しない純粋なデータ構造。
 *
 * 参照エラー（未知の層、存在しないノードを指すエッジ・region・flow step）があっても
 * 壊れないよう、たどれないものは取り除いてから組み立てる（docs/08 D7）。
 */
import type { Edge, Flow, Graph, GraphNode, Layer, Region, Screen } from '@stack-atlas/schema';
import { kindMeta, SCREEN_KINDS, type KindMeta } from './kinds';

/** 画面テクスチャの基準サイズ（プレースホルダ用の screen もこの大きさ） */
export const SCREEN_BASE_WIDTH = 768;
export const SCREEN_BASE_HEIGHT = 480;

export interface ModelNode {
  id: string;
  node: GraphNode;
  layerIndex: number;
  kind: KindMeta;
  /** screen フィールドがある、または kind が page / layout */
  isScreen: boolean;
  /** 画面ノードの screen。screen がない page / layout には regions なしのプレースホルダを入れる */
  screen?: Screen;
  /** 有効な（参照先の存在する）regions */
  regions: Region[];
  /** このノードから出るエッジ（from がこのノード） */
  out: Edge[];
  /** このノードに入るエッジ（to がこのノード） */
  inn: Edge[];
}

export interface GraphModel {
  graph: Graph;
  layers: Layer[];
  nodes: ModelNode[];
  byId: ReadonlyMap<string, ModelNode>;
  /** 両端が存在するエッジだけ */
  edges: Edge[];
  /** 存在するノードのステップだけを残し、2 ステップ以上あるフロー */
  flows: Flow[];
}

export function isScreenNode(n: GraphNode): boolean {
  return !!n.screen || SCREEN_KINDS.has(n.kind);
}

export function buildModel(graph: Graph): GraphModel {
  const layers = graph.layers;
  const layerIndex = new Map<string, number>();
  layers.forEach((l, i) => {
    if (!layerIndex.has(l.id)) layerIndex.set(l.id, i);
  });

  const byId = new Map<string, ModelNode>();
  const nodes: ModelNode[] = [];
  for (const n of graph.nodes) {
    const li = layerIndex.get(n.layer);
    if (li === undefined || byId.has(n.id)) continue;
    const isScreen = isScreenNode(n);
    const m: ModelNode = {
      id: n.id,
      node: n,
      layerIndex: li,
      kind: kindMeta(n.kind),
      isScreen,
      regions: [],
      out: [],
      inn: [],
    };
    if (isScreen) {
      m.screen = n.screen ?? { width: SCREEN_BASE_WIDTH, height: SCREEN_BASE_HEIGHT, regions: [] };
    }
    byId.set(n.id, m);
    nodes.push(m);
  }

  for (const m of nodes) {
    m.regions = (m.screen?.regions ?? []).filter((r) => byId.has(r.ref));
  }

  const edges = graph.edges.filter((e) => byId.has(e.from) && byId.has(e.to));
  for (const e of edges) {
    byId.get(e.from)!.out.push(e);
    byId.get(e.to)!.inn.push(e);
  }

  const flows = (graph.flows ?? [])
    .map((f) => ({ ...f, steps: f.steps.filter((s) => byId.has(s.node)) }))
    .filter((f) => f.steps.length >= 2);

  return { graph, layers, nodes, byId, edges, flows };
}
