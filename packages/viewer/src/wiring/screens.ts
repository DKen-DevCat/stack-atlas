// 画面の箱の中のビルド成果物の HTML（docs/18 §3.3、D62）の規則。DOM に触らない（単体テストできる）。
// - 層: iframe の層は SVG の下に置き、canvas と同じ移動・拡大（translate(tx,ty) scale(k)）を掛ける
// - 読み込み: 画面上の幅が 200px 以上で表示の枠に掛かる箱だけ、見えている面積の大きい順に 6 枚まで生かす（外れたら外す）
// - src: graph.json からの相対パスだけ。graph.json のディレクトリの下で、ビューアと同じ origin のときだけ読む
// - 領域: graph の screen.regions を計測より優先（regionsOf）。選んだ経路に入る部品の領域だけ SVG に枠を描く
// DOM を扱うのは screenLayer.ts（iframe の出し入れ）と measure.ts（計測）
import {
  hasScreenHtml,
  regionsOf,
  screenViewport,
  type GraphIndex,
  type LitSelection,
  type Rect,
  type ScreenRegion,
  type WiringLayout,
} from '@stack-atlas/wiring';
import { esc } from './render';
import type { View } from './view';

/** 読み込む箱の画面上の幅の下限（px） */
export const MIN_LIVE_PX = 200;
/** 同時に生かす iframe の数 */
export const MAX_LIVE = 6;
/** load の後に fonts.ready と画像を待つ上限（ms） */
export const SETTLE_MS = 3000;
/** 沈んだ箱の不透明度（style.css の `.wv .box.dim`。整合はテストで確かめる） */
export const DIM_OPACITY = 0.15;
/** 1 つの画面で測る [data-component] の数の上限（極端な HTML で止まらない） */
export const MAX_COMPONENTS = 2000;

/** 画面の箱 1 つ分（graph と配置から決まる。変わらない） */
export interface ScreenSpec {
  id: string;
  name: string;
  /** 画面の領域（配置の座標） */
  area: Rect;
  /** iframe の大きさ（計測した領域の座標系） */
  viewport: { width: number; height: number };
  /** iframe の src。読めないときは null で、理由は refusal */
  src: string | null;
  refusal: Refusal | null;
}

/**
 * 画面を読まない理由。nobase: graph.json をファイルで開いた（相対パスを解けない）、
 * outside: 絶対 URL・別の origin・graph.json のディレクトリの外
 */
export type Refusal = 'nobase' | 'outside';

/**
 * 画面の状態（プレースホルダの文言と e2e のため）。idle: 読んでいない（小さい・枠の外・7 枚目以降）、loading: 読み込み中、
 * ready: 表示中（領域は測り終えたら measured に入る）、blocked: contentDocument が読めない（別 origin など）
 */
export type ScreenState = 'idle' | 'loading' | 'ready' | 'blocked' | Refusal;

const SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i;

/**
 * screen.html（graph.json からの相対パス）→ iframe の src。graph.json の URL（baseUrl）が無い・絶対 URL・`/` や `//` で
 * 始まる・`\` を含む・解いた先がビューアと別の origin か graph.json のディレクトリの外なら読まない
 */
