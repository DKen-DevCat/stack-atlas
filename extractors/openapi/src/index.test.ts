import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import type { PartialGraph, RepoContext, StackAtlasConfig } from '@stack-atlas/core';
import {
  createMemoryLogger,
  createRepoContext,
  itemId as coreItemId,
  mergePartialGraphs,
} from '@stack-atlas/core';
import type { ItemV2 } from '@stack-atlas/schema';
import { extractor, itemId, openapiFiles, parseOpenApi } from './index.js';

const fixtures = resolve(dirname(fileURLToPath(import.meta.url)), '../test/fixtures');
const infos: string[] = [];
const log = { debug() {}, info: (m: string) => infos.push(m), warn() {}, error() {} };
function ctxOf(repo: string, config: StackAtlasConfig = {}): RepoContext {
  const root = resolve(fixtures, repo);
  return {
    root,
    config,
    repoName: repo,
    repos: { a: resolve(fixtures, 'a'), b: resolve(fixtures, 'b'), c: resolve(fixtures, 'c') },
    configDir: fixtures,
    log,
    resolve: (...s) => resolve(root, ...s),
  };
}

describe('parseOpenApi', () => {
  const spec = parseOpenApi(readFileSync(resolve(fixtures, 'a/openapi/shop.yaml'), 'utf8'));
  it('operations with line, code and referenced schemas', () => {
    expect(spec.operations.map((o) => `${o.method} ${o.path}`)).toEqual([
      'GET /orders',
      'POST /orders',
      'DELETE /orders/{id}',
    ]);
    const list = spec.operations[0]!;
    expect(list).toMatchObject({ operationId: 'listOrders', summary: '注文一覧', line: 6 });
    expect(list.code.split('\n')[0]).toBe('  /orders:');
    expect(list.code.split('\n')[1]).toBe('    get:');
    expect(list.code.split('\n').length).toBeLessThanOrEqual(26);
    // parameters の $ref は components/parameters を 1 段たどる
    expect(list.schemas.sort()).toEqual(['OrderList', 'PageNumber']);
    expect(spec.operations[1]!.schemas.sort()).toEqual(['Order', 'OrderInput']);
    expect(spec.operations[2]!.schemas).toEqual([]);
  });
  it('cache only when Cache-Control or x-cache is declared', () => {
    expect(spec.operations[0]!.cache).toEqual({
      tone: 'info',
      badge: 'Cache-Control',
      rules: [{ key: '200 Cache-Control', value: 'max-age=60' }],
    });
    expect(spec.operations[1]!.cache).toBeUndefined();
    expect(spec.operations[2]!.cache?.rules).toEqual([{ key: 'x-cache', value: 'none' }]);
  });
  it('schemas', () => {
    expect(spec.schemas.map((s) => s.name)).toEqual([
      'PageNumber',
      'Order',
      'OrderList',
      'OrderInput',
    ]);
    const list = spec.schemas.find((s) => s.name === 'OrderList')!;
    expect(list.refs).toEqual(['Order']);
    expect(list.code.split('\n')[0]).toBe('    OrderList:');
  });
  it('swagger 2 (JSON)', () => {
    const s = parseOpenApi(readFileSync(resolve(fixtures, 'c/swagger.json'), 'utf8'));
    expect(s.operations[0]).toMatchObject({
      method: 'GET',
      path: '/ping',
      schemas: ['Pong'],
      line: 5,
    });
    expect(s.schemas.map((x) => x.name)).toEqual(['Pong']);
  });
});

