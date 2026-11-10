// v1 → v2 の変換（docs/16 §10）。対応表・infra の型・線の規則・host の枠・runtime・views・型を固定する
import {
  isUpgradedGraph,
  validateGraphV2,
  type Edge,
  type Graph,
  type GraphNode,
  type GraphV2,
  type NodeV2,
} from '@stack-atlas/schema';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  CACHE_LINKS,
  infraProfileOf,
  RUNTIME_OF_V1,
  UNKNOWN_KIND_BY_LAYER,
  upgradeGraph,
  V2_KIND_OF_V1,
} from '../upgrade.js';
import { diffGraphsV2, isEmptyDiffV2 } from '../diff.js';

const RACE = fileURLToPath(new URL('../../../../examples/race-site.graph.json', import.meta.url));

const LAYER_OF: Record<string, string> = {
  actor: 'infra',
  infra: 'infra',
  page: 'routes',
  layout: 'routes',
  component: 'components',
  hook: 'components',
  lib: 'components',
};
const N = (id: string, kind: string, extra: Partial<GraphNode> = {}): GraphNode => ({
  id,
  kind,
  name: id.slice(id.indexOf(':') + 1),
  layer: LAYER_OF[kind] ?? 'types',
  ...extra,
});
const E = (from: string, to: string, kind: string, label?: string): Edge => ({
  from,
  to,
  kind,
  ...(label ? { label } : {}),
});
const G = (nodes: GraphNode[], edges: Edge[], extra: Partial<Graph> = {}): Graph => ({
  version: 1,
  layers: [],
  nodes,
  edges,
  ...extra,
});
const infra = (id: string, type: string, extra: Partial<GraphNode> = {}) =>
  N(id, 'infra', { meta: { infra: { type } }, ...extra });

/** 変換して v2 の検証エラーが 0 であることも確かめる */
function up(g: Graph): GraphV2 {
  const v2 = upgradeGraph(g);
  const r = validateGraphV2(v2);
  expect(r.errors, JSON.stringify(r.errors, null, 2)).toEqual([]);
  return v2;
}
const node = (g: GraphV2, id: string): NodeV2 => {
  const n = g.nodes.find((x) => x.id === id);
  if (!n) throw new Error(`箱 ${id} がありません`);
  return n;
};
/** 線を `via from -> to`（reply は末尾に R）の文字列にする */
const wires = (g: GraphV2) =>
  g.wires.map((w) => `${w.via} ${w.from} -> ${w.to}${w.reply ? ' R' : ''}`);

describe('対応表（docs/16 §4・§10）', () => {
  it('v1 の kind → v2 の kind', () => {
    expect(V2_KIND_OF_V1).toEqual({
      actor: 'actor',
      infra: 'infra',
      page: 'screen',
      layout: 'screen',
      component: 'component',
      hook: 'hook',
      lib: 'helper',
      handler: 'fn',
      endpoint: 'endpoint',
      queue: 'queue',
      cron: 'trigger',
      service: 'infra',
      db: 'table',
      schema: 'table',
      external: 'external',
    });
  });

  it('v1 の kind → runtime の既定', () => {
    expect(RUNTIME_OF_V1).toEqual({
      actor: 'user',
      cron: 'time',
      page: 'browser',
      layout: 'browser',
      component: 'browser',
      hook: 'browser',
      lib: 'browser',
      handler: 'server',
      endpoint: 'server',
      queue: 'server',
      service: 'server',
      infra: 'server',
      db: 'data',
      schema: 'data',
      external: 'external',
    });
  });

  it('語彙に無い kind（config.kinds で足したもの）は v1 の層で決め、元の kind を meta.kindV1 に残す', () => {
    expect(UNKNOWN_KIND_BY_LAYER.infra).toEqual({ kind: 'infra', runtime: 'server' });
    const g = up(
      G(
        [
          N('job:nightly', 'job', { layer: 'infra' }),
          N('proto:a', 'proto', { layer: 'components' }),
          N('x:y', 'x', { layer: 'mine' }),
        ],
        [],
      ),
    );
    expect(node(g, 'job:nightly')).toMatchObject({
      kind: 'infra',
      runtime: 'server',
      meta: { kindV1: 'job' },
    });
    expect(node(g, 'proto:a')).toMatchObject({ kind: 'helper', runtime: 'browser' });
    expect(node(g, 'x:y')).toMatchObject({ kind: 'helper', runtime: 'server' });
  });
});

