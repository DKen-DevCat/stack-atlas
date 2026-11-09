// ts-types を examples/fixture-poly の web（Next 静的エクスポート）に掛け、手で組んだ例
// （examples/fixture-poly.today.v2.json）と口・項目・links・線を比べる（docs/17 §3.2・§7 #2・#3、D54）
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import type { GraphV2, ItemV2, LinkV2 } from '@stack-atlas/schema';
import {
  createMemoryLogger,
  createRepoContext,
  loadConfig,
  type PartialGraphV2,
  type PartialNodeV2,
} from '@stack-atlas/core';
import { extractor as tsImports } from '@stack-atlas/extractor-ts-imports';
import { extractor, buildV2 } from '../index.js';

const fixture = fileURLToPath(new URL('../../../../examples/fixture-poly', import.meta.url));
const example = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('../../../../examples/fixture-poly.today.v2.json', import.meta.url)),
    'utf8',
  ),
) as GraphV2;
const exampleNode = (id: string) => example.nodes.find((n) => n.id === id)!;

let v2: PartialGraphV2;
let byId: Map<string, PartialNodeV2>;
const log = createMemoryLogger();
beforeAll(async () => {
  const config = loadConfig(fixture, log);
  const repos = { web: `${fixture}/web`, platform: `${fixture}/platform` };
  const ctx = createRepoContext(repos.web, config, log, {
    repoName: 'web',
    repos,
    configDir: fixture,
  });
  // パイプラインと同じく ts-imports の後（解析と ts-morph の Project を共有する）
  const up = await tsImports.extract(ctx, { nodes: [], edges: [] });
  expect(await extractor.detect(ctx)).toBe(true);
  v2 = buildV2(ctx, up);
  byId = new Map(v2.nodes.map((n) => [n.id, n]));
}, 30_000);

/** 比べやすい形: 置き場の `_` を落とし、呼び出し・描画の項目の表示名（引数の書き方）を無視する */
function norm(items: readonly ItemV2[]): ItemV2[] {
  return items
    .filter((i) => i.id !== '_')
    .map((i) => {
      const out: ItemV2 = { ...i };
      if (/^(call|render)_\d+$/.test(i.id)) delete (out as Partial<ItemV2>).name;
      if (i.children) out.children = norm(i.children);
      return out;
    });
}
const portsOf = (n: { ports: { id: string; items: ItemV2[] }[] }) =>
  Object.fromEntries(n.ports.map((p) => [p.id, norm(p.items)]).filter(([, xs]) => xs!.length));

