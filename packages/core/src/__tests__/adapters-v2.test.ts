// 言語アダプタの v2 を upgrade の v2 に重ねる段（docs/17 §3.1・§3.4・§7、D50・D52・D53）:
// パスの正規化（core へ移した）・PartialGraph.v2 のマージと修飾・mergeV2 → join → cleanupV2 → writeBroken・自動率
import {
  validateGraphV2,
  type GraphV2,
  type ItemV2,
  type NodeV2,
  type PortV2,
  type WireV2,
} from '@stack-atlas/schema';
import { describe, expect, it } from 'vitest';
import {
  apiPathMatches,
  MAX_ROUTE_PATH,
  normalizeRoutePath,
  pathMatches,
  pickMostSpecific,
  rewriteRoutePath,
} from '../paths.js';
import { mergePartialGraphs } from '../merge.js';
import { prefixRepoFiles } from '../repo.js';
import { cleanupV2, coverageV2, mergeV2, removeOverrideWiresV2 } from '../merge-v2.js';
import { handlerRoutes, joinAll, joinEndpoints } from '../join.js';
import { mergeNamedTypes, mergePartialV2 } from '../v2-parts.js';
import { writeBroken } from '../broken-v2.js';
import { createMemoryLogger } from '../logger.js';
import { buildGraph } from '../pipeline.js';
import type { Extractor, PartialGraph, PartialGraphV2, PartialNodeV2 } from '../types.js';
import { tmpRepo } from './helpers.js';

const I = (id: string, type = 'string', extra: Partial<ItemV2> = {}): ItemV2 => ({
  id,
  name: id,
  type,
  ...(type === 'unknown' ? { wireType: 'unknown' as const } : {}),
  ...extra,
});
const ANY = I('_', 'unknown', { name: '値' });
const P = (id: string, dir: 'in' | 'out', items: ItemV2[]): PortV2 => ({ id, dir, items });
const box = (id: string, kind: NodeV2['kind'], extra: Partial<NodeV2> = {}): NodeV2 => ({
  id,
  kind,
  name: id,
  runtime: 'browser',
  ports: [P('in', 'in', [{ ...ANY }]), P('out', 'out', [{ ...ANY }])],
  ...extra,
});
const W = (from: string, to: string, via: WireV2['via'], extra: Partial<WireV2> = {}): WireV2 => ({
  from,
  to,
  via,
  ...extra,
});

describe('パスの正規化（api-link から core へ。docs/17 §7 #5）', () => {
  it('{id}・:id・[id]・[...slug]・{rest...} を API Gateway 形式にそろえる', () => {
    expect(normalizeRoutePath('/races/[id]')).toBe('/races/{id}');
    expect(normalizeRoutePath('/docs/[...slug]')).toBe('/docs/{slug+}');
    expect(normalizeRoutePath('/docs/[[...slug]]')).toBe('/docs/{slug+}');
    expect(normalizeRoutePath('/orders/:id/')).toBe('/orders/{id}');
    expect(normalizeRoutePath('/files/{rest...}')).toBe('/files/{rest+}');
    expect(apiPathMatches('/transactions/{id}', '/transactions/[id]')).toBe(true);
    expect(pathMatches('/races/{proxy+}', '/races')).toBe(false);
    const r = (routeKey: string) => {
      const [method = 'ANY', path = routeKey] = routeKey.split(' ');
      return { routeKey, method, path };
    };
    expect(pickMostSpecific([r('GET /a/{x}'), r('GET /a/b')]).map((x) => x.routeKey)).toEqual([
      'GET /a/b',
    ]);
  });
});

describe('パスの正規化は線形（2026-11-09 レビュー S2）', () => {
  /** `[` が多くて `]` が無い、`{` が多くて `}` が無い、`/` の長い並びなど（もとの正規表現は開きの位置ごとに末尾まで読み直す二次） */
  const hostile = (n: number) => [
    '['.repeat(n),
    '[[...'.repeat(n / 5),
    '[...'.repeat(n / 4),
    '{'.repeat(n),
    '{a...'.repeat(n / 5),
    `${'/'.repeat(n)}x`,
    `/a${'/:'.repeat(n / 2)}`,
  ];
  /** CPU 時間（並列に走る他のテストに待たされた分を含めない。perf.test と同じ） */
  const cpuMs = (f: () => unknown) => {
    const t0 = process.cpuUsage();
    f();
    const d = process.cpuUsage(t0);
    return (d.user + d.system) / 1000;
  };
  it('100k 文字の悪意のある入力でも、正規表現の書き換え（上限なし）が 1 本あたり 100ms を大きく下回る', () => {
    // もとの正規表現では 1 本あたり数十秒（20k 文字で `[` 0.9 秒・末尾の `/` 1 秒。二次）
    for (const p of hostile(100_000))
      expect(
        cpuMs(() => rewriteRoutePath(p)),
        p.slice(0, 10),
      ).toBeLessThan(100);
  });
  it(`${MAX_ROUTE_PATH} 文字を超えるパスは正規化も照合もしない（そのまま返す・合わない）`, () => {
    const long = `/a${'[x]'.repeat(1000)}`;
    expect(long.length).toBeGreaterThan(MAX_ROUTE_PATH);
    expect(normalizeRoutePath(long)).toBe(long);
    expect(apiPathMatches('/a/{x}', long)).toBe(false);
    expect(apiPathMatches(long, '/a/b')).toBe(false);
  });
  it('書き換えの規則は従来どおり（括弧の中に開き括弧があるものだけ内側を取る）', () => {
    expect(normalizeRoutePath('/a/[[...rest]]/[...x]/[id]/{p...}/:q///')).toBe(
      '/a/{rest+}/{x+}/{id}/{p+}/{q}',
    );
    expect(normalizeRoutePath('/a[b[c]')).toBe('/a[b{c}');
    expect(normalizeRoutePath('/x/*')).toBe('/x/{proxy+}');
    expect(normalizeRoutePath('///')).toBe('/');
  });
  it('joinEndpoints: 長すぎるパスの endpoint・呼び出しは照合せず 1 回だけ警告する', () => {
    const long = `/a${'/b'.repeat(MAX_ROUTE_PATH)}`;
    const g: GraphV2 = {
      version: 2,
      nodes: [
        {
          id: 'fn:a',
          kind: 'fn',
          name: 'a',
          runtime: 'browser',
          ports: [
            P('out', 'out', [
              I('call_1', 'x', { meta: { http: { method: 'GET', path: long } } }),
              I('call_2', 'x', { meta: { http: { method: 'GET', path: `${long}/c` } } }),
            ]),
          ],
        },
        {
          id: 'endpoint:GET /a',
          kind: 'endpoint',
          name: 'GET /a',
          runtime: 'server',
          meta: { api: { method: 'GET', path: long } },
          ports: [P('in', 'in', [I('path')])],
        },
      ],
      wires: [],
    };
    const r = joinEndpoints(g);
    expect(r.matched).toBe(0);
    expect(r.unmatched).toEqual([]);
    expect(r.issues.map((i) => i.message)).toEqual([
      expect.stringContaining(
        `パスが長すぎる（${MAX_ROUTE_PATH} 文字を超える）ので照合しなかった endpoint・HTTP 呼び出し 3 件`,
      ),
    ]);
  });
});

describe('PartialGraph.v2 の契約（merge と prefix が運ぶ）', () => {
  const nodeA: PartialNodeV2 = {
    id: 'fn:a',
    kind: 'fn',
    name: 'a',
    file: 'src/a.ts',
    ports: [P('in', 'in', [I('x')])],
  };
  it('mergePartialGraphs: 箱は id で口・項目を合わせ、線は (from, to)、型は id で重複排除', () => {
    const merged = mergePartialGraphs([
      {
        nodes: [],
        edges: [],
        v2: { nodes: [nodeA], wires: [W('fn:a#out/r', 'fn:b#in/r', 'call')] },
      },
      {
        nodes: [],
        edges: [],
        v2: {
          nodes: [{ ...nodeA, ports: [P('in', 'in', [I('y')]), P('out', 'out', [I('r')])] }],
          wires: [W('fn:a#out/r', 'fn:b#in/r', 'call')],
          types: [{ id: 'type:T', name: 'T' }],
          groups: { 'fn:a': 'lib:a' },
        },
      },
      { nodes: [], edges: [] },
    ]);
    expect(merged.v2!.nodes).toHaveLength(1);
    expect(merged.v2!.nodes[0]!.ports.map((p) => [p.id, p.items.map((i) => i.id)])).toEqual([
      ['in', ['x', 'y']],
      ['out', ['r']],
    ]);
    expect(merged.v2!.wires).toHaveLength(1);
    expect(merged.v2!.types).toEqual([{ id: 'type:T', name: 'T' }]);
    expect(merged.v2!.groups).toEqual({ 'fn:a': 'lib:a' });
    // v2 を出さない抽出器だけなら v2 は無い
    expect(mergePartialGraphs([{ nodes: [], edges: [] }]).v2).toBeUndefined();
  });

  it('prefixRepoFiles: 複数 repo では v2 の箱と型の file も <repo>/ で修飾する（線は箱 id なのでそのまま）', () => {
    const ctx = { repoName: 'web', repos: { web: '/x/web', api: '/x/api' }, root: '/x/web' };
    const out = prefixRepoFiles(
      {
        nodes: [],
        edges: [],
        v2: {
          nodes: [nodeA],
          wires: [W('fn:a#out/r', 'fn:b#in/r', 'call')],
          types: [{ id: 'type:T', name: 'T', file: 'src/t.ts' }],
        },
      },
      ctx,
    );
    expect(out.v2!.nodes[0]!.file).toBe('web/src/a.ts');
    expect(out.v2!.types![0]!.file).toBe('web/src/t.ts');
    expect(out.v2!.wires[0]!.from).toBe('fn:a#out/r');
  });
});

