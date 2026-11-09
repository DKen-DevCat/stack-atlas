// ハーネスの core（Phase 8-4a。docs/19 §3）: 補い（overrides の v2:。段 A / B・意味の参照・指紋・retarget・既定の links の
// 実体化）、手書きの部分グラフ、views.yaml、数え直し、strict（各規則が出ること・補いで消えること）、remove の警告
import {
  validateGraphV2,
  type GraphV2,
  type ItemV2,
  type NodeV2,
  type PortV2,
} from '@stack-atlas/schema';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadHandGraphs } from '../hand-graph.js';
import { createMemoryLogger } from '../logger.js';
import { buildGraph, type BuildGraphResult } from '../pipeline.js';
import { strictIssues } from '../strict.js';
import {
  applySupplementsA,
  applySupplementsB,
  materializeDefaultLinks,
  type SupplementResult,
} from '../supplements.js';
import type { Extractor, PartialGraph, PartialNodeV2 } from '../types.js';
import { applyViewsYaml } from '../views-yaml.js';
import { SafeOutput } from '../fsafe.js';
import { tmpRepo } from './helpers.js';

const I = (id: string, type = 'string', extra: Partial<ItemV2> = {}): ItemV2 => ({
  id,
  name: id,
  type,
  ...extra,
});
const P = (id: string, dir: 'in' | 'out', items: ItemV2[]): PortV2 => ({ id, dir, items });
const stub = (name: string, out: PartialGraph, v2Role?: Extractor['v2Role']): Extractor => ({
  name,
  ...(v2Role ? { v2Role } : {}),
  detect: async () => true,
  extract: async () => structuredClone(out),
});

// --- 隙間を仕込んだ世界（strict の各規則が出る。補いで全部消える）---

const HTTP_PATH = '/races-${x}';
const v1: PartialGraph = {
  nodes: [
    { id: 'route:/', kind: 'page', file: 'src/app/page.tsx' },
    { id: 'lib:peer', kind: 'lib', file: 'src/peer.ts' },
    { id: 'handler:svc', kind: 'handler', file: 'svc/svc.go', meta: { go: { pkg: 'svc' } } },
    { id: 'schema:t', kind: 'schema', meta: { sql: { table: 't' } } },
    { id: 'infra:lambda', kind: 'infra', name: 'lambda' },
  ],
  edges: [{ from: 'lib:peer', to: 'handler:svc', kind: 'uses' }],
  flows: [
    {
      id: 'main',
      name: 'flows の始点',
      steps: [
        { node: 'route:/', text: '開く' },
        { node: 'lib:peer', text: '呼ぶ' },
      ],
    },
  ],
};
const goFn = (id: string, ports: PortV2[]): PartialNodeV2 => ({
  id,
  kind: 'fn',
  name: id.slice(3),
  file: 'svc/svc.go',
  runtime: 'server',
  ports,
  meta: { go: { pkg: 'svc' } },
});
const lang: PartialGraph = {
  nodes: [],
  edges: [],
  v2: {
    nodes: [
      {
        id: 'fn:getRaces',
        kind: 'fn',
        name: 'getRaces',
        file: 'src/races.ts',
        runtime: 'browser',
        ports: [
          P('in', 'in', [I('call', 'void'), I('ret_1', 'Race[]')]),
          P('out', 'out', [
            I('call_1', 'Promise<Race[]>', {
              name: 'fetcher()',
              meta: { http: { method: 'GET', path: HTTP_PATH } },
              children: [I('path', 'string', { meta: { http: 'path' } })],
            }),
          ]),
        ],
      },
      goFn('fn:svc.A', [
        P('in', 'in', [I('r', '*http.Request')]),
        P('out', 'out', [
          I('query_1', 'row', {
            name: 'SELECT ghost',
            meta: { sql: { table: 'ghost', op: 'select' } },
          }),
        ]),
      ]),
      goFn('fn:svc.B', [
        P('in', 'in', [I('r', '*http.Request')]),
        P('out', 'out', [I('return', 'error')]),
      ]),
      {
        id: 'fn:hook',
        kind: 'fn',
        name: 'hook',
        file: 'hook/hook.go',
        runtime: 'server',
        meta: { route: 'POST /hook' },
        ports: [P('in', 'in', [I('r', '*http.Request')]), P('out', 'out', [I('return', 'error')])],
      },
    ],
    wires: [],
  },
};
const endpoint = (method: string, path: string): PartialNodeV2 => ({
  id: `endpoint:${method} ${path}`,
  kind: 'endpoint',
  name: `${method} ${path}`,
  runtime: 'server',
  meta: { api: { method, path } },
  ports: [
    P('in', 'in', [I('path', 'string')]),
    P('req', 'out', [I('path', 'string')]),
    P('res', 'in', [I('body', 'Race[]', { wireType: 'array' })]),
    P('out', 'out', [I('body', 'Race[]', { wireType: 'array' })]),
  ],
});
const contract: PartialGraph = {
  nodes: [],
  edges: [],
  v2: { nodes: [endpoint('GET', '/races')], wires: [] },
};
const skippy: Extractor = {
  name: 'skippy',
  v2Role: 'language',
  detect: async () => true,
  extract: async () => ({ nodes: [], edges: [], skipped: '道具が見つかりません' }),
};