describe('infra の型（infraProfileOf）', () => {
  const p = (type: string, edgeAssoc = false) => infraProfileOf(infra('infra:x', type), edgeAssoc);
  const byName = (name: string) => infraProfileOf(N('infra:x', 'infra', { name }));

  it.each([
    ['aws_cloudfront_distribution', 'cache', 'edge', undefined],
    ['aws_cloudfront_function', 'infra', 'edge', undefined],
    ['aws_lambda_function', 'infra', 'server', 'fn'],
    ['google_cloudfunctions2_function', 'infra', 'server', 'fn'],
    ['aws_ecs_service', 'infra', 'server', 'fn'],
    ['google_cloud_run_v2_service', 'infra', 'server', 'fn'],
    ['aws_dynamodb_table', 'infra', 'data', 'table'],
    ['aws_rds_cluster', 'infra', 'data', 'table'],
    ['aws_db_instance', 'infra', 'data', 'table'],
    ['aws_s3_bucket', 'infra', 'data', undefined],
    ['aws_sqs_queue', 'queue', 'server', undefined],
    ['aws_scheduler_schedule', 'trigger', 'time', undefined],
    ['aws_cloudwatch_event_rule', 'trigger', 'time', undefined],
    ['aws_apigatewayv2_api', 'infra', 'server', undefined],
    ['aws_cognito_user_pool', 'infra', 'server', undefined],
  ])('%s → kind %s / runtime %s / host %s', (type, kind, runtime, host) => {
    const r = p(type);
    expect([r.kind, r.runtime, r.host]).toEqual([kind, runtime, host]);
  });

  it('cache の関連付け（function_association）を受ける Lambda は Lambda@Edge（edge、脇で動く）', () => {
    expect(p('aws_lambda_function', true)).toMatchObject({
      runtime: 'edge',
      host: 'fn',
      edgeFn: true,
    });
  });

  it('名前の規則は具体的なものが先: CloudFront Function・Lambda@Edge は CloudFront（cache）にしない', () => {
    // 以前は CloudFront のディストリビューションの規則（/cloudfront/）が先にあり、どちらも cache になっていた
    for (const name of ['CloudFront Function (rewrite)', 'cloudfront_function_rewrite']) {
      expect(byName(name), name).toMatchObject({
        name: 'CloudFront Function',
        kind: 'infra',
        runtime: 'edge',
        edgeFn: true,
      });
    }
    for (const name of ['cloudfront_lambda_edge', 'CloudFront Lambda@Edge (auth)', 'lambda-edge']) {
      expect(byName(name), name).toMatchObject({
        name: 'Lambda@Edge',
        kind: 'infra',
        runtime: 'edge',
        host: 'fn',
        edgeFn: true,
      });
    }
    // ディストリビューションはそのまま cache
    expect(byName('cloudfront_distribution').kind).toBe('cache');
    expect(byName('CDN')).toMatchObject({ kind: 'cache' });
  });

  it('型の無い手書きの infra は id と名前で決める', () => {
    expect(byName('CloudFront').kind).toBe('cache');
    expect(byName('Lambda@Edge (auth)')).toMatchObject({ runtime: 'edge', edgeFn: true });
    expect(byName('Lambda: API')).toMatchObject({ runtime: 'server', host: 'fn' });
    expect(byName('DynamoDB races')).toMatchObject({ runtime: 'data', host: 'table' });
    expect(byName('S3 (static)')).toMatchObject({ storage: true });
    expect(byName('API Gateway')).toMatchObject({ kind: 'infra', runtime: 'server' });
  });
});