/** upgrade（箱の単位）＋ アダプタ（項目の単位）の小さな graph: 画面 → 部品 → 関数（v1 のファイルの箱）→ endpoint */
function smallWorld(): { upgraded: GraphV2; part: PartialGraphV2 } {
  const upgraded: GraphV2 = {
    version: 2,
    project: { name: 't', generator: { v2: 'upgrade' } },
    nodes: [
      box('infra:cdn', 'cache', {
        runtime: 'edge',
        ports: [P('in', 'in', [I('key', 'unknown')]), P('out', 'out', [I('value', 'unknown')])],
        variants: [{ id: 'hit', name: 'hit', default: false }],
        links: [{ from: 'in/key', to: 'out/value' }],
      }),
      box('route:/', 'screen', { host: undefined, cache: { tone: 'info', badge: 'static' } }),
      box('comp:Island', 'component'),
      box('lib:src/request.ts', 'helper', {
        file: 'src/request.ts',
        host: 'infra:fn',
        meta: { ts: { exportName: 'getToday', exports: ['getToday', 'getAll'] } },
      }),
      box('lib:consts', 'helper', { file: 'src/consts.ts' }),
      box('endpoint:GET /today', 'endpoint', {
        runtime: 'server',
        meta: { api: { method: 'GET', path: '/today' } },
        ports: [
          P('in', 'in', [{ ...ANY }]),
          P('req', 'out', [{ ...ANY }]),
          P('res', 'in', [{ ...ANY }]),
          P('out', 'out', [{ ...ANY }]),
        ],
      }),
      box('handler:api', 'fn', { runtime: 'server' }),
      box('infra:fn', 'infra', { runtime: 'server', ports: [] }),
    ],
    wires: [
      W('infra:cdn#out/value', 'route:/#in/_', 'deliver', { reply: true }),
      W('route:/#out/_', 'comp:Island#in/_', 'render'),
      W('comp:Island#out/_', 'lib:src/request.ts#in/_', 'call'),
      W('lib:src/request.ts#out/_', 'comp:Island#in/_', 'return', { reply: true }),
      W('lib:src/request.ts#out/_', 'endpoint:GET /today#in/_', 'http', { label: 'GET /today' }),
      W('endpoint:GET /today#out/_', 'lib:src/request.ts#in/_', 'http', { reply: true }),
      W('endpoint:GET /today#req/_', 'handler:api#in/_', 'call'),
      W('handler:api#out/_', 'endpoint:GET /today#res/_', 'return', { reply: true }),
      W('comp:Island#out/_', 'lib:consts#in/_', 'call'),
      W('lib:consts#out/_', 'comp:Island#in/_', 'return', { reply: true }),
    ],
    views: [{ id: 'v', name: 'v', start: 'lib:src/request.ts' }],
  };
  const today = (extra: Partial<ItemV2> = {}) =>
    I('body', 'Today', {
      wireType: 'object',
      ...extra,
      children: [I('total', 'number', { wireType: 'number' })],
    });
  const part: PartialGraphV2 = {
    nodes: [
      {
        id: 'route:/',
        kind: 'screen',
        name: '/',
        runtime: 'browser',
        ports: [
          P('in', 'in', [I('html', 'text/html')]),
          P('out', 'out', [I('render_1', 'JSX.Element')]),
        ],
        links: [{ from: 'in/html', to: 'out/render_1', confidence: 'crude' }],
      },
      {
        id: 'comp:Island',
        kind: 'component',
        name: 'Island',
        runtime: 'browser',
        ports: [
          P('in', 'in', [I('props', '{}'), I('ret_1', 'Today')]),
          P('out', 'out', [I('call_1', 'Promise<Today>')]),
        ],
        links: [{ from: 'in/props', to: 'out/call_1', confidence: 'crude' }],
      },
      {
        id: 'fn:getToday',
        kind: 'fn',
        name: 'getToday',
        file: 'src/request.ts',
        ports: [
          P('in', 'in', [I('call', 'void'), today({ id: 'ret_1', name: 'ret_1' })]),
          P('out', 'out', [
            I('call_1', 'Promise<Today>', {
              wireType: 'object',
              meta: { http: { method: 'GET', path: '/today' } },
              children: [I('url', 'string', { wireType: 'string', meta: { http: 'path' } })],
            }),
            I('return', 'Promise<Today>'),
          ]),
        ],
        links: [
          { from: 'in/call', to: 'out/call_1', confidence: 'crude' },
          { from: 'in/ret_1', to: 'out/return', confidence: 'exact' },
        ],
        meta: { ts: { exportName: 'getToday' } },
      },
      {
        id: 'fn:getAll',
        kind: 'fn',
        name: 'getAll',
        file: 'src/request.ts',
        ports: [P('in', 'in', [I('call', 'void')]), P('out', 'out', [I('return', 'void')])],
        meta: { ts: { exportName: 'getAll' } },
      },
      {
        id: 'endpoint:GET /today',
        kind: 'endpoint',
        name: 'GET /today',
        runtime: 'server',
        ports: [
          P('in', 'in', [I('path')]),
          P('req', 'out', [I('path')]),
          P('res', 'in', [today()]),
          P('out', 'out', [today()]),
        ],
        meta: { status: '200' },
      },
    ],
    wires: [
      W('route:/#out/render_1', 'comp:Island#in/props', 'render'),
      W('comp:Island#out/call_1', 'fn:getToday#in/call', 'call'),
      W('fn:getToday#out/return', 'comp:Island#in/ret_1', 'return', { reply: true }),
    ],
  };
  return { upgraded, part };
}

function run(upgraded: GraphV2, part: PartialGraphV2) {
  const state = mergeV2(upgraded, part, { adapters: ['ts-types', 'openapi'] });
  const joined = joinEndpoints(state.graph);
  const cleaned = cleanupV2(state);
  writeBroken(cleaned.graph);
  return { state, joined, cleaned, g: cleaned.graph };
}