describe('openapi extractor', async () => {
  const g = await extractor.extract(ctxOf('a'), { nodes: [], edges: [] });
  const byId = new Map(g.nodes.map((n) => [n.id, n]));

  it('detects default locations and config.openapi.files', async () => {
    expect(await extractor.detect(ctxOf('a'))).toBe(true);
    expect(await extractor.detect(ctxOf('c'))).toBe(true);
    expect(
      openapiFiles(ctxOf('a', { openapi: { files: [{ repo: 'b', path: 'openapi/shop.yaml' }] } })),
    ).toEqual([]);
    expect(
      openapiFiles(ctxOf('b', { openapi: { files: [{ repo: 'b', path: 'openapi/shop.yaml' }] } })),
    ).toEqual(['openapi/shop.yaml']);
    expect(openapiFiles(ctxOf('a', { openapi: { files: ['openapi/shop.yaml'] } }))).toEqual([
      'openapi/shop.yaml',
    ]);
    expect(await extractor.detect(ctxOf('a', { openapi: { files: ['nope.yaml'] } }))).toBe(false);
  });

  it('endpoint nodes', () => {
    const ep = byId.get('endpoint:GET /orders')!;
    expect(ep).toMatchObject({
      kind: 'endpoint',
      layer: 'types',
      name: 'GET /orders',
      file: 'openapi/shop.yaml',
      line: 6,
    });
    expect(ep.meta?.['api']).toEqual({ method: 'GET', path: '/orders', operationId: 'listOrders' });
    expect(ep.meta?.['apiRoutes']).toEqual([{ method: 'GET', path: '/orders' }]);
    expect(ep.cache?.badge).toBe('Cache-Control');
    expect(byId.get('endpoint:POST /orders')?.cache).toBeUndefined();
  });

  it('type nodes and uses edges', () => {
    expect(byId.get('type:Order')?.meta?.['ts']).toEqual({
      exportName: 'Order',
      symbolKind: 'openapi',
    });
    const uses = g.edges.map((e) => `${e.from} -> ${e.to}`).sort();
    expect(uses).toEqual([
      'endpoint:GET /orders -> type:OrderList',
      'endpoint:GET /orders -> type:PageNumber',
      'endpoint:POST /orders -> type:Order',
      'endpoint:POST /orders -> type:OrderInput',
      'type:OrderList -> type:Order',
    ]);
    expect(g.edges.every((e) => e.kind === 'uses')).toBe(true);
  });

  it('dedupes copies in another repo (keeps the first repo)', async () => {
    infos.length = 0;
    const stamped: PartialGraph = mergePartialGraphs([g]);
    const g2 = await extractor.extract(ctxOf('b'), stamped);
    expect(g2.nodes).toEqual([]);
    expect(infos.join('\n')).toContain('既出');
  });
});

