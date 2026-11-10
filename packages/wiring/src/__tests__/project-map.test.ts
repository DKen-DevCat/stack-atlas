// 地図の射影（docs/20 §2.1・§5.1・§7。8-6 の Q20 のモックで作り、本実装で groups を足した projectMap / litOnMap）。
// 基準の graph は 8-6 の fixture-poly の build を固定したもの（fixtures/poly-86.v2.json。`--no-screenshots`。
// 2026-11-10 変更（8-6）: モックの examples/map-mock/graph.json から移し、トップの groups が入った build に取り直した。
// 箱・線・型・views はモックの graph と同じ（groups と project.commit・generatedAt だけが違う））
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { validateGraph, type GraphV2, type NodeV2 } from '@stack-atlas/schema';
import { indexGraph } from '../graph-index.js';
import { edgeKey, litOnMap, projectMap, stripRuntime, unitBase } from '../project-map.js';
import { select } from '../select.js';
import { defaultState } from '../variants.js';
import { I, N, P, W } from './fixture.js';

const read = () =>
  JSON.parse(
    readFileSync(fileURLToPath(new URL('./fixtures/poly-86.v2.json', import.meta.url)), 'utf8'),
  ) as GraphV2;

describe('projectMap: fixture-poly（8-6 の build）', () => {
  const g = read();
  const p = projectMap(g, { laneColors: { user: '#cbd5e1', browser: '#4f8cff' } });

  it('v1 の検証を通る（エラーも警告も 0）・決定的', () => {
    expect(validateGraph(p.graph).errors).toEqual([]);
    expect(
      JSON.stringify(
        projectMap(read(), { laneColors: { user: '#cbd5e1', browser: '#4f8cff' } }).graph,
      ),
    ).toBe(JSON.stringify(p.graph));
  });

  it('数: 箱 71 → ノード 50（group 13・host 4）、線 143 → 束 81。層は LANES の順で存在するものだけ', () => {
    expect(g.nodes).toHaveLength(71);
    expect(p.graph.nodes).toHaveLength(50);
    expect([...p.unitKind.values()].filter((k) => k === 'group')).toHaveLength(13);
    expect([...p.unitKind.values()].filter((k) => k === 'host')).toHaveLength(4);
    expect(p.graph.edges).toHaveLength(81);
    expect(p.graph.layers.map((l) => l.id)).toEqual(['user', 'browser', 'edge', 'server', 'data']);
    expect(p.graph.layers[0]).toEqual({ id: 'user', name: '利用者・時刻', color: '#cbd5e1' });
    expect(p.graph.layers[2]!.color).toBeUndefined();
    // 型の層とフローは出さない
    expect(p.graph.nodes.some((n) => n.kind === 'type')).toBe(false);
    expect(p.graph.flows).toBeUndefined();
  });

  it('group は v1 の箱の id のまま（メモと差分のキー）。名前・kind・file は v2 の groups（元の v1 の箱）、名前が重なれば最後の 2 段', () => {
    const byId = new Map(p.graph.nodes.map((n) => [n.id, n]));
    expect(p.members.get('handler:internal/api')).toHaveLength(9);
    expect(p.members.get('schema:internal/store')).toHaveLength(9);
    expect(p.members.get('lib:web/src/feature/spend/request.ts')).toEqual([
      'fn:getToday',
      'fn:getEntries',
      'fn:createTransaction',
    ]);
    // 2026-11-10 変更（8-6）: file は groups の元の v1 の箱の file（以前は中の箱の file の共通のディレクトリ platform/internal/api）
    expect(byId.get('handler:internal/api')).toMatchObject({
      kind: 'handler',
      layer: 'server',
      name: 'internal/api',
      file: 'platform/internal/api/days.go',
    });
    // 元の名前は days/request.ts と同じ request なので、重ならない最後の 2 段
    expect(byId.get('lib:web/src/feature/spend/request.ts')).toMatchObject({
      kind: 'lib',
      layer: 'browser',
      name: 'spend/request',
      file: 'web/src/feature/spend/request.ts',
    });
    expect(byId.get('lib:web/src/feature/days/request.ts')!.name).toBe('days/request');
    expect(byId.get('schema:internal/store')).toMatchObject({
      kind: 'schema',
      name: 'internal/store',
    });
    // group の名前は重ならない（groups が無いときの規則でも同じ）
    const groupNames = p.graph.nodes
      .filter((n) => p.unitKind.get(n.id) === 'group')
      .map((n) => n.name);
    expect(new Set(groupNames).size).toBe(groupNames.length);
    expect(byId.get('route:/')).toMatchObject({ kind: 'page', layer: 'browser', name: '/' });
    expect(byId.get('layout:/')!.kind).toBe('layout');
    expect(byId.get('schema:transactions')).toMatchObject({ kind: 'schema', layer: 'data' });
    // id は infra: でも v2 で trigger の箱は cron（利用者・時刻の層）
    expect(byId.get('infra:scheduler_notify/daily')).toMatchObject({ kind: 'cron', layer: 'user' });
    // 見つかったこと: v1 で type:internal/domain だった 2 つの関数は group が無く、fn: のまま 2 つのノードになる（接頭辞の表に fn は無い）
    expect(byId.get('fn:internal/domain.Sum')).toMatchObject({ kind: 'lib', layer: 'server' });
    expect(byId.has('fn:internal/domain.ToTransaction')).toBe(true);
    expect(byId.has('type:internal/domain')).toBe(false);
  });

  it('画面: HTML は使わない（--no-screenshots の build にはスクショも regions も無いので、地図の画面はプレースホルダ）', () => {
    const today = p.graph.nodes.find((n) => n.id === 'route:/')!;
    expect(today.screen).toEqual({ width: 1280, height: 800, regions: [] });
  });

  it('host は 1 ノードで、中の箱の単位へ deploy。戻り（return・sql・http の reply）は行きの束に入る', () => {
    expect(p.edges.get(edgeKey('infra:lambda_api/api', 'handler:internal/api'))?.edge.kind).toBe(
      'deploy',
    );
    expect(p.edges.get(edgeKey('infra:aurora/this', 'schema:transactions'))?.edge.kind).toBe(
      'deploy',
    );
    // fetcher → GET /today の http の行きと戻りは 1 本（逆向きの束は無い）
    const fetch = p.edges.get(
      edgeKey('lib:web/src/feature/spend/request.ts', 'endpoint:GET /today'),
    )!;
    expect(fetch.edge.kind).toBe('http');
    expect(
      p.edges.has(edgeKey('endpoint:GET /today', 'lib:web/src/feature/spend/request.ts')),
    ).toBe(false);
    // store → テーブルの sql の往復は schema の 1 本
    expect(p.edges.get(edgeKey('schema:internal/store', 'schema:transactions'))?.edge.kind).toBe(
      'schema',
    );
    expect(p.edges.has(edgeKey('schema:transactions', 'schema:internal/store'))).toBe(false);
    // deliver（reply）はデータの向き: S3 → CloudFront → 画面
    expect(
      p.edges.get(edgeKey('infra:static_site/site', 'infra:static_site/this'))?.edge.kind,
    ).toBe('deploy');
    expect(p.edges.get(edgeKey('infra:static_site/this', 'route:/'))?.edge.kind).toBe('deploy');
    // 時刻のイベントは flow
    expect(
      p.edges.get(edgeKey('infra:scheduler_notify/daily', 'handler:cmd/notify'))?.edge.kind,
    ).toBe('flow');
    // 同じ単位の中の線は出さない
    for (const e of p.graph.edges) expect(e.from).not.toBe(e.to);
  });
});