describe('mergeV2 → join → cleanupV2（D50・D53）', () => {
  it('同じ箱 id: 口・項目・links・runtime はアダプタ、host・cache は upgrade。`_` は掃除まで残る', () => {
    const { upgraded, part } = smallWorld();
    const state = mergeV2(upgraded, part);
    const route = state.graph.nodes.find((n) => n.id === 'route:/')!;
    expect(route.cache).toEqual({ tone: 'info', badge: 'static' });
    expect(route.ports.map((p) => [p.id, p.items.map((i) => i.id)])).toEqual([
      ['in', ['html', '_']],
      ['out', ['render_1', '_']],
    ]);
    expect(route.links).toEqual([{ from: 'in/html', to: 'out/render_1', confidence: 'crude' }]);
    // 引数は変更しない
    expect(upgraded.nodes.find((n) => n.id === 'route:/')!.ports[0]!.items).toHaveLength(1);
  });

  it('分岐は v2-parts の mergeVariants で和にする（upgrade の分岐が先、同じ id は upgrade の値。2026-11-09 レビュー C9）', () => {
    const { upgraded, part } = smallWorld();
    part.nodes.push({
      id: 'infra:cdn',
      kind: 'cache',
      name: 'cdn',
      ports: [],
      variants: [
        { id: 'hit', name: 'HIT（アダプタ）', default: true },
        { id: 'stale', name: 'stale', default: false },
      ],
    });
    const cdn = mergeV2(upgraded, part).graph.nodes.find((n) => n.id === 'infra:cdn')!;
    expect(cdn.variants).toEqual([
      { id: 'hit', name: 'hit', default: false },
      { id: 'stale', name: 'stale', default: false },
    ]);
  });

  it('v1 のファイルの箱は、export が全部関数の箱になっていれば group（中の関数の箱が host を受け継ぎ、group は v1 の箱 id）', () => {
    const { upgraded, part } = smallWorld();
    const state = mergeV2(upgraded, part);
    expect([...state.groups]).toEqual([['lib:src/request.ts', ['fn:getToday', 'fn:getAll']]]);
    const fn = state.graph.nodes.find((n) => n.id === 'fn:getToday')!;
    expect(fn.host).toBe('infra:fn');
    expect(fn.group).toBe('lib:src/request.ts');
    expect(fn.runtime).toBe('browser'); // アダプタが決めない runtime は v1 の箱から
    // export が 1 つでも関数の箱になっていなければ group にしない（定数などの箱が消えないように）
    const partial = { ...part, nodes: part.nodes.filter((n) => n.id !== 'fn:getAll') };
    expect(mergeV2(upgraded, partial).groups.size).toBe(0);
    // アダプタが明示した groups は被覆に関係なく group にする
    expect([
      ...mergeV2(upgraded, { ...partial, groups: { 'fn:getToday': 'lib:src/request.ts' } }).groups,
    ]).toEqual([['lib:src/request.ts', ['fn:getToday']]]);
  });

  it('Go のパッケージの箱（classify で schema になったものも）は meta.go.pkg の被覆で group、@runtime の複製は sharedOf で', () => {
    const upgraded: GraphV2 = {
      version: 2,
      nodes: [
        box('schema:internal/store', 'helper', { meta: { go: { pkg: 'internal/store' } } }),
        box('comp:X', 'component'),
      ],
      wires: [],
    };
    const part: PartialGraphV2 = {
      nodes: [
        {
          id: 'fn:internal/store.List',
          kind: 'fn',
          name: 'List',
          ports: [],
          meta: { go: { pkg: 'internal/store' } },
        },
        {
          id: 'comp:X@browser',
          kind: 'component',
          name: 'X',
          runtime: 'browser',
          ports: [],
          meta: { sharedOf: 'comp:X' },
        },
        {
          id: 'comp:X@build',
          kind: 'component',
          name: 'X',
          runtime: 'build',
          ports: [],
          meta: { sharedOf: 'comp:X' },
        },
      ],
      wires: [],
    };
    expect([...mergeV2(upgraded, part).groups].sort()).toEqual([
      ['comp:X', ['comp:X@browser', 'comp:X@build']],
      ['schema:internal/store', ['fn:internal/store.List']],
    ]);
  });

  it('掃除: 細かい線のある箱の対の箱の単位の線を消し、配信は in/html へ、group の v1 の箱を消す。参照（定数）の `_` は残る', () => {
    const { upgraded, part } = smallWorld();
    const { g, cleaned, joined } = run(upgraded, part);
    expect(validateGraphV2(g).errors).toEqual([]);
    const ids = g.nodes.map((n) => n.id);
    expect(ids).not.toContain('lib:src/request.ts');
    const keys = g.wires.map((w) => `${w.from} → ${w.to}`);
    // 合流（D52）: 呼び出しの path → endpoint#in/path、endpoint#out/body → 呼び出し元の ret_1（reply）
    expect(joined.matched).toBe(1);
    expect(keys).toEqual(
      expect.arrayContaining([
        'fn:getToday#out/call_1.url → endpoint:GET /today#in/path',
        'endpoint:GET /today#out/body → fn:getToday#in/ret_1',
        'infra:cdn#out/value → route:/#in/html',
        'route:/#out/render_1 → comp:Island#in/props',
        // 呼び出しでない参照（定数）は箱の単位のまま
        'comp:Island#out/_ → lib:consts#in/_',
        'lib:consts#out/_ → comp:Island#in/_',
        // サーバー側（8-2b）がまだなので endpoint → handler は箱の単位のまま残る（壊れない）
        'endpoint:GET /today#req/_ → handler:api#in/_',
      ]),
    );
    // 置き換わった箱の単位の線
    for (const k of [
      'route:/#out/_ → comp:Island#in/_',
      'comp:Island#out/_ → lib:src/request.ts#in/_',
      'lib:src/request.ts#out/_ → endpoint:GET /today#in/_',
      'endpoint:GET /today#out/_ → lib:src/request.ts#in/_',
    ])
      expect(keys).not.toContain(k);
    expect(cleaned.groups).toBe(1);
    // view の始点が group になった箱なら中の最初の関数の箱
    expect(g.views![0]!.start).toBe('fn:getToday');
    // アダプタの箱の `_` は線が無ければ消える。残ったら crude の links（起動の項目 → out/_、in/_ → out）
    const route = g.nodes.find((n) => n.id === 'route:/')!;
    expect(route.ports.flatMap((p) => p.items.map((i) => i.id))).toEqual(['html', 'render_1']);
    const island = g.nodes.find((n) => n.id === 'comp:Island')!;
    expect(island.links).toEqual(
      expect.arrayContaining([
        { from: 'in/props', to: 'out/_', confidence: 'crude' },
        { from: 'in/_', to: 'out/call_1', confidence: 'crude' },
      ]),
    );
    // endpoint: `_` が残ると links を書き出す（既定の恒等 ＋ `_` への crude）
    const ep = g.nodes.find((n) => n.id === 'endpoint:GET /today')!;
    expect(ep.links).toEqual(
      expect.arrayContaining([
        { from: 'in/path', to: 'req/path' },
        { from: 'res/body', to: 'out/body' },
        { from: 'in/path', to: 'req/_', confidence: 'crude' },
        { from: 'res/_', to: 'out/body', confidence: 'crude' },
      ]),
    );
    expect(g.project?.generator).toEqual({ v2: 'upgrade', adapters: ['ts-types', 'openapi'] });
  });

  it('group の v1 の箱に付いた残りの線: 細かい線が無ければ相手がアダプタの箱でも消さず、中の関数の箱へ付け替える', () => {
    const { upgraded, part } = smallWorld();
    upgraded.wires.push(
      W('handler:api#out/_', 'lib:src/request.ts#in/_', 'call'), // アダプタでない箱から
      W('lib:src/request.ts#out/_', 'route:/#in/_', 'render'), // アダプタの箱へ
    );
    const { g, cleaned } = run(upgraded, part);
    const keys = g.wires.map((w) => `${w.from} → ${w.to}`);
    expect(keys).toEqual(
      expect.arrayContaining([
        'handler:api#out/_ → fn:getToday#in/_',
        'handler:api#out/_ → fn:getAll#in/_',
        // 2026-11-09 変更（8-2a レビュー C1）: 相手がアダプタの箱（route:/）でも、細かい線が無い対の線は消さない
        // （消すと合流できなかった線・overrides で足した線が黙って消える）。手がかり（refs）が無いので中の全部へ
        'fn:getToday#out/_ → route:/#in/_',
        'fn:getAll#out/_ → route:/#in/_',
      ]),
    );
    expect(keys.some((k) => k.startsWith('lib:src/request.ts'))).toBe(false);
    // 2026-11-09 変更（8-2a レビュー C1・C6）: 以前は route:/ への線を消して dropped 1。今は消さず、付け替え先を
    // 決められなかった線として 2 本（handler:api から・route:/ へ）を数える
    expect(cleaned.dropped).toBe(0);
    expect(cleaned.undetermined).toBe(2);
    expect(validateGraphV2(g).errors).toEqual([]);
  });

  it('付け替えは実際に参照している中の関数の箱だけ（アダプタの refs。C6）', () => {
    const { upgraded, part } = smallWorld();
    upgraded.nodes.push(box('schema:Row', 'helper', { file: 'src/db.ts' }));
    upgraded.wires.push(
      W('lib:src/request.ts#out/_', 'schema:Row#in/_', 'call'),
      W('schema:Row#out/_', 'lib:src/request.ts#in/_', 'return', { reply: true }),
      W('route:/#out/_', 'lib:src/request.ts#in/_', 'call'),
    );
    part.refs = { 'fn:getAll': ['schema:Row'], 'route:/': ['fn:getToday'] };
    const { g, cleaned } = run(upgraded, part);
    const keys = g.wires.map((w) => `${w.from} → ${w.to}`);
    expect(keys).toEqual(
      expect.arrayContaining([
        'fn:getAll#out/_ → schema:Row#in/_',
        'schema:Row#out/_ → fn:getAll#in/_',
        'route:/#out/_ → fn:getToday#in/_',
      ]),
    );
    for (const k of [
      'fn:getToday#out/_ → schema:Row#in/_',
      'schema:Row#out/_ → fn:getToday#in/_',
      'route:/#out/_ → fn:getAll#in/_',
    ])
      expect(keys).not.toContain(k);
    expect(cleaned.undetermined).toBe(0);
    expect(validateGraphV2(g).errors).toEqual([]);
  });

  it('合流できなかった HTTP の呼び出し・overrides で足した線（v1 の箱 → endpoint）は消えず、呼び出しを持つ中の関数の箱へ（C1）', () => {
    const { upgraded, part } = smallWorld();
    // getToday の呼び出しのパスが endpoint と合わない（/today/v2）。api-link（か overrides の lib → endpoint）の
    // 箱の単位の線だけが残る
    const getToday = part.nodes.find((n) => n.id === 'fn:getToday')!;
    getToday.ports[1]!.items[0]!.meta = { http: { method: 'GET', path: '/today/v2' } };
    const { g, joined, cleaned } = run(upgraded, part);
    expect(joined.unmatched).toEqual(['fn:getToday GET /today/v2']);
    const keys = g.wires.map((w) => `${w.from} → ${w.to}`);
    expect(keys).toEqual(
      expect.arrayContaining([
        'fn:getToday#out/_ → endpoint:GET /today#in/_',
        'endpoint:GET /today#out/_ → fn:getToday#in/_',
      ]),
    );
    expect(keys.some((k) => k.startsWith('fn:getAll') && k.includes('endpoint'))).toBe(false);
    expect(cleaned.undetermined).toBe(0);
    expect(validateGraphV2(g).errors).toEqual([]);
  });

  it('アダプタの線の端が graph に無ければ落として警告する', () => {
    const { upgraded, part } = smallWorld();
    part.wires.push(W('comp:Island#out/call_1', 'fn:missing#in/call', 'call'));
    const { g, cleaned } = run(upgraded, part);
    expect(g.wires.some((w) => w.to === 'fn:missing#in/call')).toBe(false);
    expect(cleaned.issues.map((i) => i.level)).toEqual(['warning']);
  });

  it('overrides で消した箱はアダプタからも出さない', () => {
    const { upgraded, part } = smallWorld();
    const state = mergeV2(upgraded, part, { removed: new Set(['fn:getAll']) });
    expect(state.graph.nodes.some((n) => n.id === 'fn:getAll')).toBe(false);
  });

  it('被覆 ②: 同じ file の部品・hook（v1 の箱の export でないもの）は group に入れない（2026-11-09 レビュー C5）', () => {
    const { upgraded, part } = smallWorld();
    part.nodes.push({
      id: 'hook:useToday',
      kind: 'hook',
      name: 'useToday',
      file: 'src/request.ts',
      ports: [P('in', 'in', [I('call', 'void')])],
      meta: { ts: { exportName: 'useToday' } },
    });
    const state = mergeV2(upgraded, part);
    expect([...state.groups]).toEqual([['lib:src/request.ts', ['fn:getToday', 'fn:getAll']]]);
    expect(state.graph.nodes.find((n) => n.id === 'hook:useToday')!.group).toBeUndefined();
  });

  it('overrides（C2）: remove の箱の @runtime の複製と、group になるはずだった中の関数の箱も消す。nodes の上書きはアダプタに勝つ', () => {
    const { upgraded, part } = smallWorld();
    // overrides を当てた v1 から作った upgrade: lib:src/request.ts は消え、comp:Island の名前は上書き済み
    const removedV1 = upgraded.nodes.find((n) => n.id === 'lib:src/request.ts')!;
    upgraded.nodes = upgraded.nodes.filter((n) => n.id !== 'lib:src/request.ts');
    upgraded.wires = upgraded.wires.filter(
      (w) => !w.from.startsWith('lib:src/request.ts') && !w.to.startsWith('lib:src/request.ts'),
    );
    upgraded.views = [];
    upgraded.nodes.find((n) => n.id === 'comp:Island')!.name = '島';
    upgraded.nodes.push(box('comp:Shared', 'component'));
    part.nodes.push(
      {
        id: 'comp:Shared@browser',
        kind: 'component',
        name: 'Shared',
        runtime: 'browser',
        ports: [],
        meta: { sharedOf: 'comp:Shared' },
      },
      {
        id: 'comp:Shared@build',
        kind: 'component',
        name: 'Shared',
        runtime: 'build',
        ports: [],
        meta: { sharedOf: 'comp:Shared' },
      },
    );
    const state = mergeV2(upgraded, part, {
      overrides: {
        remove: ['lib:src/request.ts', 'comp:Shared'],
        nodes: [{ id: 'comp:Island', name: '島' }],
      },
      removedNodes: [{ id: removedV1.id, file: removedV1.file!, meta: removedV1.meta! }],
    });
    const ids = state.graph.nodes.map((n) => n.id);
    for (const id of ['fn:getToday', 'fn:getAll', 'comp:Shared@browser', 'comp:Shared@build'])
      expect(ids, id).not.toContain(id);
    expect(state.graph.wires.some((w) => w.to.startsWith('fn:getToday'))).toBe(false);
    expect(state.graph.nodes.find((n) => n.id === 'comp:Island')!.name).toBe('島');
    expect(state.removed).toEqual(
      new Set([
        'lib:src/request.ts',
        'comp:Shared',
        'comp:Shared@browser',
        'comp:Shared@build',
        'fn:getToday',
        'fn:getAll',
      ]),
    );
    const cleaned = cleanupV2(state);
    expect(validateGraphV2(cleaned.graph).errors).toEqual([]);
  });

  it('overrides（C2）: remove の {from, to} は合流の後の線にも当たる（group の中の箱・戻りも）', () => {
    const { upgraded, part } = smallWorld();
    const state = mergeV2(upgraded, part);
    joinEndpoints(state.graph);
    const n = removeOverrideWiresV2(state, {
      remove: [
        { from: 'comp:Island', to: 'lib:src/request.ts', kind: 'uses' },
        { from: 'lib:src/request.ts', to: 'endpoint:GET /today', kind: 'http' },
      ],
    });
    const keys = state.graph.wires.map((w) => `${w.from} → ${w.to}`);
    for (const k of [
      'comp:Island#out/call_1 → fn:getToday#in/call',
      'fn:getToday#out/return → comp:Island#in/ret_1',
      'fn:getToday#out/call_1.url → endpoint:GET /today#in/path',
      'endpoint:GET /today#out/body → fn:getToday#in/ret_1',
      // upgrade の箱の単位の線も
      'comp:Island#out/_ → lib:src/request.ts#in/_',
      'lib:src/request.ts#out/_ → endpoint:GET /today#in/_',
    ])
      expect(keys).not.toContain(k);
    expect(n).toBe(8);
    // kind が合わない線は消さない（uses は render を含むが http は含まない）
    expect(keys).toContain('route:/#out/render_1 → comp:Island#in/props');
  });
});

