// 開いた直後の倍率と全体表示（docs/18 §3.2・§4「開いた直後」）: 1440×900 で項目の文字が 6px 以上。
// 全体が倍率 0.6 以上で収まるなら全体、収まらないなら 0.6 で画面の箱のあたり。`F` キーは修飾キーと入力欄を除く
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { GraphV2 } from '@stack-atlas/schema';
import { indexGraph, layoutWiring } from '@stack-atlas/wiring';
import { todayGraph } from '../../../wiring/src/__tests__/fixture';
import { SAMPLE_V2_PATH } from '../graph/testSample';
import { isFitKey } from './interaction';
import {
  fitView,
  ITEM_FONT_PX,
  MIN_TEXT_PX,
  openingFocus,
  openingView,
  READABLE_K,
  type Viewport,
} from './view';

const BASELINE = new URL(
  '../../../wiring/src/__tests__/fixtures/poly-82a.v2.json',
  import.meta.url,
);
const read = (u: URL) => JSON.parse(readFileSync(u, 'utf8')) as GraphV2;
/** e2e と同じ 1440×900。上端の帯は 44px（canvas の既定） */
const VP: Viewport = { width: 1440, height: 900, top: 44 };

describe('開いた直後の表示', () => {
  it('項目の文字の大きさは style.css と同じ（倍率の下限 0.6 の根拠）', () => {
    const css = readFileSync(new URL('./style.css', import.meta.url), 'utf8');
    const m = /\.wv \.item text \{[^}]*font-size:\s*([\d.]+)px/.exec(css);
    expect(Number(m?.[1])).toBe(ITEM_FONT_PX);
    expect(READABLE_K).toBeCloseTo(0.6);
  });

  describe.each([
    ['基準の graph（poly-82a）', () => read(BASELINE)],
    ['/today の例', () => read(SAMPLE_V2_PATH)],
  ])('%s', (_name, make) => {
    const index = indexGraph(make());
    const layout = layoutWiring(index);
    const size = { w: layout.width, h: layout.height };
    const focus = openingFocus(index, layout)!;
    const v = openingView(VP, size, focus);

    it('1440×900 で項目の文字が 6px 以上', () => {
      expect(v.k * ITEM_FONT_PX).toBeGreaterThanOrEqual(MIN_TEXT_PX - 1e-9);
    });

    it('全体は 0.6 では収まらないので、画面の箱（宣言の順で最初）を映す。全体表示（F）は 0.6 未満', () => {
      const fit = fitView(VP, size);
      expect(fit.k).toBeLessThan(READABLE_K);
      expect(v.k).toBe(READABLE_K);
      const first = index.graph.nodes.find((n) => n.kind === 'screen')!;
      expect(focus).toBe(layout.boxes.get(first.id));
      // 映した箱の左上は画面の中
      const sx = v.tx + focus.x * v.k;
      const sy = v.ty + focus.y * v.k;
      expect(sx).toBeGreaterThanOrEqual(0);
      expect(sx).toBeLessThan(VP.width);
      expect(sy).toBeGreaterThanOrEqual(VP.top);
      expect(sy).toBeLessThan(VP.height);
      // 図の外の空白は映さない（左上の端で止める）
      expect(v.tx).toBeLessThanOrEqual(20);
      expect(v.ty).toBeLessThanOrEqual(VP.top);
      expect(v.tx + size.w * v.k).toBeGreaterThanOrEqual(VP.width - 20);
    });
  });

  it('全体が 0.6 以上で収まる小さな graph は全体表示（モックを縮めた合成グラフ）', () => {
    const index = indexGraph(todayGraph());
    const layout = layoutWiring(index);
    const size = { w: layout.width, h: layout.height };
    const small: Viewport = { width: 4000, height: 3000, top: 44 };
    const v = openingView(small, size, openingFocus(index, layout));
    expect(v).toEqual(fitView(small, size));
    expect(v.k).toBeGreaterThanOrEqual(READABLE_K);
  });

  it('画面の箱が無ければ左上の箱（いちばん左の列のいちばん上）', () => {
    const g = todayGraph();
    g.nodes = g.nodes.filter((n) => n.kind !== 'screen');
    const ids = new Set(g.nodes.map((n) => n.id));
    g.wires = g.wires.filter((w) => ids.has(w.from.split('#')[0]!) && ids.has(w.to.split('#')[0]!));
    const index = indexGraph(g);
    const layout = layoutWiring(index);
    const f = openingFocus(index, layout)!;
    for (const b of layout.boxes.values()) {
      expect(b.x).toBeGreaterThanOrEqual(f.x);
      if (b.x === f.x) expect(b.y).toBeGreaterThanOrEqual(f.y);
    }
  });

  it('fitView は全体を中央に収める（左右 20px・上の帯・下 36px を避ける）', () => {
    const v = fitView(VP, { w: 2800, h: 1640 });
    expect(v.k).toBeCloseTo(Math.min(1400 / 2800, 820 / 1640));
    expect(v.tx).toBeCloseTo((1440 - 2800 * v.k) / 2);
    expect(v.ty).toBeCloseTo(44 + (856 - 1640 * v.k) / 2);
  });
});

describe('F キー', () => {
  const ev = (
    key: string,
    mods: Partial<Record<'ctrlKey' | 'metaKey' | 'altKey', boolean>> = {},
    target: unknown = null,
  ) => ({
    key,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    ...mods,
    target: target as EventTarget | null,
  });
  it('f / F で全体表示。⌘F・Ctrl+F・Alt+F（ページ内検索など）は奪わない', () => {
    expect(isFitKey(ev('f'))).toBe(true);
    expect(isFitKey(ev('F'))).toBe(true);
    expect(isFitKey(ev('f', { metaKey: true }))).toBe(false);
    expect(isFitKey(ev('f', { ctrlKey: true }))).toBe(false);
    expect(isFitKey(ev('f', { altKey: true }))).toBe(false);
    expect(isFitKey(ev('g'))).toBe(false);
  });
  it('文字を打つ欄の中では効かない。チェックボックス・スライダーの上では効く', () => {
    expect(isFitKey(ev('f', {}, { tagName: 'INPUT', type: 'text' }))).toBe(false);
    expect(isFitKey(ev('f', {}, { tagName: 'TEXTAREA' }))).toBe(false);
    expect(isFitKey(ev('f', {}, { tagName: 'DIV', isContentEditable: true }))).toBe(false);
    expect(isFitKey(ev('f', {}, { tagName: 'INPUT', type: 'checkbox' }))).toBe(true);
    expect(isFitKey(ev('f', {}, { tagName: 'INPUT', type: 'range' }))).toBe(true);
  });
});