export function screenSrc(
  html: string,
  baseUrl: string | undefined,
  pageHref: string,
): { src: string } | { refusal: Refusal } {
  if (!baseUrl) return { refusal: 'nobase' };
  if (
    !html ||
    SCHEME_RE.test(html) ||
    html.startsWith('/') ||
    html.includes('\\') ||
    // 制御文字（URL の解析で取り除かれ、判定をすり抜ける）
    // eslint-disable-next-line no-control-regex
    /[\u0000-\u001f\u007f]/.test(html)
  )
    return { refusal: 'outside' };
  let base: URL;
  let page: URL;
  let url: URL;
  try {
    base = new URL(baseUrl);
    page = new URL(pageHref);
    url = new URL(html, base);
  } catch {
    return { refusal: 'outside' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return { refusal: 'outside' };
  if (url.origin !== page.origin || base.origin !== page.origin) return { refusal: 'outside' };
  const dir = base.pathname.slice(0, base.pathname.lastIndexOf('/') + 1);
  if (!url.pathname.startsWith(dir)) return { refusal: 'outside' };
  url.hash = '';
  return { src: url.href };
}

/** 配置と graph から、画面の HTML を持つ箱の一覧（graph の宣言の順） */
export function screenSpecs(
  index: GraphIndex,
  layout: WiringLayout,
  baseUrl: string | undefined,
  pageHref: string,
): ScreenSpec[] {
  const out: ScreenSpec[] = [];
  for (const n of index.graph.nodes) {
    const b = layout.boxes.get(n.id);
    const node = index.nodes.get(n.id);
    if (!b?.screen || !node || !hasScreenHtml(node)) continue;
    const r = screenSrc(n.screen!.html!, baseUrl, pageHref);
    out.push({
      id: n.id,
      name: n.name,
      area: b.screen,
      viewport: screenViewport(n.screen),
      src: 'src' in r ? r.src : null,
      refusal: 'refusal' in r ? r.refusal : null,
    });
  }
  return out;
}

/** 画面の層の CSS の変換（SVG の g.view の `translate(tx,ty) scale(k)` と同じ写像。transform-origin は 0 0） */
export function layerTransform(v: View): string {
  return `translate(${v.tx}px, ${v.ty}px) scale(${v.k})`;
}

/**
 * iframe の置き方（層の中、配置の座標）: 外枠は画面の領域、iframe はビューポートの大きさで左上に置き、領域の幅に縮める。
 * 縦はビューポートの高さで切れる（外枠の overflow: hidden）
 */
export function frameBox(area: Rect, viewport: { width: number; height: number }) {
  return {
    left: area.x,
    top: area.y,
    width: area.w,
    height: area.h,
    frameWidth: viewport.width,
    frameHeight: viewport.height,
    scale: area.w / viewport.width,
  };
}

/** 配置の座標の矩形 → 表示の枠（stage）の座標 */
export function toScreen(r: Rect, v: View): Rect {
  return { x: v.tx + r.x * v.k, y: v.ty + r.y * v.k, w: r.w * v.k, h: r.h * v.k };
}

/**
 * 生かす iframe の id（docs/18 §3.3 の読み込み）。画面上の幅が minPx 以上で、表示の枠に掛かる箱だけ。
 * 見えている面積の大きい順（同じなら枠の中心に近い順、さらに同じなら specs の順）に max 枚まで。
 * `loading="lazy"` は変換の下で距離が決まらないので使わない
 */
export function planLive(
  specs: readonly Pick<ScreenSpec, 'id' | 'area'>[],
  view: View,
  stage: { width: number; height: number },
  opts: { minPx?: number; max?: number; skip?: ReadonlySet<string> } = {},
): string[] {
  const minPx = opts.minPx ?? MIN_LIVE_PX;
  const max = opts.max ?? MAX_LIVE;
  const cx = stage.width / 2;
  const cy = stage.height / 2;
  const cand: { id: string; seen: number; dist: number; i: number }[] = [];
  specs.forEach((s, i) => {
    if (opts.skip?.has(s.id)) return;
    const r = toScreen(s.area, view);
    if (!(r.w >= minPx)) return;
    const w = Math.min(r.x + r.w, stage.width) - Math.max(r.x, 0);
    const h = Math.min(r.y + r.h, stage.height) - Math.max(r.y, 0);
    if (w <= 0 || h <= 0) return;
    const dist = Math.hypot(r.x + r.w / 2 - cx, r.y + r.h / 2 - cy);
    cand.push({ id: s.id, seen: w * h, dist, i });
  });
  cand.sort((a, b) => b.seen - a.seen || a.dist - b.dist || a.i - b.i);
  return cand.slice(0, max).map((c) => c.id);
}

/** 画面の不透明度: 何か選んでいて、画面の箱が光っていなければ沈める（箱の `.dim` と同じ） */
export function screenOpacity(lit: LitSelection | null, id: string): number {
  return lit && !lit.boxes.has(id) ? DIM_OPACITY : 1;
}

/** 画面ごとの領域（graph の regions が計測より優先。座標はビューポート） */
export function screenRegions(
  index: GraphIndex,
  specs: readonly ScreenSpec[],
  measured: ReadonlyMap<string, readonly ScreenRegion[]>,
): Map<string, ScreenRegion[]> {
  const out = new Map<string, ScreenRegion[]>();
  for (const s of specs) {
    const r = regionsOf(index.nodes.get(s.id)?.node.screen, measured.get(s.id));
    if (r.regions.length) out.set(s.id, r.regions);
  }
  return out;
}

/**
 * 部品の領域の枠（SVG。`<g class="regions">` の中身）。選んだ経路に入る部品（lit.boxes）の領域だけ、画面の上に描く
 * （ラベルは出さない）。画面の箱そのものの領域は描かない
 */
export function renderRegions(
  specs: readonly ScreenSpec[],
  regions: ReadonlyMap<string, readonly ScreenRegion[]>,
  lit: LitSelection | null,
): string {
  if (!lit) return '';
  const n1 = (v: number) => Math.round(v * 10) / 10;
  let s = '';
  for (const sp of specs) {
    const list = regions.get(sp.id);
    if (!list) continue;
    const k = sp.area.w / sp.viewport.width;
    for (const r of list) {
      if (r.ref === sp.id || !lit.boxes.has(r.ref)) continue;
      const x = sp.area.x + r.x * k;
      const y = sp.area.y + r.y * k;
      // 領域はビューポートで切り詰め済み。画面の領域（ビューポートの高さで切れる）の中に収める
      const w = Math.min(r.w * k, sp.area.x + sp.area.w - x);
      const h = Math.min(r.h * k, sp.area.y + sp.area.h - y);
      if (w <= 0 || h <= 0) continue;
      s += `<rect class="region" data-region="${esc(r.ref)}" data-screen="${esc(sp.id)}" x="${n1(x)}" y="${n1(y)}" width="${n1(w)}" height="${n1(h)}" rx="2"/>`;
    }
  }
  return s;
}

/** プレースホルダの文言（表示中は出さない） */
export function placeholderText(state: ScreenState): string {
  switch (state) {
    case 'idle':
      return '拡大すると画面を表示';
    case 'loading':
      return '画面を読み込み中…';
    case 'ready':
      return '';
    case 'blocked':
      return '画面の HTML を読めません（別の origin）';
    case 'nobase':
      return 'graph.json を URL で開くと画面を表示';
    case 'outside':
      return '画面の HTML が graph.json の外にあるので読みません';
  }
}
