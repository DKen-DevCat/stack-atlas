// 地図の流れ（D106。docs/20 §6・§7）: 配線図の schedule を地図の束の上の球と単位の脈動に写す
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { GraphV2, NodeV2 } from '@stack-atlas/schema';
import { indexGraph } from '../graph-index.js';
import { mapFlow, mapFlowAt, PULSE_MIN } from '../map-flow.js';
import { edgeKey, projectMap } from '../project-map.js';
import { drawnBalls, schedule } from '../schedule.js';
import { select, type Selection } from '../select.js';
import { defaultState } from '../variants.js';
import { I, N, P, W } from './fixture.js';

const box = (id: string, group?: string, extra: Partial<NodeV2> = {}) =>
  N(id, 'fn', 'browser', [P('in', 'in', [I('a', 'string')]), P('out', 'out', [I('r', 'string')])], {
    ...(group ? { group } : {}),
    ...extra,
  });

/**
 * 合成: lib:A の中に fn:a と fn:d、lib:B の中に fn:b と fn:c。a → b・a → c（同じ束へ扇形に、所要が違う）、
 * b → a の戻り（return の reply。束は逆向き。a の in/ret へ）、a → d（同じ単位の中）
 */
function small(): GraphV2 {
  return {
    version: 2,
    nodes: [
      N(
        'fn:a',
        'fn',
        'browser',
        [
          P('in', 'in', [I('a', 'string'), I('ret', 'string')]),
          P('out', 'out', [I('r', 'string')]),
        ],
        { group: 'lib:A' },
      ),
      box('fn:d', 'lib:A'),
      box('fn:b', 'lib:B'),
      box('fn:c', 'lib:B'),
    ],
    wires: [
      W('fn:a#out/r', 'fn:b#in/a', 'call'),
      W('fn:a#out/r', 'fn:c#in/a', 'call'),
      W('fn:b#out/r', 'fn:a#in/ret', 'return', true),
      W('fn:a#out/r', 'fn:d#in/a', 'call'),
    ],
  };
}

/** 線の所要は lengths（線のキー `w<i>` → 長さ。無ければ 1）÷ speed */
function scheduled(g: GraphV2, sel: Selection, speed = 1, lengths: Record<string, number> = {}) {
  const index = indexGraph(g);
  const lit = select(index, defaultState(index), sel)!;
  return schedule(lit, lit.flowStarts, {
    lengthOf: (s) => lengths[s.wire?.key ?? ''] ?? 1,
    speed,
    inner: 0.25 / speed,
    rest: 0.6 / speed,
    startBoxes: lit.startBoxes,
  });
}

describe('mapFlow（合成）', () => {
  const g = small();
  const p = projectMap(g);
  // a → b は 1、a → c は 3（同じ束で所要が違う）
  const sched = scheduled(g, { kind: 'box', id: 'fn:a' }, 1, { w0: 1, w1: 3 });
  const flow = mapFlow(p, sched);

  it('単位をまたぐ線は束の上の球。同じ束・同じ向きで時間の重なる球は 1 つ（t1 は遅い方）', () => {
    const fwd = flow.balls.filter((b) => !b.reverse);
    expect(fwd).toHaveLength(1);
    expect(fwd[0]).toMatchObject({
      edge: edgeKey('lib:A', 'lib:B'),
      from: 'lib:A',
      to: 'lib:B',
      t0: 0,
      t1: 3,
      wires: ['w0', 'w1'],
    });
  });

  it('戻りの線は束の向きと逆に進む（送る側の単位から受ける側の単位へ）', () => {
    const back = flow.balls.filter((b) => b.reverse);
    expect(back).toHaveLength(1);
    expect(back[0]).toMatchObject({ edge: edgeKey('lib:A', 'lib:B'), from: 'lib:B', to: 'lib:A' });
    // 戻りは b に着いてから（行きの a → b が 1 で着き、b の中を通って出る）
    expect(back[0]!.t0).toBeGreaterThanOrEqual(1);
    const at = mapFlowAt(flow, (back[0]!.t0 + back[0]!.t1) / 2);
    const mid = at.balls.find((x) => x.ball === back[0])!;
    expect(mid.progress).toBeCloseTo(0.5);
    expect(mid.along).toBeCloseTo(0.5);
    const early = mapFlowAt(flow, back[0]!.t0 + (back[0]!.t1 - back[0]!.t0) * 0.25).balls.find(
      (x) => x.ball === back[0],
    )!;
    // 束の向き（A → B）では 0.75 の所（B の側から A へ 1/4 進んだ）
    expect(early.along).toBeCloseTo(0.75);
  });

  it('同じ単位の中の線はそのノードの脈動（短い線でも PULSE_MIN だけ光る）', () => {
    expect(flow.pulses).toEqual([{ node: 'lib:A', t0: 0, t1: 1, wires: ['w3'] }]);
    const short = mapFlow(p, scheduled(g, { kind: 'box', id: 'fn:a' }, 1, { w3: 0.05 }));
    expect(short.pulses[0]!.t1 - short.pulses[0]!.t0).toBeCloseTo(PULSE_MIN);
    const at = mapFlowAt(flow, 0.5).pulses;
    expect(at).toHaveLength(1);
    expect(at[0]!.intensity).toBeCloseTo(1);
    expect(mapFlowAt(flow, 1).pulses).toEqual([]);
  });

  it('速さに追従する: 2 倍速の schedule から写すと、球の時刻は半分', () => {
    const fast = mapFlow(p, scheduled(g, { kind: 'box', id: 'fn:a' }, 2, { w0: 1, w1: 3 }));
    expect(fast.balls.map((b) => [b.t0, b.t1])).toEqual(
      flow.balls.map((b) => [b.t0 / 2, b.t1 / 2]),
    );
    expect(fast.cycle).toBeCloseTo(flow.cycle / 2);
  });
});

