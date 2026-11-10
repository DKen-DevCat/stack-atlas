/**
 * 1 つのノードの見た目を three.js / ラベルに当てる道（Viewer.applyState と、2 面の地図の脈動が終わった画面の枠を戻すときの両方。
 * docs/20 §7.7）。順は 見た目（ラベルの見た目の class と、枠・箱の色と不透明度）→ 差分の印 → キャッシュの輪 → 始点の印。
 * ラベルのほかの class（LOD の lod-dot・lod-hide）は触らない
 */
import type { NodeVisualState } from '../state';
import { applyDiffMark } from './diff';
import { markStart } from './mapFlow';
import { setNodeObjectVisible, setNodeVisual, type SceneNode } from './nodes';

export interface PaintOptions {
  /** 差分の印を当てる（前の graph と比べているとき） */
  diff: boolean;
  /** 始点（白い輪）のノード。null は始点の印を使わない（3D だけのページ） */
  starts: ReadonlySet<string> | null;
}

export function paintNode(sn: SceneNode, nv: NodeVisualState, o: PaintOptions): void {
  setNodeObjectVisible(sn, nv.visible);
  setNodeVisual(sn, nv.visual);
  if (o.diff) applyDiffMark(sn, nv.diff);
  if (sn.ring) {
    sn.ring.visible = nv.ringVisible;
    sn.ring.material.opacity = nv.ringOpacity;
  }
  if (o.starts) markStart(sn, o.starts.has(sn.m.id));
}