describe('箱と口', () => {
  const g = up(
    G(
      [
        N('actor:user', 'actor'),
        N('route:/', 'page'),
        N('comp:A', 'component'),
        infra('infra:cdn', 'aws_cloudfront_distribution'),
        infra('infra:sched', 'aws_scheduler_schedule'),
        N('endpoint:GET /a', 'endpoint'),
        N('schema:t', 'schema', { meta: { sql: { table: 'items' } }, file: 'm.sql', line: 3 }),
      ],
      [],
    ),
  );

  it('ふつうの箱は in / out に項目 _（name 値、type unknown、wireType unknown）を 1 つずつ', () => {
    expect(node(g, 'route:/').ports).toEqual([
      {
        id: 'in',
        dir: 'in',
        items: [{ id: '_', name: '値', type: 'unknown', wireType: 'unknown' }],
      },
      {
        id: 'out',
        dir: 'out',
        items: [{ id: '_', name: '値', type: 'unknown', wireType: 'unknown' }],
      },
    ]);
    expect(node(g, 'comp:A').ports.map((p) => p.id)).toEqual(['in', 'out']);
  });

  it('利用者・時刻は出口だけ（流れの始まり）', () => {
    expect(node(g, 'actor:user').ports.map((p) => `${p.id}:${p.dir}`)).toEqual(['out:out']);
    expect(node(g, 'infra:sched')).toMatchObject({ kind: 'trigger', runtime: 'time' });
    expect(node(g, 'infra:sched').ports.map((p) => p.id)).toEqual(['out']);
  });

  it('cache は key / value の口、分岐 hit、HIT は折り返し・MISS は通り抜けの links', () => {
    const c = node(g, 'infra:cdn');
    expect(c).toMatchObject({ kind: 'cache', runtime: 'edge' });
    expect(c.variants).toEqual([{ id: 'hit', name: 'cache hit', default: false }]);
    expect(c.links).toEqual(CACHE_LINKS);
    expect(c.ports.map((p) => `${p.id}:${p.items.map((i) => i.id).join(',')}`)).toEqual([
      'in:key,value',
      'out:key,value',
    ]);
  });

  it('endpoint は in / req / res / out（docs/16 §5 の 4 つの口。links は既定の恒等）', () => {
    const e = node(g, 'endpoint:GET /a');
    expect(e.ports.map((p) => `${p.id}:${p.dir}`)).toEqual([
      'in:in',
      'req:out',
      'res:in',
      'out:out',
    ]);
    expect(e.links).toBeUndefined();
  });

  it('テーブルは key / read（既定の links は key → read）。項目の typeRef は table:<名前>、types にも出る', () => {
    const t = node(g, 'schema:t');
    expect(t).toMatchObject({ kind: 'table', runtime: 'data' });
    expect(t.ports.map((p) => `${p.id}:${p.dir}:${p.items[0]!.typeRef}`)).toEqual([
      'key:in:table:items',
      'read:out:table:items',
    ]);
    expect(g.types).toContainEqual({
      id: 'table:items',
      name: 'items',
      file: 'm.sql',
      line: 3,
      source: 'sql',
    });
  });

  it('v1 の layer・position・kinds・layers は捨て、file・line・code・cache・meta は残す', () => {
    const v1 = G(
      [
        N('lib:x', 'lib', {
          file: 'src/x.ts',
          line: 2,
          code: 'export const x = 1',
          position: { x: 1, z: 2 },
          cache: { tone: 'ok', badge: 'SWR' },
          meta: { ts: { exportName: 'x', symbolKind: 'const' } },
        }),
      ],
      [],
      { kinds: { lib: { name: 'ライブラリ' } }, project: { name: 'p' } },
    );
    const v2 = up(v1);
    // 8-1 のレビューで変更: 変換した graph には印 project.generator.v2 = "upgrade" を付ける（ビューアが箱の単位の警告を畳む）
    expect(v2.project).toEqual({ name: 'p', generator: { v2: 'upgrade' } });
    expect(Object.keys(v2)).toEqual(['version', 'project', 'nodes', 'wires']);
    const x = node(v2, 'lib:x');
    expect(x).toMatchObject({
      file: 'src/x.ts',
      line: 2,
      code: 'export const x = 1',
      cache: { tone: 'ok', badge: 'SWR' },
      meta: { ts: { exportName: 'x', symbolKind: 'const' } },
    });
    expect('position' in x).toBe(false);
    expect('layer' in x).toBe(false);
  });

  it('# を含む id は v2 に入れず知らせる（参照は最初の # で箱を切る）', () => {
    const issues: string[] = [];
    const v2 = upgradeGraph(
      G([N('lib:a#b', 'lib'), N('lib:c', 'lib')], [E('lib:c', 'lib:a#b', 'uses')]),
      {
        onIssue: (i) => issues.push(i.message),
      },
    );
    expect(v2.nodes.map((n) => n.id)).toEqual(['lib:c']);
    expect(v2.wires).toEqual([]);
    expect(issues[0]).toContain('lib:a#b');
  });
});

describe('画面（screen。8-3b で html / source を足した。docs/18 §3.3）', () => {
  const regions = [{ ref: 'comp:A', x: 1, y: 2, w: 3, h: 4 }];
  const screenOf = (screen: GraphNode['screen']) =>
    node(up(G([N('route:/', 'page', { screen }), N('comp:A', 'component')], [])), 'route:/').screen;

  it('html と source はそのまま写す（スクショがあっても source は html の出どころのまま）', () => {
    const html = {
      html: 'screens/index/index.html',
      width: 1280,
      height: 800,
      source: 'dir' as const,
    };
    expect(screenOf(html)).toEqual(html);
    expect(screenOf({ ...html, screenshot: 'shots/index.png', regions })).toEqual({
      ...html,
      screenshot: 'shots/index.png',
      regions,
    });
  });

  it('スクショだけの画面は従来どおり source: screenshot', () => {
    expect(screenOf({ screenshot: 'shots/index.png', width: 1280, height: 800, regions })).toEqual({
      screenshot: 'shots/index.png',
      source: 'screenshot',
      width: 1280,
      height: 800,
      regions,
    });
    expect(screenOf({ width: 640, height: 480 })).toEqual({ width: 640, height: 480 });
  });

  it('写したものは元の graph と共有しない', () => {
    const v1 = G(
      [
        N('route:/', 'page', { screen: { width: 1, height: 1, regions } }),
        N('comp:A', 'component'),
      ],
      [],
    );
    const v2 = upgradeGraph(v1);
    node(v2, 'route:/').screen!.regions![0]!.x = 99;
    expect(v1.nodes[0]!.screen!.regions![0]!.x).toBe(1);
  });
});

