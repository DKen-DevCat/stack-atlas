// 名前付きの始点（views。docs/15 §3.9、docs/18 §3.4）: 分岐を既定に戻してから variants を当て、start から選ぶ
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { GraphV2 } from '@stack-atlas/schema';
import { indexGraph } from '../graph-index.js';
import { variantKey } from '../variants.js';
import { applyView, findView, viewSelection } from '../views.js';

const examplePath = fileURLToPath(
  new URL('../../../../examples/fixture-poly.today.v2.json', import.meta.url),
);
const graph = JSON.parse(readFileSync(examplePath, 'utf8')) as GraphV2;
const index = indexGraph(graph);
const HIT = variantKey('infra:static_site/this', 'hit');
const LOGIN = variantKey('endpoint:GET /today', 'login');

describe('views', () => {
  it('start: 箱・host の枠・項目・線。解けなければ null', () => {
    expect(viewSelection(index, 'route:/')).toEqual({ kind: 'box', id: 'route:/' });
    expect(viewSelection(index, 'infra:lambda_api/api')).toEqual({
      kind: 'host',
      id: 'infra:lambda_api/api',
    });
    expect(viewSelection(index, 'comp:EntryList#in/entries')).toEqual({
      kind: 'item',
      ref: 'comp:EntryList#in/entries',
    });
    const w = graph.wires[4]!;
    expect(viewSelection(index, { from: w.from, to: w.to })).toEqual({
      kind: 'wire',
      from: w.from,
      to: w.to,
    });
    expect(viewSelection(index, 'nope:x')).toBeNull();
    expect(viewSelection(index, { from: w.to, to: w.from })).toBeNull();
  });

  it('分岐は既定に戻してから view の variants を当てる（前の状態は持ち越さない）', () => {
    const today = findView(graph.views, 'today')!;
    const hit = findView(graph.views, 'today-cdn-hit')!;
    expect(findView(graph.views, 'nope')).toBeUndefined();
    const a = applyView(index, today);
    expect(a.selection).toEqual({ kind: 'box', id: 'route:/' });
    expect(a.state[HIT]).toBe(false);
    expect(a.state[LOGIN]).toBe(true);
    const b = applyView(index, hit);
    expect(b.selection).toEqual({ kind: 'box', id: 'actor:user' });
    expect(b.state[HIT]).toBe(true);
    // variants の無い view は既定のまま
    expect(applyView(index, { start: 'route:/' }).state).toEqual({
      [HIT]: false,
      [LOGIN]: true,
      [variantKey('endpoint:POST /transactions', 'login')]: true,
    });
  });
});
