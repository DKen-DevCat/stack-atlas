// 画面の HTML の [data-component] を測る（docs/18 §3.3）。消毒した HTML の要素は名前付きのプロパティで document の
// メソッドを隠せる（`<img name="querySelectorAll">` で document.querySelectorAll が要素になる）ので、DOM のメソッドは
// ビューア側の prototype から call で呼ぶ（doc.querySelectorAll(...) と書かない）。
// テストでは DomApi を差し替える（単体テストに DOM が無い）
import { MAX_COMPONENTS } from './screens';
import type { RawRegion } from '@stack-atlas/wiring';

/** 計測で使う DOM の操作（既定は prototype から呼ぶ） */
export interface DomApi {
  queryAll(doc: Document, selector: string): ArrayLike<Element>;
  attr(el: Element, name: string): string | null;
  rect(el: Element): { x: number; y: number; width: number; height: number };
  /** 画像が読み終わっているか */
  complete(img: Element): boolean;
  /** 一度だけのイベント */
  once(target: EventTarget, type: string, fn: () => void): void;
  /** document.fonts.ready（無ければ undefined） */
  fontsReady(doc: Document): Promise<unknown> | undefined;
}

const getter = <T>(proto: object, name: string): ((this: unknown) => T) | undefined =>
  Object.getOwnPropertyDescriptor(proto, name)?.get as ((this: unknown) => T) | undefined;

/** ブラウザの既定（prototype から呼ぶ） */
export const domApi: DomApi = {
  queryAll: (doc, selector) => Document.prototype.querySelectorAll.call(doc, selector),
  attr: (el, name) => Element.prototype.getAttribute.call(el, name),
  rect: (el) => Element.prototype.getBoundingClientRect.call(el),
  complete: (img) => {
    const g = getter<boolean>(HTMLImageElement.prototype, 'complete');
    try {
      return g ? !!g.call(img) : true;
    } catch {
      return true; // img でないもの
    }
  },
  once: (target, type, fn) =>
    EventTarget.prototype.addEventListener.call(target, type, fn, { once: true }),
  fontsReady: (doc) => {
    const g = getter<FontFaceSet>(Document.prototype, 'fonts');
    const fonts = g?.call(doc);
    const ready = fonts ? getter<Promise<FontFaceSet>>(FontFaceSet.prototype, 'ready') : undefined;
    return ready ? ready.call(fonts) : undefined;
  },
};

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** load の後、fonts.ready と画像（img）の読み込みを待つ。上限 ms（docs/18 §3.3。上限 3 秒） */
export async function settle(doc: Document, ms: number, api: DomApi = domApi): Promise<void> {
  const waits: Promise<unknown>[] = [];
  try {
    const f = api.fontsReady(doc);
    if (f) waits.push(f.catch(() => {}));
    const imgs = api.queryAll(doc, 'img');
    for (let i = 0; i < imgs.length; i++) {
      const img = imgs[i]!;
      if (api.complete(img)) continue;
      waits.push(
        new Promise<void>((r) => {
          api.once(img, 'load', r);
          api.once(img, 'error', r);
        }),
      );
    }
  } catch {
    // 測れなくても待つのをやめるだけ
  }
  await Promise.race([Promise.all(waits), delay(ms)]);
}

/** [data-component] の名前と矩形（iframe の中の座標。ビューポートの CSS px）。上限 MAX_COMPONENTS 個 */
export function measureComponents(doc: Document, api: DomApi = domApi): RawRegion[] {
  const els = api.queryAll(doc, '[data-component]');
  const out: RawRegion[] = [];
  const n = Math.min(els.length, MAX_COMPONENTS);
  for (let i = 0; i < n; i++) {
    const el = els[i]!;
    const name = (api.attr(el, 'data-component') ?? '').trim();
    if (!name) continue;
    const r = api.rect(el);
    out.push({ name, x: r.x, y: r.y, w: r.width, h: r.height });
  }
  return out;
}