const CONFIG = 'project: { name: gaps }\nscreens: { from: dir, dir: export }\n';

async function build(
  files: Record<string, string>,
  extractors: Extractor[],
): Promise<BuildGraphResult> {
  const root = tmpRepo({ 'stack-atlas.config.yaml': CONFIG, ...files });
  return buildGraph({
    root,
    extractors,
    log: createMemoryLogger(),
    commit: false,
    now: new Date('2026-11-09T00:00:00Z'),
  });
}

const rules = (r: BuildGraphResult) => strictIssues(r).errors.map((e) => e.rule);

describe('strict（docs/19 §3.3）: 隙間を仕込んだ世界で各規則が出て、補いで消える', () => {
  it('補い無し: unjoined（呼び出し・ルート・SQL）・undetermined・screens・views・remove・skipped がエラー', async () => {
    const res = await build(
      {
        'stack-atlas.overrides.yaml':
          'remove: [ghost:x]\nnodes: [{ id: actor:user, kind: actor, name: 利用者 }]\n',
        '.stack-atlas/views.yaml': 'views: [{ id: lost, name: 迷子, start: "route:/nope" }]\n',
      },
      [
        stub('v1', v1),
        stub('lang', lang, 'language'),
        stub('contract', contract, 'contract'),
        skippy,
      ],
    );
    expect(res.issues.filter((i) => i.level === 'error')).toEqual([]);
    const h = res.harness!;
    expect(h.unjoined.calls).toEqual([
      { box: 'fn:getRaces', item: 'fn:getRaces#out/call_1', method: 'GET', path: HTTP_PATH },
    ]);
    expect(h.unjoined.routesWithoutEndpoint).toEqual([
      { box: 'fn:hook', method: 'POST', path: '/hook' },
    ]);
    expect(h.unjoined.sql).toEqual([{ item: 'fn:svc.A#out/query_1', table: 'ghost' }]);
    expect(h.unjoined.endpointsWithoutHandler).toEqual(['endpoint:GET /races']);
    expect(h.undetermined).toEqual([
      { group: 'handler:svc', peer: 'lib:peer', via: 'call', candidates: ['fn:svc.A', 'fn:svc.B'] },
      {
        group: 'handler:svc',
        peer: 'lib:peer',
        via: 'return',
        candidates: ['fn:svc.A', 'fn:svc.B'],
      },
    ]);
    expect(h.removeMissing).toEqual(['ghost:x']);
    expect(h.checked.skippy).toEqual({
      status: 'skipped',
      role: 'language',
      reason: '道具が見つかりません',
    });
    expect(h.screens.routes).toEqual([{ route: '/', html: false }]);
    expect([...new Set(rules(res))].sort()).toEqual(
      ['remove', 'screens', 'skipped', 'undetermined', 'unjoined', 'views'].sort(),
    );
    const s = strictIssues(res);
    expect(s.errors.filter((e) => e.rule === 'unjoined')).toHaveLength(3);
    // 警告（D71・D86）: handler の無い endpoint・口の単位の線・不透明な箱・unknown・overrides で足した線の無い箱
    expect(new Set(s.warnings.map((w) => w.rule))).toEqual(
      new Set(['endpoint-without-handler', 'box-wires', 'opaque', 'unknown', 'added-box']),
    );
    expect(s.warnings.find((w) => w.rule === 'added-box')!.path).toBe('v2:actor:user');
    // remove の警告は v1 にも v2 にも無い id だけ（文も直した。docs/17 §8.3b の 8）
    expect(
      res.issues.filter((i) => i.message.includes('削除しようとしたノード')).map((i) => i.message),
    ).toEqual(['削除しようとしたノード "ghost:x" は v1 にも v2 にもありません']);
    // graph.json の報告（validate --strict が読む）
    const report = res.graphV2!.project!.generator!.report!;
    expect(report.version).toBe(1);
    expect(report.counts).toMatchObject({
      unjoined: 3,
      undetermined: 2,
      removeMissing: 1,
      screensWithoutHtml: 1,
    });
    expect(report.counts.strictErrors).toBe(s.errors.length);
    expect(report.lists!.strictErrors).toHaveLength(s.errors.length);
    expect(validateGraphV2(res.graphV2).errors).toEqual([]);
  });

  it('補いで全部消える（v2.wires・retarget・nodes・items・variants・links・when、手書きの部分グラフ、views.yaml）', async () => {
    const overrides = `
nodes: [{ id: actor:user, kind: actor, name: 利用者 }]
edges: [{ from: actor:user, to: route:/, kind: flow }]
v2:
  wires:
    - from: { call: { in: fn:getRaces, http: "GET ${HTTP_PATH}" }, path: path }
      to: "endpoint:GET /races#in/path"
      via: http
      reason: ラッパーの引数がテンプレートでパスを読めない
    - from: { ref: "fn:svc.A#out/query_1", expect: { name: SELECT ghost, type: row } }
      to: "schema:t#key/_"
      via: sql
      reason: テーブル名が別名
  retarget:
    - { group: handler:svc, peer: lib:peer, to: [fn:svc.B], reason: peer は B だけを呼ぶ }
  nodes:
    - { id: fn:hook, host: infra:lambda, reason: hook の Lambda }
  items:
    - at: "fn:hook#in/r"
      expect: { type: "*http.Request" }
      children: [{ id: amount, name: amount, type: int64, wireType: integer }]
      reason: body を map で読む
  variants:
    - { node: fn:getRaces, id: cached, name: キャッシュ, reason: メモリのキャッシュ }
  links:
    - { node: fn:getRaces, from: in/call, to: { call: { http: "GET ${HTTP_PATH}" } }, reason: 起動で呼ぶ }
  when:
    - node: fn:getRaces
      link: { from: in/call, to: { call: { http: "GET ${HTTP_PATH}" } } }
      when: { cached: false }
      reason: キャッシュが無いときだけ呼ぶ
`;
    const hand = `
nodes:
  - id: "endpoint:POST /hook"
    kind: endpoint
    name: POST /hook
    runtime: server
    meta: { api: { method: POST, path: /hook } }
    ports:
      - { id: in, dir: in, items: [{ id: body, name: body, type: object, wireType: object }] }
      - { id: req, dir: out, items: [{ id: body, name: body, type: object, wireType: object }] }
      - { id: res, dir: in, items: [] }
      - { id: out, dir: out, items: [] }
`;
    const screens: Extractor = stub('screens', {
      nodes: [
        { id: 'route:/', screen: { html: 'screens/index/index.html', width: 1280, height: 800 } },
      ],
      edges: [],
    });
    const res = await build(
      {
        'stack-atlas.overrides.yaml': overrides,
        '.stack-atlas/graph/hook.v2.yaml': hand,
        '.stack-atlas/views.yaml': 'views: [{ id: main, name: 画面から, start: "route:/" }]\n',
      },
      [
        stub('v1', v1),
        stub('lang', lang, 'language'),
        stub('contract', contract, 'contract'),
        screens,
      ],
    );
    expect(res.issues.filter((i) => i.level === 'error')).toEqual([]);
    expect(res.harness!.supplements.filter((s) => s.status !== 'applied')).toEqual([]);
    expect(
      res.harness!.supplements.filter((s) => s.noReason && s.kind !== 'hand' && s.kind !== 'view'),
    ).toEqual([]);
    expect(strictIssues(res).errors).toEqual([]);
    const g = res.graphV2!;
    const node = (id: string) => g.nodes.find((n) => n.id === id)!;
    // 段 A: 補った線は crude と by。retarget で B だけへ（A には付け替えない）
    const w = g.wires.find((x) => x.from === 'fn:getRaces#out/call_1.path')!;
    expect(w).toMatchObject({
      to: 'endpoint:GET /races#in/path',
      via: 'http',
      meta: { by: 'overrides', confidence: 'crude' },
    });
    expect(
      g.wires.some((x) => x.to.startsWith('fn:svc.B#in/') && x.from.startsWith('lib:peer')),
    ).toBe(true);
    expect(
      g.wires.some((x) => x.to.startsWith('fn:svc.A#in/') && x.from.startsWith('lib:peer')),
    ).toBe(false);
    expect(node('fn:hook').host).toBe('infra:lambda');
    // 手書きの endpoint は OpenAPI と同じく自動で handler と合流する（meta.route）
    expect(
      g.wires.some(
        (x) => x.from === 'endpoint:POST /hook#req/body' && x.to.startsWith('fn:hook#in/'),
      ),
    ).toBe(true);
    expect(node('endpoint:POST /hook').meta).toMatchObject({
      by: 'hand',
      handFile: '.stack-atlas/graph/hook.v2.yaml',
    });
    expect(res.v2Adapters!.adapters).toContain('hand');
    // 段 B: items → variants → links → when（when は links が足した links と variants の分岐を指せる）
    expect(node('fn:hook').ports[0]!.items[0]!.children).toEqual([
      {
        id: 'amount',
        name: 'amount',
        type: 'int64',
        wireType: 'integer',
        confidence: 'crude',
        meta: { by: 'overrides', reason: 'body を map で読む' },
      },
    ]);
    expect(node('fn:getRaces').variants).toEqual([{ id: 'cached', name: 'キャッシュ' }]);
    expect(node('fn:getRaces').links).toContainEqual({
      from: 'in/call',
      to: 'out/call_1',
      when: { cached: false },
      confidence: 'crude',
      meta: { by: 'overrides', reason: '起動で呼ぶ' },
    });
    // views.yaml は flows 由来の同じ id に勝つ
    expect(g.views).toEqual([{ id: 'main', name: '画面から', start: 'route:/' }]);
    // 数え直し（D73）: 結べなかったものは補いで 0、v2Adapters の unjoined も最後の graph から
    expect(res.harness!.unjoined).toEqual({
      calls: [],
      endpointsWithoutHandler: ['endpoint:GET /races'],
      routesWithoutEndpoint: [],
      sql: [],
    });
    expect(res.v2Adapters!.unjoined).toEqual([]);
    expect(res.v2Adapters!.join.client.unmatched).toHaveLength(1); // 合流の時点の数はそのまま
    expect(res.harness!.undetermined).toEqual([]);
    expect(res.v2Adapters!.undetermined).toBe(0);
    expect(validateGraphV2(g).errors).toEqual([]);
  });

  it('reason の無い補いは警告（strict ではエラー）。形の違う v2: は警告して捨てる', async () => {
    const root = tmpRepo({
      'stack-atlas.config.yaml': CONFIG,
      'stack-atlas.overrides.yaml':
        'v2:\n  variants: [{ node: fn:getRaces, id: x, name: x }]\n  bogus: []\n  links: 3\n',
    });
    const log = createMemoryLogger();
    const res = await buildGraph({
      root,
      extractors: [stub('v1', v1), stub('lang', lang, 'language')],
      log,
      commit: false,
    });
    const s = strictIssues(res).errors.filter((e) => e.rule === 'supplements');
    expect(s).toHaveLength(1);
    expect(s[0]!.message).toContain('reason がありません');
    expect(res.issues.some((i) => i.message.includes('reason がありません'))).toBe(true);
    expect(log.of('warn')).toEqual(
      expect.arrayContaining([
        expect.stringContaining('v2 の未知のキー "bogus"'),
        expect.stringContaining('v2.links は配列で書いてください'),
      ]),
    );
  });

  it('remove に言語アダプタだけが出す id（fn:）を書いても警告しない（v2 で消える。docs/17 §8.3b の 8）', async () => {
    const res = await build({ 'stack-atlas.overrides.yaml': 'remove: [fn:getRaces]\n' }, [
      stub('v1', v1),
      stub('lang', lang, 'language'),
    ]);
    expect(res.issues.filter((i) => i.message.includes('削除しようとしたノード'))).toEqual([]);
    expect(res.harness!.removeMissing).toEqual([]);
    expect(res.graphV2!.nodes.some((n) => n.id === 'fn:getRaces')).toBe(false);
    expect(rules(res)).not.toContain('remove');
  });
});