describe('mapFlow（fixture-poly の build。fixtures/poly-86.v2.json）', () => {
  const g = JSON.parse(
    readFileSync(fileURLToPath(new URL('./fixtures/poly-86.v2.json', import.meta.url)), 'utf8'),
  ) as GraphV2;
  const p = projectMap(g);
  const index = indexGraph(g);
  const lit = select(index, defaultState(index), { kind: 'box', id: 'route:/' })!;
  const sched = schedule(lit, lit.flowStarts, { startBoxes: lit.startBoxes });
  const flow = mapFlow(p, sched);

  it('見つかったこと: fixture-poly には同じ単位の中の線が無い（線はどれも単位をまたぐので、脈動は出ない）', () => {
    const unit = (ref: string) => p.unitOf.get(ref.slice(0, ref.indexOf('#')));
    expect(g.wires.filter((w) => unit(w.from) === unit(w.to))).toEqual([]);
  });

  it('route:/ を選ぶ: 単位をまたぐ線の球は束の上へ、同じ単位の中の線は脈動へ。どの線も一度ずつ', () => {
    const drawn = drawnBalls(sched).filter((b) => b.seg.kind === 'wire');
    const cross = drawn.filter(
      (b) => p.unitOf.get(b.seg.from.node.id) !== p.unitOf.get(b.seg.to.node.id),
    );
    const inner = drawn.filter(
      (b) => p.unitOf.get(b.seg.from.node.id) === p.unitOf.get(b.seg.to.node.id),
    );
    expect(cross.length).toBeGreaterThan(0);
    expect(inner).toEqual([]);
    const ballWires = flow.balls.flatMap((b) => b.wires).sort();
    const pulseWires = flow.pulses.flatMap((q) => q.wires).sort();
    expect(ballWires).toEqual(cross.map((b) => b.seg.wire!.key).sort());
    expect(pulseWires).toEqual(inner.map((b) => b.seg.wire!.key).sort());
    // まとめたので球は線より少ないか同じ。束はどれも地図にある
    expect(flow.balls.length).toBeLessThanOrEqual(cross.length);
    for (const b of flow.balls) expect(p.edges.has(b.edge)).toBe(true);
    // 最初の球は画面（route:/）から出る（始点の白い輪と同じ所）
    expect(flow.balls[0]!.from).toBe('route:/');
    expect(flow.balls[0]!.t0).toBe(0);
    expect(flow.cycle).toBe(sched.cycle);
  });

  it('シークに追従する: どの時刻でも、1 本の線だけの球の進み具合は配線図の球と同じ', () => {
    const single = flow.balls.filter((b) => b.wires.length === 1);
    expect(single.length).toBeGreaterThan(0);
    const byKey = new Map(drawnBalls(sched).map((b) => [b.seg.wire?.key, b]));
    for (const tau of [0.1, 0.7, 1.3, sched.end * 0.5, sched.end * 0.9]) {
      const at = mapFlowAt(flow, tau);
      for (const x of at.balls.filter((y) => y.ball.wires.length === 1)) {
        const wb = byKey.get(x.ball.wires[0])!;
        expect(x.progress).toBeCloseTo((tau - wb.t0) / wb.dur);
      }
      // 見えている球は、その時刻に配線図で走っている線の球
      for (const x of at.balls)
        expect(
          x.ball.wires.some((w) => {
            const wb = byKey.get(w)!;
            return tau >= wb.t0 && tau < wb.t0 + wb.dur;
          }),
        ).toBe(true);
    }
  });
});
