// 球の再生: 速さを変えても周回の中の同じ位置から続く（位相が飛ばない。2026-11-09 のレビュー指摘）
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { GraphV2 } from '@stack-atlas/schema';
import {
  defaultState,
  drawnBalls,
  indexGraph,
  layoutWiring,
  schedule,
  segmentRoute,
  select,
} from '@stack-atlas/wiring';
import { SAMPLE_V2_PATH } from '../graph/testSample';
import { cycleTime, layoutFlow, rescaleTime, stepKind, timing, type FlowRules } from './balls';

describe('rescaleTime', () => {
  it('周回の中の割合を保つ（速さ 2 倍で周期が半分なら時刻も半分）', () => {
    expect(rescaleTime(3, 10, 5)).toBeCloseTo(1.5);
    expect(rescaleTime(0, 10, 5)).toBe(0);
    expect(rescaleTime(10, 10, 20)).toBeCloseTo(20);
  });

  it('範囲の外は周回の端に収める。周期が 0 以下なら 0', () => {
    expect(rescaleTime(12, 10, 5)).toBeCloseTo(5);
    expect(rescaleTime(-1, 10, 5)).toBe(0);
    expect(rescaleTime(3, 0, 5)).toBe(0);
    expect(rescaleTime(3, 10, 0)).toBe(0);
  });
});

describe('速さを変えたときの球の位置', () => {
  const graph = JSON.parse(readFileSync(SAMPLE_V2_PATH, 'utf8')) as GraphV2;
  const index = indexGraph(graph);
  const layout = layoutWiring(index);
  const lit = select(index, defaultState(index), { kind: 'box', id: 'route:/' })!;
  const routes = new Map(lit.segs.map((s) => [s.key, segmentRoute(layout, s)]));
  const sched = (mul: number) =>
    schedule(lit, lit.flowStarts, {
      lengthOf: (s) => routes.get(s.key)?.length ?? 0,
      ...timing(mul),
      startBoxes: lit.startBoxes,
    });

  it('置き直した時刻では、どの球も前と同じ進み具合（区間の中の割合）にいる', () => {
    const a = sched(1);
    const b = sched(2.5);
    expect(b.cycle).toBeCloseTo(a.cycle / 2.5);
    expect(b.balls.length).toBe(a.balls.length);
    for (const f of [0.1, 0.37, 0.8]) {
      const tauA = a.cycle * f;
      const tauB = rescaleTime(tauA, a.cycle, b.cycle);
      a.balls.forEach((ba, i) => {
        const bb = b.balls[i]!;
        expect(bb.seg.key).toBe(ba.seg.key);
        if (ba.dur <= 0) return;
        expect((tauB - bb.t0) / bb.dur).toBeCloseTo((tauA - ba.t0) / ba.dur, 6);
      });
    }
  });
});