describe('strictIssues の規則（文と警告）', () => {
  const base = async () =>
    build({}, [
      stub('v1', v1),
      stub('lang', lang, 'language'),
      stub('contract', contract, 'contract'),
    ]);
  it('解けない・指紋の合わない補いと views、カバー率 0・broken・typeRef の欠けの警告', async () => {
    const res = await base();
    const h = res.harness!;
    h.supplements = [
      { kind: 'wires', index: 0, status: 'mismatch', message: 'm', reason: 'r' },
      { kind: 'view', index: 1, status: 'unresolved', target: 'v', message: 'start が無い' },
      { kind: 'hand', index: 0, status: 'applied', target: 'f' },
    ];
    h.screens.routes = [{ route: '/', html: true, coverage: { reachable: 2, dom: 0, yaml: 0 } }];
    res.graphV2!.wires[0]!.broken = [{ path: '', level: 'error', reason: 'x' }];
    res.v2Warnings = [
      {
        level: 'warning',
        path: '/x',
        message: '項目 "a" の typeRef "type:X" が types にありません',
      },
    ];
    const s = strictIssues(res);
    expect(s.errors.filter((e) => e.rule === 'supplements' || e.rule === 'views')).toEqual([
      { rule: 'supplements', path: 'supplements:wires', message: 'v2.wires[0]: 指紋が合わない。m' },
      { rule: 'views', path: 'supplements:view', message: 'view[1]（v）: 解けない。start が無い' },
    ]);
    expect(s.warnings.map((w) => w.rule)).toEqual(
      expect.arrayContaining(['coverage', 'broken', 'type-ref']),
    );
    expect(strictIssues({ ...res, graphV2: undefined }).errors[0]!.rule).toBe('v2');
  });
});

