// 画面の箱の中のビルド成果物の HTML（docs/18 §3.3）の規則: 層の変換、iframe の置き方、読み込みの規則（200px 以上・6 枚まで・
// 枠の外は外す）、src（graph.json からの相対パスだけ）、領域（graph の regions が優先、選んだ経路の部品だけ枠）、沈んだ画面、
// プレースホルダ
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { GraphV2 } from '@stack-atlas/schema';
import {
  indexGraph,
  layoutWiring,
  select,
  defaultState,
  type Rect,
  type ScreenRegion,
} from '@stack-atlas/wiring';
import { todayGraph, withScreenHtml } from '../../../wiring/src/__tests__/fixture';
import { DIM } from './dim';
import {
  DIM_OPACITY,
  frameBox,
  layerTransform,
  MAX_LIVE,
  MIN_LIVE_PX,
  placeholderText,
  planLive,
  renderRegions,
  screenOpacity,
  screenRegions,
  screenSpecs,
  screenSrc,
  toScreen,
  type ScreenSpec,
  type ScreenState,
} from './screens';

const PAGE = 'http://localhost:4173/?graph=out/graph.json';
const BASE = 'http://localhost:4173/out/graph.json';

describe('層の変換（SVG の g.view と同じ写像）', () => {
  it('CSS の translate(tx,ty) scale(k)（transform-origin 0 0）は点 p を (tx + k·p.x, ty + k·p.y) に写す', () => {
    const v = { k: 0.6, tx: 20, ty: -63.875 };
    expect(layerTransform(v)).toBe('translate(20px, -63.875px) scale(0.6)');
    // SVG の transform 属性（canvas.ts）と同じ順・同じ値
    const svgAttr = `translate(${v.tx},${v.ty}) scale(${v.k})`;
    const nums = (s: string) => (s.match(/-?[\d.]+/g) ?? []).map(Number);
    expect(nums(layerTransform(v))).toEqual(nums(svgAttr));
    const r: Rect = { x: 100, y: 200, w: 598, h: 373.75 };
    expect(toScreen(r, v)).toEqual({ x: 80, y: 56.125, w: 358.8, h: 224.25 });
  });

  it('iframe はビューポートの大きさで画面の領域の左上に置き、領域の幅に縮める（縦はビューポートの高さで切れる）', () => {
    const b = frameBox({ x: 533, y: 458, w: 598, h: 373.75 }, { width: 1280, height: 800 });
    expect(b).toEqual({
      left: 533,
      top: 458,
      width: 598,
      height: 373.75,
      frameWidth: 1280,
      frameHeight: 800,
      scale: 598 / 1280,
    });
    expect(b.frameHeight * b.scale).toBeCloseTo(b.height, 6);
  });
});

describe('読み込みの規則（planLive）', () => {
  const stage = { width: 1440, height: 900 };
  const at = (id: string, x: number, y: number, w = 598): Pick<ScreenSpec, 'id' | 'area'> => ({
    id,
    area: { x, y, w, h: (w * 800) / 1280 },
  });

  it('画面上の幅が 200px 以上の箱だけ（ちょうど 200 は読む）', () => {
    const specs = [at('a', 0, 0, 400)];
    expect(planLive(specs, { k: 0.5, tx: 0, ty: 0 }, stage)).toEqual(['a']);
    expect(planLive(specs, { k: 0.499, tx: 0, ty: 0 }, stage)).toEqual([]);
    expect(MIN_LIVE_PX).toBe(200);
  });

  it('表示の枠に掛からない箱は読まない（枠から外れたら外す）', () => {
    const specs = [
      at('in', 100, 100),
      at('right', 2000, 0),
      at('above', 0, -1000),
      at('edge', 1439, 0),
    ];
    expect(planLive(specs, { k: 1, tx: 0, ty: 0 }, stage).sort()).toEqual(['edge', 'in']);
    // 移動で枠から外れた
    expect(planLive(specs, { k: 1, tx: -3000, ty: 0 }, stage)).toEqual([]);
  });

  it('同時に 6 枚まで。見えている面積の大きい順、同じなら枠の中心に近い順', () => {
    const specs = Array.from({ length: 9 }, (_, i) =>
      at(`s${i}`, (i % 3) * 300, Math.floor(i / 3) * 200, 250),
    );
    const live = planLive(specs, { k: 1, tx: 0, ty: 0 }, stage);
    expect(live).toHaveLength(MAX_LIVE);
    expect(MAX_LIVE).toBe(6);
    // 一部だけ見える箱は後回し
    const partial = [at('half', 1300, 0), at('full', 0, 0)];
    expect(planLive(partial, { k: 1, tx: 0, ty: 0 }, stage)).toEqual(['full', 'half']);
    // 同じ面積なら中心に近い方
    const same = [at('far', 0, 0, 300), at('near', 570, 300, 300)];
    expect(planLive(same, { k: 1, tx: 0, ty: 0 }, stage, { max: 1 })).toEqual(['near']);
  });

  it('skip（src の無い画面・読めなかった画面）は読まない', () => {
    const specs = [at('a', 0, 0), at('b', 0, 400)];
    expect(planLive(specs, { k: 1, tx: 0, ty: 0 }, stage, { skip: new Set(['a']) })).toEqual(['b']);
  });
});