describe('線（edge → wire）', () => {
  it('uses: 関数・hook・helper へは call と return（reply）、部品・画面へは render だけ', () => {
    const g = up(
      G(
        [N('route:/', 'page'), N('comp:A', 'component'), N('hook:useA', 'hook'), N('lib:x', 'lib')],
        [
          E('route:/', 'comp:A', 'uses'),
          E('comp:A', 'hook:useA', 'uses'),
          E('hook:useA', 'lib:x', 'uses'),
        ],
      ),
    );
    expect(wires(g)).toEqual([
      'render route:/#out/_ -> comp:A#in/_',
      'call comp:A#out/_ -> hook:useA#in/_',
      'return hook:useA#out/_ -> comp:A#in/_ R',
      'call hook:useA#out/_ -> lib:x#in/_',
      'return lib:x#out/_ -> hook:useA#in/_ R',
    ]);
  });

  it('uses: 型へは線にせず types[].meta.usedBy に入れる（型どうしも）', () => {
    const g = up(
      G(
        [
          N('comp:A', 'component'),
          N('type:T', 'type', { file: 't.ts', line: 1 }),
          N('type:U', 'type'),
        ],
        [E('comp:A', 'type:T', 'uses'), E('type:U', 'type:T', 'uses')],
      ),
    );
    expect(g.wires).toEqual([]);
    expect(g.nodes.map((n) => n.id)).toEqual(['comp:A']);
    expect(g.types).toEqual([
      { id: 'type:T', name: 'T', file: 't.ts', line: 1, meta: { usedBy: ['comp:A', 'type:U'] } },
      { id: 'type:U', name: 'U' },
    ]);
  });

  it('uses: テーブルへは sql の往復（key へ、read から戻る）', () => {
    const g = up(
      G([N('handler:h', 'handler'), N('schema:t', 'schema')], [E('handler:h', 'schema:t', 'uses')]),
    );
    expect(wires(g)).toEqual([
      'sql handler:h#out/_ -> schema:t#key/_',
      'sql schema:t#read/_ -> handler:h#in/_ R',
    ]);
  });

  it('http: 呼び出しと戻り（ラベルは行きに残す）。endpoint → 実装は req / res の call と return', () => {
    const g = up(
      G(
        [N('lib:client', 'lib'), N('endpoint:GET /a', 'endpoint'), N('handler:h', 'handler')],
        [
          E('lib:client', 'endpoint:GET /a', 'http', 'GET /a'),
          E('endpoint:GET /a', 'handler:h', 'http'),
        ],
      ),
    );
    expect(g.wires).toContainEqual({
      from: 'lib:client#out/_',
      to: 'endpoint:GET /a#in/_',
      via: 'http',
      label: 'GET /a',
    });
    expect(wires(g)).toEqual([
      'http lib:client#out/_ -> endpoint:GET /a#in/_',
      'http endpoint:GET /a#out/_ -> lib:client#in/_ R',
      'call endpoint:GET /a#req/_ -> handler:h#in/_',
      'return handler:h#out/_ -> endpoint:GET /a#res/_ R',
    ]);
  });

  it('http: コードから cache へは無効化の呼び出し。links の無い in/purge で止まり、オリジンへ広がらない', () => {
    const g = up(
      G(
        [N('route:/admin', 'page'), infra('infra:cdn', 'aws_cloudfront_distribution')],
        [E('route:/admin', 'infra:cdn', 'http')],
      ),
    );
    expect(wires(g)).toEqual(['http route:/admin#out/_ -> infra:cdn#in/purge']);
    expect(node(g, 'infra:cdn').ports[0]!.items.map((i) => i.id)).toEqual([
      'key',
      'value',
      'purge',
    ]);
    expect(node(g, 'infra:cdn').links!.some((l) => l.from === 'in/purge')).toBe(false);
  });

  it('flow: インフラどうしは http（ラベルは属性名）、時刻・キューからは event', () => {
    const g = up(
      G(
        [
          infra('infra:sched', 'aws_scheduler_schedule'),
          infra('infra:gw', 'aws_apigatewayv2_api'),
          infra('infra:q', 'aws_sqs_queue'),
          infra('infra:pool', 'aws_cognito_user_pool'),
        ],
        [
          E('infra:sched', 'infra:gw', 'flow', 'target.arn'),
          E('infra:gw', 'infra:pool', 'flow'),
          E('infra:q', 'infra:pool', 'flow'),
        ],
      ),
    );
    expect(g.wires).toEqual([
      { from: 'infra:sched#out/_', to: 'infra:gw#in/_', via: 'event', label: 'target.arn' },
      { from: 'infra:gw#out/_', to: 'infra:pool#in/_', via: 'http' },
      { from: 'infra:q#out/_', to: 'infra:pool#in/_', via: 'event' },
    ]);
  });

  it('同じ (from, to) の線は 1 本。先に引いたコードの線（sql）が残り、別の種類の線のラベルは付けない', () => {
    const g = up(
      G(
        [
          infra('infra:fn', 'aws_lambda_function'),
          infra('infra:ddb', 'aws_dynamodb_table'),
          N('handler:h', 'handler'),
          N('schema:t', 'schema', { meta: { ts: { exportName: 'T', symbolKind: 'type' } } }),
        ],
        [
          E('infra:fn', 'infra:ddb', 'flow', 'environment.TABLE'),
          E('infra:fn', 'handler:h', 'deploy'),
          E('infra:ddb', 'schema:t', 'schema'),
          E('handler:h', 'schema:t', 'uses'),
        ],
      ),
    );
    expect(g.wires).toEqual([
      { from: 'handler:h#out/_', to: 'schema:t#key/_', via: 'sql' },
      { from: 'schema:t#read/_', to: 'handler:h#in/_', via: 'sql', reply: true },
    ]);
  });
});

