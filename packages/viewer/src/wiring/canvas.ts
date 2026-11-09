// 無限の平面（Figma と同じ）: ドラッグで移動、ホイール（トラックパッドの 2 本指）で移動、ctrl/⌘ ＋ ホイールとピンチで
// 拡大縮小（カーソル中心、0.1〜4 倍）。スクロールバーは無い。開いた直後は読める倍率（docs/18 §3.2。view.ts）、
// `F` キーで全体が収まる倍率
import type { Rect } from '@stack-atlas/wiring';
import { fitView, K_MAX, K_MIN, openingView, type View, type Viewport } from './view';

export type { View } from './view';

export interface Canvas {
  readonly view: View;
  /** 変換を #view の g に当てる（描き直したあとにも呼ぶ） */
  apply(): void;
  /** 全体が収まる倍率にする */
  fit(): void;
  /** 開いた直後の表示（全体が読める倍率で収まらなければ focus のあたりを読める倍率で） */
  open(focus: Rect | null): void;
  /** 直前の mousedown 〜 mouseup がドラッグだったか（クリックにしないため。読むと消える） */
  consumeDrag(): boolean;
  dispose(): void;
}

export interface CanvasOptions {
  stage: HTMLElement;
  /** 変換を当てる要素（描き直すたびに変わるので関数で渡す） */
  target: () => SVGGElement | null;
  /** 中身の大きさ */
  size: { w: number; h: number };
  /** ドラッグを始めない要素（分岐の表など） */
  ignore?: (t: EventTarget | null) => boolean;
  /** 上端の帯の高さ（全体表示で避ける） */
  top?: number;
}

export function createCanvas(opts: CanvasOptions): Canvas {
  const { stage, target, size } = opts;
  const top = opts.top ?? 44;
  const view: View = { k: 1, tx: 0, ty: 0 };
  const apply = () => {
    target()?.setAttribute('transform', `translate(${view.tx},${view.ty}) scale(${view.k})`);
  };
  const viewport = (): Viewport | null => {
    const r = stage.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0 || size.w <= 0 || size.h <= 0) return null;
    return { width: r.width, height: r.height, top };
  };
  const set = (v: View) => {
    view.k = v.k;
    view.tx = v.tx;
    view.ty = v.ty;
    apply();
  };
  const fit = () => {
    const vp = viewport();
    if (vp) set(fitView(vp, size));
  };
  const open = (focus: Rect | null) => {
    const vp = viewport();
    if (vp) set(openingView(vp, size, focus));
  };

  const onWheel = (ev: WheelEvent) => {
    ev.preventDefault();
    const r = stage.getBoundingClientRect();
    if (ev.ctrlKey || ev.metaKey) {
      // ピンチは ctrlKey 付きの wheel で届く
      const cx = ev.clientX - r.left;
      const cy = ev.clientY - r.top;
      const k = Math.min(K_MAX, Math.max(K_MIN, view.k * Math.exp(-ev.deltaY * 0.01)));
      view.tx = cx - (cx - view.tx) * (k / view.k);
      view.ty = cy - (cy - view.ty) * (k / view.k);
      view.k = k;
    } else {
      view.tx -= ev.deltaX;
      view.ty -= ev.deltaY;
    }
    apply();
  };
  let drag: { x: number; y: number; tx: number; ty: number } | null = null;
  let dragged = false;
  const onDown = (ev: MouseEvent) => {
    if (ev.button !== 0 || opts.ignore?.(ev.target)) return;
    drag = { x: ev.clientX, y: ev.clientY, tx: view.tx, ty: view.ty };
    dragged = false;
  };
  const onMove = (ev: MouseEvent) => {
    if (!drag) return;
    const dx = ev.clientX - drag.x;
    const dy = ev.clientY - drag.y;
    if (!dragged && Math.hypot(dx, dy) > 3) {
      dragged = true;
      stage.classList.add('dragging');
    }
    if (dragged) {
      view.tx = drag.tx + dx;
      view.ty = drag.ty + dy;
      apply();
    }
  };
  const onUp = () => {
    drag = null;
    stage.classList.remove('dragging');
  };
  // 窓の大きさが変わったら中心を保ったまま追従
  let last = stage.getBoundingClientRect();
  const onResize = () => {
    const r = stage.getBoundingClientRect();
    view.tx += (r.width - last.width) / 2;
    view.ty += (r.height - last.height) / 2;
    last = r;
    apply();
  };

  stage.addEventListener('wheel', onWheel, { passive: false });
  stage.addEventListener('mousedown', onDown);
  window.addEventListener('mousemove', onMove);
  window.addEventListener('mouseup', onUp);
  window.addEventListener('resize', onResize);

  return {
    view,
    apply,
    fit,
    open,
    consumeDrag() {
      const d = dragged;
      dragged = false;
      return d;
    },
    dispose() {
      stage.removeEventListener('wheel', onWheel);
      stage.removeEventListener('mousedown', onDown);
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      window.removeEventListener('resize', onResize);
    },
  };
}
