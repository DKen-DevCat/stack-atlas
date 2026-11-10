// 畳んだ表示の時刻と流れ・配置（docs/21 §2.3・§2.6・§3・§5.4。D129・D131）
import { describe, expect, it } from 'vitest';
import type { GraphV2 } from '@stack-atlas/schema';
import { containmentOf } from '../containment.js';
import {
  closeContainer,
  initialCut,
  normalizeCut,
  openContainer,
  slicesOf,
  type Cut,
} from '../cut.js';
import { foldView, litOn, segmentOn, type FoldView } from '../fold.js';
import {
  FOLD_HIDDEN,
  FOLD_WIDTH,
  flowOn,
  foldLayoutOptions,
  foldLengths,
  foldWidthOf,
} from '../fold-flow.js';
import { indexGraph, type GraphIndex } from '../graph-index.js';
import { defaultWidthOf, layoutWiring, segmentRoute } from '../layout/index.js';
import type { WiringLayout } from '../layout/types.js';
import { mapFlow, PULSE_MIN, type MapFlow } from '../map-flow.js';
import { projectMap } from '../project-map.js';
import { drawnBalls, schedule, type Schedule } from '../schedule.js';
import { select, type LitSelection } from '../select.js';
import { defaultState } from '../variants.js';
import { boxIds, load, pathCut, spikeCuts } from './fold-fixture.js';
import { boxOverlaps, hostOverlaps } from './metrics.js';
import { synthetic } from './synthetic.js';

// ビューアと同じ定数（packages/viewer の配線図の再生。SPEED 420・INNER 0.25・REST 0.6）
const SPEED = 420;
const opts = (lit: LitSelection) => ({
  speed: SPEED,
  inner: 0.25,
  rest: 0.6,
  startBoxes: lit.startBoxes,
});
const flatSched = (layout: WiringLayout, lit: LitSelection): Schedule =>
  schedule(lit, lit.flowStarts, {
    lengthOf: (s) => segmentRoute(layout, s)?.length ?? 0,
    ...opts(lit),
  });
const foldSched = (view: FoldView, layout: WiringLayout, lit: LitSelection, hidden?: number) =>
  schedule(lit, lit.flowStarts, {
    lengthOf: foldLengths(view, layout, {
      speed: SPEED,
      ...(hidden === undefined ? {} : { hidden }),
    }),
    ...opts(lit),
  });
const foldLayout = (v: FoldView) => layoutWiring(v.index, foldLayoutOptions(v));

function setup(graph: GraphV2) {
  const index = indexGraph(graph);
  const c = containmentOf(graph);
  const slice = slicesOf(index);
  return { graph, index, c, slice, view: (cut: Cut) => foldView(index, c, cut, slice) };
}
const poly = setup(load('poly-86'));
const cuts = spikeCuts(poly.c, poly.index, poly.slice);
const views = cuts.map(([label, cut]) => {
  const view = poly.view(cut);
  return { label, view, layout: foldLayout(view) };
});
const flat = layoutWiring(poly.index);
const sel = (index: GraphIndex, id: string) =>
  select(index, defaultState(index), { kind: 'box', id })!;

/** 地図で比べるもの: 球の数、球の載る（束 × 向き）、球になる線、脈動の数と線 */
const mapKey = (f: MapFlow) => ({
  n: f.balls.length,
  dirs: [...new Set(f.balls.map((b) => `${b.edge}|${b.reverse}`))].sort(),
  wires: [...new Set(f.balls.flatMap((b) => b.wires))].sort(),
  pulses: f.pulses.length,
  pulseWires: [...new Set(f.pulses.flatMap((b) => b.wires))].sort(),
});