// v2（docs/17 §7 #5、8-2a）: endpoint の 4 つの口と、request / response の schema の項目
describe('openapi extractor: v2（endpoint の 4 つの口と項目）', async () => {
  const g = await extractor.extract(ctxOf('a'), { nodes: [], edges: [] });
  const byId = new Map(g.v2!.nodes.map((n) => [n.id, n]));
  const port = (id: string, p: string) => byId.get(id)!.ports.find((x) => x.id === p)!;

  it('in / req に path・query・body、res / out に body（無ければ status）。links は書かない（既定の恒等）', () => {
    expect([...byId.keys()]).toEqual([
      'endpoint:GET /orders',
      'endpoint:POST /orders',
      'endpoint:DELETE /orders/{id}',
    ]);
    const list = byId.get('endpoint:GET /orders')!;
    expect(list).toMatchObject({
      kind: 'endpoint',
      runtime: 'server',
      file: 'openapi/shop.yaml',
      line: 6,
    });
    expect(list.ports.map((p) => [p.id, p.dir, p.items.map((i) => i.id)])).toEqual([
      ['in', 'in', ['path', 'query']],
      ['req', 'out', ['path', 'query']],
      ['res', 'in', ['body']],
      ['out', 'out', ['body']],
    ]);
    expect(list.links).toBeUndefined();
    // components/parameters の $ref を解いたクエリ。required でなければ optional
    expect(port('endpoint:GET /orders', 'in').items[1]!.children).toEqual([
      {
        id: 'page',
        name: 'page',
        type: 'PageNumber',
        wireType: 'integer',
        typeRef: 'type:PageNumber',
        optional: true,
      },
    ]);
    // 応答の body: 名前付きの schema は typeRef、配列は要素の型、所属する型（親）を子の typeRef に
    const body = port('endpoint:GET /orders', 'out').items[0]!;
    expect(body).toMatchObject({
      type: 'OrderList',
      wireType: 'object',
      typeRef: 'type:OrderList',
    });
    // 応答のコードは箱の meta.status（合流の戻りの線のラベル）
    expect(list.meta).toEqual({ operationId: 'listOrders', status: '200' });
    expect(body.children![0]).toMatchObject({
      id: 'items',
      type: 'Order[]',
      wireType: 'array',
      typeRef: 'type:Order',
    });
    expect(
      body.children![0]!.children!.map((c) => [c.id, c.wireType, c.typeRef, c.optional]),
    ).toEqual([
      ['id', 'string', 'type:Order', true],
      ['total', 'integer', 'type:Order', true],
    ]);
  });

  it('requestBodies / responses の $ref を 1 段たどる。body の無い応答は status（コード 説明）', () => {
    const post = byId.get('endpoint:POST /orders')!;
    expect(port('endpoint:POST /orders', 'in').items.map((i) => i.id)).toEqual(['path', 'body']);
    // requestBody の required が無ければ optional（OpenAPI の既定は false）
    expect(port('endpoint:POST /orders', 'in').items[1]).toMatchObject({
      typeRef: 'type:OrderInput',
      optional: true,
    });
    expect(port('endpoint:POST /orders', 'out').items[0]).toMatchObject({
      id: 'body',
      typeRef: 'type:Order',
    });
    expect(post.meta).toEqual({ operationId: 'createOrder', status: '201' });
    const del = byId.get('endpoint:DELETE /orders/{id}')!;
    // パスのパラメータは path の子
    expect(del.ports[0]!.items[0]).toEqual({
      id: 'path',
      name: 'DELETE /orders/{id}',
      type: 'string',
      wireType: 'string',
      children: [{ id: 'id', name: 'id', type: 'string', wireType: 'string' }],
    });
    expect(port('endpoint:DELETE /orders/{id}', 'out').items).toEqual([
      { id: 'status', name: 'status', type: '204 deleted', wireType: 'integer' },
    ]);
  });

  it('型（components.schemas）を types[] に。写しの repo では出さない', async () => {
    expect(g.v2!.types!.map((t) => [t.id, t.source])).toEqual([
      ['type:PageNumber', 'openapi'],
      ['type:Order', 'openapi'],
      ['type:OrderList', 'openapi'],
      ['type:OrderInput', 'openapi'],
    ]);
    const g2 = await extractor.extract(ctxOf('b'), mergePartialGraphs([g]));
    expect(g2.v2).toBeUndefined();
  });

  it('wireType の対応表: date-time / date → datetime、byte / binary → bytes、nullable、3.1 の型の null、required と深さ', () => {
    const spec = parseOpenApi(
      [
        'openapi: 3.1.0',
        'paths:',
        '  /x:',
        '    post:',
        '      requestBody:',
        '        required: true',
        '        content:',
        '          application/json:',
        '            schema:',
        '              type: object',
        '              required: [at]',
        '              properties:',
        '                at: { type: string, format: date-time }',
        '                day: { type: string, format: date }',
        '                blob: { type: string, format: byte }',
        '                memo: { type: string, nullable: true }',
        '                note: { type: [string, "null"] }',
        '                deep: { type: object, properties: { a: { type: object, properties: { b: { type: string } } } } }',
        '                map: { type: object, additionalProperties: { type: integer } }',
        '      responses:',
        '        "200": { description: OK }',
      ].join('\n'),
      { depth: 2 },
    );
    const body = spec.operations[0]!.items.request[1]!;
    expect(body.optional).toBeUndefined();
    const c = new Map(body.children!.map((x) => [x.id, x]));
    expect(c.get('at')).toMatchObject({ wireType: 'datetime', type: 'string (date-time)' });
    expect(c.get('at')!.optional).toBeUndefined();
    expect(c.get('day')).toMatchObject({ wireType: 'datetime', optional: true });
    expect(c.get('blob')!.wireType).toBe('bytes');
    expect(c.get('memo')!.nullable).toBe(true);
    expect(c.get('note')).toMatchObject({ wireType: 'string', nullable: true });
    // 深さ 2: body → deep → a まで（a の子 b は置かない）
    expect(c.get('deep')!.children![0]!.children).toBeUndefined();
    // additionalProperties だけの object は子を置かない（不透明）
    expect(c.get('map')).toMatchObject({ wireType: 'object' });
    expect(c.get('map')!.children).toBeUndefined();
    expect(spec.operations[0]!.items.response).toEqual([
      { id: 'status', name: 'status', type: '200 OK', wireType: 'integer' },
    ]);
  });
});

/** CPU 時間（並列に走る他のテストに待たされた分を含めない） */
const cpuSince = (t0: NodeJS.CpuUsage) => {
  const d = process.cpuUsage(t0);
  return (d.user + d.system) / 1000;
};

/** 項目の数（入れ子を含む） */
const countItems = (items: readonly ItemV2[]): number =>
  items.reduce((n, it) => n + 1 + countItems(it.children ?? []), 0);