describe('パイプラインの overrides と要約（2026-11-09 レビュー C2・C8・C10）', () => {
  const stub = (name: string, out: PartialGraph, v2Role?: Extractor['v2Role']): Extractor => ({
    name,
    ...(v2Role ? { v2Role } : {}),
    detect: async () => true,
    extract: async () => out,
  });
  const fn = (
    id: string,
    file: string,
    exportName: string,
    extra: Partial<PartialNodeV2> = {},
  ): PartialNodeV2 => ({
    id,
    kind: 'fn',
    name: exportName,
    file,
    ports: [P('in', 'in', [I('call', 'void')]), P('out', 'out', [I('return', 'void')])],
    meta: { ts: { exportName } },
    ...extra,
  });
  it('overrides.yaml は 1 回だけ読み（警告も 1 回）、v2 にも当てる。言語アダプタと契約を分ける', async () => {
    const root = tmpRepo({
      'stack-atlas.config.yaml': 'project: { name: demo }\n',
      'stack-atlas.overrides.yaml': [
        'bogus: 1',
        'remove:',
        '  - lib:util',
        '  - comp:Shared',
        '  - { from: comp:Card, to: lib:api }',
        'nodes:',
        '  - { id: comp:Card, name: カード }',
      ].join('\n'),
    });
    const log = createMemoryLogger();
    const v1: PartialGraph = {
      nodes: [
        { id: 'lib:api', kind: 'lib', file: 'src/api.ts', meta: { ts: { exports: ['getA'] } } },
        { id: 'lib:util', kind: 'lib', file: 'src/util.ts', meta: { ts: { exports: ['x', 'y'] } } },
        { id: 'comp:Card', kind: 'component', file: 'src/Card.tsx' },
        { id: 'comp:Shared', kind: 'component', file: 'src/Shared.tsx' },
      ],
      edges: [
        { from: 'comp:Card', to: 'lib:api', kind: 'uses' },
        { from: 'comp:Card', to: 'comp:Shared', kind: 'uses' },
      ],
    };
    const lang: PartialGraph = {
      nodes: [],
      edges: [],
      v2: {
        nodes: [
          fn('fn:getA', 'src/api.ts', 'getA'),
          fn('fn:x', 'src/util.ts', 'x'),
          fn('fn:y', 'src/util.ts', 'y'),
          {
            id: 'comp:Card',
            kind: 'component',
            name: 'Card',
            file: 'src/Card.tsx',
            ports: [P('in', 'in', [I('props', '{}')]), P('out', 'out', [I('call_1', 'void')])],
          },
          {
            id: 'comp:Shared@browser',
            kind: 'component',
            name: 'Shared',
            ports: [],
            meta: { sharedOf: 'comp:Shared' },
          },
          {
            id: 'comp:Shared@build',
            kind: 'component',
            name: 'Shared',
            ports: [],
            meta: { sharedOf: 'comp:Shared' },
          },
        ],
        wires: [W('comp:Card#out/call_1', 'fn:getA#in/call', 'call')],
      },
    };
    const contract: PartialGraph = {
      nodes: [
        { id: 'endpoint:GET /a', kind: 'endpoint', meta: { api: { method: 'GET', path: '/a' } } },
      ],
      edges: [],
      v2: {
        nodes: [
          {
            id: 'endpoint:GET /a',
            kind: 'endpoint',
            name: 'GET /a',
            runtime: 'server',
            ports: [
              P('in', 'in', [I('path')]),
              P('req', 'out', [I('path')]),
              P('res', 'in', []),
              P('out', 'out', []),
            ],
          },
        ],
        wires: [],
      },
    };
    const res = await buildGraph({
      root,
      log,
      commit: false,
      extractors: [
        stub('v1', v1),
        stub('lang', lang, 'language'),
        stub('contract', contract, 'contract'),
      ],
    });
    // C8: 2 回読むと同じ警告が 2 回出ていた
    expect(log.of('warn').filter((m) => m.includes('未知のキー "bogus"'))).toHaveLength(1);
    const g = res.graphV2!;
    const ids = g.nodes.map((n) => n.id);
    // C2: remove の複製・group になるはずだった中の関数の箱
    for (const id of ['comp:Shared@browser', 'comp:Shared@build', 'fn:x', 'fn:y'])
      expect(ids, id).not.toContain(id);
    // C2: remove の {from, to} はアダプタの線にも（comp:Card → lib:api の中の fn:getA）
    expect(g.wires.some((w) => w.from.startsWith('comp:Card') && w.to.startsWith('fn:getA'))).toBe(
      false,
    );
    // C2: nodes の上書きはアダプタの名前に勝つ
    expect(g.nodes.find((n) => n.id === 'comp:Card')!.name).toBe('カード');
    // C10: 言語アダプタと契約を分ける
    expect(res.v2Adapters).toMatchObject({ adapters: ['lang'], contracts: ['contract'] });
    expect(g.project?.generator).toMatchObject({ adapters: ['lang'], contracts: ['contract'] });
    expect(res.issues.filter((i) => i.level === 'error')).toEqual([]);
  });
});

