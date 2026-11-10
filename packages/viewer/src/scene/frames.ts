// 描く・描かないの規則（docs/20 §5.1 #10、Phase 8-6）: 3D は止まっている間は描かない。three.js に触らない（単体テストできる）。
// 動いているもの（カメラの寄せ・OrbitControls の慣性・層の展開・旧フロー・キャッシュの輪・地図の球）があれば毎フレーム描いて次のフレームも頼み、
// 何も動いていなければ、見た目が変わったとき（dirty）だけ 1 回描いて止まる。隠した面（2 面の狭い画面）は描かない

export interface FrameState {
  /** 見た目・大きさ・テクスチャが変わった（1 回描けばよい） */
  dirty: boolean;
  /** カメラの寄せ・リセットの途中 */
  camera: boolean;
  /** OrbitControls が動いた（操作中・慣性） */
  controls: boolean;
  /** 層の展開・重ねるの途中 */
  explode: boolean;
  /** 旧フロー（flows.yaml。3D の地図だけのページ） */
  flow: boolean;
  /** キャッシュの輪の脈動 */
  cache: boolean;
  /** 地図の球・脈動が動いている（D106。配線図の再生中） */
  mapFlow: boolean;
  /** 面が隠れている */
  hidden: boolean;
}

export interface FramePlan {
  /** このフレームで描く */
  render: boolean;
  /** 次のフレームも頼む */
  next: boolean;
}

export function framePlan(s: FrameState): FramePlan {
  if (s.hidden) return { render: false, next: false };
  const moving = s.camera || s.controls || s.explode || s.flow || s.cache || s.mapFlow;
  return { render: moving || s.dirty, next: moving };
}
