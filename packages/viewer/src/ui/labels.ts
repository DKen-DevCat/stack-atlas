/** ノードのラベル（CSS2D で 3D 空間に貼る HTML）と、ラベルの出し方（LOD）の規則 */
import type { ModelNode } from '../graph/model';
import { LABEL_LOD_NODES, type LabelMode, type NodeVisual } from '../state';
import { h } from './dom';

export function makeNodeLabel(n: ModelNode): { el: HTMLDivElement; memoBadge: HTMLSpanElement } {
  const memoBadge = h('span', { class: 'memo' });
  const C = n.node.cache;
  const el = h(
    'div',
    { class: 'nl', attrs: { 'data-id': n.id }, style: `--kc:${n.kind.color}` },
    h('span', { class: 'k' }, n.node.kind),
    n.node.name,
    memoBadge,
    C ? h('span', { class: `cb ${C.tone}` }, C.badge) : null,
  );
  return { el, memoBadge };
}

/**
 * 1 つのラベルの出し方。
 * - full: 通常どおり
 * - dot: 名前を畳んで小さな点にする（遠くにある・数が多いとき）
 * - hidden: 出さない
 */
export type LabelDisplay = 'full' | 'dot' | 'hidden';

/** ラベルを点にするカメラ距離（プロトタイプの大きさ = sceneScale 1 のとき）。視点リセット位置（約 53）では点、少し寄ると出る */
export const LABEL_LOD_DISTANCE = 45;

export interface LabelContext {
  /** 「ラベル」の設定 */
  mode: LabelMode;
  /** ハイライトの対象・関連（sel / down / up / flow）か */
  visual: NodeVisual;
  /** いつもラベルを出す層（インフラ・画面）のノードか */
  alwaysLayer: boolean;
  /** シーンの大きさ（sceneScaleFor）。距離の閾値に掛ける */
  sceneScale: number;
}

/** ハイライトの対象・関連として常にラベルを出す見た目 */
const KEEP: ReadonlySet<NodeVisual> = new Set(['sel', 'down', 'up', 'flow']);

/**
 * ラベルの LOD 規則（純関数）。
 * - ハイライト中のノード（対象・依存先・影響範囲・フロー）はどの設定でも出す
 * - 「なし」: それ以外は出さない
 * - 「関連のみ」: インフラ・画面の層だけ出す
 * - 「すべて」: ノード数が LABEL_LOD_NODES を超え、カメラから遠い（LABEL_LOD_DISTANCE × sceneScale）
 *   ラベルは点にする。インフラ・画面の層は常に出す
 */
export function labelMode(nodeCount: number, distance: number, ctx: LabelContext): LabelDisplay {
  if (KEEP.has(ctx.visual)) return 'full';
  if (ctx.mode === 'none') return 'hidden';
  if (ctx.alwaysLayer) return 'full';
  if (ctx.mode === 'related') return 'hidden';
  if (nodeCount > LABEL_LOD_NODES && distance > LABEL_LOD_DISTANCE * ctx.sceneScale) return 'dot';
  return 'full';
}

/** ラベル要素にクラスを反映する（変わったときだけ触る） */
export function applyLabelDisplay(el: HTMLElement, d: LabelDisplay): void {
  const dot = d === 'dot';
  const hidden = d === 'hidden';
  if (el.classList.contains('lod-dot') !== dot) el.classList.toggle('lod-dot', dot);
  if (el.classList.contains('lod-hide') !== hidden) el.classList.toggle('lod-hide', hidden);
}

/** いつもラベルを出す層: 画面ノードのある層とその上（インフラ）。画面がなければ最上段だけ */
export function alwaysLabelLayers(nodes: readonly ModelNode[]): ReadonlySet<number> {
  let last = 0;
  for (const n of nodes) if (n.isScreen) last = Math.max(last, n.layerIndex);
  const out = new Set<number>();
  for (let i = 0; i <= last; i++) out.add(i);
  return out;
}

export { LABEL_LOD_NODES };