describe('合流（endpoint のクライアント側。D52）と writeBroken', () => {
  /** 送る側（TS）と受ける側（OpenAPI）で body の子が食い違う POST */
  function postWorld(): GraphV2 {
    const entry = (wt: 'number' | 'integer', extra: ItemV2[] = []) => [
      I('id', 'string', { wireType: 'string' }),
      I('amount', wt, { wireType: wt }),
      ...extra,
    ];
    return {
      version: 2,
      nodes: [
        {
          id: 'fn:create',
          kind: 'fn',
          name: 'create',
          runtime: 'browser',
          ports: [
            P('in', 'in', [
              I('body', 'Entry', { wireType: 'object', children: entry('number') }),
              I('ret_1', 'void'),
            ]),
            P('out', 'out', [
              I('call_1', 'Promise<void>', {
                wireType: 'object',
                meta: { http: { method: 'POST', path: '/transactions/{id}' } },
                children: [
                  I('url', 'string', { wireType: 'string', meta: { http: 'path' } }),
                  I('query', 'object', {
                    wireType: 'object',
                    meta: { http: 'query' },
                    children: [I('dry')],
                  }),
                  I('body', 'Entry', {
                    wireType: 'object',
                    meta: { http: 'body' },
                    children: entry('number'),
                  }),
                ],
              }),
            ]),
          ],
        },
        {
          id: 'endpoint:POST /transactions/:id',
          kind: 'endpoint',
          name: 'POST /transactions/:id',
          runtime: 'server',
          ports: [
            P('in', 'in', [
              I('path'),
              I('query', 'object', {
                wireType: 'object',
                children: [I('dry', 'string', { optional: true })],
              }),
              I('body', 'Transaction', {
                wireType: 'object',
                children: entry('integer', [I('occurredAt', 'string', { wireType: 'datetime' })]),
              }),
            ]),
            P('req', 'out', []),
            P('res', 'in', []),
            P('out', 'out', [I('status', '201 Created', { wireType: 'integer' })]),
          ],
        },
      ],
      wires: [],
    };
  }

  it('役割ごとに親 1 本（受ける側だけにある必須の子 occurredAt が見つかる）。パスは :id と {id} を同じに扱う', () => {
    const g = postWorld();
    const r = joinEndpoints(g);
    expect(r.matched).toBe(1);
    expect(g.wires.map((w) => [w.from, w.to, w.via, w.reply ?? false, w.label ?? ''])).toEqual([
      [
        'fn:create#out/call_1.url',
        'endpoint:POST /transactions/:id#in/path',
        'http',
        false,
        'POST /transactions/:id',
      ],
      ['fn:create#out/call_1.query', 'endpoint:POST /transactions/:id#in/query', 'http', false, ''],
      ['fn:create#out/call_1.body', 'endpoint:POST /transactions/:id#in/body', 'http', false, ''],
      [
        'endpoint:POST /transactions/:id#out/status',
        'fn:create#in/ret_1',
        'http',
        true,
        '201 Created',
      ],
    ]);
    expect(writeBroken(g)).toBe(1);
    const body = g.wires.find((w) => w.from.endsWith('call_1.body'))!;
    expect(body.broken?.map((b) => [b.path, b.level])).toEqual([
      ['amount', 'warn'],
      ['occurredAt', 'error'],
    ]);
    // body の無い応答（status）から呼び出し元の戻りへは照合しない（fetch の戻りは Response。2026-11-09 の確認）
    expect(g.wires.find((w) => w.reply)!.broken).toBeUndefined();
    expect(validateGraphV2(g).errors).toEqual([]);
  });

  it('照合できない呼び出しは警告（線は引かない）。言語の中の線には broken を書かない', () => {
    const g = postWorld();
    g.nodes[1]!.meta = { api: { method: 'GET', path: '/transactions/{id}' } };
    const r = joinEndpoints(g);
    expect(r.unmatched).toEqual(['fn:create POST /transactions/{id}']);
    expect(r.issues.map((i) => i.level)).toEqual(['warning']);
    // 言語の中の線（送る側だけにある子があっても）
    g.nodes.push({
      id: 'fn:sink',
      kind: 'fn',
      name: 'sink',
      runtime: 'browser',
      ports: [P('in', 'in', [I('body', 'X', { wireType: 'object', children: [I('id')] })])],
    });
    g.wires.push(W('fn:create#out/call_1.body', 'fn:sink#in/body', 'call'));
    expect(writeBroken(g)).toBe(0);
  });
});

describe('自動率（coverageV2。CLI の build の要約）', () => {
  it('項目・unknown、線（項目 / 箱の単位 / 呼び出しでない参照）、links（exact / crude）、不透明な箱', () => {
    const { upgraded, part } = smallWorld();
    const { g } = run(upgraded, part);
    const c = coverageV2(g);
    expect(c.wires).toBe(c.itemWires + c.boxWires);
    expect(c.refWires).toBe(2); // comp:Island ↔ lib:consts
    expect(c.exactLinks).toBe(1);
    expect(c.items).toBeGreaterThan(c.unknownItems);
    expect(c.opaqueBoxes).toBeGreaterThan(0); // handler:api（箱の単位のまま）
  });
});

// ---------------------------------------------------------------------------------------------------------------
// 8-2b: サーバー側と table の合流、D59（役割ごとの欠け）、D65（型）、D66（テーブルの読む線）、掃除の付け替え
// ---------------------------------------------------------------------------------------------------------------

