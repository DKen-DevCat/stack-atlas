// 画面の箱の大きさ（docs/18 §3.3、Phase 8-3b）: 幅は通常の 2 倍、高さは「ビューポートの比率の画面」と「項目の行」の大きい方。
// 画面の領域は名前の帯の下で、ビューアはここに画面の HTML を縮小して置く。screen.html の無い画面は 8-3a のまま。
// 測った値（2026-11-09。fixture-poly の画面 3 枚に 1280×800 の HTML を付けたもの = 8-3b の fixture-poly の build の出力）:
//   基準の graph（poly-82a）: 4656×2366（1.968、交差 425）→ 4568×2444（1.869、交差 457）
//   /today の例:             2676×1516（1.765、交差 50） → 2740×1526（1.795、交差 56）
// 交差の上限は実装時の値 ×1.1（切り上げ）。高さの条件（8-0 の 6486 の 50% 以下）も同じく満たす
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { GraphV2 } from '@stack-atlas/schema';
import { indexGraph } from '../graph-index.js';
import {
  layoutWiring,
  screenArea,
  screenViewport,
  hasScreenHtml,
  DEFAULT_VIEWPORT,
  SCREEN_INSET,
  VIEWPORT_MAX,
  VIEWPORT_MIN,
} from '../layout/index.js';
import { HEAD } from '../layout/model.js';
import { I, N, P, todayGraph, withScreenHtml } from './fixture.js';
import { boxOverlaps, countCrossings, hostOverlaps, wiresThroughBoxes } from './metrics.js';