describe('litOnMap: 配線図の選択を地図に写す', () => {
  const g = read();
  const p = projectMap(g);
  const index = indexGraph(g);
  const st = defaultState(index);

  it('route:/ を選ぶ: 18 ノード（/today の経路と配信）が光り、ほかの画面と push は光らない。始点は route:/', () => {
    const m = litOnMap(p, g, select(index, st, { kind: 'box', id: 'route:/' })!);
    expect(m.starts).toEqual(new Set(['route:/']));
    expect(m.nodes.size).toBe(18);
    for (const id of [
      'comp:TodayIsland',
      'lib:fetcher',
      'endpoint:GET /today',
      'handler:internal/api',
      'schema:transactions',
      'infra:lambda_api/api',
    ])
      expect(m.nodes.has(id)).toBe(true);
    for (const id of [
      'route:/calendar',
      'route:/push',
      'comp:PushToggle',
      'lib:internal/push',
      'handler:cmd/notify',
    ])
      expect(m.nodes.has(id)).toBe(false);
    // 光る束の両端は光る
    for (const k of m.edges) {
      const [a, b] = k.split('\n');
      expect(m.nodes.has(a!) && m.nodes.has(b!)).toBe(true);
    }
    expect(m.edges.has(edgeKey('infra:lambda_api/api', 'handler:internal/api'))).toBe(true);
  });

  it('fn:getToday（group の中の 1 箱）: 地図では group のノードが始点として光る', () => {
    const m = litOnMap(p, g, select(index, st, { kind: 'box', id: 'fn:getToday' })!);
    expect(m.starts).toEqual(new Set(['lib:web/src/feature/spend/request.ts']));
    expect(m.nodes.has('endpoint:GET /today')).toBe(true);
    // getEntries・createTransaction の先は光らない（箱の単位でたどる）
    expect(m.nodes.has('endpoint:GET /entries')).toBe(false);
    expect(m.nodes.has('endpoint:POST /transactions')).toBe(false);
  });

  it('地図の group を選ぶ（中の箱ごとにたどって合併）: 中の 3 関数の先がすべて光る', () => {
    const id = 'lib:web/src/feature/spend/request.ts';
    const lit = select(index, st, { kind: 'group', id, members: p.members.get(id)! })!;
    expect(lit.startBoxes).toEqual(
      new Set(['fn:getToday', 'fn:getEntries', 'fn:createTransaction']),
    );
    const m = litOnMap(p, g, lit);
    expect(m.starts).toEqual(new Set([id]));
    // 2026-11-10 追加（8-6）: id はメモのキー（@runtime を外した id）なので、始点は中の箱の単位から引く
    const other = litOnMap(p, g, {
      ...lit,
      selection: { kind: 'group', id: 'x', members: ['fn:getToday'] },
    });
    expect(other.starts).toEqual(new Set([id]));
    for (const e of ['endpoint:GET /today', 'endpoint:GET /entries', 'endpoint:POST /transactions'])
      expect(m.nodes.has(e)).toBe(true);
  });

  it('host を選ぶと始点は host のノード。型の横断面は始点なし', () => {
    const h = litOnMap(p, g, select(index, st, { kind: 'host', id: 'infra:lambda_api/notify' })!);
    expect(h.starts.has('infra:lambda_api/notify')).toBe(true);
    expect(h.nodes.has('handler:cmd/notify')).toBe(true);
    const typeRef = [...index.byTypeRef.keys()][0]!;
    const t = litOnMap(p, g, select(index, st, { kind: 'type', typeRef })!);
    expect(t.starts.size).toBe(0);
  });
});