/** endpoint（openapi の 4 口）・Go の handler と store（go-types）・テーブル（sql）の小さな graph（upgrade は空） */
function serverWorld(): GraphV2 {
  const tx = (wt: 'datetime' | 'string' = 'datetime') => [
    I('id', 'string', { wireType: 'string' }),
    I('amount', 'integer', { wireType: 'integer' }),
    I('occurredAt', 'string', { wireType: wt }),
  ];
  const col = (id: string, wireType: ItemV2['wireType'], extra: Partial<ItemV2> = {}) =>
    I(id, 'TEXT', { wireType, typeRef: 'table:transactions', ...extra });
  const cols = (extra: Partial<ItemV2> = {}) => [
    col('id', 'string'),
    col('amount', 'integer', extra),
    col('occurred_at', 'datetime', extra),
  ];
  const endpoint = (method: string, path: string, req: ItemV2[], res: ItemV2[]): NodeV2 => ({
    id: `endpoint:${method} ${path}`,
    kind: 'endpoint',
    name: `${method} ${path}`,
    runtime: 'server',
    ports: [
      P('in', 'in', req),
      P('req', 'out', structuredClone(req)),
      P('res', 'in', res),
      P('out', 'out', structuredClone(res)),
    ],
  });
  return {
    version: 2,
    nodes: [
      box('infra:api', 'infra', { runtime: 'server', ports: [] }),
      box('infra:other', 'infra', { runtime: 'server', ports: [] }),
      endpoint(
        'GET',
        '/tx',
        [I('path')],
        [I('body', 'Tx[]', { wireType: 'array', children: tx().slice(0, 2) })],
      ),
      endpoint(
        'POST',
        '/tx',
        [I('path'), I('body', 'Tx', { wireType: 'object', children: tx() })],
        [I('status', '201', { wireType: 'integer' })],
      ),
      endpoint(
        'DELETE',
        '/tx/{id}',
        [I('path', 'string', { children: [I('id')] })],
        [I('status', '204', { wireType: 'integer' })],
      ),
      {
        id: 'fn:api.list',
        kind: 'fn',
        name: 'api.list',
        runtime: 'server',
        host: 'infra:api',
        meta: {
          route: { method: 'GET', path: '/tx' },
          auth: 'login',
          authBy: { fn: 'fn:auth.Middleware', header: 'Authorization', status: 401 },
        },
        ports: [
          P('in', 'in', [
            I('r', '*http.Request', { wireType: 'unknown' }),
            I('ret_1', '[]Tx', { wireType: 'array', children: tx() }),
          ]),
          P('out', 'out', [
            I('call_1', '[]Tx', { wireType: 'array' }),
            I('txs', '[]Tx', { wireType: 'array', meta: { http: 'response' }, children: tx() }),
          ]),
        ],
      },
      {
        id: 'fn:api.create',
        kind: 'fn',
        name: 'api.create',
        runtime: 'server',
        meta: { route: 'POST /tx', auth: 'login' },
        ports: [
          P('in', 'in', [
            I('body', 'Tx', { wireType: 'object', meta: { http: 'body' }, children: tx() }),
          ]),
          P('out', 'out', [
            I('status', 'http.StatusCreated', { wireType: 'integer', meta: { http: 'status' } }),
          ]),
        ],
      },
      {
        id: 'fn:api.remove',
        kind: 'fn',
        name: 'api.remove',
        runtime: 'server',
        meta: { routes: [{ path: '/tx/{id}' }] },
        ports: [
          P('in', 'in', [
            I('path', 'path', { wireType: 'object', meta: { http: 'path' }, children: [I('id')] }),
          ]),
          P('out', 'out', [
            I('status', 'http.StatusNoContent', { wireType: 'integer', meta: { http: 'status' } }),
          ]),
        ],
      },
      {
        id: 'fn:api.orphan',
        kind: 'fn',
        name: 'api.orphan',
        runtime: 'server',
        meta: { route: { method: 'GET', path: '/nowhere' } },
        ports: [P('in', 'in', [I('r', '*http.Request', { wireType: 'unknown' })])],
      },
      {
        id: 'fn:store.list',
        kind: 'fn',
        name: 'store.list',
        runtime: 'server',
        ports: [
          P('in', 'in', [
            I('day', 'time.Time', { wireType: 'datetime' }),
            // SELECT occurred_at::date, SUM(amount) … の 1 行（id・amount は選んでいない。sum は式）
            I('row', 'record', {
              wireType: 'object',
              meta: { sql: { table: 'transactions', query: 'query_1' } },
              children: [
                col('occurred_at', 'datetime'),
                I('sum', 'SUM(amount)', { wireType: 'unknown', meta: { expr: 'SUM(amount)' } }),
              ],
            }),
          ]),
          P('out', 'out', [
            I('query_1', 'SELECT …', {
              wireType: 'object',
              meta: {
                sql: {
                  table: 'transactions',
                  op: 'select',
                  row: 'row',
                  where: ['occurred_at'],
                  item: 'query_1',
                },
              },
              children: [col('occurred_at', 'datetime')],
            }),
            I('query_2', 'SELECT * …', {
              wireType: 'object',
              meta: {
                sql: { table: 'public.Transactions', op: 'select', where: [], item: 'query_2' },
              },
            }),
            I('query_3', 'SELECT … FROM missing', {
              wireType: 'object',
              meta: { sql: { table: 'missing', op: 'select', where: [], item: 'query_3' } },
            }),
          ]),
        ],
      },
      {
        id: 'fn:store.write',
        kind: 'fn',
        name: 'store.write',
        runtime: 'server',
        ports: [
          P('out', 'out', [
            I('insert_1', 'INSERT …', {
              wireType: 'object',
              meta: { sql: { table: 'transactions', op: 'insert', where: [], item: 'insert_1' } },
              children: [col('id', 'string'), col('amount', 'integer')],
            }),
            I('update_1', 'UPDATE … SET amount = $1 WHERE id = $2', {
              wireType: 'object',
              meta: {
                sql: { table: 'transactions', op: 'update', where: ['id'], item: 'update_1' },
              },
              children: [col('amount', 'integer')],
            }),
          ]),
        ],
      },
      {
        id: 'schema:transactions',
        kind: 'table',
        name: 'transactions',
        runtime: 'data',
        meta: { sql: { table: 'transactions' } },
        ports: [
          P('key', 'in', cols()),
          // occurred_at は DEFAULT now()（INSERT で省ける）
          P('write', 'in', [
            I('row', 'record', {
              wireType: 'object',
              children: [
                col('id', 'string'),
                col('amount', 'integer'),
                col('occurred_at', 'datetime', { optional: true }),
              ],
            }),
          ]),
          P('read', 'out', [I('row', 'record', { wireType: 'object', children: cols() })]),
        ],
      },
      // クライアント（TS）: body を送らない POST（D59）と、GET
      {
        id: 'comp:Toggle',
        kind: 'component',
        name: 'Toggle',
        runtime: 'browser',
        ports: [
          P('in', 'in', [I('props', '{}'), I('ret_1', 'Response', { wireType: 'object' })]),
          P('out', 'out', [
            I('call_1', 'fetch()', {
              wireType: 'object',
              meta: { http: { method: 'POST', path: '/tx' } },
              children: [I('input', 'string', { wireType: 'string', meta: { http: 'path' } })],
            }),
          ]),
        ],
      },
    ],
    wires: [],
  };
}