// --- 段 A / B の単体 ---

function world(): GraphV2 {
  return {
    version: 2,
    nodes: [
      {
        id: 'fn:a',
        kind: 'fn',
        name: 'a',
        runtime: 'browser',
        ports: [
          P('in', 'in', [
            I('call', 'void'),
            I('ret_1', 'R'),
            I('entries', 'E[]', { children: [I('amount', 'number')] }),
          ]),
          P('out', 'out', [
            I('call_1', 'R', {
              name: 'getRaces()',
              meta: { http: { method: 'GET', path: '/races' } },
            }),
            I('rows', 'Row[]', { children: [I('total', 'number')] }),
          ]),
        ],
      },
      {
        id: 'fn:b',
        kind: 'fn',
        name: 'b',
        runtime: 'browser',
        ports: [P('in', 'in', [I('call', 'void')]), P('out', 'out', [I('ret', 'R')])],
      },
      {
        id: 'endpoint:GET /races',
        kind: 'endpoint',
        name: 'GET /races',
        runtime: 'server',
        ports: [P('in', 'in', [I('path', 'string')]), P('req', 'out', [I('path', 'string')])],
      },
    ],
    wires: [
      { from: 'fn:a#out/call_1', to: 'fn:b#in/call', via: 'call' },
      { from: 'fn:b#out/ret', to: 'fn:a#in/ret_1', via: 'return', reply: true },
    ],
  };
}

const statuses = (rs: SupplementResult[]) => rs.map((r) => `${r.kind}:${r.status}`);