describe('screenSrc（graph.json からの相対パスだけ、同じ origin の graph.json のディレクトリの下）', () => {
  it('相対パスは graph.json の URL から解く', () => {
    expect(screenSrc('screens/index/index.html', BASE, PAGE)).toEqual({
      src: 'http://localhost:4173/out/screens/index/index.html',
    });
    expect(screenSrc('./screens/a%20b/index.html#x', BASE, PAGE)).toEqual({
      src: 'http://localhost:4173/out/screens/a%20b/index.html',
    });
  });
  it('graph.json をファイルで開いた（baseUrl が無い）なら読まない', () => {
    expect(screenSrc('screens/index/index.html', undefined, PAGE)).toEqual({ refusal: 'nobase' });
  });
  it.each([
    ['絶対 URL', 'https://evil.example/x.html'],
    ['プロトコル相対', '//evil.example/x.html'],
    ['javascript:', 'javascript:alert(1)'],
    ['data:', 'data:text/html,<b>x</b>'],
    ['ルートからのパス', '/screens/index/index.html'],
    ['graph.json のディレクトリの外', '../secret/index.html'],
    ['エンコードした ..', 'screens/%2e%2e/%2e%2e/x.html'],
    ['バックスラッシュ', 'screens\\..\\..\\x.html'],
    ['制御文字', 'java\tscript:alert(1)'],
    ['空', ''],
  ])('%s は読まない', (_n, html) => {
    expect(screenSrc(html, BASE, PAGE)).toEqual({ refusal: 'outside' });
  });
  it('graph.json がビューアと別の origin なら読まない', () => {
    expect(screenSrc('screens/a/index.html', 'https://other.example/graph.json', PAGE)).toEqual({
      refusal: 'outside',
    });
  });
});