describe('host の枠（D42 改訂）', () => {
  const v1 = G(
    [
      N('actor:user', 'actor'),
      infra('infra:cdn', 'aws_cloudfront_distribution'),
      infra('infra:site', 'aws_s3_bucket'),
      infra('infra:api', 'aws_lambda_function'),
      infra('infra:idle', 'aws_lambda_function'),
      infra('infra:pool', 'aws_cognito_user_pool'),
      infra('infra:db', 'aws_rds_cluster'),
      N('route:/', 'page', { meta: { next: { segment: '', output: 'export' } } }),
      N('handler:cmd/api', 'handler', { meta: { go: { pkg: 'cmd/api' } } }),
      N('handler:internal/api', 'handler', { meta: { go: { pkg: 'internal/api' } } }),
      N('lib:internal/auth', 'lib', { meta: { go: { pkg: 'internal/auth' } } }),
      N('endpoint:GET /a', 'endpoint'),
      N('schema:items', 'schema', { meta: { sql: { table: 'items' } } }),
    ],
    [
      E('actor:user', 'infra:cdn', 'flow'),
      E('infra:cdn', 'infra:site', 'flow', 'origin.domain_name'),
      E('infra:site', 'route:/', 'deploy'),
      E('infra:api', 'handler:cmd/api', 'deploy'),
      E('infra:api', 'endpoint:GET /a', 'deploy'),
      E('infra:api', 'infra:pool', 'flow', 'environment.POOL'),
      E('actor:user', 'infra:api', 'http'),
      E('handler:cmd/api', 'handler:internal/api', 'uses'),
      E('handler:internal/api', 'lib:internal/auth', 'uses'),
      E('endpoint:GET /a', 'handler:internal/api', 'http'),
      E('infra:db', 'schema:items', 'schema'),
    ],
  );
  const g = up(v1);

  it('箱を載せている Lambda と DB だけが枠（ports: []）。何も載せていない Lambda は普通の箱', () => {
    expect(node(g, 'infra:api')).toMatchObject({ kind: 'infra', runtime: 'server', ports: [] });
    expect(node(g, 'infra:db')).toMatchObject({ kind: 'infra', runtime: 'data', ports: [] });
    expect(node(g, 'infra:idle').ports.map((p) => p.id)).toEqual(['in', 'out']);
    expect(node(g, 'schema:items').host).toBe('infra:db');
    expect(node(g, 'handler:cmd/api').host).toBe('infra:api');
  });

  it('枠の中の関数から uses でたどれる関数・helper は同じ枠に入る（Go の import）', () => {
    expect(node(g, 'handler:internal/api').host).toBe('infra:api');
    expect(node(g, 'lib:internal/auth')).toMatchObject({ host: 'infra:api', runtime: 'server' });
  });

  it('endpoint（契約）は枠に入れない。枠への http は受け持つ endpoint へ引き直す', () => {
    expect(node(g, 'endpoint:GET /a').host).toBeUndefined();
    expect(wires(g)).toContain('http actor:user#out/_ -> endpoint:GET /a#in/_');
  });

  it('枠から出る flow は直に載っている関数から引く', () => {
    expect(g.wires).toContainEqual({
      from: 'handler:cmd/api#out/_',
      to: 'infra:pool#in/_',
      via: 'http',
      label: 'environment.POOL',
    });
  });

  it('S3 の静的サイトは枠ではなく配信元の箱（edge）。前に cache があれば cache の out/value から画面へ deliver', () => {
    expect(node(g, 'infra:site')).toMatchObject({ kind: 'infra', runtime: 'edge' });
    expect(node(g, 'infra:site').ports.map((p) => p.id)).toEqual(['in', 'out']);
    expect(node(g, 'route:/')).toMatchObject({ kind: 'screen', runtime: 'browser' });
    expect(node(g, 'route:/').host).toBeUndefined();
    expect(wires(g)).toEqual(
      expect.arrayContaining([
        'http actor:user#out/_ -> infra:cdn#in/key',
        'http infra:cdn#out/key -> infra:site#in/_',
        'deliver infra:site#out/_ -> infra:cdn#in/value R',
        'deliver infra:cdn#out/value -> route:/#in/_ R',
      ]),
    );
  });

  it('cache の無い S3 は画面へ直接 deliver（data ではなく edge）', () => {
    const h = up(
      G(
        [infra('infra:site', 'aws_s3_bucket'), N('route:/', 'page')],
        [E('infra:site', 'route:/', 'deploy')],
      ),
    );
    expect(wires(h)).toEqual(['deliver infra:site#out/_ -> route:/#in/_']);
    expect(node(h, 'infra:site').runtime).toBe('edge');
    // 何も配らない S3 はデータ
    expect(node(up(G([infra('infra:b', 'aws_s3_bucket')], [])), 'infra:b').runtime).toBe('data');
  });

  it('画面だけを載せた枠（Next の Lambda）: cache からの要求は画面へ、戻りは in/value へ。枠から出る flow は線にせず meta.flows に残す', () => {
    const h = up(
      G(
        [
          infra('infra:cdn', 'aws_cloudfront_distribution'),
          infra('infra:next', 'aws_lambda_function'),
          infra('infra:gw', 'aws_apigatewayv2_api'),
          infra('infra:edge', 'aws_lambda_function'),
          N('route:/', 'page'),
          N('route:/b', 'page'),
        ],
        [
          E('infra:cdn', 'infra:next', 'flow', 'origin.domain_name'),
          E(
            'infra:cdn',
            'infra:edge',
            'flow',
            'ordered_cache_behavior.lambda_function_association.lambda_arn',
          ),
          E('infra:next', 'route:/', 'deploy'),
          E('infra:next', 'route:/b', 'deploy'),
          E('infra:next', 'infra:gw', 'flow', 'environment.API_BASE_URL'),
        ],
      ),
    );
    expect(node(h, 'route:/')).toMatchObject({ host: 'infra:next', runtime: 'server' });
    expect(wires(h)).toEqual([
      'http infra:cdn#out/key -> route:/#in/_',
      'http route:/#out/_ -> infra:cdn#in/value R',
      'http infra:cdn#out/key -> route:/b#in/_',
      'http route:/b#out/_ -> infra:cdn#in/value R',
      // Lambda@Edge は脇で動くので戻りを引かない
      'http infra:cdn#out/key -> infra:edge#in/_',
    ]);
    expect(node(h, 'infra:edge')).toMatchObject({ runtime: 'edge' });
    expect(node(h, 'infra:next').meta).toEqual({
      infra: { type: 'aws_lambda_function' },
      flows: [{ to: 'infra:gw', label: 'environment.API_BASE_URL' }],
    });
  });

  it('コードを載せた Lambda@Edge（枠）: cache からの要求は中の箱へ引き直すが、戻りは cache へ引かない', () => {
    // 以前は引き直し先の箱（profile が無い）で判定していたので、Lambda@Edge の中の箱から cache の in/value へ戻りを引いていた
    const h = up(
      G(
        [
          infra('infra:cdn', 'aws_cloudfront_distribution'),
          infra('infra:edge', 'aws_lambda_function'),
          N('handler:auth', 'handler'),
        ],
        [
          E(
            'infra:cdn',
            'infra:edge',
            'flow',
            'default_cache_behavior.lambda_function_association.lambda_arn',
          ),
          E('infra:edge', 'handler:auth', 'deploy'),
        ],
      ),
    );
    expect(node(h, 'infra:edge')).toMatchObject({ runtime: 'edge', ports: [] });
    expect(node(h, 'handler:auth')).toMatchObject({ host: 'infra:edge', runtime: 'edge' });
    expect(wires(h)).toEqual(['http infra:cdn#out/key -> handler:auth#in/_']);
  });

  it('枠の deploy を線にしない理由: テーブルは deploy で枠に入れない、ほかは別の枠に載っている', () => {
    // 以前はどちらも「別の枠（なし）に載っている」と出ていた（テーブルは host が無いので「なし」）
    const issues: string[] = [];
    upgradeGraph(
      G(
        [
          infra('infra:a', 'aws_lambda_function'),
          infra('infra:b', 'aws_lambda_function'),
          N('handler:a', 'handler'),
          N('handler:b', 'handler'),
          N('schema:t', 'schema', { meta: { sql: { table: 't' } } }),
        ],
        [
          E('infra:a', 'handler:a', 'deploy'),
          E('infra:b', 'handler:b', 'deploy'),
          E('infra:a', 'handler:b', 'deploy'),
          E('infra:a', 'schema:t', 'deploy'),
        ],
      ),
      { onIssue: (i) => issues.push(i.message) },
    );
    expect(issues).toEqual([
      '"handler:b" は別の枠（infra:b）に載っています。deploy "infra:a" → "handler:b" は線にしません',
      '"schema:t" はテーブルで、deploy では枠に入れません（テーブルは DB からの schema のエッジで枠に入る）。deploy "infra:a" → "schema:t" は線にしません',
    ]);
  });

  it('2 つの枠からたどれる helper は枠に入れない（使う側ごとの複製は 8-2）', () => {
    const h = up(
      G(
        [
          infra('infra:a', 'aws_lambda_function'),
          infra('infra:b', 'aws_lambda_function'),
          N('handler:a', 'handler'),
          N('handler:b', 'handler'),
          N('lib:shared', 'lib', { meta: { go: { pkg: 'internal/shared' } } }),
        ],
        [
          E('infra:a', 'handler:a', 'deploy'),
          E('infra:b', 'handler:b', 'deploy'),
          E('handler:a', 'lib:shared', 'uses'),
          E('handler:b', 'lib:shared', 'uses'),
        ],
      ),
    );
    expect(node(h, 'lib:shared').host).toBeUndefined();
    expect(node(h, 'lib:shared').runtime).toBe('server');
  });
});

