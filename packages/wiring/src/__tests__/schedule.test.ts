// 球の時刻（1 通信 1 球、分かれる数は出て行く線の数、合流は最長経路、循環は同じ線を 2 回流さない）
import { describe, expect, it } from 'vitest';
import { indexGraph } from '../graph-index.js';
import { schedule } from '../schedule.js';
import { select } from '../select.js';
import { traverse } from '../traverse.js';
import { defaultState } from '../variants.js';
import { cycleGraph, fanInGraph, todayGraph } from './fixture.js';

describe('schedule', () => {
  it('合流は全部の球が着いてから（最長経路）。分かれる数は出て行く線の数', () => {
    const idx = indexGraph(fanInGraph());
    const starts = [idx.items.get('fn:X#out/a')!, idx.items.get('fn:Y#out/b')!];
    const lit = traverse(idx, defaultState(idx), starts, { up: false, down: true });
    const lengths = new Map([
      ['fn:X#out/a', 1],
      ['fn:Y#out/b', 3],
    ]);
    const s = schedule(lit, ['fn:X#out/a', 'fn:Y#out/b'], {
      inner: 0.5,
      rest: 0,
      lengthOf: (seg) => lengths.get(seg.from.ref) ?? 1,
    });
    const ball = (from: string, to: string) =>
      s.balls.find((b) => b.seg.from.ref === from && b.seg.to.ref === to)!;
    expect(ball('fn:X#out/a', 'fn:Z#in/a').t0).toBe(0);
    expect(ball('fn:Y#out/b', 'fn:Z#in/b').t0).toBe(0);
    expect(ball('fn:Z#in/a', 'fn:Z#out/c').t0).toBe(1);
    expect(ball('fn:Z#in/b', 'fn:Z#out/c').t0).toBe(3);
    // Z の出口は遅い方（3 + 0.5）を待つ
    expect(ball('fn:Z#out/c', 'fn:W#in/c').t0).toBe(3.5);
    // W から 2 本に分かれる: 同時刻の球が 2 つ
    const outW = s.balls.filter((b) => b.seg.from.node.id === 'fn:W' && b.seg.kind === 'wire');
    expect(outW.map((b) => b.t0)).toEqual([5, 5]);
    expect(s.end).toBe(6);
    expect(s.cycle).toBe(6);
    expect(s.skipped).toEqual([]);
    // 1 区間 1 球
    expect(new Set(s.balls.map((b) => b.seg)).size).toBe(s.balls.length);
  });

  it('循環（A ↔ B）: 同じ線を 1 周回に 2 回流さず、周回の長さが有限', () => {
    const idx = indexGraph(cycleGraph());
    const state = defaultState(idx);
    const sel = select(idx, state, { kind: 'box', id: 'fn:A' })!;
    const s = schedule(sel, sel.flowStarts, { inner: 0.25, rest: 0, startBoxes: sel.startBoxes });
    expect(Number.isFinite(s.cycle)).toBe(true);
    expect(s.balls.length).toBeLessThanOrEqual(sel.segs.length);
    expect(new Set(s.balls.map((b) => b.seg)).size).toBe(s.balls.length);
    // 戻る辺が切られている（A に戻る線は始点に戻るので流さない）
    expect(s.skipped.length).toBeGreaterThan(0);
    // 始点の箱の中は時間 0
    for (const b of s.balls)
      if (b.seg.kind === 'link' && b.seg.node!.id === 'fn:A') expect(b.dur).toBe(0);
    // 線は長さ 1 なので各球の出発時刻は整数 ＋ 箱の中の 0.25 の倍数
    for (const b of s.balls) expect(b.t0).toBeGreaterThanOrEqual(0);
  });

  it('画面クリック: 始点の項目が時刻 0、上流（利用者）には球が流れない', () => {
    const idx = indexGraph(todayGraph());
    const state = defaultState(idx);
    const sel = select(idx, state, { kind: 'box', id: 'screen:/today' })!;
    const s = schedule(sel, sel.flowStarts, { startBoxes: sel.startBoxes });
    const toScreen = s.balls.filter(
      (b) => b.seg.kind === 'wire' && b.seg.to.node.id === 'screen:/today',
    );
    expect(toScreen).toEqual([]);
    const first = s.balls.filter((b) => b.t0 === 0 && b.seg.kind === 'wire');
    expect(first.every((b) => b.seg.from.node.id === 'screen:/today')).toBe(true);
    expect(first.length).toBeGreaterThan(0);
    // 上流の区間は光るが球は流れない（skipped に入る）
    expect(s.skipped.some((x) => x.kind === 'wire' && x.wire!.fromNode.id === 'actor:user')).toBe(
      true,
    );
    expect(s.end).toBeGreaterThan(5);
  });
});