describe('graph と配置から', () => {
  const g = withScreenHtml(todayGraph());
  const index = indexGraph(g);
  const layout = layoutWiring(index);
  const specs = screenSpecs(index, layout, BASE, PAGE);

  it('screenSpecs は screen.html のある画面の箱だけ（領域・ビューポート・src）', () => {
    expect(specs.map((s) => s.id)).toEqual(['screen:/today']);
    const s = specs[0]!;
    expect(s.area).toEqual(layout.boxes.get('screen:/today')!.screen);
    expect(s.viewport).toEqual({ width: 1280, height: 800 });
    expect(s.src).toBe('http://localhost:4173/out/screens/today/index.html');
    expect(s.refusal).toBeNull();
    // html の無い graph では空
    const plain = indexGraph(todayGraph());
    expect(screenSpecs(plain, layoutWiring(plain), BASE, PAGE)).toEqual([]);
    // ファイルで開いたときは src が無く、理由が nobase
    expect(screenSpecs(index, layout, undefined, PAGE)[0]).toMatchObject({
      src: null,
      refusal: 'nobase',
    });
  });

  const measured = new Map<string, ScreenRegion[]>([
    ['screen:/today', [{ ref: 'comp:TodayIsland', x: 100, y: 80, w: 400, h: 60 }]],
  ]);

  it('領域: graph の screen.regions が計測より優先、無ければ計測', () => {
    expect(screenRegions(index, specs, measured).get('screen:/today')).toEqual(
      measured.get('screen:/today'),
    );
    const g2 = structuredClone(g);
    g2.nodes.find((n) => n.id === 'screen:/today')!.screen!.regions = [
      { ref: 'comp:TotalCard', x: 10, y: 20, w: 30, h: 40 },
    ];
    const i2 = indexGraph(g2);
    const s2 = screenSpecs(i2, layoutWiring(i2), BASE, PAGE);
    expect(screenRegions(i2, s2, measured).get('screen:/today')).toEqual([
      { ref: 'comp:TotalCard', x: 10, y: 20, w: 30, h: 40 },
    ]);
    // 読めなかった画面（measured が無い）でも graph の regions で描ける
    expect(screenRegions(i2, s2, new Map()).get('screen:/today')).toHaveLength(1);
    expect(screenRegions(index, specs, new Map()).has('screen:/today')).toBe(false);
  });

  it('枠: 選んだ経路に入る部品だけ、画面の領域の上に縮めて描く（ラベル無し）。選択が無ければ描かない', () => {
    const regions = screenRegions(index, specs, measured);
    expect(renderRegions(specs, regions, null)).toBe('');
    const lit = select(index, defaultState(index), { kind: 'box', id: 'screen:/today' })!;
    expect(lit.boxes.has('comp:TodayIsland')).toBe(true);
    const svg = renderRegions(specs, regions, lit);
    const a = specs[0]!.area;
    const k = a.w / 1280;
    const n1 = (v: number) => Math.round(v * 10) / 10;
    expect(svg).toBe(
      `<rect class="region" data-region="comp:TodayIsland" data-screen="screen:/today" x="${n1(a.x + 100 * k)}" y="${n1(a.y + 80 * k)}" width="${n1(400 * k)}" height="${n1(60 * k)}" rx="2"/>`,
    );
    expect(svg).not.toContain('<text');
    // 経路に入らない部品は描かない
    const other = select(index, defaultState(index), { kind: 'box', id: 'trigger:scheduler' })!;
    expect(other.boxes.has('comp:TodayIsland')).toBe(false);
    expect(renderRegions(specs, regions, other)).toBe('');
  });

  it('枠は画面の領域の中に収める（ビューポートの下にはみ出す部品は下端で切る）', () => {
    const lit = select(index, defaultState(index), { kind: 'box', id: 'screen:/today' })!;
    const tall = new Map([
      ['screen:/today', [{ ref: 'comp:TodayIsland', x: 0, y: 700, w: 1280, h: 100 }]],
    ]);
    const m = /y="([\d.]+)" width="([\d.]+)" height="([\d.]+)"/.exec(
      renderRegions(specs, tall, lit),
    )!;
    const a = specs[0]!.area;
    expect(Number(m[1]) + Number(m[3])).toBeLessThanOrEqual(a.y + a.h + 0.1);
  });

  it('沈んだ画面は iframe の不透明度も沈んだ箱と同じに下げる', () => {
    // 2026-11-10 変更（8-7、D117・D122）: 前は style.css の `.wv .box.dim { opacity }` と突き合わせていた。
    // 沈んだ箱は class を持たず、根の has-sel と :not(.lit) で箱の係数（--bo）が決まる。値の正は dim.ts（CSS との整合は dim.test.ts）
    const css = readFileSync(new URL('./style.css', import.meta.url), 'utf8');
    const m = /\.wv\.has-sel \.box:not\(\.lit\) \{[^}]*--bo:\s*([\d.]+)/.exec(css);
    expect(Number(m?.[1])).toBe(DIM_OPACITY);
    expect(DIM_OPACITY).toBe(DIM.box);
    expect(screenOpacity(null, 'screen:/today')).toBe(1);
    const on = select(index, defaultState(index), { kind: 'box', id: 'screen:/today' })!;
    expect(screenOpacity(on, 'screen:/today')).toBe(1);
    const off = select(index, defaultState(index), { kind: 'box', id: 'trigger:scheduler' })!;
    expect(screenOpacity(off, 'screen:/today')).toBe(DIM_OPACITY);
  });
});

describe('プレースホルダ', () => {
  it('読めない理由ごとの文言。表示中は出さない', () => {
    const states: ScreenState[] = ['idle', 'loading', 'ready', 'blocked', 'nobase', 'outside'];
    const texts = states.map(placeholderText);
    expect(texts[2]).toBe('');
    for (const [i, t] of texts.entries())
      if (i !== 2) expect(t.length, states[i]).toBeGreaterThan(0);
    expect(new Set(texts).size).toBe(states.length);
  });
});

describe('基準の graph に画面の HTML（fixture-poly の build と同じ形）', () => {
  const BASELINE = new URL(
    '../../../wiring/src/__tests__/fixtures/poly-82a.v2.json',
    import.meta.url,
  );
  it('画面 3 枚。開いた直後（倍率 0.6）は全部 200px 以上で、6 枚の上限に入る', () => {
    const g = withScreenHtml(JSON.parse(readFileSync(BASELINE, 'utf8')) as GraphV2);
    const index = indexGraph(g);
    const specs = screenSpecs(index, layoutWiring(index), BASE, PAGE);
    expect(specs.map((s) => s.id).sort()).toEqual(['route:/', 'route:/calendar', 'route:/push']);
    for (const s of specs) expect(s.area.w * 0.6).toBeGreaterThanOrEqual(MIN_LIVE_PX);
  });
});