describe('ts-types: fixture-poly の web', () => {
  it('箱: 画面・部品・関数。id は ts-imports / nextjs-app と同じ（lib:fetcher は v1 の id のまま）', () => {
    expect([...byId.keys()].sort()).toEqual(
      [
        'route:/',
        'route:/calendar',
        'route:/push',
        'layout:/',
        'comp:CalendarGrid',
        'comp:CalendarIsland',
        'comp:EntryList',
        'comp:PushToggle',
        'comp:TodayIsland',
        'comp:TotalCard',
        'fn:getDays',
        'fn:toCells',
        'fn:getToday',
        'fn:getEntries',
        'fn:createTransaction',
        'fn:toTodayView',
        'lib:fetcher',
      ].sort(),
    );
    expect(byId.get('route:/')!.kind).toBe('screen');
    expect(byId.get('lib:fetcher')!.kind).toBe('helper');
    expect(byId.get('fn:getToday')!.kind).toBe('fn');
    // 関数の箱が v1 のファイルの箱を全部置き換えるときは groups で知らせる（mergeV2 が group にする）
    expect(v2.groups).toEqual({
      'fn:getDays': 'lib:web/src/feature/days/request.ts',
      'fn:toCells': 'lib:web/src/feature/days/transformer.ts',
      'fn:getToday': 'lib:web/src/feature/spend/request.ts',
      'fn:getEntries': 'lib:web/src/feature/spend/request.ts',
      'fn:createTransaction': 'lib:web/src/feature/spend/request.ts',
      'fn:toTodayView': 'lib:web/src/feature/spend/transformer.ts',
    });
  });

  it('runtime: 画面は静的エクスポートでも browser（D54）、use client の閉包の部品・関数も browser', () => {
    for (const n of v2.nodes) expect(n.runtime, n.id).toBe('browser');
    expect(log.of('info')).toEqual(
      expect.arrayContaining([expect.stringContaining('react の型が解けないので最小の stub')]),
    );
  });

  it.each([
    'route:/',
    'comp:TodayIsland',
    'comp:TotalCard',
    'comp:EntryList',
    'fn:getToday',
    'fn:toTodayView',
    'lib:fetcher',
    'fn:createTransaction',
  ])('%s の口と項目が手で組んだ例と同じ（型・wireType・typeRef・optional・meta.http）', (id) => {
    expect(portsOf(byId.get(id)!)).toEqual(portsOf(exampleNode(id)));
  });

  it('links: データ由来は例と同じ。起動の links（§7 #3）は crude（例は exact と書いている所がある）', () => {
    const key = (l: LinkV2) => `${l.from} → ${l.to}`;
    for (const id of [
      'route:/',
      'comp:TodayIsland',
      'fn:getToday',
      'fn:toTodayView',
      'lib:fetcher',
      'fn:createTransaction',
    ]) {
      const gen = (byId.get(id)!.links ?? []).filter(
        (l) => !l.from.endsWith('/_') && !l.to.endsWith('/_'),
      );
      const ex = exampleNode(id).links ?? [];
      expect(gen.map(key).sort(), id).toEqual(ex.map(key).sort());
      for (const l of gen) {
        const e = ex.find((x) => key(x) === key(l))!;
        // 見つかったこと: 例は起動の links（in/html → render_1、in/call → call_1）を exact と書いているが、規則（§7 #3）は crude
        const activation = /^in\/(html|call|props)$/.test(l.from);
        expect(l.confidence, `${id} ${key(l)}`).toBe(activation ? 'crude' : e.confidence);
      }
    }
  });

  it('同じ言語の中の線（呼び出し・戻り・render。最も粗い単位）と、呼び出しでない参照（定数）の箱の単位の線', () => {
    const keys = v2.wires.map((w) => `${w.from} → ${w.to} (${w.via}${w.reply ? ', reply' : ''})`);
    expect(keys).toEqual(
      expect.arrayContaining([
        'route:/#out/render_1 → comp:TodayIsland#in/props (render)',
        'comp:TodayIsland#out/call_1 → fn:getToday#in/call (call)',
        'fn:getToday#out/return → comp:TodayIsland#in/ret_1 (return, reply)',
        'comp:TodayIsland#out/call_2.today → fn:toTodayView#in/today (call)',
        'comp:TodayIsland#out/render_1.view → comp:TotalCard#in/view (render)',
        'comp:TodayIsland#out/render_2.entries → comp:EntryList#in/entries (render)',
        'fn:getToday#out/call_1.url → lib:fetcher#in/url (call)',
        'lib:fetcher#out/return → fn:getToday#in/ret_1 (return, reply)',
        // body（JSON.stringify を剥がした Entry）は fetcher の init へ
        'fn:createTransaction#out/call_1.body → lib:fetcher#in/init (call)',
        // クエリは パスの引数（url）へ
        'fn:getDays#out/call_1.query → lib:fetcher#in/url (call)',
        'route:/calendar#out/render_1.month → comp:CalendarIsland#in/month (render)',
        // API_DOMAIN（定数）の参照は ts-imports と同じ相手（lib:consts）へ箱の単位で
        'lib:fetcher#out/_ → lib:consts#in/_ (call)',
        'lib:consts#out/_ → lib:fetcher#in/_ (return, reply)',
        'comp:PushToggle#out/_ → lib:consts#in/_ (call)',
      ]),
    );
    // endpoint への線は合流の段が引く（アダプタは引かない。D49）
    expect(keys.some((k) => k.includes('endpoint:'))).toBe(false);
  });

  it('HTTP の呼び出し: fetch を直接呼ぶ部品（PushToggle）と、クエリ付きの呼び出し（getDays）', () => {
    const push = byId.get('comp:PushToggle')!;
    const call = push.ports.find((p) => p.id === 'out')!.items.find((i) => i.id === 'call_1')!;
    expect(call.meta).toEqual({ http: { method: 'POST', path: '/push/subscriptions' } });
    // 呼び先（fetch）の引数名。body の無い init は項目にしない
    expect(call.children!.map((c) => [c.id, c.meta])).toEqual([['input', { http: 'path' }]]);
    const getDays = byId.get('fn:getDays')!;
    const c1 = getDays.ports.find((p) => p.id === 'out')!.items.find((i) => i.id === 'call_1')!;
    expect(c1.meta).toEqual({ http: { method: 'GET', path: '/days' } });
    expect(c1.children!.map((c) => [c.id, c.meta])).toEqual([
      ['url', { http: 'path' }],
      ['query', { http: 'query' }],
    ]);
    expect(c1.children![1]!.children).toEqual([
      { id: 'month', name: 'month', type: 'string', wireType: 'string' },
    ]);
    expect(getDays.links).toEqual(
      expect.arrayContaining([
        { from: 'in/month', to: 'out/call_1.query.month', confidence: 'exact' },
      ]),
    );
  });
});
