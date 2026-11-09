// 画面の部品の領域（docs/18 §3.3）: data-component の名前 → 箱 id（screenshots 抽出器と同じ規則。抽出器は core の再 export から
// これを使う。一致は extractors/screenshots の index.test.ts でも確かめる）、ビューポートでの切り詰め、graph の regions の優先
import { describe, expect, it } from 'vitest';
import { clipRegion, regionsOf, resolveRegionRef, resolveRegions } from '../regions.js';

/** screenshots 抽出器のテストと同じ表 */
export const REF_CASES: [string, string | undefined][] = [
  ['Header', 'comp:Header'],
  ['useSession', 'hook:useSession'],
  ['Dup', 'comp:Dup'],
  ['apiClient', 'lib:apiClient'],
  ['hook:useSession', 'hook:useSession'],
  ['Nope', undefined],
];
const IDS = ['comp:Header', 'hook:useSession', 'comp:Dup', 'hook:Dup', 'lib:apiClient', 'route:/'];

describe('resolveRegionRef', () => {
  it.each(REF_CASES)('%s → %s（comp: → hook: → 末尾一致、id そのものも可）', (name, want) => {
    expect(resolveRegionRef(name, IDS)).toBe(want);
    expect(resolveRegionRef(name, new Set(IDS))).toBe(want);
  });
  it('末尾一致は `:` の後ろ全体で比べる（部分一致しない）', () => {
    expect(resolveRegionRef('Client', ['lib:apiClient'])).toBeUndefined();
    expect(resolveRegionRef('apiClient', ['lib:x/apiClient'])).toBeUndefined();
  });
});

describe('clipRegion', () => {
  const vp = { width: 1280, height: 800 };
  it('ビューポートに切り詰めて整数に丸め、はみ出して面積 0 のもの・数でないものは捨てる', () => {
    expect(clipRegion({ x: 10.4, y: 20.6, w: 100.2, h: 50 }, vp)).toEqual({
      x: 10,
      y: 21,
      w: 101,
      h: 50,
    });
    expect(clipRegion({ x: -10, y: 700, w: 100, h: 300 }, vp)).toEqual({
      x: 0,
      y: 700,
      w: 90,
      h: 100,
    });
    expect(clipRegion({ x: 0, y: 900, w: 10, h: 10 }, vp)).toBeUndefined();
    expect(clipRegion({ x: 0, y: 0, w: 0, h: 10 }, vp)).toBeUndefined();
    expect(clipRegion({ x: Number.NaN, y: 0, w: 10, h: 10 }, vp)).toBeUndefined();
  });
});

describe('resolveRegions', () => {
  it('名前を箱 id に解き、解けない名前・空の名前・画面の外を落とす（同じ部品が 2 か所なら 2 つ）', () => {
    const got = resolveRegions(
      [
        { name: 'Header', x: 0, y: 0, w: 1280, h: 60 },
        { name: 'Nope', x: 0, y: 0, w: 10, h: 10 },
        { name: '', x: 0, y: 0, w: 10, h: 10 },
        { name: 'Dup', x: 0, y: 900, w: 10, h: 10 },
        { name: 'Dup', x: 10, y: 100, w: 20, h: 20 },
        { name: 'Dup', x: 40, y: 100, w: 20, h: 20 },
      ],
      IDS,
      { width: 1280, height: 800 },
    );
    expect(got).toEqual([
      { ref: 'comp:Header', x: 0, y: 0, w: 1280, h: 60 },
      { ref: 'comp:Dup', x: 10, y: 100, w: 20, h: 20 },
      { ref: 'comp:Dup', x: 40, y: 100, w: 20, h: 20 },
    ]);
  });
});

describe('regionsOf（graph の screen.regions が計測より優先）', () => {
  const measured = [{ ref: 'comp:A', x: 1, y: 2, w: 3, h: 4 }];
  it('graph の regions があればそれ（計測は使わない）', () => {
    const r = regionsOf(
      { width: 1280, height: 800, regions: [{ ref: 'comp:B', x: 10, y: 20, w: 30, h: 40 }] },
      measured,
    );
    expect(r).toEqual({ regions: [{ ref: 'comp:B', x: 10, y: 20, w: 30, h: 40 }], from: 'graph' });
  });
  it('graph の regions が無い・空なら計測、どちらも無ければ none', () => {
    expect(regionsOf({ width: 1280, height: 800 }, measured)).toEqual({
      regions: measured,
      from: 'measured',
    });
    expect(regionsOf({ width: 1280, height: 800, regions: [] }, measured).from).toBe('measured');
    expect(regionsOf(undefined, undefined)).toEqual({ regions: [], from: 'none' });
    expect(regionsOf({ width: 1280, height: 800 }, [])).toEqual({ regions: [], from: 'none' });
  });
  it('graph の regions は screen の座標から、範囲に収めたビューポートの座標に直して切り詰める', () => {
    // 幅 8192 は 4096 に収まる（半分）。高さも同じ比で
    const r = regionsOf(
      {
        width: 8192,
        height: 4096,
        regions: [
          { ref: 'comp:B', x: 100, y: 200, w: 300, h: 400 },
          { ref: 'comp:C', x: 0, y: 5000, w: 10, h: 10 },
        ],
      },
      undefined,
    );
    expect(r.regions).toEqual([{ ref: 'comp:B', x: 50, y: 100, w: 150, h: 200 }]);
  });
});