describe('runtime（docs/16 §4 の優先順）', () => {
  it('meta.runtime（明示）> host > Go > kind の既定。誰からも呼ばれずサーバー側だけを呼ぶ helper は server', () => {
    const g = up(
      G(
        [
          N('comp:S', 'component', { meta: { runtime: 'build' } }),
          N('lib:go', 'lib', { meta: { go: { pkg: 'internal/x' } } }),
          N('lib:entry', 'lib'),
          N('lib:web', 'lib'),
          N('handler:h', 'handler'),
          N('comp:A', 'component'),
        ],
        [
          E('lib:entry', 'handler:h', 'uses'),
          E('comp:A', 'lib:web', 'uses'),
          E('lib:web', 'handler:h', 'uses'),
        ],
      ),
    );
    expect(node(g, 'comp:S').runtime).toBe('build');
    expect(node(g, 'lib:go').runtime).toBe('server');
    expect(node(g, 'lib:entry').runtime).toBe('server');
    // 呼ばれている helper は既定の browser のまま
    expect(node(g, 'lib:web').runtime).toBe('browser');
    expect(node(g, 'handler:h')).toMatchObject({ kind: 'fn', runtime: 'server' });
  });

  it('handler は fn。meta.api があれば meta.route に「メソッド パス」', () => {
    const g = up(
      G([N('handler:h', 'handler', { meta: { api: { method: 'GET', path: '/a' } } })], []),
    );
    expect(node(g, 'handler:h').meta).toMatchObject({ route: 'GET /a' });
  });

  it('コードのパッケージを schema に分類したもの（Go の store）はテーブルではなく helper', () => {
    const g = up(
      G([N('schema:internal/store', 'schema', { meta: { go: { pkg: 'internal/store' } } })], []),
    );
    expect(node(g, 'schema:internal/store')).toMatchObject({ kind: 'helper', runtime: 'server' });
  });
});

