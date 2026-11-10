// 箱の縁から 6px 以内を通る線が無いこと（docs/18 §11.4・§11.10、Phase 8-7）。
// 8-7 から配線図の箱は全部 1 つの層で線の上に描く（選ぶたびに箱を層の間で動かさない）。光る線の当たり判定は幅 12px
// （線の左右 6px）なので、箱の縁から 6px 以内を光る線が通ると、そこだけ箱（と項目・ピン）のクリックが勝つ。
// 配置は縦のトラックを通り道の端から 12px 以上内側に置くので起きない、という見込みを事実として固定する。
// 差分の表示（幽霊の箱・項目・線を足した graph を配置する。docs/18 §3.4）も同じ配置なので同じ条件を当てる
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { GraphV2 } from '@stack-atlas/schema';
import { diffOverlayV2 } from '../diff.js';
import { indexGraph } from '../graph-index.js';
import { layoutWiring, type WiringLayout } from '../layout/index.js';
import { synthetic } from '../synthetic.js';
import { prevOfToday } from './diff-fixture.js';
import { withScreenHtml } from './fixture.js';
import { wiresNearBoxes, wiresThroughBoxes } from './metrics.js';

const read = (rel: string) =>
  JSON.parse(readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')) as GraphV2;
const baseline = () => read('./fixtures/poly-82a.v2.json');
const today = () => read('../../../../examples/fixture-poly.today.v2.json');

/** 差分の配置: 今の graph に前にしか無い箱・項目・線を足して、ビューアと同じ引数で配置する */
const overlay = (prev: GraphV2, next: GraphV2): WiringLayout => {
  const ov = diffOverlayV2(prev, next);
  return layoutWiring(indexGraph(ov.graph), { ghostItems: ov.ghost.items });
};

/** 今の graph から箱を 5 つに 1 つ抜く（抜いた箱とその線が幽霊になる） */
const thinned = (g: GraphV2): GraphV2 => {
  const boxes = g.nodes.filter((n) => n.ports.length > 0);
  const gone = new Set(boxes.filter((_, i) => i % 5 === 2).map((n) => n.id));
  const node = (ref: string) => ref.slice(0, ref.indexOf('#'));
  return {
    ...g,
    nodes: g.nodes.filter((n) => !gone.has(n.id)),
    wires: g.wires.filter((w) => !gone.has(node(w.from)) && !gone.has(node(w.to))),
  };
};

const cases: [string, () => WiringLayout][] = [
  ['基準の graph（poly-82a）', () => layoutWiring(indexGraph(baseline()))],
  ['/today の例', () => layoutWiring(indexGraph(today()))],
  ['基準の graph に画面の HTML', () => layoutWiring(indexGraph(withScreenHtml(baseline())))],
  ['/today の例に画面の HTML', () => layoutWiring(indexGraph(withScreenHtml(today())))],
  ['合成（箱 300・線 1000）', () => layoutWiring(indexGraph(synthetic()))],
  [
    '差分: /today の例と前の graph（幽霊の箱・項目・線）',
    () => overlay(prevOfToday(today()), today()),
  ],
  [
    '差分: 基準の graph から箱を 5 つに 1 つ抜いたもの',
    () => overlay(baseline(), thinned(baseline())),
  ],
  ['差分: 合成から箱を 5 つに 1 つ抜いたもの', () => overlay(synthetic(), thinned(synthetic()))],
];

describe.each(cases)('箱の縁から 6px 以内を通る線は無い: %s', (_name, make) => {
  const layout = make();

  it('線と箱がある', () => {
    expect(layout.boxes.size).toBeGreaterThan(0);
    expect(layout.routes.size).toBeGreaterThan(0);
  });

  it('箱を通る線 0、縁から 6px 以内を通る線 0', () => {
    expect(wiresThroughBoxes(layout)).toEqual([]);
    expect(wiresNearBoxes(layout, 6)).toEqual([]);
  });
});

describe('wiresNearBoxes の数え方', () => {
  const base = layoutWiring(indexGraph(today()));

  it('差分の配置には幽霊の箱と線が入っている（空の確かめになっていない）', () => {
    const ov = diffOverlayV2(prevOfToday(today()), today());
    expect(ov.ghost.nodes.size).toBeGreaterThan(0);
    expect(ov.ghost.wires.size).toBeGreaterThan(0);
    const l = layoutWiring(indexGraph(ov.graph), { ghostItems: ov.ghost.items });
    for (const id of ov.ghost.nodes) expect(l.boxes.has(id) || l.hosts.has(id)).toBe(true);
    for (const k of ov.ghost.wires) expect(l.routes.has(k)).toBe(true);
  });

  it('ピンへの出入りは数えないが、縁に沿って走る線・縁の近くを通る線は数える', () => {
    const [key, route] = [...base.routes.entries()][0]!;
    const box = [...base.boxes.values()].find(
      (b) =>
        !route.points.some((p) => p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.h),
    )!;
    const withRoute = (points: { x: number; y: number }[]): WiringLayout => ({
      ...base,
      broken: [],
      routes: new Map([[key, { points, length: 0 }]]),
      boxes: new Map([[box.id, box]]),
    });
    const right = box.x + box.w;
    const midY = box.y + box.h / 2;
    // 右の縁のピンから横に出て、12px 先で縦に曲がる: 数えない
    expect(
      wiresNearBoxes(
        withRoute([
          { x: right, y: midY },
          { x: right + 12, y: midY },
          { x: right + 12, y: box.y - 40 },
        ]),
      ),
    ).toEqual([]);
    // 4px 先で縦に曲がる: 縦の区間が縁から 6px 以内
    expect(
      wiresNearBoxes(
        withRoute([
          { x: right, y: midY },
          { x: right + 4, y: midY },
          { x: right + 4, y: box.y - 40 },
        ]),
      ),
    ).toHaveLength(1);
    // 縁の上を縦に走る（wiresThroughBoxes は数えない）
    const along = withRoute([
      { x: right, y: box.y - 40 },
      { x: right, y: box.y + box.h + 40 },
    ]);
    expect(wiresThroughBoxes(along)).toEqual([]);
    expect(wiresNearBoxes(along)).toHaveLength(1);
    // 上の縁の 5px 上を横に通る: 数える。6px ちょうどは数えない
    const above = (d: number) =>
      withRoute([
        { x: box.x - 40, y: box.y - d },
        { x: right + 40, y: box.y - d },
      ]);
    expect(wiresNearBoxes(above(5))).toHaveLength(1);
    expect(wiresNearBoxes(above(6))).toEqual([]);
  });
});