const read = (rel: string) =>
  JSON.parse(readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')) as GraphV2;
const baseline = () => read('./fixtures/poly-82a.v2.json');
const today = () => read('../../../../examples/fixture-poly.today.v2.json');

describe('screenViewport', () => {
  it('screen の幅・高さ（整数に丸める）。無い・使えない値は 1280×800', () => {
    expect(screenViewport(undefined)).toEqual(DEFAULT_VIEWPORT);
    expect(screenViewport({ width: 1280, height: 800 })).toEqual({ width: 1280, height: 800 });
    expect(screenViewport({ width: 390.4, height: 844.6 })).toEqual({ width: 390, height: 845 });
    expect(screenViewport({ width: 0, height: -1 })).toEqual(DEFAULT_VIEWPORT);
    expect(screenViewport({ width: Number.NaN, height: Infinity })).toEqual(DEFAULT_VIEWPORT);
  });
  it('極端な値は範囲に収める（箱と iframe が巨大にならない）', () => {
    expect(screenViewport({ width: 1e9, height: 1e9 })).toEqual({
      width: VIEWPORT_MAX,
      height: VIEWPORT_MAX,
    });
    expect(screenViewport({ width: 10, height: 10 })).toEqual({
      width: VIEWPORT_MIN,
      height: VIEWPORT_MIN,
    });
    // 比を保って縮める・伸ばす
    expect(screenViewport({ width: 8192, height: 4096 })).toEqual({ width: 4096, height: 2048 });
    expect(screenViewport({ width: 3000, height: 6000 })).toEqual({ width: 2048, height: 4096 });
    expect(screenViewport({ width: 400, height: 120 })).toEqual({ width: 667, height: 200 });
    // 縦 / 横 は 0.25〜2.5
    expect(screenViewport({ width: 1280, height: 100000 })).toEqual({ width: 1280, height: 3200 });
    expect(screenViewport({ width: 1280, height: 1 })).toEqual({ width: 1280, height: 320 });
  });
});

describe('画面の箱の大きさ', () => {
  const index = indexGraph(withScreenHtml(todayGraph()));
  const layout = layoutWiring(index);
  const b = layout.boxes.get('screen:/today')!;

  it('screen.html のある画面の箱は幅 600、名前の帯の下にビューポートの比率の画面の領域', () => {
    expect(hasScreenHtml(index.nodes.get('screen:/today')!)).toBe(true);
    expect(b.w).toBe(600);
    const s = b.screen!;
    expect(s.x).toBe(b.x + SCREEN_INSET);
    expect(s.y).toBe(b.y + HEAD);
    expect(s.w).toBe(600 - 2 * SCREEN_INSET);
    expect(s.h).toBeCloseTo((s.w * 800) / 1280, 6);
    // 項目の行は 2 つで画面より低いので、高さは画面で決まる（下の枠の内側まで）
    expect(b.h).toBeCloseTo(HEAD + s.h + SCREEN_INSET, 6);
  });

  it('項目のピンは箱の縁（in は左辺、out は右辺）で、画面の上に重なる', () => {
    for (const ref of b.ins) if (ref) expect(layout.pins.get(ref)!.x).toBe(b.x);
    for (const ref of b.outs) if (ref) expect(layout.pins.get(ref)!.x).toBe(b.x + b.w);
    for (const ref of [...b.ins, ...b.outs]) {
      if (!ref) continue;
      const y = layout.pins.get(ref)!.y;
      expect(y).toBeGreaterThan(b.screen!.y);
      expect(y).toBeLessThan(b.screen!.y + b.screen!.h);
    }
  });

  it('項目の行が画面より高ければ、項目の行の高さ（画面の領域はビューポートの比率のまま）', () => {
    const g = withScreenHtml(todayGraph());
    const scr = g.nodes.find((n) => n.id === 'screen:/today')!;
    const many = Array.from({ length: 40 }, (_, i) => I(`p${i}`, 'string'));
    scr.ports[0]!.items.push(...many);
    const idx = indexGraph(g);
    const tall = layoutWiring(idx).boxes.get('screen:/today')!;
    expect(tall.screen!.h).toBeCloseTo((598 * 800) / 1280, 6);
    expect(tall.h).toBeGreaterThan(HEAD + tall.screen!.h + SCREEN_INSET);
    expect(tall.h).toBeGreaterThanOrEqual(HEAD + 8 + 42 * 18);
  });

  it('ビューポートの比率（スマホの縦長）で高さが変わる', () => {
    const idx = indexGraph(withScreenHtml(todayGraph(), { width: 390, height: 844 }));
    const s = layoutWiring(idx).boxes.get('screen:/today')!.screen!;
    expect(s.h / s.w).toBeCloseTo(844 / 390, 6);
  });

  it('screen.html の無い画面の箱・画面でない箱は画面の領域を持たず、高さは 8-3a のまま', () => {
    const plain = indexGraph(todayGraph());
    const a = layoutWiring(plain);
    const off = layoutWiring(plain, { screens: false });
    for (const [id, box] of a.boxes) {
      expect(box.screen, id).toBeUndefined();
      expect([box.x, box.y, box.w, box.h], id).toEqual(
        (({ x, y, w, h }) => [x, y, w, h])(off.boxes.get(id)!),
      );
    }
    // screenArea は画面でない箱・html の無い画面に null
    expect(screenArea(plain.nodes.get('screen:/today')!, 600, HEAD)).toBeNull();
    expect(screenArea(index.nodes.get('comp:TodayIsland')!, 300, HEAD)).toBeNull();
    // html が空文字は無いのと同じ
    const g = todayGraph();
    g.nodes.find((n) => n.id === 'screen:/today')!.screen = { html: '', width: 1280, height: 800 };
    expect(hasScreenHtml(indexGraph(g).nodes.get('screen:/today')!)).toBe(false);
  });

  it('画面でない kind に screen.html があっても画面の領域は取らない', () => {
    const g = todayGraph();
    const n = g.nodes.find((x) => x.kind === 'component')!;
    n.screen = { html: 'screens/x/index.html', width: 1280, height: 800 };
    const idx = indexGraph(g);
    expect(layoutWiring(idx).boxes.get(n.id)!.screen).toBeUndefined();
  });

  it('screenArea は箱の幅から決まる（幅を変える widthOf にも追う）', () => {
    const node = indexGraph(withScreenHtml(todayGraph())).nodes.get('screen:/today')!;
    expect(screenArea(node, 800, HEAD)).toEqual({
      x: SCREEN_INSET,
      y: HEAD,
      w: 798,
      h: (798 * 800) / 1280,
    });
    const wide = layoutWiring(indexGraph(withScreenHtml(todayGraph())), {
      widthOf: (n, w) => (n.node.kind === 'screen' ? w * 3 : w),
    }).boxes.get('screen:/today')!;
    expect(wide.w).toBe(900);
    expect(wide.screen!.w).toBe(898);
  });
});

describe.each([
  ['基準の graph（poly-82a）に画面の HTML', () => withScreenHtml(baseline()), 503],
  ['/today の例に画面の HTML', () => withScreenHtml(today()), 62],
])('受け入れ条件（画面の HTML あり）: %s', (_name, make, maxCrossings) => {
  const index = indexGraph(make());
  const layout = layoutWiring(index);

  it('screen.html のある画面の箱は全部、画面の領域を持ち、箱の中に収まる', () => {
    const screens = index.graph.nodes.filter((n) => n.kind === 'screen' && n.screen?.html);
    expect(screens.length).toBeGreaterThan(0);
    for (const n of screens) {
      const b = layout.boxes.get(n.id);
      if (!b) continue; // host の枠になる箱は箱として置かない
      const s = b.screen!;
      expect(s.x).toBeGreaterThanOrEqual(b.x);
      expect(s.y).toBeGreaterThanOrEqual(b.y);
      expect(s.x + s.w).toBeLessThanOrEqual(b.x + b.w);
      expect(s.y + s.h).toBeLessThanOrEqual(b.y + b.h);
    }
  });

  it('縦横比は 1:1.6〜2.2:1、重なり 0、箱を通る線 0', () => {
    const a = layout.width / layout.height;
    expect(a).toBeGreaterThanOrEqual(1 / 1.6);
    expect(a).toBeLessThanOrEqual(2.2);
    expect(boxOverlaps(layout)).toEqual([]);
    expect(hostOverlaps(layout)).toEqual([]);
    expect(wiresThroughBoxes(layout)).toEqual([]);
  });

  it(`直交の線分どうしの交差は ${maxCrossings} 以下（実装時の値 ×1.1）`, () => {
    expect(countCrossings(layout)).toBeLessThanOrEqual(maxCrossings);
  });
});

describe('受け入れ条件（画面の HTML あり）: 基準の graph の高さ', () => {
  it('8-0 の高さ（6486）の 50% 以下', () => {
    expect(layoutWiring(indexGraph(withScreenHtml(baseline())))!.height).toBeLessThanOrEqual(
      6486 * 0.5,
    );
  });
});

describe('N は使える（テストの補助の型の確認）', () => {
  it('画面の箱を手で作っても screen.html があれば画面の領域を取る', () => {
    const g: GraphV2 = {
      version: 2,
      nodes: [
        N('route:/a', 'screen', 'browser', [P('out', 'out', [I('x', 'string')])], {
          screen: { html: 'screens/a/index.html', width: 1280, height: 800 },
        }),
      ],
      wires: [],
    };
    const b = layoutWiring(indexGraph(g)).boxes.get('route:/a')!;
    expect(b.screen).toBeDefined();
    expect(b.h).toBeCloseTo(HEAD + (598 * 800) / 1280 + SCREEN_INSET, 6);
  });
});