describe('合流（サーバー側・table・D59。8-2b）', () => {
  it('handler のルート: { method, path }・"METHOD path"・method の無いもの（ANY）・apiRoutes', () => {
    expect(handlerRoutes({ meta: { route: { method: 'get', path: '/a' } } })).toEqual([
      { method: 'GET', path: '/a' },
    ]);
    expect(handlerRoutes({ meta: { route: 'POST /b', routes: ['/c', { path: '/d' }] } })).toEqual([
      { method: 'POST', path: '/b' },
      { method: 'ANY', path: '/c' },
      { method: 'ANY', path: '/d' },
    ]);
    expect(
      handlerRoutes({
        meta: {
          route: 'GET /r/{id}',
          apiRoutes: [
            { method: 'GET', path: '/r/{id}' },
            { method: 'GET', path: '/r' },
          ],
        },
      }),
    ).toEqual([
      { method: 'GET', path: '/r/{id}' },
      { method: 'GET', path: '/r' },
    ]);
    expect(handlerRoutes({ meta: { route: 'not a route' } })).toEqual([]);
  });

  it('サーバー側: 役割ごとに親 1 本（path の子は名前で）、項目の無い handler は req/path → in/r、応答は res/body・res/status（reply）', () => {
    const g = serverWorld();
    const r = joinAll(g);
    const got = (pred: (w: WireV2) => boolean) =>
      g.wires.filter(pred).map((w) => `${w.from} → ${w.to} (${w.via}${w.reply ? ', reply' : ''})`);
    expect(got((w) => w.from.startsWith('endpoint:') && w.via === 'call')).toEqual([
      'endpoint:GET /tx#req/path → fn:api.list#in/r (call)',
      'endpoint:POST /tx#req/body → fn:api.create#in/body (call)',
      'endpoint:DELETE /tx/{id}#req/path → fn:api.remove#in/path (call)',
    ]);
    expect(got((w) => w.to.startsWith('endpoint:') && w.via === 'return')).toEqual([
      'fn:api.list#out/txs → endpoint:GET /tx#res/body (return, reply)',
      'fn:api.create#out/status → endpoint:POST /tx#res/status (return, reply)',
      'fn:api.remove#out/status → endpoint:DELETE /tx/{id}#res/status (return, reply)',
    ]);
    // method の無いルート（ANY）は DELETE に合う。endpoint に無い handler のルートは数えて警告
    expect(r.server).toEqual({
      matched: 3,
      unmatched: ['fn:api.orphan GET /nowhere'],
      withoutHandler: [],
      login: 2,
    });
    expect(r.issues.some((i) => i.message.includes('fn:api.orphan GET /nowhere'))).toBe(true);
    // 合流した箱の対（掃除で細かい線があるものとして数える）
    expect(r.pairs.has('endpoint:GET /tx\u0000fn:api.list')).toBe(true);
    expect(r.pairs.has('fn:api.list\u0000endpoint:GET /tx')).toBe(true);
    writeBroken(g, { fixed: r.fixedBroken });
    // 送る側（handler の応答）だけにある occurredAt は「受ける側に無い」（例の GET /today と同じ）
    const list = g.wires.find((w) => w.from === 'fn:api.list#out/txs')!;
    expect(list.broken?.map((b) => [b.path, b.level])).toEqual([['occurredAt', 'error']]);
    expect(validateGraphV2(g).errors).toEqual([]);
  });

  it('認証: handler の meta.auth = login → endpoint に login の分岐と in → req の links の when（線には付けない）', () => {
    const g = serverWorld();
    joinAll(g);
    const ep = g.nodes.find((n) => n.id === 'endpoint:POST /tx')!;
    expect(ep.variants).toEqual([{ id: 'login', name: 'ログイン済み', default: true }]);
    expect(ep.links).toEqual([
      { from: 'in/path', to: 'req/path', when: { login: true } },
      { from: 'in/body', to: 'req/body', when: { login: true } },
      { from: 'res/status', to: 'out/status' },
    ]);
    expect(ep.meta?.auth).toBe('login');
    const list = g.nodes.find((n) => n.id === 'endpoint:GET /tx')!;
    expect(list.meta?.auth).toBe('auth.Middleware（Authorization ヘッダ）');
    // 認証の無い handler（remove）の endpoint には付けない
    expect(g.nodes.find((n) => n.id === 'endpoint:DELETE /tx/{id}')!.variants).toBeUndefined();
    expect(g.wires.filter((w) => w.when)).toEqual([]);
    expect(validateGraphV2(g).errors).toEqual([]);
  });

  it('handler が複数合うときは、endpoint を受け持つインフラと host が合うものを優先する（合わなければ全部と結んで警告）', () => {
    const g = serverWorld();
    const twin = structuredClone(g.nodes.find((n) => n.id === 'fn:api.list')!);
    twin.id = 'fn:other.list';
    twin.host = 'infra:other';
    g.nodes.push(twin);
    const r = joinAll(g, { endpointHosts: new Map([['endpoint:GET /tx', ['infra:api']]]) });
    expect(g.wires.filter((w) => w.from === 'endpoint:GET /tx#req/path').map((w) => w.to)).toEqual([
      'fn:api.list#in/r',
    ]);
    expect(r.server.matched).toBe(3);
    const g2 = serverWorld();
    g2.nodes.push(twin);
    const r2 = joinAll(g2);
    expect(
      g2.wires
        .filter((w) => w.from === 'endpoint:GET /tx#req/path')
        .map((w) => w.to)
        .sort(),
    ).toEqual(['fn:api.list#in/r', 'fn:other.list#in/r']);
    expect(r2.issues.some((i) => i.message.includes('合う handler が 2 つ'))).toBe(true);
  });

  it('箱の単位の handler（`_` しか無い v1 の箱）と skip した箱（group）はサーバー側の合流に使わない', () => {
    const g = serverWorld();
    g.nodes.push(
      box('handler:internal/api', 'fn', {
        runtime: 'server',
        meta: { apiRoutes: [{ method: 'GET', path: '/tx' }] },
      }),
    );
    const r = joinAll(g, { skip: new Set(['fn:api.create']) });
    expect(g.wires.some((w) => w.to.startsWith('handler:internal/api'))).toBe(false);
    expect(g.wires.some((w) => w.to.startsWith('fn:api.create'))).toBe(false);
    expect(r.server.withoutHandler).toEqual(['endpoint:POST /tx']);
  });

  it('table: WHERE のカラム → key/<col>、WHERE の無い SELECT → key/_、INSERT・UPDATE → write/row（親 1 本）、1 行 → in/row（reply）', () => {
    const g = serverWorld();
    const r = joinAll(g);
    expect(
      g.wires
        .filter((w) => w.via === 'sql')
        .map((w) => `${w.from} → ${w.to}${w.reply ? ' (reply)' : ''}`),
    ).toEqual([
      'fn:store.list#out/query_1.occurred_at → schema:transactions#key/occurred_at',
      'schema:transactions#read/row → fn:store.list#in/row (reply)',
      // `public.Transactions` は最後の段で、大文字小文字を区別せずに引く
      'fn:store.list#out/query_2 → schema:transactions#key/_',
      'fn:store.write#out/insert_1 → schema:transactions#write/row',
      'fn:store.write#out/update_1 → schema:transactions#write/row',
    ]);
    expect(r.table).toEqual({ matched: 4, unmatched: ['fn:store.list#out/query_3 missing'] });
    // WHERE の無い SELECT のために key に `_` を足した
    const t = g.nodes.find((n) => n.id === 'schema:transactions')!;
    expect(t.ports.find((p) => p.id === 'key')!.items.map((i) => i.id)).toContain('_');
    // table の箱に書く口が無い（sql の v2 が無い 8-1 の箱の単位）なら INSERT は結ばず、数えず、対にもしない
    const g2 = serverWorld();
    const t2 = g2.nodes.find((n) => n.id === 'schema:transactions')!;
    t2.ports = t2.ports.filter((p) => p.id !== 'write');
    const r2 = joinAll(g2);
    expect(r2.table.unmatched).toEqual([
      'fn:store.list#out/query_3 missing',
      'fn:store.write#out/insert_1 transactions',
      'fn:store.write#out/update_1 transactions',
    ]);
    expect(r2.pairs.has('fn:store.write\u0000schema:transactions')).toBe(false);
  });

  it('D66: 読む線は受ける側（SELECT のカラム）だけ、UPDATE は送る側（SET のカラム）だけを比べる。INSERT は必須の欠けが error', () => {
    const g = serverWorld();
    const r = joinAll(g);
    writeBroken(g, { fixed: r.fixedBroken });
    const brokenOf = (from: string, to: string) =>
      g.wires.find((w) => w.from === from && w.to === to)!.broken?.map((b) => [b.path, b.level]);
    // テーブルにしか無い id・amount（選んでいない）と、式の sum は「受ける側に無い」「送る側に無い」にしない
    expect(brokenOf('schema:transactions#read/row', 'fn:store.list#in/row')).toBeUndefined();
    // UPDATE は id・occurred_at を書かなくてよい
    expect(
      brokenOf('fn:store.write#out/update_1', 'schema:transactions#write/row'),
    ).toBeUndefined();
    // INSERT は occurred_at（DEFAULT で optional）を省けるが、必須のカラムを省くと error
    expect(
      brokenOf('fn:store.write#out/insert_1', 'schema:transactions#write/row'),
    ).toBeUndefined();
    const ins = g.nodes.find((n) => n.id === 'fn:store.write')!.ports[0]!.items[0]!;
    ins.children = ins.children!.filter((c) => c.id !== 'id');
    writeBroken(g, { fixed: r.fixedBroken });
    expect(brokenOf('fn:store.write#out/insert_1', 'schema:transactions#write/row')).toEqual([
      ['id', 'error'],
    ]);
    // 選んだカラムの型が食い違えば読む線も error（受ける側の子は比べる）
    const row = g.nodes.find((n) => n.id === 'fn:store.list')!.ports[0]!.items[1]!;
    row.children![0]!.wireType = 'boolean';
    writeBroken(g, { fixed: r.fixedBroken });
    expect(brokenOf('schema:transactions#read/row', 'fn:store.list#in/row')).toEqual([
      ['occurred_at', 'error'],
    ]);
  });

  it('D59: 必須の body を丸ごと送っていない呼び出しは、親の call_n から in/body へ線を引いて線そのもの（path ""）を error に', () => {
    const g = serverWorld();
    const r = joinAll(g);
    expect(r.client).toEqual({ matched: 1, direct: 0, unmatched: [], missing: 1 });
    const w = g.wires.find((x) => x.from === 'comp:Toggle#out/call_1')!;
    expect(w).toMatchObject({ to: 'endpoint:POST /tx#in/body', via: 'http' });
    expect(w.broken).toEqual([{ path: '', level: 'error', reason: '送る側に無い（必須の body）' }]);
    // writeBroken は照合し直さない（子の照合では出ないので消さない）
    expect(writeBroken(g, { fixed: r.fixedBroken })).toBeGreaterThanOrEqual(1);
    expect(w.broken).toHaveLength(1);
    expect(validateGraphV2(g).errors).toEqual([]);
    // 任意の body（requestBody が required でない）なら引かない
    const g2 = serverWorld();
    const body = g2.nodes.find((n) => n.id === 'endpoint:POST /tx')!.ports[0]!.items[1]!;
    body.optional = true;
    expect(joinAll(g2).client.missing).toBe(0);
  });

  it('OpenAPI の無いとき: endpoint に合わない呼び出しは、ルートを持つ handler と直接結ぶ（入口の項目へ path の子から、戻りは return）', () => {
    const g: GraphV2 = {
      version: 2,
      nodes: [
        {
          id: 'fn:api.getRaces',
          kind: 'fn',
          name: 'api.getRaces',
          runtime: 'browser',
          ports: [
            P('in', 'in', [I('q', 'Q'), I('ret_1', 'R')]),
            P('out', 'out', [
              I('call_1', 'Promise<R>', {
                meta: { http: { method: 'GET', path: '/races' } },
                children: [I('path', 'string', { meta: { http: 'path' } })],
              }),
            ]),
          ],
        },
        {
          id: 'handler:getRaces',
          kind: 'fn',
          name: 'getRaces',
          runtime: 'server',
          meta: {
            route: 'GET /races/{id}',
            apiRoutes: [
              { method: 'GET', path: '/races/{id}' },
              { method: 'GET', path: '/races' },
            ],
          },
          ports: [
            P('in', 'in', [I('e', 'any', { wireType: 'unknown' })]),
            P('out', 'out', [I('return', 'R')]),
          ],
        },
      ],
      wires: [],
    };
    const r = joinAll(g);
    expect(r.client).toEqual({ matched: 0, direct: 1, unmatched: [], missing: 0 });
    expect(g.wires.map((w) => `${w.from} → ${w.to} (${w.via}${w.reply ? ', reply' : ''})`)).toEqual(
      [
        'fn:api.getRaces#out/call_1.path → handler:getRaces#in/e (http)',
        'handler:getRaces#out/return → fn:api.getRaces#in/ret_1 (http, reply)',
      ],
    );
    // handler の無い呼び出しは結べない（警告は 1 回）
    g.nodes[0]!.ports[1]!.items[0]!.meta = { http: { method: 'GET', path: '/elsewhere' } };
    g.wires = [];
    const r2 = joinAll(g);
    expect(r2.client.unmatched).toEqual(['fn:api.getRaces GET /elsewhere']);
    expect(r2.issues.filter((i) => i.message.includes('結べない HTTP 呼び出し'))).toHaveLength(1);
  });
});