describe('foldWidthOf・foldLengths', () => {
  it('畳んだ箱は幅 FOLD_WIDTH、ほかは今の既定の幅', () => {
    const { view, layout } = views[1]!;
    for (const b of layout.boxes.values()) {
      if (view.units.has(b.id)) expect(b.w).toBe(FOLD_WIDTH);
      else expect(b.w).toBe(flat.boxes.get(b.id)!.w);
    }
    const w = foldWidthOf(view, () => 7);
    expect(w(view.index.nodes.get('actor:user')!, 300)).toBe(7);
    expect(defaultWidthOf(view.index.nodes.get('actor:user')!, 300)).toBe(300);
  });

  it('何も畳まなければ今の配線図と同じ長さ。単位の中の線は hidden 秒ぶん（既定 0.25 秒）', () => {
    const lit = sel(poly.index, 'route:/');
    const all = poly.view(normalizeCut(poly.c, poly.c.containers.keys()));
    const len = foldLengths(all, flat, { speed: SPEED });
    for (const s of lit.segs)
      expect(len(s)).toBe(s.kind === 'wire' ? (segmentRoute(flat, s)?.length ?? 0) : 0);

    const { view, layout } = views[0]!;
    const hidden = lit.segs.filter(
      (s) => s.kind === 'wire' && view.lineOf.get(s.wire!.key) === null,
    );
    expect(hidden.length).toBeGreaterThan(0);
    const l0 = foldLengths(view, layout, { speed: SPEED });
    const l1 = foldLengths(view, layout, { speed: SPEED, hidden: 0.1 });
    for (const s of hidden) {
      expect(l0(s) / SPEED).toBeCloseTo(FOLD_HIDDEN, 12);
      expect(l1(s) / SPEED).toBeCloseTo(0.1, 12);
    }
    const sched = foldSched(view, layout, lit);
    for (const b of sched.balls) if (hidden.includes(b.seg)) expect(b.dur).toBeCloseTo(0.25, 12);
  });
});

