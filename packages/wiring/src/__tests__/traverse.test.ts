// たどる規則（docs/15 §3.5 の 7 操作、2 段の戻りの絞り込み、分岐、親子の写し）
import { describe, expect, it } from 'vitest';
import { indexGraph } from '../graph-index.js';
import { select } from '../select.js';
import { traverse } from '../traverse.js';
import { defaultState } from '../variants.js';
import { cycleGraph, todayGraph } from './fixture.js';

const index = indexGraph(todayGraph());
const state0 = defaultState(index);

const boxes = (sel: ReturnType<typeof select>) => [...(sel?.boxes ?? [])].sort();

describe('select: 7 操作', () => {
  it('箱をクリック: 下流＋上流が光り、別経路（Scheduler → notify）は光らない', () => {
    const lit = select(index, state0, { kind: 'box', id: 'screen:/today' })!;
    const b = lit.boxes;
    for (const id of [
      'actor:user',
      'screen:/today',
      'comp:TodayIsland',
      'comp:TotalCard',
      'comp:EntryList',
      'hook:useToday',
      'cache:swr',
      'lib:fetcher',
      'endpoint:GET /today',
      'fn:api.handleToday',
      'fn:store.ListEntries',
      'table:entries',
    ]) {
      expect(b.has(id), id).toBe(true);
    }
    for (const id of ['fn:notify.Run', 'trigger:scheduler', 'external:gmail', 'comp:LoginPrompt']) {
      expect(b.has(id), id).toBe(false);
    }
    expect(lit.startBoxes).toEqual(new Set(['screen:/today']));
    // 分岐で存在しない項目（login: false の render_login）は球の始点にならない
    expect(lit.flowStarts.has('screen:/today#out/render_login')).toBe(false);
    expect(lit.flowStarts.has('screen:/today#out/props_date')).toBe(true);
  });

  it('項目をクリック: その項目の上流と下流だけ（total は entries の経路を光らせない）', () => {
    const lit = select(index, state0, { kind: 'item', ref: 'comp:TodayIsland#in/total' })!;
    expect(lit.items.has('comp:TotalCard#in/total')).toBe(true);
    expect(lit.items.has('hook:useToday#out/total')).toBe(true);
    expect(lit.items.has('cache:swr#out/value.total')).toBe(true);
    expect(lit.items.has('endpoint:GET /today#out/body.total')).toBe(true);
    expect(lit.items.has('fn:api.handleToday#out/resp.total')).toBe(true);
    expect(lit.items.has('fn:api.handleToday#in/rows')).toBe(true);
    expect(lit.items.has('table:entries#read/row')).toBe(true);
    // 子が光れば親も光る
    expect(lit.items.has('cache:swr#out/value')).toBe(true);
    // entries 側は光らない
    expect(lit.items.has('comp:TodayIsland#in/entries')).toBe(false);
    expect(lit.items.has('hook:useToday#out/entries')).toBe(false);
    expect(lit.boxes.has('comp:EntryList')).toBe(false);
    expect(lit.boxes.has('fn:notify.Run')).toBe(false);
  });

  it('光っている線をクリック: その線から下流だけ', () => {
    const lit = select(index, state0, {
      kind: 'wire',
      from: 'hook:useToday#out/total',
      to: 'comp:TodayIsland#in/total',
    })!;
    expect(boxes(lit)).toEqual(['comp:TodayIsland', 'comp:TotalCard', 'hook:useToday']);
    expect(lit.startSeg).toBeDefined();
    expect(lit.segs[0]!.key).toBe(lit.startSeg);
    expect(lit.flowStarts).toEqual(new Set(['hook:useToday#out/total']));
  });

  it('光っている箱をクリック（downOnly）: 上流が消える', () => {
    const lit = select(index, state0, { kind: 'box', id: 'hook:useToday', downOnly: true })!;
    expect(lit.boxes.has('comp:TotalCard')).toBe(true);
    expect(lit.boxes.has('table:entries')).toBe(true);
    expect(lit.boxes.has('screen:/today')).toBe(false);
    expect(lit.boxes.has('actor:user')).toBe(false);
  });

  it('型をクリック: 同じ typeRef の項目が全部光り、線はたどらない（横断面）', () => {
    const lit = select(index, state0, { kind: 'type', typeRef: 'table:entries' })!;
    expect(lit.flows).toBe(false);
    expect(lit.segs).toEqual([]);
    expect(lit.items.has('table:entries#read/row')).toBe(true);
    expect(lit.items.has('table:entries#read/row.amount')).toBe(true);
    expect(lit.items.has('table:entries#key/date')).toBe(true);
    // Go の Row（store.Row）はテーブルの行型の写しなので typeRef table:entries を持つ → 横断面に入る
    expect(boxes(lit)).toEqual([
      'fn:api.handleToday',
      'fn:notify.Run',
      'fn:store.ListEntries',
      'table:entries',
    ]);
    const entry = select(index, state0, { kind: 'type', typeRef: 'type:Entry' })!;
    expect(entry.boxes.has('fn:api.handleToday')).toBe(true);
    expect(entry.boxes.has('comp:EntryList')).toBe(true);
    expect(entry.boxes.has('comp:TotalCard')).toBe(false);
  });

  it('host の枠をクリック: 中の箱ごとに独立にたどって合併（notify 側も光る）', () => {
    const lit = select(index, state0, { kind: 'host', id: 'infra:lambda-api' })!;
    expect(lit.startBoxes).toEqual(new Set(['fn:api.handleToday', 'fn:store.ListEntries']));
    for (const id of [
      'screen:/today',
      'fn:notify.Run',
      'trigger:scheduler',
      'external:gmail',
      'table:entries',
    ]) {
      expect(lit.boxes.has(id), id).toBe(true);
    }
  });

  it('存在しない選択は null', () => {
    expect(select(index, state0, { kind: 'box', id: 'fn:nope' })).toBeNull();
    expect(select(index, state0, { kind: 'item', ref: 'fn:nope#in/x' })).toBeNull();
    expect(select(index, state0, { kind: 'wire', from: 'a#in/x', to: 'b#in/y' })).toBeNull();
  });
});

