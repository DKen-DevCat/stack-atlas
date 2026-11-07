import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { PartialGraph, RepoContext, StackAtlasConfig } from '@stack-atlas/core';
import { mergePartialGraphs } from '@stack-atlas/core';
import { extractor, openapiFiles, parseOpenApi } from './index.js';

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