describe('変換した graph の印（project.generator.v2）', () => {
  it('project が無い v1 にも付け、v1 の generator のほかの値は残す。isUpgradedGraph で見分けられる', () => {
    const bare = up(G([N('lib:x', 'lib')], []));
    expect(bare.project).toEqual({ generator: { v2: 'upgrade' } });
    expect(isUpgradedGraph(bare)).toBe(true);
    const kept = up(G([], [], { project: { name: 'p', generator: { tool: 'x' } } }));
    expect(kept.project).toEqual({ name: 'p', generator: { tool: 'x', v2: 'upgrade' } });
    // 手書きの v2（印なし）は変換したものではない
    expect(isUpgradedGraph({ project: { name: 'p' } })).toBe(false);
    expect(isUpgradedGraph(undefined)).toBe(false);
  });
});

describe('型と views', () => {
  it('OpenAPI にもある型は契約側を正にする（file は OpenAPI、元の場所は meta.copies。D37）', () => {
    const g = up(
      G(
        [
          N('type:Entry', 'type', {
            file: 'web/src/types.ts',
            line: 1,
            meta: {
              ts: { exportName: 'Entry', symbolKind: 'type' },
              openapi: { file: 'openapi/a.yaml' },
            },
          }),
          N('endpoint:GET /a', 'endpoint', { file: 'platform/openapi/a.yaml' }),
        ],
        [],
      ),
    );
    expect(g.types![0]).toMatchObject({
      id: 'type:Entry',
      file: 'platform/openapi/a.yaml',
      source: 'openapi',
      meta: { copies: ['web/src/types.ts:1'] },
    });
  });

  it('flows → views: 最初の箱を start に、文は捨てる。cache を通るフローは tone で hit を保存する', () => {
    const g = up(
      G(
        [
          N('actor:user', 'actor'),
          infra('infra:cdn', 'aws_cloudfront_distribution'),
          N('type:T', 'type'),
        ],
        [E('actor:user', 'infra:cdn', 'flow')],
        {
          flows: [
            {
              id: 'miss',
              name: 'MISS',
              steps: [
                { node: 'type:T', text: '型' },
                { node: 'actor:user', text: 'a' },
                { node: 'infra:cdn', text: 'b' },
              ],
            },
            {
              id: 'hit',
              name: 'HIT',
              tone: 'cache-hit',
              steps: [
                { node: 'actor:user', text: 'a' },
                { node: 'infra:cdn', text: 'b' },
              ],
            },
            { id: 'none', name: '型だけ', steps: [{ node: 'type:T', text: '型' }] },
          ],
        },
      ),
    );
    expect(g.views).toEqual([
      { id: 'miss', name: 'MISS', start: 'actor:user', variants: { 'infra:cdn#hit': false } },
      { id: 'hit', name: 'HIT', start: 'actor:user', variants: { 'infra:cdn#hit': true } },
    ]);
  });

  it('最初の箱が枠（口も線も無い）なら、直に載っている最初の箱を start にする', () => {
    // 以前は枠をそのまま start にしていたので、何も流れない view になった（fixture-poly の「メール取り込み」）
    const g = up(
      G(
        [
          infra('infra:webhook', 'aws_lambda_function'),
          N('lib:parser', 'lib', { meta: { go: { pkg: 'internal/parser' } } }),
          N('handler:webhook', 'handler'),
          N('handler:main', 'handler'),
        ],
        [
          E('infra:webhook', 'handler:webhook', 'deploy'),
          E('infra:webhook', 'handler:main', 'deploy'),
          E('handler:webhook', 'lib:parser', 'uses'),
        ],
        {
          flows: [
            {
              id: 'inbound',
              name: '取り込み',
              steps: [
                { node: 'infra:webhook', text: 'a' },
                { node: 'lib:parser', text: 'b' },
              ],
            },
          ],
        },
      ),
    );
    expect(node(g, 'infra:webhook').ports).toEqual([]);
    expect(node(g, 'lib:parser').host).toBe('infra:webhook');
    expect(g.views).toEqual([{ id: 'inbound', name: '取り込み', start: 'handler:webhook' }]);
  });
});