describe('掃除と型（8-2b）', () => {
  it('mergeV2: 複数の入口から使う関数（meta.hosts）は group の host を受け継がない', () => {
    const upgraded: GraphV2 = {
      version: 2,
      nodes: [
        box('schema:internal/store', 'helper', {
          runtime: 'server',
          host: 'infra:api',
          meta: { go: { pkg: 'internal/store' } },
        }),
      ],
      wires: [],
    };
    const fn = (id: string, meta: Record<string, unknown>): PartialNodeV2 => ({
      id,
      kind: 'fn',
      name: id,
      runtime: 'server',
      ports: [P('in', 'in', [I('x')])],
      meta: { go: { pkg: 'internal/store' }, ...meta },
    });
    const state = mergeV2(upgraded, {
      nodes: [
        fn('fn:internal/store.Insert', { hosts: ['infra:api', 'infra:hook'] }),
        fn('fn:internal/store.List', {}),
      ],
      wires: [],
    });
    const byId = new Map(state.graph.nodes.map((n) => [n.id, n]));
    expect(byId.get('fn:internal/store.Insert')!.host).toBeUndefined();
    expect(byId.get('fn:internal/store.List')!.host).toBe('infra:api');
    expect(byId.get('fn:internal/store.Insert')!.group).toBe('schema:internal/store');
  });

  it('掃除: group の v1 の箱からテーブルへの線は、SQL でそのテーブルを使う中の関数の箱へ（無ければ中の全部へ、数える）', () => {
    const table = (id: string): NodeV2 => ({
      id,
      kind: 'table',
      name: id.slice('schema:'.length),
      runtime: 'data',
      meta: { sql: { table: id.slice('schema:'.length) } },
      ports: [P('key', 'in', [{ ...ANY }]), P('read', 'out', [{ ...ANY }])],
    });
    const upgraded: GraphV2 = {
      version: 2,
      nodes: [
        box('handler:cmd/notify', 'fn', { runtime: 'server', meta: { go: { pkg: 'cmd/notify' } } }),
        box('schema:internal/store', 'helper', {
          runtime: 'server',
          meta: { go: { pkg: 'internal/store' } },
        }),
        table('schema:subs'),
        table('schema:other'),
      ],
      wires: [
        W('handler:cmd/notify#out/_', 'schema:subs#key/_', 'sql'),
        W('schema:subs#read/_', 'handler:cmd/notify#in/_', 'sql', { reply: true }),
        W('schema:internal/store#out/_', 'schema:other#key/_', 'sql'),
      ],
    };
    const fn = (id: string, pkg: string, items: ItemV2[] = []): PartialNodeV2 => ({
      id,
      kind: 'fn',
      name: id,
      runtime: 'server',
      ports: [
        P('in', 'in', [I('call', 'void')]),
        P('out', 'out', items.length ? items : [I('return', 'x')]),
      ],
      meta: { go: { pkg } },
    });
    const sqlItem = (table: string) =>
      I('query_1', 'SELECT', {
        meta: { sql: { table, op: 'delete', where: [], item: 'query_1' } },
      });
    const part: PartialGraphV2 = {
      nodes: [
        fn('fn:cmd/notify.main', 'cmd/notify'),
        fn('fn:internal/store.A', 'internal/store'),
        // B は other を SQL で使う（合流では key/_ へ。WHERE が無い DELETE）
        fn('fn:internal/store.B', 'internal/store', [sqlItem('other')]),
      ],
      wires: [],
    };
    const state = mergeV2(upgraded, part);
    const joined = joinAll(state.graph, { skip: new Set(state.groups.keys()) });
    const cleaned = cleanupV2(state, { pairs: joined.pairs });
    const wires = cleaned.graph.wires.map((w) => `${w.from} → ${w.to}`);
    expect(wires).toEqual(
      expect.arrayContaining([
        // notify の中に SQL で subs を使う関数は無い → 中の全部（main）へ付け替える
        'fn:cmd/notify.main#out/_ → schema:subs#key/_',
        'schema:subs#read/_ → fn:cmd/notify.main#in/_',
        // 合流の線（B → other）がある
        'fn:internal/store.B#out/query_1 → schema:other#key/_',
      ]),
    );
    // store → other の箱の単位の線は合流の線で置き換わり、A へは付け替えない
    expect(wires.some((w) => w.startsWith('fn:internal/store.A'))).toBe(false);
    // 2026-11-09 変更（8-2b レビュー）: 中が main 1 つだけの group は付け替え先が決まっている（以前は 2 = 行きと戻り）
    expect(cleaned.undetermined).toBe(0);
  });

  it('D65: 同じ id の型は契約（openapi・sql）が言語アダプタ（typescript・go）に勝ち、負けた側の宣言は copies に', () => {
    const go = {
      id: 'type:Transaction',
      name: 'Transaction',
      file: 'platform/internal/domain/transaction.go',
      line: 7,
      source: 'go',
    };
    const oa = {
      id: 'type:Transaction',
      name: 'Transaction',
      file: 'platform/openapi/today.yaml',
      line: 127,
      source: 'openapi',
      meta: { usedBy: ['endpoint:POST /transactions'] },
    };
    for (const merged of [mergeNamedTypes([go], [oa]), mergeNamedTypes([oa], [go])]) {
      expect(merged).toEqual([
        {
          ...oa,
          meta: {
            usedBy: ['endpoint:POST /transactions'],
            copies: ['platform/internal/domain/transaction.go:7'],
          },
        },
      ]);
    }
    // 言語どうしは先のもの
    const ts = { id: 'type:X', name: 'X', file: 'web/x.ts', line: 1, source: 'typescript' };
    const gx = { id: 'type:X', name: 'X', file: 'p/x.go', line: 2, source: 'go' };
    expect(mergeNamedTypes([ts], [gx])[0]).toMatchObject({
      source: 'typescript',
      meta: { copies: ['p/x.go:2'] },
    });
    // 抽出器どうしのマージ（mergePartialV2）も同じ（go-types が openapi より先に走る）
    const merged = mergePartialV2([
      { nodes: [], wires: [], types: [go] },
      { nodes: [], wires: [], types: [oa] },
    ]);
    expect(merged!.types![0]!.source).toBe('openapi');
  });
});
