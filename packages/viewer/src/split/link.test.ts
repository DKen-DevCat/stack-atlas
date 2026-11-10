// 2 面の写しの規則（docs/20 §5.1 #2・#6・#7・#12・#16・#17）。基準の graph は 8-6 の fixture-poly の build
// （packages/wiring/src/__tests__/fixtures/poly-86.v2.json）
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { GraphV2 } from '@stack-atlas/schema';
import {
  defaultState,
  indexGraph,
  litOnMap,
  projectMap,
  select,
  type Selection,
} from '@stack-atlas/wiring';
import { memoOrphans } from '../wiring/memoRules';
import { mapTargets, memoKeyOf, resolveSel, selectionForUnit, selParam, wiringOnly } from './link';

const g = JSON.parse(
  readFileSync(
    new URL('../../../wiring/src/__tests__/fixtures/poly-86.v2.json', import.meta.url),
    'utf8',
  ),
) as GraphV2;
const p = projectMap(g);
const index = indexGraph(g);
const state = defaultState(index);
const REQUEST = 'lib:web/src/feature/spend/request.ts';

describe('地図 → 配線図（selectionForUnit。§5.1 #7）', () => {
  it('箱そのもののノードは box、host は host、group は中の箱ごと（札の見出しは地図の名前）', () => {
    expect(selectionForUnit(p, 'route:/')).toEqual({ kind: 'box', id: 'route:/' });
    expect(selectionForUnit(p, 'infra:lambda_api/api')).toEqual({
      kind: 'host',
      id: 'infra:lambda_api/api',
    });
    expect(selectionForUnit(p, REQUEST)).toEqual({
      kind: 'group',
      id: REQUEST,
      members: ['fn:getToday', 'fn:getEntries', 'fn:createTransaction'],
      label: 'spend/request',
    });
    expect(selectionForUnit(p, 'lib:nope')).toBeNull();
  });

  it('@runtime の写しの group は、id（メモのキー）から @runtime を外し、中の箱はその写しのもの', () => {
    const q = projectMap({
      version: 2,
      nodes: [
        { id: 'fn:a', kind: 'fn', name: 'a', runtime: 'browser', ports: [], group: 'lib:shared' },
        { id: 'fn:b', kind: 'fn', name: 'b', runtime: 'server', ports: [], group: 'lib:shared' },
        { id: 'fn:c', kind: 'fn', name: 'c', runtime: 'server', ports: [], group: 'lib:shared' },
      ],
      wires: [],
    });
    expect(selectionForUnit(q, 'lib:shared@browser')).toMatchObject({
      kind: 'group',
      id: 'lib:shared',
      members: ['fn:a'],
    });
    // ?sel= には写しの id を書く（開き直すと同じ写しを選ぶ）
    expect(selParam(q, selectionForUnit(q, 'lib:shared@browser'))).toBe('lib:shared@browser');
    expect(memoKeyOf('lib:shared@browser')).toBe('lib:shared');
    expect(memoKeyOf('endpoint:GET /a@b')).toBe('endpoint:GET /a@b');
  });
});

describe('配線図 → 地図（litOnMap で写すだけ。§5.1 #6）', () => {
  it('fn:getToday（group の中の 1 箱）を選ぶと、地図はその group のノードが始点として光る', () => {
    const m = litOnMap(p, g, select(index, state, { kind: 'box', id: 'fn:getToday' })!);
    expect(m.starts).toEqual(new Set([REQUEST]));
    expect(m.nodes.has(REQUEST)).toBe(true);
  });

  it('地図から選んで配線図で写し直しても同じ（往復で変わらない）', () => {
    const sel = selectionForUnit(p, REQUEST)!;
    const m = litOnMap(p, g, select(index, state, sel)!);
    expect(m.starts).toEqual(new Set([REQUEST]));
    // ?sel= は地図のノードの id
    expect(selParam(p, sel)).toBe(REQUEST);
    expect(resolveSel(p, g, REQUEST)).toEqual(sel);
  });
});

describe('?sel=（§5.1 #16）', () => {
  it('地図のノード → host → 箱の順に解く。解けなければ null', () => {
    expect(resolveSel(p, g, 'route:/')).toEqual({ kind: 'box', id: 'route:/' });
    expect(resolveSel(p, g, 'infra:lambda_api/api')).toEqual({
      kind: 'host',
      id: 'infra:lambda_api/api',
    });
    // group の中の箱（地図のノードではない）は箱として
    expect(resolveSel(p, g, 'fn:getToday')).toEqual({ kind: 'box', id: 'fn:getToday' });
    expect(resolveSel(p, g, 'endpoint:GET /today')).toEqual({
      kind: 'box',
      id: 'endpoint:GET /today',
    });
    expect(resolveSel(p, g, 'fn:nope')).toBeNull();
    expect(resolveSel(p, g, '')).toBeNull();
  });

  it('URL エンコードした値（空白・/ を含む id）は URLSearchParams で戻ったものを解く', () => {
    const q = new URLSearchParams(`sel=${encodeURIComponent('endpoint:GET /today')}`);
    expect(resolveSel(p, g, q.get('sel')!)).toEqual({ kind: 'box', id: 'endpoint:GET /today' });
  });

  it('選択から書く値は箱・host・group だけ（項目・線・型は書かない）', () => {
    const cases: [Selection | null, string | null][] = [
      [{ kind: 'box', id: 'fn:getToday' }, 'fn:getToday'],
      [{ kind: 'box', id: 'fn:getToday', downOnly: true }, 'fn:getToday'],
      [{ kind: 'host', id: 'infra:lambda_api/api' }, 'infra:lambda_api/api'],
      [{ kind: 'item', ref: 'route:/#out/render_1' }, null],
      [{ kind: 'wire', from: 'a#out/x', to: 'b#in/y' }, null],
      [{ kind: 'type', typeRef: 'type:Entry' }, null],
      [null, null],
    ];
    for (const [sel, want] of cases) expect(selParam(p, sel)).toBe(want);
  });

  it('?pane=wiring で配線図だけ（§5.1 #17）', () => {
    expect(wiringOnly('?graph=x&pane=wiring')).toBe(true);
    expect(wiringOnly('?graph=x&pane=map')).toBe(false);
    expect(wiringOnly('?graph=x')).toBe(false);
  });
});

describe('孤立メモ（§5.1 #12）: v2 の箱 ∪ 型 ∪ group ∪ 地図のノード', () => {
  it('地図のノードを足すと、地図のノードのメモは孤立にならない', () => {
    const memos = { [REQUEST]: 'group のメモ', 'route:/': '画面', 'lib:gone': '消えた箱' };
    const extra = mapTargets(p).map((t) => t.id);
    expect(memoOrphans(index, memos, extra)).toEqual(['lib:gone']);
    // 地図のノードは箱・host・group のどれか（v2 の箱 ∪ group と重なる）
    expect(extra.every((id) => p.unitKind.has(id))).toBe(true);
  });
});
