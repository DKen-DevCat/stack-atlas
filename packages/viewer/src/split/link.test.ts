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
  schedule,
  select,
  type Selection,
} from '@stack-atlas/wiring';
import { memoBoxIds, memoOrphans, memoTargets } from '../wiring/memoRules';
import {
  flowCache,
  initialSelection,
  mapTargets,
  memoKeyOf,
  resolveSel,
  restrictScreenshots,
  selectionForUnit,
  selParam,
  wiringOnly,
} from './link';

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

  it('@runtime の写しの group は、id（メモのキー）が元の group の値、中の箱はその写しのもの', () => {
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
    expect(memoKeyOf(q, 'lib:shared@browser')).toBe('lib:shared');
    expect(memoKeyOf(q, 'endpoint:GET /a@b')).toBe('endpoint:GET /a@b');
  });

  // 2026-11-10 追加（8-6 のレビュー）: 接頭辞の無い group の値は地図では `group:<値>` のノード。直す前はメモのキーが
  // `group:<値>`（地図の 📝・地図から選んだ札）と `<値>`（配線図の箱の角の印・札の group のメモ）で分かれ、同じ group の
  // メモが片方の面にしか出なかった
  it('接頭辞の無い group: 2 面とも同じメモのキー（group の値そのもの）', () => {
    const q2: GraphV2 = {
      version: 2,
      nodes: [
        { id: 'fn:a', kind: 'fn', name: 'a', runtime: 'server', ports: [], group: 'feature/spend' },
        { id: 'fn:b', kind: 'fn', name: 'b', runtime: 'server', ports: [], group: 'feature/spend' },
        {
          id: 'fn:c',
          kind: 'fn',
          name: 'c',
          runtime: 'browser',
          ports: [],
          group: 'feature/spend',
        },
      ],
      wires: [],
    };
    const pq = projectMap(q2);
    const iq = indexGraph(q2);
    const memos = { 'feature/spend': 'group のメモ' };
    // 地図のノード（元と @runtime の写し）の 📝 のキー
    expect(memoKeyOf(pq, 'group:feature/spend')).toBe('feature/spend');
    expect(memoKeyOf(pq, 'group:feature/spend@browser')).toBe('feature/spend');
    // 地図から選ぶ → 配線図の札は group の値のメモ
    for (const unit of ['group:feature/spend', 'group:feature/spend@browser']) {
      const sel = selectionForUnit(pq, unit)!;
      expect(sel).toMatchObject({ kind: 'group', id: 'feature/spend' });
      expect(memoTargets(iq, sel, memos).map((t) => t.id)).toEqual(['feature/spend']);
    }
    // 配線図: 箱の角の印と、箱を選んだときの札の group のメモ
    expect([...memoBoxIds(iq, memos)].sort()).toEqual(['fn:a', 'fn:b', 'fn:c']);
    expect(memoTargets(iq, { kind: 'box', id: 'fn:a' }, memos).map((t) => t.id)).toEqual([
      'fn:a',
      'feature/spend',
    ]);
    // 孤立にならず、「移す…」の候補は値そのもの 1 つ（@runtime の写しは出さない）
    expect(mapTargets(pq)).toEqual([{ id: 'feature/spend', name: 'feature/spend' }]);
    expect(
      memoOrphans(
        iq,
        memos,
        mapTargets(pq).map((t) => t.id),
      ),
    ).toEqual([]);
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

  // 2026-11-10 変更（8-6 のレビュー）: 中の箱のある host は地図のノード（unitKind が host）なので、別に host の一覧で引く
  // 枝は、箱として無い host（参照だけ）を host の選択にしていた（配線図では選べず、何も光らない）
  it('箱として無い host（参照だけ）は解かない', () => {
    const q: GraphV2 = {
      version: 2,
      nodes: [
        { id: 'fn:a', kind: 'fn', name: 'a', runtime: 'server', ports: [], host: 'infra:gone' },
      ],
      wires: [],
    };
    expect(resolveSel(projectMap(q), q, 'infra:gone')).toBeNull();
    expect(resolveSel(projectMap(q), q, 'fn:a')).toEqual({ kind: 'box', id: 'fn:a' });
  });

  // 2026-11-10 追加（8-6 のレビュー）: 直す前は ?view= があるだけで ?sel= を外していた（view の id が graph に無くても）
  it('開いた直後: 解ける ?view= だけが ?sel= に勝つ。解けない ?view= なら ?sel= を当てる', () => {
    const view = g.views![0]!.id;
    expect(initialSelection(p, g, 'route:/', view)).toEqual({ dropSel: true });
    expect(initialSelection(p, g, 'route:/', 'no-such-view')).toEqual({
      select: { kind: 'box', id: 'route:/' },
      dropSel: false,
    });
    expect(initialSelection(p, g, 'route:/', undefined)).toEqual({
      select: { kind: 'box', id: 'route:/' },
      dropSel: false,
    });
    const bad = initialSelection(p, g, 'fn:nope', 'no-such-view');
    expect(bad.dropSel).toBe(true);
    expect(bad.select).toBeUndefined();
    expect(bad.issue).toMatchObject({ level: 'warning', path: '?sel' });
    expect(initialSelection(p, g, undefined, view)).toEqual({ dropSel: false });
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

  // 2026-11-10 追加（8-6 のレビュー）: 直す前は地図の全部のノード（@runtime の写しの id も）を候補にしていた。
  // 写しの id に移したメモは地図のどのノードにも出ない（地図の 📝 は元のキーで引く）
  it('「移す…」の候補はメモのキーだけ（@runtime の写しは出さない）', () => {
    const q = projectMap({
      version: 2,
      nodes: [
        { id: 'fn:a', kind: 'fn', name: 'a', runtime: 'browser', ports: [], group: 'lib:shared' },
        { id: 'fn:b', kind: 'fn', name: 'b', runtime: 'server', ports: [], group: 'lib:shared' },
        { id: 'fn:c', kind: 'fn', name: 'c', runtime: 'server', ports: [], group: 'lib:shared' },
        { id: 'fn:d', kind: 'fn', name: 'd', runtime: 'server', ports: [] },
      ],
      wires: [],
    });
    expect(q.graph.nodes.map((n) => n.id)).toEqual(['lib:shared@browser', 'lib:shared', 'fn:d']);
    expect(mapTargets(q)).toEqual([
      { id: 'lib:shared', name: 'shared' },
      { id: 'fn:d', name: 'd' },
    ]);
  });
});

// 2026-11-10 追加（8-6 のレビュー）: 直す前は配線図の onClock（シークの input・一時停止・バーを離した）のたびに mapFlow を作り直していた
describe('地図の流れ（flowCache。D106）', () => {
  it('schedule が同じなら作り直さない（シーク・一時停止は時刻だけ）。新しい schedule・null で変わる', () => {
    const lit = select(index, state, { kind: 'box', id: 'route:/' })!;
    const s1 = schedule(lit, lit.flowStarts, { lengthOf: () => 1, startBoxes: lit.startBoxes });
    const s2 = schedule(lit, lit.flowStarts, { lengthOf: () => 1, startBoxes: lit.startBoxes });
    const c = flowCache(p);
    expect(c.get(null)).toBeNull();
    const f1 = c.get(s1);
    expect(f1).not.toBeNull();
    expect(c.get(s1)).toBe(f1);
    expect(c.get(s1)).toBe(f1);
    expect(c.builds).toBe(1);
    const f2 = c.get(s2);
    expect(f2).not.toBe(f1);
    expect(c.builds).toBe(2);
    expect(c.get(null)).toBeNull();
    expect(c.builds).toBe(2);
  });
});

// 2026-11-10 追加（8-6 のレビュー）: 直す前は v2 の screen.screenshot をそのまま地図に渡し、絶対 URL（外の origin）も読んでいた
describe('地図のスクショ（restrictScreenshots）: 配線図の画面の HTML と同じ制限', () => {
  const BASE = 'http://localhost:4173/out/graph.json';
  const PAGE = 'http://localhost:4173/viewer/?graph=../out/graph.json';
  const shot = (screenshot: string) => ({
    version: 1 as const,
    layers: [{ id: 'browser', name: 'ブラウザ' }],
    nodes: [
      {
        id: 'route:/',
        layer: 'browser',
        kind: 'page',
        name: '/',
        screen: { width: 10, height: 10, screenshot, regions: [] },
      },
      { id: 'comp:A', layer: 'browser', kind: 'component', name: 'A' },
    ],
    edges: [],
  });
  it('graph.json のディレクトリの下の相対パスは残す（同じ graph を返す）', () => {
    const g1 = shot('screenshots/top.png');
    expect(restrictScreenshots(g1, BASE, PAGE)).toBe(g1);
  });
  it.each([
    ['絶対 URL', 'https://evil.example/pixel.png'],
    ['プロトコル相対', '//evil.example/pixel.png'],
    ['data:', 'data:image/png;base64,AAAA'],
    ['ルートからのパス', '/secret.png'],
    ['graph.json のディレクトリの外', '../x.png'],
  ])('%s は外す（プレースホルダになる）', (_n, path) => {
    const g1 = shot(path);
    const out = restrictScreenshots(g1, BASE, PAGE);
    expect(out.nodes[0]!.screen).toEqual({ width: 10, height: 10, regions: [] });
    expect(out.nodes[1]).toBe(g1.nodes[1]);
    // 元の graph は変えない
    expect(g1.nodes[0]!.screen!.screenshot).toBe(path);
  });
  it('graph.json をファイルで開いた（baseUrl が無い）なら外す', () => {
    expect(
      restrictScreenshots(shot('screenshots/top.png'), undefined, PAGE).nodes[0]!.screen,
    ).toEqual({ width: 10, height: 10, regions: [] });
  });
});