describe('参照（docs/19 §3.1、D67）: 意味の参照と指紋', () => {
  it('意味の参照 call（to・http）と ret は、候補がちょうど 1 つなら解ける', () => {
    const g = world();
    const a = applySupplementsA(g, {
      wires: [
        {
          from: { call: { in: 'fn:a', to: 'fn:b' } },
          to: 'endpoint:GET /races#in/path',
          via: 'http',
          reason: 'r',
        },
        {
          from: { call: { in: 'fn:a', http: 'GET /races' } },
          to: 'fn:b#in/call',
          via: 'call',
          reason: 'r',
        },
        {
          from: 'fn:b#out/ret',
          to: { ret: { in: 'fn:a', from: 'fn:b' } },
          via: 'return',
          reason: 'r',
        },
      ],
    });
    expect(statuses(a.results)).toEqual(['wires:applied', 'wires:applied', 'wires:applied']);
    expect(a.results[1]!.message).toBe('同じ線が既にあります');
    expect(g.wires.find((w) => w.to === 'endpoint:GET /races#in/path')!.from).toBe(
      'fn:a#out/call_1',
    );
  });

  it('番号の参照は expect が要る。前に呼び出しを 1 つ足すと番号の補いは指紋が合わず失敗し、意味の参照は追いかける', () => {
    const sup = {
      wires: [
        {
          from: { ref: 'fn:a#out/call_1', expect: { name: 'getRaces()', http: 'GET /races' } },
          to: 'endpoint:GET /races#in/path',
          via: 'http',
          reason: 'r',
        },
        {
          from: { call: { in: 'fn:a', http: 'GET /races' } },
          to: 'endpoint:GET /races#in/path',
          via: 'http',
          reason: 'r',
        },
        { from: 'fn:a#out/call_1', to: 'endpoint:GET /races#in/path', via: 'http', reason: 'r' },
      ],
    };
    const before = applySupplementsA(world(), sup);
    expect(statuses(before.results)).toEqual([
      'wires:applied',
      'wires:applied',
      'wires:unresolved',
    ]);
    expect(before.results[2]!.message).toContain('expect');
    // 前に呼び出し（log()）が入り、getRaces は call_2 になった
    const g = world();
    const a = g.nodes[0]!;
    const out = a.ports[1]!;
    out.items = [
      I('call_1', 'void', { name: 'log()' }),
      { ...out.items[0]!, id: 'call_2' },
      ...out.items.slice(1),
    ];
    g.wires[0]!.from = 'fn:a#out/call_2';
    const after = applySupplementsA(g, sup);
    expect(statuses(after.results)).toEqual([
      'wires:mismatch',
      'wires:applied',
      'wires:unresolved',
    ]);
    expect(after.results[0]!.message).toContain('name が "log()"（expect "getRaces()"）');
    expect(g.wires.find((w) => w.to === 'endpoint:GET /races#in/path')!.from).toBe(
      'fn:a#out/call_2',
    );
  });

  it('候補が 2 つ以上・無い・向きが違う・group の v1 の箱・via が無いものは解けない', () => {
    const g = world();
    g.wires.push({ from: 'fn:a#out/rows', to: 'fn:b#in/call', via: 'call' });
    const a = applySupplementsA(
      g,
      {
        wires: [
          {
            from: { call: { in: 'fn:a', to: 'fn:b' } },
            to: 'fn:b#in/call',
            via: 'call',
            reason: 'r',
          },
          {
            from: { call: { in: 'fn:a', http: 'POST /x' } },
            to: 'fn:b#in/call',
            via: 'call',
            reason: 'r',
          },
          { from: 'fn:b#in/call', to: 'fn:a#in/call', via: 'call', reason: 'r' },
          { from: 'lib:g#out/_', to: 'fn:b#in/call', via: 'call', reason: 'r' },
          { from: 'fn:a#out/rows', to: 'fn:b#in/call', reason: 'r' },
          { from: 'fn:a#out/rows', to: 'fn:nope#in/x', via: 'call', reason: 'r' },
        ],
      },
      { groups: new Map([['lib:g', ['fn:a']]]) },
    );
    expect(statuses(a.results)).toEqual(Array(6).fill('wires:unresolved'));
    expect(a.results.map((r) => r.message)).toEqual([
      expect.stringContaining('2 つあります'),
      expect.stringContaining('POST /x の呼び出しがありません'),
      expect.stringContaining('dir out の口の項目ではありません'),
      expect.stringContaining('箱 lib:g がありません'),
      expect.stringContaining('via'),
      expect.stringContaining('箱 fn:nope がありません'),
    ]);
  });

  it('remove は線（項目の参照か箱 id の組）を消す。無ければ解けない', () => {
    const g = world();
    const a = applySupplementsA(g, {
      remove: [
        { wire: { from: 'fn:b', to: 'fn:a' }, reason: 'r' },
        { wire: { from: 'fn:b#out/ret', to: 'fn:a#in/ret_1' }, reason: 'r' },
      ],
    });
    expect(statuses(a.results)).toEqual(['remove:applied', 'remove:unresolved']);
    expect(g.wires).toHaveLength(1);
  });
});