describe('悪意のある・壊れた spec（2026-11-09 レビュー S1）', () => {
  const roots: string[] = [];
  afterAll(() => {
    for (const r of roots) rmSync(r, { recursive: true, force: true });
  });
  /** 1 操作（POST /x、body と 200 の応答が schema S0）の spec を JSON で */
  const specWith = (schemas: Record<string, unknown>) =>
    JSON.stringify({
      openapi: '3.0.3',
      paths: {
        '/x': {
          post: {
            requestBody: {
              required: true,
              content: { 'application/json': { schema: { $ref: '#/components/schemas/S0' } } },
            },
            responses: {
              '200': {
                description: 'OK',
                content: { 'application/json': { schema: { $ref: '#/components/schemas/S0' } } },
              },
            },
          },
        },
      },
      components: { schemas },
    });

  it('allOf の菱形（S0 allOf [S1, S1]、S1 allOf [S2, S2]… を 30 段）は段ごとに倍にならない（1 秒未満）', () => {
    const schemas: Record<string, unknown> = {};
    const L = 30;
    for (let i = 0; i < L; i++) {
      const next = { $ref: `#/components/schemas/S${i + 1}` };
      schemas[`S${i}`] = { allOf: [next, next], properties: { [`p${i}`]: { type: 'string' } } };
    }
    schemas[`S${L}`] = { type: 'object', properties: { leaf: { type: 'integer' } } };
    const t0 = process.cpuUsage();
    const spec = parseOpenApi(specWith(schemas));
    expect(cpuSince(t0)).toBeLessThan(1000);
    // 菱形でも全段のプロパティは 1 回ずつまとまる（p0〜p29 と leaf）
    const body = spec.operations[0]!.items.request.find((i) => i.id === 'body')!;
    expect(body.children!.map((c) => c.id).sort()).toEqual(
      [...Array.from({ length: L }, (_, i) => `p${i}`), 'leaf'].sort(),
    );
  });

  it('項目の上限（adapters.maxItems。既定 200）: 2000 個のプロパティがそれぞれ 2000 個のプロパティの B を指しても、操作あたり上限で止めて警告する（1 秒未満）', async () => {
    const N = 2000;
    const bProps: Record<string, unknown> = {};
    for (let i = 0; i < N; i++) bProps[`b${i}`] = { type: 'string' };
    const aProps: Record<string, unknown> = {};
    for (let i = 0; i < N; i++) aProps[`a${i}`] = { $ref: '#/components/schemas/B' };
    const src = specWith({
      S0: { type: 'object', properties: aProps },
      B: { type: 'object', properties: bProps },
    });
    const t0 = process.cpuUsage();
    const spec = parseOpenApi(src);
    expect(cpuSince(t0)).toBeLessThan(1000);
    const items = spec.operations[0]!.items;
    expect(items.truncated).toBe(true);
    // request と response の合計で上限（top-level の path と body は形として必ず置く）
    expect(countItems([...items.request, ...items.response])).toBeLessThanOrEqual(200 + 1);
    // 同じ schema（B）を別々のプロパティが指すのは、それぞれ展開する（上限の中で）
    const small = parseOpenApi(
      specWith({
        S0: {
          type: 'object',
          properties: {
            x: { $ref: '#/components/schemas/B' },
            y: { $ref: '#/components/schemas/B' },
          },
        },
        B: { type: 'object', properties: { v: { type: 'string' } } },
      }),
    );
    const sb = small.operations[0]!.items.request.find((i) => i.id === 'body')!;
    expect(sb.children!.map((c) => [c.id, c.children?.map((x) => x.id)])).toEqual([
      ['x', ['v']],
      ['y', ['v']],
    ]);
    expect(small.operations[0]!.items.truncated).toBeUndefined();

    // 抽出器: 打ち切ったら警告（何を・config のキー）。上限は config の adapters.maxItems
    const root = mkdtempSync(join(tmpdir(), 'stack-atlas-openapi-'));
    roots.push(root);
    mkdirSync(join(root, 'openapi'));
    writeFileSync(join(root, 'openapi', 'openapi.json'), src);
    const mlog = createMemoryLogger();
    const ctx = createRepoContext(root, { adapters: { maxItems: 50 } }, mlog, { repoName: 'a' });
    const t1 = process.cpuUsage();
    const part = await extractor.extract(ctx, { nodes: [], edges: [] });
    expect(cpuSince(t1)).toBeLessThan(1000);
    const ep = part.v2!.nodes[0]!;
    const inPort = ep.ports.find((p) => p.id === 'in')!;
    const outPort = ep.ports.find((p) => p.id === 'out')!;
    expect(countItems([...inPort.items, ...outPort.items])).toBeLessThanOrEqual(50 + 1);
    expect(mlog.of('warn')).toEqual([
      expect.stringMatching(
        /^openapi: endpoint:POST \/x（openapi\/openapi\.json）の項目が上限（50）を超えたので、schema の子の展開を打ち切りました（config の adapters\.maxItems）$/,
      ),
    ]);
  });
});

describe('道具は core の 1 つの定義（2026-11-09 レビュー C9）', () => {
  it('itemId は core のもの（openapi は再 export するだけ）', () => {
    expect(itemId).toBe(coreItemId);
    expect(itemId('query.date')).toBe('query_date');
  });
});