describe('flowOn', () => {
  it('何も畳まなければ、球は今の drawnBalls と同じもの・同じ順で、脈動は無い', () => {
    const all = poly.view(normalizeCut(poly.c, poly.c.containers.keys()));
    for (const id of ['route:/', 'actor:user', 'fn:createTransaction']) {
      const lit = sel(poly.index, id);
      expect(litOn(all, lit)).toBe(lit);
      const sched = flatSched(flat, lit);
      const f = flowOn(all, sched);
      const drawn = drawnBalls(sched);
      expect(f.balls.map((b) => [b.seg, b.t0, b.dur])).toEqual(
        drawn.map((b) => [b.seg, b.t0, b.dur]),
      );
      expect(f.balls.every((b, i) => b.seg === drawn[i]!.seg)).toBe(true);
      expect(f.pulses).toEqual([]);
      expect(f.cycle).toBe(sched.cycle);
    }
  });

  it('畳んだ表示: 描く球の線は、どれも見えている線の球か畳んだ箱の脈動のどちらか 1 つに入る（球が消えない）', () => {
    for (const { view, layout } of views) {
      for (const id of ['route:/', 'actor:user']) {
        const lit = sel(poly.index, id);
        const sched = foldSched(view, layout, lit);
        const f = flowOn(view, sched);
        const want = drawnBalls(sched).flatMap((b) =>
          b.seg.kind === 'wire' ? [b.seg.wire!.key] : [],
        );
        const got = [...f.balls.flatMap((b) => b.wires), ...f.pulses.flatMap((p) => p.wires)];
        expect([...got].sort()).toEqual([...want].sort());
        for (const b of f.balls) {
          if (b.seg.kind === 'wire')
            expect(view.index.wires.some((w) => w.key === b.seg.wire!.key)).toBe(true);
          else expect(view.units.has(b.seg.node!.id)).toBe(false);
        }
        for (const p of f.pulses) {
          expect(view.units.has(p.unit)).toBe(true);
          expect(p.t1 - p.t0).toBeGreaterThanOrEqual(Math.min(PULSE_MIN, f.cycle - p.t0) - 1e-9);
          expect(p.t1).toBeLessThanOrEqual(f.cycle);
        }
        const t0s = f.balls.map((b) => b.t0);
        expect(t0s).toEqual([...t0s].sort((a, b) => a - b));
      }
    }
  });

  it('67 通りの選択 × 13 通りの切り口でも球は消えない。脈動になるのは単位の中の線だけ。この view の索引に無い線は描かない', () => {
    let balls = 0;
    for (const id of boxIds(poly.graph)) {
      const lit = sel(poly.index, id);
      for (const { view, layout } of views) {
        const sched = foldSched(view, layout, lit);
        const f = flowOn(view, sched);
        const want = drawnBalls(sched).flatMap((b) =>
          b.seg.kind === 'wire' ? [b.seg.wire!.key] : [],
        );
        const got = [...f.balls.flatMap((b) => b.wires), ...f.pulses.flatMap((p) => p.wires)];
        expect([...got].sort()).toEqual([...want].sort());
        for (const p of f.pulses) for (const w of p.wires) expect(view.lineOf.get(w)).toBeNull();
        balls += want.length;
      }
    }
    expect(balls).toBeGreaterThan(5000);
    // 索引に無い線（別の graph の schedule）の球は、脈動にも球にもしない
    const { view, layout } = views[0]!;
    const lit = sel(poly.index, 'route:/');
    const sched = foldSched(view, layout, lit);
    const b = sched.balls.find(
      (x) => x.seg.kind === 'wire' && view.lineOf.get(x.seg.wire!.key) === null,
    )!;
    const alien = {
      ...b,
      seg: { ...b.seg, key: 'w9999|x|y', wire: { ...b.seg.wire!, key: 'w9999' } },
    };
    const f = flowOn(view, { ...sched, balls: [alien] });
    expect(f).toEqual({ balls: [], pulses: [], cycle: sched.cycle });
  });

  it('segmentOn は同じ区間に同じものを返す（view ごとに覚える）。foldLengths は写した経路の長さ', () => {
    const { view, layout } = views[1]!;
    const a = sel(poly.index, 'route:/');
    const b = sel(poly.index, 'actor:user');
    const len = foldLengths(view, layout, { speed: SPEED });
    let shared = 0;
    for (const s of a.segs) {
      const on = segmentOn(view, s);
      expect(segmentOn(view, s)).toBe(on);
      if (s.kind === 'wire')
        expect(len(s)).toBe(on ? (segmentRoute(layout, on)?.length ?? 0) : FOLD_HIDDEN * SPEED);
      const other = b.segs.find((x) => x.key === s.key);
      if (other) {
        expect(segmentOn(view, other)).toBe(on);
        shared++;
      }
    }
    expect(shared).toBeGreaterThan(0);
    // 写した区間は litOn の区間と同じもの
    const lit = litOn(view, a);
    for (const s of lit.segs) expect(a.segs.some((x) => segmentOn(view, x) === s)).toBe(true);
  });

  it('route:/（8-6 の基準）: 13 通りの切り口のどれでも地図の球は 21。配線図の球と脈動は全部畳むと 6 と 15、初めの切り口で 13 と 8', () => {
    const lit = sel(poly.index, 'route:/');
    const p = projectMap(poly.graph);
    expect(mapFlow(p, flatSched(flat, lit)).balls).toHaveLength(21);
    const facts = views.map(({ view, layout }) => {
      const sched = foldSched(view, layout, lit);
      const f = flowOn(view, sched);
      expect(mapKey(mapFlow(p, sched)).pulses).toBe(0);
      return [
        mapFlow(p, sched).balls.length,
        f.balls.filter((b) => b.wires.length).length,
        f.pulses.length,
      ];
    });
    for (const [n] of facts) expect(n).toBe(21);
    expect(facts[0]!.slice(1)).toEqual([6, 15]);
    expect(facts[1]!.slice(1)).toEqual([13, 8]);
  });

  it('隠れた線の時間を 0 にすると、その線の球が地図から消える（mapFlow は時間 0 の球を捨てる）。0.1・0.5 秒では 21 のまま', () => {
    const lit = sel(poly.index, 'route:/');
    const p = projectMap(poly.graph);
    const { view, layout } = views[0]!;
    expect(mapFlow(p, foldSched(view, layout, lit, 0)).balls).toHaveLength(6);
    expect(mapFlow(p, foldSched(view, layout, lit, 0.1)).balls).toHaveLength(21);
    expect(mapFlow(p, foldSched(view, layout, lit, 0.5)).balls).toHaveLength(21);
  });

  it('67 通りの選択 × 13 通りの切り口: 地図で球の載る束と向き・球になる線・脈動は今と同じ。球の数は違う場合がある', () => {
    const p = projectMap(poly.graph);
    let total = 0;
    let sameCount = 0;
    const differs = new Set<string>();
    for (const id of boxIds(poly.graph)) {
      const lit = sel(poly.index, id);
      const base = mapKey(mapFlow(p, flatSched(flat, lit)));
      for (const { view, layout } of views) {
        const k = mapKey(mapFlow(p, foldSched(view, layout, lit)));
        total++;
        expect(k.dirs).toEqual(base.dirs);
        expect(k.wires).toEqual(base.wires);
        expect(k.pulses).toBe(base.pulses);
        expect(k.pulseWires).toEqual(base.pulseWires);
        if (k.n === base.n) sameCount++;
        else differs.add(id);
      }
    }
    // 見つかったことの固定: 時間の重なる球を 1 つにまとめるので、線の時間が変われば地図の球の数も変わりうる。
    // 871 通り中 785 で同じ、違う 86 通りは 8 つの選択で起きる。スパイク 2（docs/21 §5.4）は 783 / 88 だった。
    // 違い: スパイクは束を（from の端, to の端）だけで作り（戻りを分けない）、長さを線の両端の経路で取っていた。
    // 実装は戻りを別の束にし、長さを区間（子の項目のまま）を写した経路で取る
    expect(total).toBe(871);
    expect(sameCount).toBe(785);
    expect(differs.size).toBe(8);
  });

  it('再生位置: 割合で引き継ぐと（ビューアの rescaleTime と同じ式）、400 回開閉してもずれない', () => {
    // packages/viewer/src/wiring/balls.ts の rescaleTime の写し（wiring はビューアに依存しない）
    const rescale = (tau: number, oldCycle: number, newCycle: number) =>
      !(oldCycle > 0) || !(newCycle > 0) ? 0 : Math.min(1, Math.max(0, tau / oldCycle)) * newCycle;
    const lit = sel(poly.index, 'route:/');
    const a = foldSched(views[0]!.view, views[0]!.layout, lit).cycle;
    const b = foldSched(views[1]!.view, views[1]!.layout, lit).cycle;
    expect(a).not.toBe(b);
    const tau0 = 0.37 * a;
    let tau = tau0;
    let worst = 0;
    for (let i = 0; i < 400; i++) {
      const t = rescale(tau, a, b);
      worst = Math.max(worst, Math.abs(t / b - tau0 / a));
      tau = rescale(t, b, a);
    }
    expect(worst).toBeLessThan(1e-15);
    expect(Math.abs(tau - tau0)).toBeLessThan(1e-12);
  });
});

