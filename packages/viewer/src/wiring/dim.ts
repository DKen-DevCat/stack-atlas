// 沈める表現の係数（docs/18 §11.5、D117）。style.css の「沈める表現」の区画と同じ値（dim.test.ts が CSS と突き合わせる）。
// 要素の opacity は使わず、塗りの不透明度（fill-opacity / stroke-opacity）で沈める。塗りの不透明度は入れ子で掛け算に
// ならないので、箱の係数 × 項目の係数を CSS の変数（--bo・--io）と calc() で出す。ここはその「今の積」の正
export const DIM = {
  /** 選択中の光らない箱・host の枠（幽霊も）。画面の iframe も同じ値 */
  box: 0.15,
  /** 選択中の光らない項目（光る箱の中でも） */
  itemOff: 0.35,
  /** 今の分岐に無い項目（選択に関係なく） */
  itemInactive: 0.2,
  /** 線（選択なし） */
  wire: 0.35,
  wireInactive: 0.1,
  wireGhost: 0.6,
  wireAdded: 0.75,
  /** 線（選択中の沈んだ線。幽霊も） */
  wireSel: 0.12,
  wireSelInactive: 0.1,
  wireSelAdded: 0.15,
  /** 切れた線のうち光らないもの（選択中、送り側の箱が光らない） */
  brokenOff: 0.6,
} as const;

/** 箱の係数（--bo）: 選択中の光らない箱だけ沈む */
export function boxFactor(s: { hasSel: boolean; lit: boolean }): number {
  return s.hasSel && !s.lit ? DIM.box : 1;
}

/** 項目の係数（--io）: 今の分岐に無ければ 0.2、選択中に光らなければ 0.35（幽霊の項目は沈めない） */
export function itemFactor(s: {
  hasSel: boolean;
  on: boolean;
  inactive: boolean;
  ghost: boolean;
}): number {
  if (s.ghost) return 1;
  if (s.inactive) return DIM.itemInactive;
  return s.hasSel && !s.on ? DIM.itemOff : 1;
}

/** 項目の実効の不透明度 = 箱の係数 × 項目の係数（要素の opacity の入れ子だったときの積と同じ） */
export function itemOpacity(s: {
  hasSel: boolean;
  boxLit: boolean;
  on: boolean;
  inactive: boolean;
  ghost: boolean;
}): number {
  return boxFactor({ hasSel: s.hasSel, lit: s.boxLit }) * itemFactor(s);
}

/** 基の線（細い線）の不透明度。今だけ（added）は inactive より優先、選択中の幽霊はほかの沈んだ線と同じ */
export function wireOpacity(s: {
  hasSel: boolean;
  inactive: boolean;
  ghost: boolean;
  added: boolean;
}): number {
  if (s.hasSel) return s.added ? DIM.wireSelAdded : s.inactive ? DIM.wireSelInactive : DIM.wireSel;
  if (s.added) return DIM.wireAdded;
  if (s.ghost) return DIM.wireGhost;
  return s.inactive ? DIM.wireInactive : DIM.wire;
}

/** 切れた線の不透明度（光る = 選択が無いか、送り側の箱が光る） */
export function brokenOpacity(s: { lit: boolean }): number {
  return s.lit ? 1 : DIM.brokenOff;
}
