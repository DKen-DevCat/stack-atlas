// 球の再生: 速さを変えても周回の中の同じ位置から続く（位相が飛ばない。2026-11-09 のレビュー指摘）
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { GraphV2 } from '@stack-atlas/schema';
import { indexGraph, layoutWiring, schedule, segmentRoute, select } from '@stack-atlas/wiring';
import { defaultState } from '@stack-atlas/wiring';
import { SAMPLE_V2_PATH } from '../graph/testSample';
import { rescaleTime, timing } from './balls';

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