describe('段 B: 既定の links の実体化・mode: replace・items・when', () => {
  it('links の無い箱は既定（全 in → 全 out）を書き出してから足す。mode: replace は置き換え', () => {
    const g = world();
    applySupplementsB(g, {
      links: [{ node: 'fn:a', from: 'in/entries.amount', to: 'out/rows.total', reason: 'r' }],
    });
    const a = g.nodes[0]!;
    // 既定 3 × 2 = 6 本（crude）＋ 足した 1 本
    expect(a.links).toHaveLength(7);
    expect(a.links!.filter((l) => l.meta?.by === 'overrides')).toEqual([
      {
        from: 'in/entries.amount',
        to: 'out/rows.total',
        confidence: 'crude',
        meta: { by: 'overrides', reason: 'r' },
      },
    ]);
    expect(a.links!.slice(0, 6).every((l) => l.confidence === 'crude' && !l.meta)).toBe(true);
    const h = world();
    applySupplementsB(h, {
      links: [
        {
          node: 'fn:a',
          from: 'in/entries',
          to: 'out/rows',
          mode: 'replace',
          confidence: 'exact',
          reason: 'r',
        },
        { node: 'fn:a', from: 'in/entries.amount', to: 'out/rows.total', reason: 'r' },
      ],
    });
    expect(h.nodes[0]!.links!.map((l) => `${l.from}>${l.to}:${l.confidence}`)).toEqual([
      'in/entries>out/rows:exact',
      'in/entries.amount>out/rows.total:crude',
    ]);
  });

  it('既定の links の形は wiring の defaultLinks と同じ（table は key → read、endpoint は恒等）', () => {
    const table: NodeV2 = {
      id: 'schema:t',
      kind: 'table',
      name: 't',
      runtime: 'data',
      ports: [
        P('key', 'in', [I('id')]),
        P('write', 'in', [I('row', 'row')]),
        P('read', 'out', [I('row', 'row')]),
      ],
    };
    expect(materializeDefaultLinks(table)).toEqual([{ from: 'key/id', to: 'read/row' }]);
    const ep = world().nodes[2]!;
    expect(materializeDefaultLinks(ep)).toEqual([{ from: 'in/path', to: 'req/path' }]);
  });

  it('items はアダプタの子がある項目には足せない。when は links が無ければ解けない。分岐の id は upsert', () => {
    const g = world();
    const r = applySupplementsB(g, {
      items: [
        { at: 'fn:a#in/entries', children: [{ id: 'x' }], reason: 'r' },
        { at: 'fn:a#in/call', expect: { type: 'Nope' }, children: [{ id: 'x' }], reason: 'r' },
        { at: 'fn:b#in/call', children: [{ id: 'bad.id' }], reason: 'r' },
      ],
      variants: [
        { node: 'fn:a', id: 'flag', name: 'A', reason: 'r' },
        { node: 'fn:a', id: 'flag', name: 'B', default: true, reason: 'r' },
      ],
      when: [
        {
          node: 'fn:b',
          link: { from: 'in/call', to: 'out/nope' },
          when: { flag: true },
          reason: 'r',
        },
        {
          node: 'fn:a',
          link: { from: 'in/call', to: 'out/rows' },
          when: { flag: true },
          reason: 'r',
        },
      ],
    });
    expect(statuses(r)).toEqual([
      'items:unresolved',
      'items:mismatch',
      'items:unresolved',
      'variants:applied',
      'variants:applied',
      'when:unresolved',
      'when:applied',
    ]);
    expect(r[0]!.message).toContain('アダプタの子があります');
    expect(g.nodes[0]!.variants).toEqual([{ id: 'flag', name: 'B', default: true }]);
    // when は既定の links を書き出してから付ける
    expect(
      g.nodes[0]!.links!.find((l) => l.from === 'in/call' && l.to === 'out/rows')!.when,
    ).toEqual({ flag: true });
  });
});

describe('段の順序（D73）', () => {
  const v1api: PartialGraph = {
    nodes: [
      { id: 'lib:api', kind: 'lib', file: 'src/api.ts', meta: { ts: { exports: ['getA'] } } },
      { id: 'endpoint:GET /a', kind: 'endpoint', meta: { api: { method: 'GET', path: '/a' } } },
    ],
    edges: [{ from: 'lib:api', to: 'endpoint:GET /a', kind: 'http' }],
  };
  const adapter: PartialGraph = {
    nodes: [],
    edges: [],
    v2: {
      nodes: [
        {
          id: 'fn:getA',
          kind: 'fn',
          name: 'getA',
          file: 'src/api.ts',
          ports: [
            P('in', 'in', [I('call', 'void')]),
            P('out', 'out', [
              I('call_1', 'R', {
                meta: { http: { method: 'GET', path: '/zzz' } },
                children: [I('path', 'string', { meta: { http: 'path' } })],
              }),
            ]),
          ],
          meta: { ts: { exportName: 'getA' } },
        },
      ],
      wires: [],
    },
  };
  const ep: PartialGraph = {
    nodes: [],
    edges: [],
    v2: { nodes: [endpoint('GET', '/a')], wires: [] },
  };
  const run = (overrides?: string) =>
    build(overrides ? { 'stack-atlas.overrides.yaml': overrides } : {}, [
      stub('v1', v1api),
      stub('lang', adapter, 'language'),
      stub('contract', ep, 'contract'),
    ]);

  it('段 A の線は cleanupV2 の「細かい方が勝つ」に入る（箱の単位の線が消える）', async () => {
    const box = (r: BuildGraphResult) =>
      r.graphV2!.wires.filter(
        (w) => w.from.startsWith('fn:getA#out/_') && w.to.startsWith('endpoint:GET /a#'),
      );
    const without = await run();
    expect(box(without)).toHaveLength(1);
    expect(without.harness!.unjoined.calls).toHaveLength(1);
    const withWire = await run(
      'v2:\n  wires:\n    - { from: { call: { in: fn:getA, http: GET /zzz }, path: path }, to: "endpoint:GET /a#in/path", via: http, reason: r }\n',
    );
    expect(box(withWire)).toEqual([]);
    expect(withWire.harness!.unjoined.calls).toEqual([]);
  });

  it('段 B の links は掃除の crude の links の後（`_` の links を消さない）', async () => {
    const res = await run(
      'v2:\n  links:\n    - { node: fn:getA, from: in/call, to: { call: { http: GET /zzz } }, confidence: exact, reason: r }\n',
    );
    const links = res.graphV2!.nodes.find((n) => n.id === 'fn:getA')!.links!;
    expect(links.some((l) => l.to === 'out/_' && l.confidence === 'crude')).toBe(true);
    expect(links).toContainEqual({
      from: 'in/call',
      to: 'out/call_1',
      confidence: 'exact',
      meta: { by: 'overrides', reason: 'r' },
    });
  });

  it('retarget は group でない箱・中に無い箱・使われないものを解けない補いにする', async () => {
    const res = await run(
      'v2:\n  retarget:\n    - { group: lib:api, peer: endpoint:GET /a, to: [fn:nope], reason: r }\n    - { group: fn:getA, peer: x, to: [fn:getA], reason: r }\n    - { group: lib:api, peer: lib:other, to: [fn:getA], reason: r }\n',
    );
    expect(res.harness!.supplements.map((s) => `${s.status}:${s.message}`)).toEqual([
      expect.stringMatching(/^unresolved:fn:nope は lib:api の中にありません/),
      expect.stringMatching(/^unresolved:fn:getA は group/),
      'unresolved:group と peer の間に付け替える箱の単位の線がありません',
    ]);
  });
});