describe('projectMap: 単位の規則（合成）', () => {
  const box = (id: string, runtime: NodeV2['runtime'], extra: Partial<NodeV2> = {}) =>
    N(
      id,
      'fn',
      runtime,
      [P('in', 'in', [I('a', 'string')]), P('out', 'out', [I('r', 'string')])],
      extra,
    );

  it('group の値が接頭辞で始まらなければ group: を付ける。@runtime は外せる', () => {
    expect(unitBase({ id: 'fn:a', group: 'src/feature' })).toBe('group:src/feature');
    expect(unitBase({ id: 'fn:a', group: 'lib:src/x.ts' })).toBe('lib:src/x.ts');
    expect(unitBase({ id: 'fn:a' })).toBe('fn:a');
    expect(stripRuntime('lib:x@server')).toBe('lib:x');
    expect(stripRuntime('endpoint:GET /a@b')).toBe('endpoint:GET /a@b');
  });

  it('同じ group が 2 つの runtime にあると、箱の多い側が id を持ち、ほかは <id>@<runtime>', () => {
    const g: GraphV2 = {
      version: 2,
      nodes: [
        box('fn:a', 'browser', { group: 'lib:shared' }),
        box('fn:b', 'server', { group: 'lib:shared' }),
        box('fn:c', 'server', { group: 'lib:shared' }),
      ],
      wires: [W('fn:a#out/r', 'fn:b#in/a', 'http'), W('fn:b#out/r', 'fn:a#in/a', 'http', true)],
    };
    const p = projectMap(g);
    expect(p.unitOf.get('fn:b')).toBe('lib:shared');
    expect(p.unitOf.get('fn:a')).toBe('lib:shared@browser');
    expect(p.graph.nodes.map((n) => [n.id, n.layer, n.name])).toEqual([
      ['lib:shared@browser', 'browser', 'shared@browser'],
      ['lib:shared', 'server', 'shared'],
    ]);
    // 戻りの http は向きを戻して 1 本
    expect(p.graph.edges).toEqual([{ from: 'lib:shared@browser', to: 'lib:shared', kind: 'http' }]);
    expect(validateGraph(p.graph).errors).toEqual([]);
  });

  // 2026-11-10 追加（8-6）: v2 のトップの groups（docs/20 §5.1 #3）
  it('groups があれば group のノードの名前・kind・file はその値。無ければ id の接頭辞と最後の段（モックの規則）', () => {
    const nodes = [
      box('fn:a', 'server', { group: 'handler:cmd/api', file: 'platform/cmd/api/main.go' }),
      box('fn:b', 'server', { group: 'handler:cmd/api', file: 'platform/cmd/api/serve.go' }),
      box('fn:c', 'browser', { group: 'lib:src/x/request.ts', file: 'src/x/request.ts' }),
      box('fn:d', 'browser', { group: 'lib:src/y/request.ts', file: 'src/y/request.ts' }),
      box('fn:e', 'browser', { group: 'lib:src/z/util.ts', file: 'src/z/util.ts' }),
    ];
    const without = projectMap({ version: 2, nodes, wires: [] }).graph.nodes;
    expect(without.map((n) => [n.id, n.kind, n.name, n.file])).toEqual([
      ['handler:cmd/api', 'handler', 'cmd/api', 'platform/cmd/api'],
      ['lib:src/x/request.ts', 'lib', 'x/request', 'src/x/request.ts'],
      ['lib:src/y/request.ts', 'lib', 'y/request', 'src/y/request.ts'],
      ['lib:src/z/util.ts', 'lib', 'z/util', 'src/z/util.ts'],
    ]);
    const g: GraphV2 = {
      version: 2,
      nodes,
      wires: [],
      groups: [
        { id: 'handler:cmd/api', name: 'api の入口', kind: 'service', file: 'platform/cmd/api' },
        { id: 'lib:src/x/request.ts', name: 'request', kind: 'lib' },
        { id: 'lib:src/y/request.ts', name: 'request', kind: 'lib' },
        { id: 'lib:src/z/util.ts', name: 'util', kind: 'hook', file: 'src/z/util.ts' },
      ],
    };
    const p = projectMap(g);
    expect(p.graph.nodes.map((n) => [n.id, n.kind, n.name, n.file])).toEqual([
      ['handler:cmd/api', 'service', 'api の入口', 'platform/cmd/api'],
      // 元の名前が重なる 2 つは、重ならない最後の 2 段
      ['lib:src/x/request.ts', 'lib', 'x/request', 'src/x/request.ts'],
      ['lib:src/y/request.ts', 'lib', 'y/request', 'src/y/request.ts'],
      ['lib:src/z/util.ts', 'hook', 'util', 'src/z/util.ts'],
    ]);
    // 1 箱の group でも、groups の元の値があれば行・コードは出さない（関数の行は group の行ではない）
    const one = projectMap({
      version: 2,
      nodes: [box('fn:m', 'server', { group: 'handler:cmd/x', line: 3, code: 'func main()' })],
      wires: [],
      groups: [{ id: 'handler:cmd/x', name: 'cmd/x', kind: 'handler' }],
    }).graph.nodes[0]!;
    expect(one).toMatchObject({ id: 'handler:cmd/x', kind: 'handler', name: 'cmd/x' });
    expect(one.line).toBeUndefined();
    expect(one.code).toBeUndefined();
    expect(validateGraph(p.graph).errors).toEqual([]);
  });

  it('画面の regions の ref は単位に付け替え、無い箱を指すものは落とす', () => {
    const g: GraphV2 = {
      version: 2,
      nodes: [
        N('route:/', 'screen', 'browser', [P('out', 'out', [I('render', 'node')])], {
          screen: {
            html: 'screens/index.html',
            screenshot: 'shots/top.png',
            width: 100,
            height: 80,
            regions: [
              { ref: 'fn:a', x: 1, y: 2, w: 3, h: 4, source: 'yaml' },
              { ref: 'comp:gone', x: 0, y: 0, w: 1, h: 1 },
            ],
          },
        }),
        box('fn:a', 'browser', { group: 'comp:Card' }),
      ],
      wires: [],
    };
    const n = projectMap(g).graph.nodes[0]!;
    expect(n.screen).toEqual({
      width: 100,
      height: 80,
      screenshot: 'shots/top.png',
      regions: [{ ref: 'comp:Card', x: 1, y: 2, w: 3, h: 4 }],
    });
  });

  it('束の kind は deploy ＞ http ＞ schema ＞ uses ＞ flow', () => {
    const g: GraphV2 = {
      version: 2,
      nodes: [box('fn:a', 'server'), box('fn:b', 'server')],
      wires: [
        W('fn:a#out/r', 'fn:b#in/a', 'call'),
        W('fn:a#out/r', 'fn:b#in/a', 'sql'),
        W('fn:a#out/r', 'fn:b#in/a', 'event'),
      ],
    };
    expect(projectMap(g).graph.edges).toEqual([{ from: 'fn:a', to: 'fn:b', kind: 'schema' }]);
  });
});
