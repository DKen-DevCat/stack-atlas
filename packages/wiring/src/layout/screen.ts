// 画面の箱の中の画面の領域（docs/18 §3.3）。箱の幅は通常の 2 倍（defaultWidthOf）、画面の高さはビューポートの比率。
// ビューアはこの領域に、ビルド成果物の HTML（screen.html）をビューポートの大きさの iframe で縮小して置く
import type { ScreenV2 } from '@stack-atlas/schema';
import type { IndexedNode } from '../graph-index.js';
import type { Rect } from './types.js';

/** screen が無い・値が使えないときのビューポート（screens 抽出器の既定と同じ） */
export const DEFAULT_VIEWPORT: Readonly<{ width: number; height: number }> = {
  width: 1280,
  height: 800,
};
/** ビューポートの幅・高さの範囲（graph の値が極端でも、箱と iframe が巨大にならない） */
export const VIEWPORT_MIN = 200;
export const VIEWPORT_MAX = 4096;
/** 高さ / 幅 の範囲（スマホの縦長 390×844 は 2.16） */
export const SCREEN_RATIO_MIN = 0.25;
export const SCREEN_RATIO_MAX = 2.5;
/** 画面の領域を箱の枠の内側に寄せる量（角の丸みと枠の線に iframe がはみ出さない） */
export const SCREEN_INSET = 1;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const usable = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0;

/**
 * 画面のビューポート（iframe の大きさで、計測した領域の座標系）。screen.width / height（無い・使えない値は 1280×800）を、
 * 縦 / 横 を 0.25〜2.5 に、幅と高さを 200〜4096 に収める（比を保ったまま縮める・伸ばす）。整数に丸める
 */
export function screenViewport(screen: Pick<ScreenV2, 'width' | 'height'> | undefined): {
  width: number;
  height: number;
} {
  const w0 = screen && usable(screen.width) ? screen.width : DEFAULT_VIEWPORT.width;
  const h0 = screen && usable(screen.height) ? screen.height : DEFAULT_VIEWPORT.height;
  const ratio = clamp(h0 / w0, SCREEN_RATIO_MIN, SCREEN_RATIO_MAX);
  let width = clamp(w0, VIEWPORT_MIN, VIEWPORT_MAX);
  let height = width * ratio;
  if (height > VIEWPORT_MAX) {
    width *= VIEWPORT_MAX / height;
    height = VIEWPORT_MAX;
  } else if (height < VIEWPORT_MIN) {
    width *= VIEWPORT_MIN / height;
    height = VIEWPORT_MIN;
  }
  return { width: Math.round(width), height: Math.round(height) };
}

/** 画面の HTML を持つ画面の箱か（kind screen で screen.html が空でない文字列） */
export function hasScreenHtml(n: IndexedNode): boolean {
  const html = n.node.screen?.html;
  return n.node.kind === 'screen' && typeof html === 'string' && html.length > 0;
}

/**
 * 画面の箱の中の画面の領域（箱の左上からの位置）。名前の帯（head）の下に、幅いっぱい（枠の内側）でビューポートの比率の高さ。
 * screen.html の無い箱（HTML を写していない画面・スクショだけの画面）は今までどおり項目の行だけの高さで、null
 */
export function screenArea(n: IndexedNode, boxW: number, head: number): Rect | null {
  if (!hasScreenHtml(n)) return null;
  const vp = screenViewport(n.node.screen);
  const w = Math.max(0, boxW - 2 * SCREEN_INSET);
  return { x: SCREEN_INSET, y: head, w, h: (w * vp.height) / vp.width };
}