describe('配置（開閉のたびに今の配置で並べ直す。D131）', () => {
  it('(graph, 切り口) だけで決まる: 開く順に依らない・開いて閉じると元と同一', () => {
    const json = (l: WiringLayout) =>
      JSON.stringify([[...l.boxes], [...l.routes], l.width, l.height]);
    const a = openContainer(poly.c, openContainer(poly.c, new Set(), 'd:platform'), 'd:web/src');
    const b = openContainer(poly.c, openContainer(poly.c, new Set(), 'd:web/src'), 'd:platform');
    expect(json(foldLayout(poly.view(a)))).toBe(json(foldLayout(poly.view(b))));
    const init = initialCut(poly.c, poly.index, poly.slice);
    const before = json(foldLayout(poly.view(init)));
    for (const id of poly.c.containers.keys()) {
      const opened = openContainer(poly.c, init, id);
      if (opened.size === init.size) continue;
      foldLayout(poly.view(opened));
      expect(json(foldLayout(poly.view(closeContainer(poly.c, opened, id))))).toBe(before);
    }
  });

  it('全部の入れ物を 1 つずつ開いて落ちない。箱・枠は重ならない。見えている箱の項目は平らな配置と同じ組（順は変わりうる）', () => {
    const facts: Record<string, [number, number]> = {};
    for (const [name, s] of [
      ['poly-86', poly],
      ['合成 300', setup(synthetic())],
    ] as const) {
      const base = name === 'poly-86' ? flat : layoutWiring(s.index);
      const all: Cut[] = [
        new Set(),
        initialCut(s.c, s.index, s.slice),
        ...[...s.c.containers.keys()].map((id) => pathCut(s.c, id)),
      ];
      let boxes = 0;
      let reordered = 0;
      for (const cut of all) {
        const v = s.view(cut);
        const l = foldLayout(v);
        expect(boxOverlaps(l)).toEqual([]);
        expect(hostOverlaps(l)).toEqual([]);
        for (const b of l.boxes.values()) {
          if (v.units.has(b.id)) continue;
          const f = base.boxes.get(b.id)!;
          const items = (xs: (string | null)[]) => xs.filter((x): x is string => x !== null);
          expect([...items(b.ins)].sort()).toEqual([...items(f.ins)].sort());
          expect([...items(b.outs)].sort()).toEqual([...items(f.outs)].sort());
          boxes++;
          if (
            items(b.ins).join() !== items(f.ins).join() ||
            items(b.outs).join() !== items(f.outs).join()
          )
            reordered++;
        }
      }
      facts[name] = [boxes, reordered];
    }
    // 見つかったことの固定: 項目の行の順は配置が交差を減らすように決めるので、同じ箱でも切り口で変わる
    // （docs/21 §3 の「項目の順が平らな配置と同じ」は成り立たない。組は同じ）。（見えている箱の数, 順が変わった数）
    expect(facts).toEqual({ 'poly-86': [102, 25], '合成 300': [300, 260] });
  });
});

