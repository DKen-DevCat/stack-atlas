// 開いた直後の倍率と全体表示（docs/18 §3.2）。DOM に触らない（単体テストできる）。
// 全体が倍率 0.6 以上で収まるなら全体を、収まらないなら倍率 0.6（項目の文字が 6px）で画面の箱（無ければ左上の箱）の
// あたりを映す。全体を見たいときはホイールで縮小するか `F` キー
import type { GraphIndex, Rect, WiringLayout } from '@stack-atlas/wiring';

export interface View {
  k: number;
  tx: number;
  ty: number;
}

/** 表示の枠（stage の大きさ）と、上端の帯の高さ（全体表示で避ける） */
export interface Viewport {
  width: number;
  height: number;
  top: number;
}

export const K_MIN = 0.1;
export const K_MAX = 4;
/** 項目の名前の文字の大きさ（style.css の `.wv .item text`。整合はテストで確かめる） */
export const ITEM_FONT_PX = 10;
/** 開いた直後に読める文字の大きさ */
export const MIN_TEXT_PX = 6;
/** 開いた直後の倍率の下限（項目の文字が MIN_TEXT_PX になる倍率） */
export const READABLE_K = MIN_TEXT_PX / ITEM_FONT_PX;
/** 全体表示の左右の余白と、下端の余白（再生バーを避ける） */
const SIDE = 20;
const BOTTOM = 36;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** 全体が収まる倍率で中央に置く */
export function fitView(vp: Viewport, size: { w: number; h: number }): View {
  if (vp.width <= 0 || vp.height <= 0 || size.w <= 0 || size.h <= 0) return { k: 1, tx: 0, ty: 0 };
  const k = clamp(
    Math.min((vp.width - 2 * SIDE) / size.w, (vp.height - vp.top - BOTTOM) / size.h),
    K_MIN,
    K_MAX,
  );
  return {
    k,
    tx: (vp.width - size.w * k) / 2,
    ty: vp.top + (vp.height - vp.top - size.h * k) / 2,
  };
}

/**
 * 開いた直後の表示。全体が READABLE_K 以上で収まるなら全体、収まらないなら READABLE_K で focus の中心を画面の中央に
 * 寄せる（図の外の空白を映さないよう、図の端で止める）
 */
export function openingView(
  vp: Viewport,
  size: { w: number; h: number },
  focus: Rect | null,
): View {
  const fit = fitView(vp, size);
  if (fit.k >= READABLE_K || vp.width <= 0 || vp.height <= 0) return fit;
  const k = READABLE_K;
  const cx = focus ? focus.x + focus.w / 2 : 0;
  const cy = focus ? focus.y + focus.h / 2 : 0;
  const axis = (center: number, extent: number, lo: number, hi: number) => {
    const want = (lo + hi) / 2 - center * k;
    const min = hi - extent * k; // 図の右端・下端が枠の右端・下端に来る位置
    const max = lo; // 図の左端・上端が枠の左端・上端に来る位置
    return min > max ? (lo + hi - extent * k) / 2 : clamp(want, min, max);
  };
  return {
    k,
    tx: axis(cx, size.w, SIDE, vp.width - SIDE),
    ty: axis(cy, size.h, vp.top, vp.height - BOTTOM),
  };
}

/** 開いた直後に映す箱: graph の宣言の順で最初の画面の箱。無ければ左上の箱（いちばん左の列のいちばん上） */
export function openingFocus(index: GraphIndex, layout: WiringLayout): Rect | null {
  for (const n of index.graph.nodes) {
    if (n.kind !== 'screen') continue;
    const b = layout.boxes.get(n.id);
    if (b) return b;
  }
  let best: Rect | null = null;
  for (const b of layout.boxes.values())
    if (!best || b.x < best.x || (b.x === best.x && b.y < best.y)) best = b;
  return best;
}
