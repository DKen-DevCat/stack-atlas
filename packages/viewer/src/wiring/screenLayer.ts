// 画面の層（docs/18 §3.3、D62）: SVG の下の div に、画面の箱の画面の領域ごとに sandbox の iframe を置く。
// 層全体に canvas と同じ移動・拡大を掛け、pointer-events は無し（クリック・hover・ドラッグは上の SVG が受ける）。
// iframe は `sandbox="allow-same-origin"`（allow-scripts・allow-forms・allow-popups は付けない）、`referrerpolicy="no-referrer"`。
// 規則（どれを生かすか・src・領域の優先・不透明度）は screens.ts、計測は measure.ts。ここは DOM の出し入れだけ
import {
  resolveRegions,
  type GraphIndex,
  type LitSelection,
  type ScreenRegion,
  type WiringLayout,
} from '@stack-atlas/wiring';
import { measureComponents, settle } from './measure';
import {
  frameBox,
  layerTransform,
  placeholderText,
  planLive,
  screenOpacity,
  screenRegions,
  screenSpecs,
  SETTLE_MS,
  type ScreenSpec,
  type ScreenState,
} from './screens';
import type { View } from './view';

export interface ScreenLayerOptions {
  stage: HTMLElement;
  svg: SVGSVGElement;
  index: GraphIndex;
  layout: WiringLayout;
  /** graph.json の URL（ファイルで開いたときは無い） */
  baseUrl: string | undefined;
  /** 測った領域が変わった（枠を描き直す） */
  onRegions: () => void;
}

interface Live {
  wrap: HTMLDivElement;
  frame: HTMLIFrameElement;
}

/** e2e・デバッグ用 */
export interface ScreenDebug {
  live: string[];
  state: Record<string, ScreenState>;
  measured: Record<string, ScreenRegion[]>;
  regions: Record<string, ScreenRegion[]>;
}

export class ScreenLayer {
  readonly el: HTMLDivElement;
  readonly specs: ScreenSpec[];
  private readonly byId: Map<string, ScreenSpec>;
  private readonly live = new Map<string, Live>();
  private readonly state = new Map<string, ScreenState>();
  private readonly measured = new Map<string, ScreenRegion[]>();
  private readonly nodeIds: Set<string>;
  private view: View = { k: 1, tx: 0, ty: 0 };
  private lit: LitSelection | null = null;
  private raf = 0;
  private disposed = false;

  constructor(private readonly opts: ScreenLayerOptions) {
    this.specs = screenSpecs(opts.index, opts.layout, opts.baseUrl, location.href);
    this.byId = new Map(this.specs.map((s) => [s.id, s]));
    this.nodeIds = new Set(opts.index.nodes.keys());
    for (const s of this.specs) this.state.set(s.id, s.refusal ?? 'idle');
    this.el = document.createElement('div');
    this.el.className = 'wv-screens';
    this.el.setAttribute('aria-hidden', 'true');
  }

  /** canvas の変換が変わった（毎回すぐに変換を当て、どれを生かすかは次のフレームで決める） */
  setView(v: View) {
    this.view = { ...v };
    this.el.style.transform = layerTransform(v);
    if (!this.raf && this.specs.length)
      this.raf = requestAnimationFrame(() => {
        this.raf = 0;
        this.plan();
      });
  }

  /** 選択が変わった（沈んだ画面は iframe の不透明度も下げる） */
  setLit(lit: LitSelection | null) {
    this.lit = lit;
    for (const [id, l] of this.live) l.wrap.style.opacity = String(screenOpacity(lit, id));
  }

  /** 画面ごとの領域（graph の regions が計測より優先） */
  regions(): Map<string, ScreenRegion[]> {
    return screenRegions(this.opts.index, this.specs, this.measured);
  }

  /** SVG のプレースホルダに状態と文言を付ける（描き直したあと・状態が変わったとき） */
  decorate() {
    this.opts.svg.querySelectorAll<SVGGElement>('[data-screen-ph]').forEach((g) => {
      const id = g.dataset.screenPh ?? '';
      const st = this.state.get(id) ?? 'idle';
      g.dataset.state = st;
      const t = g.querySelector('text');
      if (t) t.textContent = placeholderText(st);
    });
  }