describe('球の規則（線の時間と描く球。場面から読む 2 つの入力。docs/18 §11.3）', () => {
  const graph = JSON.parse(readFileSync(SAMPLE_V2_PATH, 'utf8')) as GraphV2;
  const index = indexGraph(graph);
  const layout = layoutWiring(index);
  const state = { ...defaultState(index), 'infra:static_site/this#hit': true };
  const lits = [
    select(index, defaultState(index), { kind: 'box', id: 'route:/' })!,
    select(index, state, { kind: 'box', id: 'route:/' })!,
    select(index, defaultState(index), { kind: 'box', id: 'endpoint:POST /transactions' })!,
    // キャッシュの箱（箱の中の対応 = HIT の折り返しも描く）
    select(index, state, { kind: 'box', id: 'infra:static_site/this' })!,
  ];
  const sched = (lit: (typeof lits)[number], flow: FlowRules) =>
    schedule(lit, lit.flowStarts, {
      lengthOf: (s) => flow.lengthOf(s),
      ...timing(1),
      startBoxes: lit.startBoxes,
    });

  it('既定（layoutFlow）: 区間の長さは配置の経路の長さ。経路の無い区間は 0', () => {
    const flow = layoutFlow(layout);
    let wires = 0;
    for (const lit of lits)
      for (const s of lit.segs) {
        expect(flow.lengthOf(s), s.key).toBe(segmentRoute(layout, s)?.length ?? 0);
        if (s.kind === 'wire') wires++;
      }
    expect(wires).toBeGreaterThan(20);
  });

  it('既定: 描くのは線ごとに 1 球と、キャッシュの箱の中の対応だけ。道は配置の経路', () => {
    const flow = layoutFlow(layout);
    let inner = 0;
    for (const lit of lits) {
      const sc = sched(lit, flow);
      const drawn = flow.drawn(sc);
      const candidates = new Set(drawnBalls(sc));
      expect(drawn.size).toBeGreaterThan(0);
      const perWire = new Map<string, number>();
      for (const [ball, route] of drawn) {
        expect(candidates.has(ball)).toBe(true);
        const s = ball.seg;
        expect(s.kind === 'wire' || s.node?.node.kind === 'cache', s.key).toBe(true);
        expect(route).toEqual(segmentRoute(layout, s));
        if (s.kind === 'wire') perWire.set(s.wire!.key, (perWire.get(s.wire!.key) ?? 0) + 1);
        else inner++;
      }
      expect([...perWire.values()].every((n) => n === 1)).toBe(true);
      // 描かない球（箱の中の対応など）は入らない
      for (const ball of sc.balls)
        if (ball.seg.kind !== 'wire' && ball.seg.node?.node.kind !== 'cache')
          expect(drawn.has(ball)).toBe(false);
    }
    // HIT の折り返し（キャッシュの箱の中の対応）も描く
    expect(inner).toBeGreaterThan(0);
  });

  it('差し替えられる: 線の時間を変えると周期が変わり、描く球を変えると描く数が変わる（Player は場面の規則だけを読む）', () => {
    const base = layoutFlow(layout);
    const lit = lits[0]!;
    const a = sched(lit, base);
    // 例: 畳んだ場面は、線の時間を見えている線の経路長にする（ここでは半分の長さ）
    const half: FlowRules = {
      lengthOf: (s) => base.lengthOf(s) / 2,
      drawn: (sc) => base.drawn(sc),
    };
    const b = sched(lit, half);
    expect(b.cycle).toBeLessThan(a.cycle);
    expect(b.balls.length).toBe(a.balls.length);
    // 例: 見えている線の上の球だけ描く（ここでは最初の 3 つ）
    const few: FlowRules = {
      lengthOf: base.lengthOf,
      drawn: (sc) => new Map([...base.drawn(sc)].slice(0, 3)),
    };
    expect(few.drawn(a).size).toBe(3);
    expect(base.drawn(a).size).toBeGreaterThan(3);
  });
});

describe('再生の時刻（rAF の時刻から 1 周回の中へ。2026-11-10、8-7 の計測で見つけた）', () => {
  it('cycleTime: 始まりより前（フレームの始まりの時刻がクリックで決めた始まりより前）は 0。周回の末尾へ回り込まない', () => {
    // 直す前は ((t % c) + c) % c で、-0.004 秒が 4.996 秒（周回の末尾）になり、全部の球が出て着いた扱いになっていた
    expect(cycleTime(1000 - 4, 1000, 5)).toBe(0);
    expect(cycleTime(1000, 1000, 5)).toBe(0);
    expect(cycleTime(1000 + 1500, 1000, 5)).toBeCloseTo(1.5, 9);
    expect(cycleTime(1000 + 6500, 1000, 5)).toBeCloseTo(1.5, 9);
    expect(cycleTime(5000, 1000, 0)).toBe(0);
  });
  it('stepKind: 進んだ・周回の始まりに戻った・少しだけ戻った（シーク・再開の直後）を分ける', () => {
    expect(stepKind(-1, 0, 5)).toBe('forward'); // まだ前のフレームが無い
    expect(stepKind(1.2, 1.216, 5)).toBe('forward');
    expect(stepKind(1.2, 1.2, 5)).toBe('forward');
    expect(stepKind(4.98, 0.01, 5)).toBe('wrap');
    // seek(1.2) のあと、次のフレームの始まりの時刻が 4ms 前: 周回の始まりに戻ったとは読まない（直す前は戻ったと読み、
    // 1.2 秒までの球を全部もう一度出して光らせていた）
    expect(stepKind(1.2, 1.196, 5)).toBe('jitter');
    // 速さ ×4 で周回が短くても、1 フレームぶんの戻りは jitter
    expect(stepKind(0.3, 0.25, 1.2)).toBe('jitter');
    expect(stepKind(1.15, 0.02, 1.2)).toBe('wrap');
  });
});
