// たどる規則（docs/15 §3.5 の 7 操作、2 段の戻りの絞り込み、分岐、親子の写し）
import { describe, expect, it } from 'vitest';
import { indexGraph } from '../graph-index.js';
import { select } from '../select.js';
import { traverse } from '../traverse.js';
import { defaultState } from '../variants.js';
import type { GraphV2 } from '@stack-atlas/schema';
import { cycleGraph, I, L, N, P, todayGraph, W } from './fixture.js';

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

describe('2 段のたどり: 「全員へ」は光る箱が増えなくなってから決める（8-1 のレビュー）', () => {
  /**
   * 箱の単位の小さな graph（fixture-repo の apiClient / useSession の形）:
   * 共有の S を A と B が呼ぶ（call / return）。A は部品 C を描き（render）、C と D は共有の H を呼ぶ（call / return）。
   * D（Header）は S を使わない
   */
  const box = (id: string, kind: 'fn' | 'helper' | 'component') =>
    N(id, kind, 'browser', [
      P('in', 'in', [I('_', 'unknown')]),
      P('out', 'out', [I('_', 'unknown')]),
    ]);
  const sharedGraph = (): GraphV2 => ({
    version: 2,
    nodes: [
      box('fn:A', 'fn'),
      box('fn:B', 'fn'),
      box('helper:S', 'helper'),
      box('comp:C', 'component'),
      box('helper:H', 'helper'),
      box('comp:D', 'component'),
    ],
    wires: [
      W('fn:A#out/_', 'helper:S#in/_', 'call'),
      W('helper:S#out/_', 'fn:A#in/_', 'return', true),
      W('fn:B#out/_', 'helper:S#in/_', 'call'),
      W('helper:S#out/_', 'fn:B#in/_', 'return', true),
      W('fn:A#out/_', 'comp:C#in/_', 'render'),
      W('comp:C#out/_', 'helper:H#in/_', 'call'),
      W('helper:H#out/_', 'comp:C#in/_', 'return', true),
      W('comp:D#out/_', 'helper:H#in/_', 'call'),
      W('helper:H#out/_', 'comp:D#in/_', 'return', true),
    ],
  });

  it('S の下流: S は全員（A・B）へ返すが、H は光っている C へだけ返し、S を使わない D は光らない', () => {
    // 以前は第 k 回の判断を前の回の範囲だけで行い、C が光るのと同じ回に H の戻りを「相手が誰も光っていない → 全員へ」で
    // 通していたので D まで光った（fixture-repo の lib:apiClient で /login と Header が光った件）
    const idx = indexGraph(sharedGraph());
    const lit = select(idx, defaultState(idx), { kind: 'box', id: 'helper:S', downOnly: true })!;
    expect([...lit.boxes].sort()).toEqual(['comp:C', 'fn:A', 'fn:B', 'helper:H', 'helper:S']);
    expect(lit.items.has('comp:D#in/_')).toBe(false);
  });

  it('線の宣言順を逆にしても同じ', () => {
    const g = sharedGraph();
    g.wires.reverse();
    const idx = indexGraph(g);
    const lit = select(idx, defaultState(idx), { kind: 'box', id: 'helper:S', downOnly: true })!;
    expect([...lit.boxes].sort()).toEqual(['comp:C', 'fn:A', 'fn:B', 'helper:H', 'helper:S']);
  });

  it('共有の H から始めると、呼び出し元の C と D は全部光る（上流も下流も。誰も光っていなければ全員へ）', () => {
    const idx = indexGraph(sharedGraph());
    const st = defaultState(idx);
    const both = select(idx, st, { kind: 'box', id: 'helper:H' })!;
    expect(both.boxes.has('comp:C')).toBe(true);
    expect(both.boxes.has('comp:D')).toBe(true);
    const down = select(idx, st, { kind: 'box', id: 'helper:H', downOnly: true })!;
    expect([...down.boxes].sort()).toEqual(['comp:C', 'comp:D', 'helper:H']);
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

describe('往復の相手（requesters / repliers。docs/15 §3.5）', () => {
  /** テーブル T へ A は書くだけ（call、戻り無し）、B は読む（call ＋ reply）。B の読んだ値は C へ */
  const writeReadGraph = (): GraphV2 => ({
    version: 2,
    nodes: [
      N('fn:A', 'fn', 'server', [P('out', 'out', [I('row', 'Row')])]),
      N(
        'fn:B',
        'fn',
        'server',
        [
          P('in', 'in', [I('row', 'Row')]),
          P('out', 'out', [I('date', 'string'), I('total', 'int')]),
        ],
        { links: [L('in/row', 'out/total')] },
      ),
      N(
        'table:T',
        'table',
        'data',
        [
          P('key', 'in', [I('date', 'date')]),
          P('write', 'in', [I('row', 'record')]),
          P('read', 'out', [I('row', 'record')]),
        ],
        { links: [L('key/date', 'read/row'), L('write/row', 'read/row')] },
      ),
      N('comp:C', 'component', 'browser', [P('in', 'in', [I('total', 'int')])]),
    ],
    wires: [
      W('fn:A#out/row', 'table:T#write/row', 'sql'),
      W('fn:B#out/date', 'table:T#key/date', 'sql'),
      W('table:T#read/row', 'fn:B#in/row', 'sql', true),
      W('fn:B#out/total', 'comp:C#in/total', 'props'),
    ],
  });

  it('書くだけの箱は往復の相手に数えない: A を選んでも T → B の戻りは切れない', () => {
    const idx = indexGraph(writeReadGraph());
    expect([...idx.requesters.get('table:T')!]).toEqual(['fn:B']);
    const lit = select(idx, defaultState(idx), { kind: 'box', id: 'fn:A' })!;
    expect(lit.boxes.has('table:T')).toBe(true);
    expect(lit.boxes.has('fn:B')).toBe(true);
    expect(lit.boxes.has('comp:C')).toBe(true);
    expect(lit.items.has('fn:B#out/total')).toBe(true);
  });

  /** X は P から呼ばれ、P と Q へ戻す（Q は X を呼ばない） */
  const replyOnlyGraph = (): GraphV2 => ({
    version: 2,
    nodes: [
      N('fn:P', 'fn', 'server', [P('in', 'in', [I('r', 'int')]), P('out', 'out', [I('q', 'int')])]),
      N('fn:X', 'fn', 'server', [P('in', 'in', [I('q', 'int')]), P('out', 'out', [I('r', 'int')])]),
      N('fn:Q', 'fn', 'server', [P('in', 'in', [I('r', 'int')])]),
    ],
    wires: [
      W('fn:P#out/q', 'fn:X#in/q', 'call'),
      W('fn:X#out/r', 'fn:P#in/r', 'return', true),
      W('fn:X#out/r', 'fn:Q#in/r', 'return', true),
    ],
  });

  it('戻りを受けるだけの箱も相手に数えない: Q から上流へたどると、X を呼んだ P に届く（上流の対称）', () => {
    const idx = indexGraph(replyOnlyGraph());
    expect([...idx.repliers.get('fn:X')!]).toEqual(['fn:P']);
    const lit = select(idx, defaultState(idx), { kind: 'box', id: 'fn:Q' })!;
    expect(lit.boxes.has('fn:X')).toBe(true);
    expect(lit.boxes.has('fn:P')).toBe(true);
    expect(lit.items.has('fn:P#out/q')).toBe(true);
  });
});

describe('親子の写し: 自分の辺を持たない中間の項目', () => {
  /**
   * F の in/rows → out/entries（親の links）と、孫の改名 in/rows.meta.ts → out/entries.meta.stamp。
   * out/entries.meta の子はそれぞれ G へ線を持つ。H は in/rows.meta.other へ線を引く
   */
  const nestedGraph = (): GraphV2 => ({
    version: 2,
    nodes: [
      N('fn:H', 'fn', 'server', [P('out', 'out', [I('other', 'string')])]),
      N(
        'fn:F',
        'fn',
        'server',
        [
          P('in', 'in', [
            I('rows', 'Row[]', {
              children: [I('meta', 'Meta', { children: [I('ts', 'time'), I('other', 'string')] })],
            }),
          ]),
          P('out', 'out', [
            I('entries', 'Entry[]', {
              children: [
                I('meta', 'Meta', { children: [I('stamp', 'time'), I('other', 'string')] }),
              ],
            }),
          ]),
        ],
        { links: [L('in/rows', 'out/entries'), L('in/rows.meta.ts', 'out/entries.meta.stamp')] },
      ),
      N('fn:G', 'fn', 'server', [P('in', 'in', [I('stamp', 'time'), I('other', 'string')])]),
    ],
    wires: [
      W('fn:H#out/other', 'fn:F#in/rows.meta.other', 'call'),
      W('fn:F#out/entries.meta.stamp', 'fn:G#in/stamp', 'call'),
      W('fn:F#out/entries.meta.other', 'fn:G#in/other', 'call'),
    ],
  });
  const idx = indexGraph(nestedGraph());
  const st = defaultState(idx);

  it('in/rows.meta（自分の辺なし、孫に改名あり）: 祖先の辺で out/entries.meta へ写り、meta.other の線も流れる', () => {
    const lit = select(idx, st, { kind: 'item', ref: 'fn:F#in/rows.meta', downOnly: true })!;
    expect(lit.items.has('fn:F#out/entries.meta')).toBe(true);
    expect(lit.items.has('fn:F#out/entries.meta.other')).toBe(true);
    expect(lit.items.has('fn:G#in/other')).toBe(true);
    // 孫の改名の links も使う
    expect(lit.items.has('fn:F#out/entries.meta.stamp')).toBe(true);
    expect(lit.items.has('fn:G#in/stamp')).toBe(true);
    const mapped = [...lit.links.values()].find(
      (s) => s.from.ref === 'fn:F#in/rows.meta' && s.to.ref === 'fn:F#out/entries.meta',
    );
    expect(mapped).toBeDefined();
  });

  it('in/rows.meta.ts（自分の改名の辺あり）: 改名の links だけを使い、親の links では写らない', () => {
    const lit = select(idx, st, { kind: 'item', ref: 'fn:F#in/rows.meta.ts', downOnly: true })!;
    expect(lit.items.has('fn:F#out/entries.meta.stamp')).toBe(true);
    expect(lit.items.has('fn:G#in/stamp')).toBe(true);
    expect(lit.items.has('fn:F#out/entries.meta.other')).toBe(false);
    expect(lit.items.has('fn:G#in/other')).toBe(false);
    expect(lit.boxes.has('fn:H')).toBe(false);
  });

  it('上流も対称: out/entries.meta から上流へは祖先の辺で in/rows.meta に写り、H に届く', () => {
    const lit = traverse(idx, st, [idx.items.get('fn:F#out/entries.meta')!], {
      up: true,
      down: false,
    });
    expect(lit.items.has('fn:F#in/rows.meta')).toBe(true);
    expect(lit.items.has('fn:F#in/rows.meta.ts')).toBe(true);
    expect(lit.boxes.has('fn:H')).toBe(true);
  });
});