describe('examples/race-site.graph.json', () => {
  const v1 = JSON.parse(readFileSync(RACE, 'utf8')) as Graph;
  const g = upgradeGraph(v1);
  const r = validateGraphV2(g);

  it('検証エラー 0（警告は口の単位の線と wireType unknown だけ）', () => {
    expect(r.errors).toEqual([]);
    const kinds = new Set(
      r.warnings.map((w) =>
        /口の単位/.test(w.message)
          ? '口の単位'
          : /wireType が unknown/.test(w.message)
            ? 'unknown'
            : w.message,
      ),
    );
    expect([...kinds].sort()).toEqual(['unknown', '口の単位']);
  });

  it('箱 id は変えない。type: は types[] に移る', () => {
    const v1Ids = v1.nodes.filter((n) => n.kind !== 'type').map((n) => n.id);
    expect(g.nodes.map((n) => n.id)).toEqual(v1Ids);
    expect(g.types!.filter((t) => t.id.startsWith('type:')).map((t) => t.id)).toEqual(
      v1.nodes.filter((n) => n.kind === 'type').map((n) => n.id),
    );
  });

  it('CloudFront は cache、Lambda@Edge は edge の箱、Lambda と DynamoDB は枠、API Gateway は箱', () => {
    expect(node(g, 'infra:cloudfront').kind).toBe('cache');
    expect(node(g, 'infra:edge')).toMatchObject({ kind: 'infra', runtime: 'edge' });
    expect(node(g, 'infra:lambdaNext').ports).toEqual([]);
    expect(node(g, 'infra:lambdaApi').ports).toEqual([]);
    expect(node(g, 'infra:dynamo').ports).toEqual([]);
    expect(node(g, 'infra:apigw').ports.map((p) => p.id)).toEqual(['in', 'out']);
    expect(node(g, 'schema:RaceItem')).toMatchObject({ kind: 'table', host: 'infra:dynamo' });
    expect(node(g, 'route:/')).toMatchObject({ kind: 'screen', host: 'infra:lambdaNext' });
  });

  it('3 つのフローは views になる', () => {
    expect(g.views!.map((v) => [v.id, v.start, v.variants])).toEqual([
      ['miss', 'actor:user', { 'infra:cloudfront#hit': false }],
      ['hit', 'actor:user', { 'infra:cloudfront#hit': true }],
      ['entry', 'actor:user', { 'infra:cloudfront#hit': false }],
    ]);
  });

  it('同じ入力から同じ出力（決定的）', () => {
    expect(JSON.stringify(upgradeGraph(v1))).toBe(JSON.stringify(g));
  });
});

describe('diffGraphsV2', () => {
  const v1 = JSON.parse(readFileSync(RACE, 'utf8')) as Graph;

  it('口の無い箱（検証していない graph）でも落ちない', () => {
    // 以前は n.ports をそのまま回していたので TypeError で落ちた（CLI の diff は今は v2 を検証してから比べる）
    const a = upgradeGraph(v1);
    const b = structuredClone(a);
    delete (b.nodes[0] as Partial<NodeV2>).ports;
    const d = diffGraphsV2(a, b);
    expect(d.removedItems.length).toBeGreaterThan(0);
    expect(d.removedItems.every((r) => r.startsWith(`${a.nodes[0]!.id}#`))).toBe(true);
  });

  it('同じなら空。箱・線・型・項目の増減と、箱・線の変更を出す', () => {
    const a = upgradeGraph(v1);
    expect(isEmptyDiffV2(diffGraphsV2(a, a))).toBe(true);
    const b = structuredClone(a);
    b.nodes = b.nodes.filter((n) => n.id !== 'comp:Pagination');
    b.wires = b.wires.filter(
      (w) => !w.from.startsWith('comp:Pagination') && !w.to.startsWith('comp:Pagination'),
    );
    b.nodes.find((n) => n.id === 'route:/')!.name = 'Home';
    b.nodes
      .find((n) => n.id === 'route:/')!
      .ports[0]!.items.push({ id: 'date', name: 'date', type: 'string' });
    b.wires.find((w) => w.from === 'route:/#out/_' && w.to === 'comp:RaceCard#in/_')!.label =
      'props';
    b.types = b.types!.filter((t) => t.id !== 'type:Session');
    const d = diffGraphsV2(a, b);
    expect(d.removedNodes).toEqual(['comp:Pagination']);
    expect(d.changedNodes).toEqual([{ id: 'route:/', fields: ['name'] }]);
    expect(d.addedItems).toEqual(['route:/#in/date']);
    expect(d.removedWires).toEqual([
      { from: 'route:/races#out/_', to: 'comp:Pagination#in/_', via: 'render' },
    ]);
    expect(d.changedWires).toEqual([
      { from: 'route:/#out/_', to: 'comp:RaceCard#in/_', via: 'render', fields: ['label'] },
    ]);
    expect(d.removedTypes).toEqual(['type:Session']);
    expect(isEmptyDiffV2(d)).toBe(false);
  });
});