describe('手書きの部分グラフ（.stack-atlas/graph/*.v2.yaml）', () => {
  const owned = () =>
    new Map<string, PartialNodeV2>([
      [
        'fn:x',
        {
          id: 'fn:x',
          kind: 'fn',
          name: 'x',
          ports: [
            P('in', 'in', [
              I('body', 'map[string]any', { wireType: 'unknown' }),
              I('typed', 'T', { children: [I('a')] }),
            ]),
          ],
        },
      ],
    ]);
  it('アダプタの箱には子の追加だけ（子の無い・unknown の項目）。新しい箱はそのまま足す', () => {
    const root = tmpRepo({
      '.stack-atlas/graph/a.v2.yaml': `
nodes:
  - id: fn:x
    kind: fn
    name: x
    ports:
      - id: in
        dir: in
        items:
          - { id: body, name: body, type: object, children: [{ id: amount, name: amount, type: int64 }] }
          - { id: typed, name: typed, type: T, children: [{ id: b, name: b, type: string }] }
          - { id: extra, name: extra, type: string }
  - { id: "external:stripe", kind: external, name: Stripe, runtime: external, ports: [{ id: in, dir: in, items: [{ id: body, name: body, type: object }] }] }
wires:
  - { from: "fn:x#out/call_1", to: "external:stripe#in/body", via: http }
`,
    });
    const o = owned();
    const r = loadHandGraphs(root, o);
    expect(r.results.map((x) => x.status)).toEqual(['applied']);
    const body = o.get('fn:x')!.ports[0]!.items[0]!;
    expect(body.children).toEqual([
      { id: 'amount', name: 'amount', type: 'int64', confidence: 'crude', meta: { by: 'hand' } },
    ]);
    expect(o.get('fn:x')!.ports[0]!.items[1]!.children).toEqual([I('a')]);
    expect(r.issues.map((i) => i.message)).toEqual([
      'fn:x#in/typed にはアダプタの子があるので足しません',
      'fn:x#in/extra はアダプタの箱に無いので足しません（アダプタが勝つ）',
    ]);
    expect(r.part!.nodes.map((n) => n.id)).toEqual(['external:stripe']);
    expect(r.part!.wires[0]!.meta).toEqual({ by: 'hand' });
  });

  it('形の違うファイル・runtime の無い新しい箱・別名の爆弾・シンボリックリンクは読まない', () => {
    const bomb = [
      'a: &a [x, x, x, x, x, x, x, x, x]',
      ...Array.from(
        { length: 12 },
        (_, k) =>
          `${String.fromCharCode(98 + k)}: &${String.fromCharCode(98 + k)} [*${String.fromCharCode(97 + k)}, *${String.fromCharCode(97 + k)}, *${String.fromCharCode(97 + k)}]`,
      ),
      'nodes: []',
    ].join('\n');
    const root = tmpRepo({
      '.stack-atlas/graph/1-shape.v2.yaml': 'nodes: 3\n',
      '.stack-atlas/graph/2-runtime.v2.yaml':
        'nodes: [{ id: "external:a", kind: external, name: a, ports: [] }]\n',
      '.stack-atlas/graph/3-bomb.v2.yaml': bomb,
      '.stack-atlas/graph/4-kind.v2.yaml':
        'nodes: [{ id: "external:b", kind: nope, name: b, runtime: external, ports: [] }]\n',
      'elsewhere.yaml': 'nodes: []\n',
      'ignored.yaml': '',
    });
    symlinkSync(join(root, 'elsewhere.yaml'), join(root, '.stack-atlas/graph/5-link.v2.yaml'));
    const r = loadHandGraphs(root, new Map());
    expect(r.results.map((x) => `${x.target}:${x.status}`)).toEqual([
      '.stack-atlas/graph/1-shape.v2.yaml:unresolved',
      '.stack-atlas/graph/2-runtime.v2.yaml:unresolved',
      '.stack-atlas/graph/3-bomb.v2.yaml:unresolved',
      '.stack-atlas/graph/4-kind.v2.yaml:unresolved',
      '.stack-atlas/graph/5-link.v2.yaml:unresolved',
    ]);
    expect(r.results[2]!.message).toMatch(/別名|alias/i);
    expect(r.results[4]!.message).toContain('シンボリックリンク');
    expect(r.part).toBeUndefined();
    // ディレクトリそのもののリンクも読まない
    const other = tmpRepo({ 'g/a.v2.yaml': 'nodes: []\n', '.stack-atlas/x': '' });
    symlinkSync(join(other, 'g'), join(other, '.stack-atlas/graph'));
    const l = loadHandGraphs(other, new Map());
    expect(l.files).toEqual([]);
    expect(l.issues[0]!.message).toContain('シンボリックリンク');
  });
});