  get debug(): ScreenDebug {
    const rec = <T>(m: Map<string, T>) =>
      Object.fromEntries([...m].sort(([a], [b]) => (a < b ? -1 : 1)));
    return {
      live: [...this.live.keys()].sort(),
      state: rec(this.state),
      measured: rec(this.measured),
      regions: rec(this.regions()),
    };
  }

  dispose() {
    this.disposed = true;
    if (this.raf) cancelAnimationFrame(this.raf);
    for (const id of [...this.live.keys()]) this.unmount(id);
    this.el.remove();
  }

  private plan() {
    if (this.disposed) return;
    const r = this.opts.stage.getBoundingClientRect();
    const skip = new Set<string>();
    for (const s of this.specs) if (!s.src || this.state.get(s.id) === 'blocked') skip.add(s.id);
    const want = new Set(
      planLive(this.specs, this.view, { width: r.width, height: r.height }, { skip }),
    );
    let changed = false;
    for (const id of [...this.live.keys()])
      if (!want.has(id)) {
        this.unmount(id);
        changed = true;
      }
    for (const id of want)
      if (!this.live.has(id)) {
        this.mount(this.byId.get(id)!);
        changed = true;
      }
    if (changed) this.decorate();
  }

  private mount(s: ScreenSpec) {
    const b = frameBox(s.area, s.viewport);
    const wrap = document.createElement('div');
    wrap.className = 'wv-screen';
    wrap.dataset.screen = s.id;
    Object.assign(wrap.style, {
      left: `${b.left}px`,
      top: `${b.top}px`,
      width: `${b.width}px`,
      height: `${b.height}px`,
      opacity: String(screenOpacity(this.lit, s.id)),
    });
    const frame = document.createElement('iframe');
    // sandbox は src より先に付ける（最初の読み込みから効かせる）
    frame.setAttribute('sandbox', 'allow-same-origin');
    frame.setAttribute('referrerpolicy', 'no-referrer');
    frame.setAttribute('scrolling', 'no');
    frame.setAttribute('tabindex', '-1');
    frame.title = `画面: ${s.name}`;
    Object.assign(frame.style, {
      width: `${b.frameWidth}px`,
      height: `${b.frameHeight}px`,
      transform: `scale(${b.scale})`,
    });
    const live: Live = { wrap, frame };
    frame.addEventListener('load', () => void this.loaded(s, live));
    frame.src = s.src!;
    wrap.append(frame);
    this.el.append(wrap);
    this.live.set(s.id, live);
    this.state.set(s.id, 'loading');
  }

  /** [data-component] を測って箱 id に解く（測れなければ空） */
  private measure(doc: Document, s: ScreenSpec): ScreenRegion[] {
    try {
      return resolveRegions(measureComponents(doc), this.nodeIds, s.viewport);
    } catch {
      return [];
    }
  }

  private unmount(id: string) {
    const l = this.live.get(id);
    if (!l) return;
    this.live.delete(id);
    l.wrap.remove();
    if (this.state.get(id) !== 'blocked') this.state.set(id, 'idle');
  }

  private async loaded(s: ScreenSpec, live: Live) {
    if (this.live.get(s.id) !== live) return; // 外したあとに届いた
    const doc = readableDocument(live.frame);
    if (!doc) {
      // 別の origin（応答ヘッダの sandbox に allow-same-origin が無い、など）。プレースホルダと graph の regions で描く
      this.unmount(s.id);
      this.state.set(s.id, 'blocked');
      this.decorate();
      this.opts.onRegions();
      return;
    }
    this.state.set(s.id, 'ready');
    this.decorate();
    await settle(doc, SETTLE_MS);
    if (this.disposed || this.live.get(s.id) !== live) return;
    this.measured.set(s.id, this.measure(doc, s));
    this.opts.onRegions();
  }
}

/** iframe の文書（別の origin で読めなければ null） */
function readableDocument(frame: HTMLIFrameElement): Document | null {
  try {
    return frame.contentDocument;
  } catch {
    return null;
  }
}
