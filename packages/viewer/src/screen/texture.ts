/**
 * 画面ノードのテクスチャ（Canvas 2D）。
 * - ベース: スクショ画像（遅延読み込み）か、なければプレースホルダ（ルート名と regions の枠）
 * - その上にハイライト中の region を重ね描きする（プロトタイプの renderScreen と同じ）
 *
 * 再描画は呼び出し側が「ハイライト対象が変わったとき」だけ render() を呼ぶ。
 */
import type { Highlight } from '../graph/closure';
import { SCREEN_BASE_HEIGHT, SCREEN_BASE_WIDTH, type ModelNode } from '../graph/model';

export const CW = SCREEN_BASE_WIDTH;
export const CH = SCREEN_BASE_HEIGHT;
export const CANVAS_FONT = '"Hiragino Sans","Noto Sans JP",system-ui,sans-serif';

export interface RegionOverlayContext {
  hl: Highlight;
  /** region の ref のノードが表示中の層にあるか */
  isVisible(id: string): boolean;
}

/** canvas 座標系に直した region */
export interface CanvasRegion {
  ref: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface ScreenCanvasOptions {
  /** 解決済みのスクショ URL。なければプレースホルダのまま */
  screenshotUrl?: string;
  /** region の ref の表示名 */
  nameOf(id: string): string;
  /** キャンバスを描き直したとき（テクスチャの needsUpdate 用） */
  onUpdate(): void;
}

export type ScreenImageState = 'none' | 'loading' | 'loaded' | 'error';

export class ScreenCanvas {
  readonly canvas: HTMLCanvasElement;
  readonly regions: CanvasRegion[];
  private readonly base: HTMLCanvasElement;
  private image: HTMLImageElement | null = null;
  private override: HTMLImageElement | null = null;
  private lastOverlay: RegionOverlayContext | null = null;
  imageState: ScreenImageState = 'none';

  private readonly screenshotUrl: string | undefined;
  private readonly unresolvedScreenshot: boolean;
  private readonly nameOf: (id: string) => string;
  private readonly onUpdate: () => void;

  constructor(
    private readonly node: ModelNode,
    opts: ScreenCanvasOptions,
  ) {
    this.screenshotUrl = opts.screenshotUrl;
    this.unresolvedScreenshot = !!node.screen?.screenshot && !opts.screenshotUrl;
    this.nameOf = opts.nameOf;
    this.onUpdate = opts.onUpdate;
    this.canvas = makeCanvas();
    this.base = makeCanvas();
    const scale = CW / (node.screen?.width || CW);
    this.regions = node.regions.map((r) => ({
      ref: r.ref,
      x: r.x * scale,
      y: r.y * scale,
      w: r.w * scale,
      h: r.h * scale,
    }));
    this.drawBase();
  }

  /** スクショの読み込みを始める（一度だけ） */
  load(): void {
    if (!this.screenshotUrl || this.imageState !== 'none') return;
    this.imageState = 'loading';
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => {
      this.image = img;
      this.imageState = 'loaded';
      this.redraw();
    };
    img.onerror = () => {
      this.imageState = 'error';
      this.redraw();
    };
    img.src = this.screenshotUrl;
  }

  /** パネルの「差し替え」で貼られた画像。null で元に戻す */
  setOverride(img: HTMLImageElement | null): void {
    this.override = img;
    this.redraw();
  }

  get hasOverride(): boolean {
    return !!this.override;
  }

  /** フォント読み込み後などにベースから描き直す */
  redraw(): void {
    this.drawBase();
    this.render(this.lastOverlay);
  }