describe('views.yaml（docs/19 §3.4）', () => {
  const g = (): GraphV2 => ({
    ...world(),
    nodes: [
      ...world().nodes,
      {
        id: 'cache:c',
        kind: 'cache',
        name: 'c',
        runtime: 'edge',
        ports: [],
        variants: [{ id: 'hit', name: 'hit' }],
      },
    ],
    views: [{ id: 'main', name: 'flows', start: 'fn:b' }],
  });
  it('同じ id は flows 由来に勝つ。start・分岐が解けないものは落として報告。group の v1 の箱は中の最初の箱', () => {
    const root = tmpRepo({
      '.stack-atlas/views.yaml': `
views:
  - { id: main, name: 上書き, start: "fn:a#out/rows" }
  - { id: wire, name: 線から, start: { from: "fn:a#out/call_1", to: "fn:b#in/call" }, variants: { "cache:c#hit": true } }
  - { id: lost, name: 迷子, start: "fn:nope" }
  - { id: badv, name: 分岐, start: fn:a, variants: { "cache:c#miss": true } }
  - { id: grp, name: group, start: lib:g }
  - { name: id なし, start: fn:a }
`,
    });
    const graph = g();
    const r = applyViewsYaml(graph, root, new Map([['lib:g', ['fn:b', 'fn:a']]]));
    expect(r.results.map((x) => `${x.target ?? '-'}:${x.status}`)).toEqual([
      'main:applied',
      'wire:applied',
      'lost:unresolved',
      'badv:unresolved',
      'grp:applied',
      '-:unresolved',
    ]);
    expect(graph.views!.map((v) => [v.id, v.name, v.start])).toEqual([
      ['main', '上書き', 'fn:a#out/rows'],
      ['wire', '線から', { from: 'fn:a#out/call_1', to: 'fn:b#in/call' }],
      ['grp', 'group', 'fn:b'],
    ]);
    expect(validateGraphV2(graph).errors).toEqual([]);
  });
  it('無ければ何もしない。壊れた YAML・リンクは報告する', () => {
    expect(applyViewsYaml(g(), tmpRepo({})).results).toEqual([]);
    const bad = applyViewsYaml(g(), tmpRepo({ '.stack-atlas/views.yaml': 'views: [\n' }));
    expect(bad.results[0]!.status).toBe('unresolved');
    const root = tmpRepo({ 'v.yaml': 'views: []\n', '.stack-atlas/x': '' });
    symlinkSync(join(root, 'v.yaml'), join(root, '.stack-atlas/views.yaml'));
    expect(applyViewsYaml(g(), root).results[0]!.message).toContain('シンボリックリンク');
  });
});

describe('SafeOutput（screens から core へ。init --skill の安全）', () => {
  it('create は既存を上書きしない。unsafe は途中・最後のリンクとディレクトリでないものを返す', () => {
    const root = tmpRepo({ 'a/b.txt': 'old' });
    const out = new SafeOutput(root);
    expect(out.create(['a', 'b.txt'], 'new').created).toBe(false);
    expect(out.create(['a', 'c.txt'], 'new').created).toBe(true);
    expect(out.unsafe(['a', 'b.txt'])).toBeUndefined();
    expect(out.unsafe(['x', 'y.txt'])).toBeUndefined();
    mkdirSync(join(root, 'real'));
    symlinkSync(join(root, 'real'), join(root, 'link'));
    expect(out.unsafe(['link', 'f.txt'])).toBe(join(root, 'link'));
    writeFileSync(join(root, 'file'), '');
    expect(out.unsafe(['file', 'f.txt'])).toBe(join(root, 'file'));
    symlinkSync(join(root, 'a/b.txt'), join(root, 'a/l.txt'));
    expect(out.unsafe(['a', 'l.txt'])).toBe(join(root, 'a/l.txt'));
    expect(() => out.create(['link', 'f.txt'], 'x')).toThrow(/シンボリックリンク/);
  });
});