describe('2 段のたどり（D43）: 複数から呼ばれる箱の戻り', () => {
  it('ListEntries を選ぶと、呼び出し元の両方（handleToday と notify.Run）に戻る', () => {
    const lit = select(index, state0, { kind: 'box', id: 'fn:store.ListEntries' })!;
    expect(lit.boxes.has('fn:api.handleToday')).toBe(true);
    expect(lit.boxes.has('fn:notify.Run')).toBe(true);
    expect(lit.boxes.has('screen:/today')).toBe(true);
    expect(lit.boxes.has('external:gmail')).toBe(true);
  });

  it('画面を選ぶと戻りは handleToday だけ。Scheduler から選ぶと notify だけ', () => {
    const fromScreen = select(index, state0, { kind: 'box', id: 'screen:/today' })!;
    expect(fromScreen.boxes.has('fn:notify.Run')).toBe(false);
    const fromScheduler = select(index, state0, { kind: 'box', id: 'trigger:scheduler' })!;
    expect(fromScheduler.boxes.has('fn:notify.Run')).toBe(true);
    expect(fromScheduler.boxes.has('fn:store.ListEntries')).toBe(true);
    expect(fromScheduler.boxes.has('table:entries')).toBe(true);
    expect(fromScheduler.boxes.has('fn:api.handleToday')).toBe(false);
    expect(fromScheduler.boxes.has('screen:/today')).toBe(false);
  });

  it('結果は線の宣言順に依らない（線を逆順にしても同じ箱）', () => {
    const g = todayGraph();
    g.wires.reverse();
    const idx2 = indexGraph(g);
    const a = select(index, state0, { kind: 'box', id: 'screen:/today' })!;
    const b = select(idx2, defaultState(idx2), { kind: 'box', id: 'screen:/today' })!;
    expect([...b.boxes].sort()).toEqual([...a.boxes].sort());
    expect([...b.items].sort()).toEqual([...a.items].sort());
  });
});

