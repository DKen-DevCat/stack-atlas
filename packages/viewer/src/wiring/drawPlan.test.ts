// 描く graph と配置（docs/18 §3.4）: 差分を足した graph を配置できないときは差分を外して描く、切れた線の端は幽霊の行に降りない
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { GraphV2 } from '@stack-atlas/schema';
import { indexGraph, type GraphIndex, type WiringLayout } from '@stack-atlas/wiring';
import { prevOfToday } from '../../../wiring/src/__tests__/diff-fixture';
import { SAMPLE_V2_PATH } from '../graph/testSample';
import { planDraw } from './drawPlan';

const read = () => JSON.parse(readFileSync(SAMPLE_V2_PATH, 'utf8')) as GraphV2;

// 配置は重いので 1 回ずつだけ（テストの中では配置しない）
const graph = read();
const index = indexGraph(graph);
const plain = planDraw(index, graph, undefined);
const withDiff = planDraw(index, graph, prevOfToday(graph));

/** 前の graph の受ける側（GET /today の body の entries）にだけ occurredAt がある。例の v2 の切れた線の path が指す子 */
function prevWithReceiverChild(): GraphV2 {
  const prev = structuredClone(graph);
  const body = prev.nodes
    .find((n) => n.id === 'endpoint:GET /today')!
    .ports.find((p) => p.id === 'res')!.items[0]!;
  const entries = body.children!.find((c) => c.id === 'entries')!;
  entries.children!.push({
    id: 'occurredAt',
    name: 'occurredAt',
    type: 'string',
    wireType: 'datetime',
  });
  return prev;
}
const withGhostChild = planDraw(index, graph, prevWithReceiverChild());

describe('planDraw', () => {
  it('前が無ければ今の索引で配置する。前が v2 なら幽霊を足した graph を配置する', () => {
    expect(plain.overlay).toBeNull();
    expect(plain.drawIndex).toBe(index);
    expect(plain.issue).toBeUndefined();
    expect(withDiff.overlay).not.toBeNull();
    // not.toBe は違うときに深い比較をする（索引は大きいので同一かどうかだけ見る）
    expect(withDiff.drawIndex === index).toBe(false);
    expect(withDiff.issue).toBeUndefined();
    for (const id of withDiff.overlay!.ghost.nodes)
      expect(withDiff.layout.boxes.has(id), id).toBe(true);
  });

  it('足した graph の配置が例外を投げたら（前の graph が敵対的）、差分を外して今の graph で描き、警告を 1 件返す', () => {
    const calls: GraphIndex[] = [];
    const hostile = (ix: GraphIndex): WiringLayout => {
      calls.push(ix);
      if (ix !== index) throw new Error('配置できない');
      return plain.layout;
    };
    const p = planDraw(index, graph, prevOfToday(graph), hostile);
    expect(calls).toHaveLength(2);
    expect(calls[1]).toBe(index);
    expect(p.overlay).toBeNull();
    expect(p.drawIndex).toBe(index);
    expect(p.layout).toBe(plain.layout);
    expect(p.issue).toEqual({
      level: 'warning',
      path: 'prev',
      message: '前回の graph.json と比べられないため差分は表示しません: 配置できない',
    });
  });

  it('前の graph と比べられない（壊れた項目）ときも同じく差分を外す', () => {
    const prev = structuredClone(graph);
    (prev.nodes[0]!.ports[0]!.items[0] as { children?: unknown }).children = 5;
    const p = planDraw(index, graph, prev, () => plain.layout);
    expect(p.overlay).toBeNull();
    expect(p.drawIndex).toBe(index);
    expect(p.issue?.path).toBe('prev');
  });

  it('今の graph の配置が投げる例外はそのまま投げる（配線図を描けない）', () => {
    const boom = () => {
      throw new Error('今の graph');
    };
    expect(() => planDraw(index, graph, undefined, boom)).toThrow('今の graph');
  });

  it('切れた線の端は幽霊の項目に降りない（?prev= が無いときと同じ所）', () => {
    const end = (l: WiringLayout) => l.broken.find((b) => b.path === 'entries.occurredAt')!.to;
    const ghost = 'endpoint:GET /today#res/body.entries.occurredAt';
    expect(withGhostChild.overlay!.ghost.items.has(ghost)).toBe(true);
    expect(withGhostChild.drawIndex.items.has(ghost)).toBe(true);
    expect(end(withGhostChild.layout)).toBe(end(plain.layout));
    expect(end(withGhostChild.layout)).toBe('endpoint:GET /today#res/body.entries');
  });
});