describe('速さ（CPU 時間。layout-perf.test.ts と同じ測り方）', () => {
  type Usage = NodeJS.CpuUsage;
  const threadCpu = (process as { threadCpuUsage?: (prev?: Usage) => Usage }).threadCpuUsage;
  const usage = (prev?: Usage): Usage =>
    threadCpu ? threadCpu.call(process, prev) : process.cpuUsage(prev);
  const cpuMs = (f: () => void) => {
    const t0 = usage();
    f();
    const d = usage(t0);
    return (d.user + d.system) / 1000;
  };

  it('合成 300: 初めの切り口（14 単位）と根を 1 段開いた切り口（58 単位）で、畳む ＋ 配置が 50ms 未満', () => {
    // 測った値（2026-11-10、手元）: 初めの切り口 6.5〜9.6ms、根を開いた切り口 19〜22ms（うち foldView 1〜2ms）
    const s = setup(synthetic());
    for (const [cut, units] of [
      [initialCut(s.c, s.index, s.slice), 14],
      [openContainer(s.c, new Set(), 'd:src'), 58],
    ] as const) {
      let n = 0;
      const run = () => {
        const v = s.view(cut);
        n = v.index.nodes.size - s.index.hosts.size;
        layoutWiring(v.index, { widthOf: foldWidthOf(v) });
      };
      run();
      run();
      const ms: number[] = [];
      for (let i = 0; i < 5; i++) ms.push(cpuMs(run));
      expect(n).toBe(units);
      expect(Math.min(...ms)).toBeLessThan(50);
    }
  });
});

describe('敵対的な入力', () => {
  it('空の schedule・切り口に無い線・時間 0 の線でも落ちない', () => {
    const { view, layout } = views[0]!;
    expect(flowOn(view, { balls: [], end: 0, cycle: 0, skipped: [] })).toEqual({
      balls: [],
      pulses: [],
      cycle: 0,
    });
    const lit = sel(poly.index, 'route:/');
    const sched = schedule(lit, lit.flowStarts, { lengthOf: () => 0, ...opts(lit) });
    const f = flowOn(view, sched);
    for (const p of f.pulses) expect(p.t1).toBeLessThanOrEqual(f.cycle);
    const len = foldLengths(view, layout);
    for (const s of lit.segs) expect(Number.isFinite(len(s))).toBe(true);
  });
});