describe('分岐（variants / when）', () => {
  it('login=false: LoginPrompt が光り、TodayIsland は光らない', () => {
    const state = { ...state0, 'screen:/today#login': false };
    const lit = select(index, state, { kind: 'box', id: 'screen:/today' })!;
    expect(lit.boxes.has('comp:LoginPrompt')).toBe(true);
    expect(lit.boxes.has('comp:TodayIsland')).toBe(false);
    expect(lit.boxes.has('hook:useToday')).toBe(false);
  });

  it('date=false: date の経路が消えて fetch まで届かない', () => {
    const state = { ...state0, 'screen:/today#date': false };
    const lit = select(index, state, { kind: 'box', id: 'screen:/today' })!;
    expect(lit.boxes.has('comp:TodayIsland')).toBe(true); // render は login だけに依る
    expect(lit.boxes.has('hook:useToday')).toBe(false);
    expect(lit.items.has('screen:/today#in/query_date')).toBe(false);
  });

  it('SWR hit=true: キャッシュで折り返し、fetcher 以降は光らない。親で届いた value は辺を持つ子だけ降りる', () => {
    const state = { ...state0, 'cache:swr#hit': true };
    const lit = select(index, state, { kind: 'box', id: 'screen:/today' })!;
    expect(lit.boxes.has('cache:swr')).toBe(true);
    expect(lit.boxes.has('comp:TotalCard')).toBe(true);
    expect(lit.boxes.has('lib:fetcher')).toBe(false);
    expect(lit.boxes.has('endpoint:GET /today')).toBe(false);
    expect(lit.items.has('cache:swr#out/value')).toBe(true);
    expect(lit.items.has('cache:swr#in/value')).toBe(false);
    // useToday の in/data の子は固有の links（data.total → total）を持つので降りる
    expect(lit.items.has('hook:useToday#in/data.total')).toBe(true);
    expect(lit.items.has('hook:useToday#out/total')).toBe(true);
  });
});

describe('親子の写し', () => {
  it('改名の links（created_at → createdAt）を持つ子は、親の links ではなくその links でたどる', () => {
    const lit = select(index, state0, { kind: 'item', ref: 'table:entries#read/row.created_at' })!;
    expect(lit.items.has('fn:store.ListEntries#in/row.created_at')).toBe(true);
    expect(lit.items.has('fn:api.handleToday#in/rows.created_at')).toBe(true);
    expect(lit.items.has('fn:api.handleToday#out/resp.entries.createdAt')).toBe(true);
    expect(lit.items.has('endpoint:GET /today#res/body.entries.createdAt')).toBe(true);
    expect(lit.items.has('comp:EntryList#in/entries.createdAt')).toBe(true);
    expect(lit.items.has('comp:EntryList#in/entries.amount')).toBe(false);
    // rows → resp.total の親の links は使われない
    expect(lit.items.has('fn:api.handleToday#out/resp.total')).toBe(false);
    expect(lit.boxes.has('comp:TotalCard')).toBe(false);
  });

  it('固有の辺を持たない子は、親の辺に乗って相手側の同名の子へ写る（無ければ親へ落ちる）', () => {
    const lit = select(index, state0, { kind: 'item', ref: 'table:entries#read/row.amount' })!;
    expect(lit.items.has('fn:api.handleToday#out/resp.entries.amount')).toBe(true);
    // rows → resp.total の親の links は total（子が無い）へ落ちる
    expect(lit.items.has('fn:api.handleToday#out/resp.total')).toBe(true);
    expect(lit.items.has('comp:TotalCard#in/total')).toBe(true);
    expect(lit.items.has('comp:EntryList#in/entries.amount')).toBe(true);
    expect(lit.items.has('comp:EntryList#in/entries.createdAt')).toBe(false);
  });
});

describe('循環', () => {
  it('A ↔ B の呼び合いでも不動点で止まる', () => {
    const idx = indexGraph(cycleGraph());
    const lit = traverse(idx, defaultState(idx), idx.nodes.get('fn:A')!.roots, {
      up: true,
      down: true,
    });
    expect([...lit.boxes].sort()).toEqual(['fn:A', 'fn:B']);
    expect(lit.wires.size).toBe(4);
  });
});
