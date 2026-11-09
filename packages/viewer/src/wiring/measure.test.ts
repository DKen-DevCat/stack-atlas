// 画面の HTML の [data-component] を測る（docs/18 §3.3）。単体テストに DOM は無いので DomApi を差し替える。
// 実際のブラウザでの計測（prototype から call で呼ぶので名前付きのプロパティに隠されない、など）は e2e の screens.spec.ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { measureComponents, settle, type DomApi } from './measure';
import { MAX_COMPONENTS } from './screens';

interface FakeEl {
  attrs: Record<string, string>;
  rect: { x: number; y: number; width: number; height: number };
  complete?: boolean;
  on?: Record<string, () => void>;
}

/** document のメソッドを名前付きのプロパティで隠した文書（doc.querySelectorAll が要素になっている） */
const shadowedDoc = () =>
  ({ querySelectorAll: { tagName: 'IMG' }, fonts: { tagName: 'IMG' } }) as unknown as Document;

const fakeApi = (els: FakeEl[], imgs: FakeEl[] = [], fonts?: Promise<unknown>): DomApi => ({
  queryAll: (_doc, sel) => (sel === 'img' ? imgs : els) as unknown as Element[],
  attr: (el, name) => (el as unknown as FakeEl).attrs[name] ?? null,
  rect: (el) => (el as unknown as FakeEl).rect,
  complete: (img) => !!(img as unknown as FakeEl).complete,
  once: (t, type, fn) => {
    const f = t as unknown as FakeEl;
    (f.on ??= {})[type] = fn;
  },
  fontsReady: () => fonts,
});

const el = (name: string | null, x = 0, y = 0, w = 10, h = 10): FakeEl => ({
  attrs: name === null ? {} : { 'data-component': name },
  rect: { x, y, width: w, height: h },
});

afterEach(() => {
  vi.useRealTimers();
});

describe('measureComponents', () => {
  it('名前（前後の空白を除く）と矩形。document のメソッドには触らない（DomApi だけを通す）', () => {
    const doc = shadowedDoc();
    const got = measureComponents(
      doc,
      fakeApi([
        el(' TodayIsland ', 184, 85, 912, 59),
        el(''),
        el(null),
        el('Header', 0, 0, 1280, 60),
      ]),
    );
    expect(got).toEqual([
      { name: 'TodayIsland', x: 184, y: 85, w: 912, h: 59 },
      { name: 'Header', x: 0, y: 0, w: 1280, h: 60 },
    ]);
  });

  it(`測るのは ${MAX_COMPONENTS} 個まで`, () => {
    const many = Array.from({ length: MAX_COMPONENTS + 50 }, (_, i) => el(`C${i}`));
    expect(measureComponents(shadowedDoc(), fakeApi(many))).toHaveLength(MAX_COMPONENTS);
  });
});

describe('settle（fonts.ready と画像を待つ。上限あり）', () => {
  it('読み終わった画像と fonts.ready だけなら上限を待たずに終わる', async () => {
    vi.useFakeTimers();
    let done = false;
    const p = settle(
      shadowedDoc(),
      3000,
      fakeApi([], [{ ...el(null), complete: true }], Promise.resolve()),
    ).then(() => (done = true));
    await vi.advanceTimersByTimeAsync(0);
    expect(done).toBe(true);
    await p;
  });

  it('読み込み中の画像は load か error で終わる', async () => {
    vi.useFakeTimers();
    const a: FakeEl = { ...el(null), complete: false };
    const b: FakeEl = { ...el(null), complete: false };
    let done = false;
    const p = settle(shadowedDoc(), 3000, fakeApi([], [a, b])).then(() => (done = true));
    await vi.advanceTimersByTimeAsync(10);
    expect(done).toBe(false);
    a.on!.load!();
    await vi.advanceTimersByTimeAsync(10);
    expect(done).toBe(false);
    b.on!.error!();
    await vi.advanceTimersByTimeAsync(0);
    expect(done).toBe(true);
    await p;
  });

  it('終わらない画像・fonts.ready は上限（3 秒）で打ち切る', async () => {
    vi.useFakeTimers();
    let done = false;
    const p = settle(
      shadowedDoc(),
      3000,
      fakeApi([], [{ ...el(null), complete: false }], new Promise(() => {})),
    ).then(() => (done = true));
    await vi.advanceTimersByTimeAsync(2999);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(done).toBe(true);
    await p;
  });

  it('DOM の操作が例外を投げても、待つのをやめるだけ', async () => {
    vi.useFakeTimers();
    const api = fakeApi([]);
    api.queryAll = () => {
      throw new Error('boom');
    };
    let done = false;
    const p = settle(shadowedDoc(), 3000, api).then(() => (done = true));
    await vi.advanceTimersByTimeAsync(0);
    expect(done).toBe(true);
    await p;
  });
});
