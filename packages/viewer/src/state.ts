/**
 * 表示状態（ホバー・選択・検索・フロー・キャッシュ・展開・層と kind の表示・ラベル）と、そこから決まる見た目。
 * 優先順位はここ（computeVisuals）の 1 か所で決める:
 *
 * - 見た目: 「検索の一致 ＞ ホバー／選択のハイライト ＞ フロー ＞ キャッシュ ＞ 差分 ＞ 通常」。
 *   検索中は一致ノードが `sel`、ホバー中の依存先・影響範囲は `down` / `up`、それ以外は `dim`
 *   （検索はホバーと同じ「ハイライト」の扱いで、ホバーより上に乗る）。
 * - 表示／非表示: 層チップ（layerVisible）と kind チップ（kindVisible）はどちらも同じ扱いで、
 *   ノードは両方がオンのときだけ描き、エッジは両端が描かれるときだけ描く。
 *
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
  /** kind チップで隠した kind（無いものは表示） */
  kindVisible: Record<string, boolean>;
  /** 検索に一致したノード id。null なら検索していない（空の一致は Set() で「0 件」） */
  searchMatches: ReadonlySet<string> | null;
  /** ラベルの出し方（docs/05）。all = すべて、related = 関連のみ、none = なし */
  labelMode: LabelMode;
}

export type LabelMode = 'all' | 'related' | 'none';

/** これを超えるノード数ではラベルの既定を「関連のみ」にし、遠いラベルを点にする */
export const LABEL_LOD_NODES = 80;

export function defaultLabelMode(nodeCount: number): LabelMode {
  return nodeCount > LABEL_LOD_NODES ? 'related' : 'all';
}

export function initialState(layerCount: number, nodeCount = 0): ViewState {
  return {
    hoverId: null,
    selectedId: null,
    flowId: null,
    cacheOn: false,
    diffOn: true,
    explodeTarget: 1,
    layerVisible: Array.from({ length: layerCount }, () => true),
    kindVisible: {},
    searchMatches: null,
    labelMode: defaultLabelMode(nodeCount),
  };
}

/** 層と kind の両方で表示されているか */
export function isNodeShown(state: ViewState, n: { layerIndex: number; node: { kind: string } }) {
  return (state.layerVisible[n.layerIndex] ?? true) && (state.kindVisible[n.node.kind] ?? true);
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
  const search = state.searchMatches;
  const diffShown = !!diff && state.diffOn;
  // 差分の色分けはハイライト・検索・フロー・キャッシュがないときだけ
  const diffActive = diffShown && !hl.a && !search && !flowSet && !state.cacheOn;

  const nodes = new Map<string, NodeVisualState>();
  for (const n of model.nodes) {
    const visible = isNodeShown(state, n);
    let visual: NodeVisual = 'normal';
    if (search) {
      visual = search.has(n.id)
        ? 'sel'
        : hl.a && (n.id === hl.a || hl.down.has(n.id))
          ? 'down'
          : hl.a && hl.up.has(n.id)
            ? 'up'
            : 'dim';
    } else if (hl.a) {
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
    const visible = !!fromN && !!toN && isNodeShown(state, fromN) && isNodeShown(state, toN);
    const base = edgeBaseStyle(model, e);
    if (search && !hl.a) {
      const both = search.has(e.from) && search.has(e.to);
      return { visible, color: base.color, opacity: both ? base.opacity : 0.05 };
    }
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
    : hl.a || search
      ? 0.06
      : flowSet || state.cacheOn
        ? 0.1
        : GHOST_OPACITY;
  return { hl, nodes, edges, ghostOpacity };
}
