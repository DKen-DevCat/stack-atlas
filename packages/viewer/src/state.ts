/**
 * 表示状態（ホバー・選択・フロー・キャッシュ・展開・層の表示）と、そこから決まる見た目。
 * 優先順位「ハイライト ＞ フロー ＞ キャッシュ ＞ 差分 ＞ 通常」はここ（computeVisuals）の 1 か所で決める。
 * three.js・DOM に依存しない純関数。
 */
import type { Edge } from '@stack-atlas/schema';
import type { DiffMarks } from './graph/diff';
import { computeHighlight, edgeHighlight, type Highlight } from './graph/closure';
import { edgeKindStyle } from './graph/kinds';
import type { GraphModel } from './graph/model';

export interface ViewState {
  hoverId: string | null;
  selectedId: string | null;
  flowId: string | null;
  cacheOn: boolean;
  /** 差分の色分け（?prev= があるときだけ意味を持つ） */
  diffOn: boolean;
  /** 0 = 重ねる、1 = 展開（目標値） */
  explodeTarget: number;
  /** layers と同じ長さ */
  layerVisible: boolean[];
}

export function initialState(layerCount: number): ViewState {
  return {
    hoverId: null,
    selectedId: null,
    flowId: null,
    cacheOn: false,
    diffOn: true,
    explodeTarget: 1,
    layerVisible: Array.from({ length: layerCount }, () => true),
  };
}

export type NodeVisual = 'normal' | 'sel' | 'down' | 'up' | 'dim' | 'flow' | 'soft';

export interface NodeVisualState {
  visual: NodeVisual;
  visible: boolean;
  ringVisible: boolean;
  ringOpacity: number;
  /** 差分の印（追加・変更）。上位の表示（ハイライト・フロー・キャッシュ）があるときや差分オフのときは null */
  diff: 'added' | 'changed' | null;
}

export interface EdgeVisualState {
  visible: boolean;
  color: string;
  opacity: number;
}

export interface Visuals {
  hl: Highlight;
  nodes: Map<string, NodeVisualState>;
  /** model.edges と同じ順番 */
  edges: EdgeVisualState[];
  /** 削除ノード（ゴースト）・削除エッジ（破線）の不透明度。0 なら隠す */
  ghostOpacity: number;
}

/** ゴースト（削除ノード）の通常時の不透明度 */
export const GHOST_OPACITY = 0.25;

export const HIGHLIGHT_COLORS = { down: '#ff3b3b', up: '#ff8a5c' } as const;

/** エッジの通常時の色。層またぎは上の層の色（不透明度 .55）、層内は kind 別 */
export function edgeBaseStyle(model: GraphModel, e: Edge): { color: string; opacity: number } {
  const a = model.byId.get(e.from);
  const b = model.byId.get(e.to);
  if (a && b && a.layerIndex !== b.layerIndex) {
    const upper = model.layers[Math.min(a.layerIndex, b.layerIndex)];
    return { color: upper?.color ?? '#9ca3af', opacity: 0.55 };
  }
  return edgeKindStyle(e.kind);
}

export function highlightTarget(state: ViewState): string | null {
  return state.hoverId ?? state.selectedId;
}

export function computeVisuals(
  model: GraphModel,
  state: ViewState,
  diff: DiffMarks | null = null,
): Visuals {
  const a = highlightTarget(state);
  const hl = computeHighlight(model, a);
  const flow = state.flowId ? model.flows.find((f) => f.id === state.flowId) : undefined;
  const flowSet = flow ? new Set(flow.steps.map((s) => s.node)) : null;
  const layerOn = (i: number) => state.layerVisible[i] ?? true;
  const diffShown = !!diff && state.diffOn;
  // 差分の色分けはハイライト・フロー・キャッシュがないときだけ
  const diffActive = diffShown && !hl.a && !flowSet && !state.cacheOn;

  const nodes = new Map<string, NodeVisualState>();
  for (const n of model.nodes) {
    const visible = layerOn(n.layerIndex);
    let visual: NodeVisual = 'normal';
    if (hl.a) {
      visual = n.id === hl.a ? 'sel' : hl.down.has(n.id) ? 'down' : hl.up.has(n.id) ? 'up' : 'dim';
    } else if (flowSet) {
      visual = flowSet.has(n.id) ? 'flow' : 'dim';
    } else if (state.cacheOn) {
      visual = n.node.cache ? 'normal' : 'soft';
    }
    nodes.set(n.id, {
      visual,
      visible,
      ringVisible: state.cacheOn && visible && !!n.node.cache,
      ringOpacity: visual === 'dim' || visual === 'soft' ? 0.15 : 0.85,
      diff: !diffActive
        ? null
        : diff!.added.has(n.id)
          ? 'added'
          : diff!.changed.has(n.id)
            ? 'changed'
            : null,
    });
  }

  const edges = model.edges.map((e): EdgeVisualState => {
    const fromN = model.byId.get(e.from);
    const toN = model.byId.get(e.to);
    const visible = !!fromN && !!toN && layerOn(fromN.layerIndex) && layerOn(toN.layerIndex);
    const base = edgeBaseStyle(model, e);
    if (hl.a) {
      const h = edgeHighlight(hl, e);
      if (h === 'down') return { visible, color: HIGHLIGHT_COLORS.down, opacity: 1 };
      if (h === 'up') return { visible, color: HIGHLIGHT_COLORS.up, opacity: 0.9 };
      return { visible, color: base.color, opacity: 0.05 };
    }
    const k = flowSet ? 0.35 : state.cacheOn ? 0.5 : 1;
    return { visible, color: base.color, opacity: base.opacity * k };
  });

  const ghostOpacity = !diffShown
    ? 0
    : hl.a
      ? 0.06
      : flowSet || state.cacheOn
        ? 0.1
        : GHOST_OPACITY;
  return { hl, nodes, edges, ghostOpacity };
}