  /** ベースの上に region のハイライトを重ねる */
  render(ctx: RegionOverlayContext | null): void {
    this.lastOverlay = ctx;
    const c = this.canvas.getContext('2d');
    if (!c) return;
    c.clearRect(0, 0, CW, CH);
    c.drawImage(this.base, 0, 0);
    const a = ctx?.hl.a;
    if (ctx && a) {
      const { down, up } = ctx.hl;
      const tagged = new Set<string>();
      for (const r of this.regions) {
        const st = r.ref === a ? 'sel' : down.has(r.ref) ? 'down' : up.has(r.ref) ? 'up' : null;
        if (!st || !ctx.isVisible(r.ref)) continue;
        const col = st === 'up' ? '#ff8a5c' : '#ff3b3b';
        c.save();
        c.fillStyle =
          st === 'sel'
            ? 'rgba(255,59,59,.22)'
            : st === 'down'
              ? 'rgba(255,59,59,.10)'
              : 'rgba(255,138,92,.12)';
        c.fillRect(r.x, r.y, r.w, r.h);
        c.strokeStyle = col;
        c.lineWidth = st === 'sel' ? 6 : 4;
        c.strokeRect(r.x + 2, r.y + 2, r.w - 4, r.h - 4);
        if (!tagged.has(r.ref)) {
          tagged.add(r.ref);
          const name = this.nameOf(r.ref);
          c.font = `700 13px ${CANVAS_FONT}`;
          const tw = c.measureText(name).width + 16;
          c.fillStyle = col;
          c.fillRect(r.x + 2, r.y + 2, tw, 22);
          c.fillStyle = '#fff';
          c.textAlign = 'left';
          c.textBaseline = 'alphabetic';
          c.fillText(name, r.x + 10, r.y + 18);
        }
        c.restore();
      }
    }
    this.onUpdate();
  }

  /** キャンバス座標 → region の ref（当たらなければ null） */
  regionAt(px: number, py: number, isVisible: (id: string) => boolean): string | null {
    const r = this.regions.find(
      (q) => px >= q.x && px <= q.x + q.w && py >= q.y && py <= q.y + q.h && isVisible(q.ref),
    );
    return r ? r.ref : null;
  }

  private drawBase(): void {
    const c = this.base.getContext('2d');
    if (!c) return;
    const img = this.override ?? this.image;
    if (img && img.width > 0) {
      c.fillStyle = '#fff';
      c.fillRect(0, 0, CW, CH);
      const s = CW / img.width;
      c.drawImage(img, 0, 0, CW, img.height * s);
      return;
    }
    this.drawPlaceholder(c);
  }

  private drawPlaceholder(c: CanvasRenderingContext2D): void {
    c.fillStyle = '#eef1f6';
    c.fillRect(0, 0, CW, CH);
    // 中央にルート名
    c.textAlign = 'center';
    c.textBaseline = 'alphabetic';
    c.fillStyle = '#13233f';
    c.font = `700 40px ${CANVAS_FONT}`;
    c.fillText(fit(c, this.node.node.name, CW - 80), CW / 2, CH / 2 + 14);
    c.fillStyle = '#7b8496';
    c.font = `400 15px ${CANVAS_FONT}`;
    c.fillText(this.node.kind.ja, CW / 2, CH / 2 + 46);
    // 状態の注記（右下）
    const note =
      this.imageState === 'loading'
        ? 'スクリーンショットを読み込み中…'
        : this.imageState === 'error'
          ? 'スクリーンショットを読み込めませんでした'
          : this.unresolvedScreenshot
            ? 'スクリーンショットはファイル読み込みでは表示できません'
            : 'スクリーンショットなし（プレースホルダ）';
    c.textAlign = 'right';
    c.fillStyle = '#9aa3b5';
    c.font = `400 12px ${CANVAS_FONT}`;
    c.fillText(note, CW - 14, CH - 12);
    // regions の枠と ref 名
    for (const r of this.regions) {
      c.save();
      c.fillStyle = 'rgba(79,140,255,.08)';
      c.fillRect(r.x, r.y, r.w, r.h);
      c.setLineDash([8, 5]);
      c.strokeStyle = '#7f93b8';
      c.lineWidth = 2;
      c.strokeRect(r.x + 1.5, r.y + 1.5, r.w - 3, r.h - 3);
      c.setLineDash([]);
      c.fillStyle = '#41506b';
      c.font = `600 13px ${CANVAS_FONT}`;
      c.textAlign = 'left';
      const label = this.nameOf(r.ref);
      c.fillText(fit(c, label, Math.max(20, r.w - 16)), r.x + 8, r.y + Math.min(20, r.h - 4));
      c.restore();
    }
  }
}

function makeCanvas(): HTMLCanvasElement {
  const cv = document.createElement('canvas');
  cv.width = CW;
  cv.height = CH;
  return cv;
}

/** 幅に収まらない文字列を … で切る */
function fit(c: CanvasRenderingContext2D, s: string, maxW: number): string {
  if (c.measureText(s).width <= maxW) return s;
  let t = s;
  while (t.length > 1 && c.measureText(t + '…').width > maxW) t = t.slice(0, -1);
  return t + '…';
}
