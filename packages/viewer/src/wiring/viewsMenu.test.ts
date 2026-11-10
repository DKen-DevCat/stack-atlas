// views のメニュー（docs/18 §3.4）: 選択肢、選んだ view とほかを選んだら外れること、選んだ view の当て方、?view= で開いたときに映す所
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { GraphV2 } from '@stack-atlas/schema';
import { defaultState, indexGraph, layoutWiring } from '@stack-atlas/wiring';
import { SAMPLE_V2_PATH } from '../graph/testSample';
import { selectionFocus, ViewChoice, viewOptions, viewPick, VIEW_PLACEHOLDER } from './viewsMenu';

const graph = JSON.parse(readFileSync(SAMPLE_V2_PATH, 'utf8')) as GraphV2;
const index = indexGraph(graph);
const layout = layoutWiring(index);

describe('viewOptions', () => {
  it('先頭は空の選択肢、続いて views の宣言の順。views が無ければ空（メニューを出さない）', () => {
    expect(viewOptions(graph.views)).toEqual([
      { value: '', label: VIEW_PLACEHOLDER },
      { value: 'today', label: '今日の合計を見る', title: '/ を開いて今日の合計と明細が出るまで' },
      { value: 'today-cdn-hit', label: '今日の合計を見る（CloudFront HIT）' },
    ]);
    expect(viewOptions(undefined)).toEqual([]);
    expect(viewOptions([])).toEqual([]);
  });
});

describe('ViewChoice（選んでいる view）', () => {
  it('選ぶと id、ほかを選ぶ・分岐を変える（clear）と空に戻る。変わったときだけ通知する', () => {
    const log: (string | null)[] = [];
    const c = new ViewChoice(graph.views, (id) => log.push(id));
    expect(c.pick('today')!.start).toBe('route:/');
    expect(c.id).toBe('today');
    expect(c.pick('today-cdn-hit')!.start).toBe('actor:user');
    c.clear();
    c.clear();
    expect(c.id).toBeNull();
    // graph に無い id と空の選択は外す
    c.pick('today');
    expect(c.pick('nope')).toBeUndefined();
    expect(c.pick(null)).toBeUndefined();
    expect(log).toEqual(['today', 'today-cdn-hit', null, 'today', null]);
  });
});

describe('selectionFocus（?view= で開いた直後に映す所）', () => {
  it('箱・host の枠・項目の箱・線の送る側の箱。型と選択なしは null', () => {
    expect(selectionFocus(index, layout, { kind: 'box', id: 'actor:user' })).toBe(
      layout.boxes.get('actor:user'),
    );
    expect(selectionFocus(index, layout, { kind: 'host', id: 'infra:lambda_api/api' })).toBe(
      layout.hosts.get('infra:lambda_api/api'),
    );
    expect(selectionFocus(index, layout, { kind: 'item', ref: 'comp:EntryList#in/entries' })).toBe(
      layout.boxes.get('comp:EntryList'),
    );
    const w = graph.wires[4]!;
    expect(selectionFocus(index, layout, { kind: 'wire', from: w.from, to: w.to })).toBe(
      layout.boxes.get('route:/'),
    );
    expect(selectionFocus(index, layout, { kind: 'type', typeRef: 'type:Entry' })).toBeNull();
    expect(selectionFocus(index, layout, null)).toBeNull();
  });
});

describe('viewPick（メニューで選んだ view を当てる）', () => {
  const HIT = 'infra:static_site/this#hit';
  it('view は既定 ＋ variants と start。空の選択肢は分岐を既定に戻して選択なし（前の view の分岐を残さない）', () => {
    const hit = viewPick(
      index,
      graph.views!.find((v) => v.id === 'today-cdn-hit'),
    );
    expect(hit.state[HIT]).toBe(true);
    expect(hit.selection).toEqual({ kind: 'box', id: 'actor:user' });
    const none = viewPick(index, undefined);
    expect(none.selection).toBeNull();
    expect(none.state).toEqual(defaultState(index));
    expect(none.state[HIT]).toBe(false);
  });
});

describe('selectionFocus: 地図の group の選択（8-6 のモック）', () => {
  it('中の箱のうち配置にある最初の箱。どれも無ければ null', () => {
    expect(
      selectionFocus(index, layout, {
        kind: 'group',
        id: 'lib:x',
        members: ['fn:gone', 'fn:getToday', 'route:/'],
      }),
    ).toBe(layout.boxes.get('fn:getToday'));
    expect(
      selectionFocus(index, layout, { kind: 'group', id: 'lib:x', members: ['fn:gone'] }),
    ).toBeNull();
  });
});
