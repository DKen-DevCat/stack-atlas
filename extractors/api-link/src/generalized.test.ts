import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { PartialGraph, RepoContext, StackAtlasConfig } from '@stack-atlas/core';
import {
  apiPathMatches,
  clientFiles,
  extractor,
  gatewayRoutesFromMeta,
  parseClientFiles,
} from './index.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../test/fixtures/web');
const warnings: string[] = [];
const log = { debug() {}, info() {}, warn: (m: string) => warnings.push(m), error() {} };
const CLIENTS = ['src/lib/fetcher/**/*.ts', 'src/feature/**/*.ts', 'src/components/*-island.tsx'];
function ctxOf(config: StackAtlasConfig = { api: { clients: CLIENTS } }): RepoContext {
  return {
    root,
    config,
    repoName: 'web',
    repos: { web: root, platform: '/nonexistent' },
    configDir: root,
    log,
    resolve: (...s) => resolve(root, ...s),
  };
}

const endpoint = (method: string, path: string) => ({
  id: `endpoint:${method} ${path}`,
  kind: 'endpoint',
  meta: { api: { method, path }, apiRoutes: [{ method, path }] },
});
/** platform 側（openapi / go / tf-graph）の結果のうち api-link が見る部分 */
const upstream: PartialGraph = {
  nodes: [
    endpoint('GET', '/orders'),
    endpoint('POST', '/orders'),
    endpoint('DELETE', '/orders/{id}'),
    {
      id: 'handler:internal/api',
      kind: 'handler',
      file: 'platform/internal/api/server.go',
      meta: {
        go: { pkg: 'internal/api' },
        apiRoutes: [
          { method: 'GET', path: '/orders' },
          { method: 'POST', path: '/orders' },
          { method: 'DELETE', path: '/orders/{id}' },
          { method: 'POST', path: '/ping' },
        ],
      },
    },
    {
      id: 'handler:cmd/webhook',
      kind: 'handler',
      meta: { apiRoutes: [{ method: 'POST', path: '/' }] },
    },
    {
      id: 'infra:fn/api',
      kind: 'infra',
      meta: { infra: { type: 'aws_lambda_function', functionUrl: true } },
    },
    { id: 'infra:fn/webhook', kind: 'infra', meta: { infra: { type: 'aws_lambda_function' } } },
    {
      id: 'lib:request',
      kind: 'lib',
      file: 'web/src/feature/orders/request.ts',
      meta: { ts: { exportName: 'listOrders', symbolKind: 'function', exports: ['listOrders'] } },
    },
    {
      id: 'comp:PingIsland',
      kind: 'component',
      file: 'src/components/ping-island.tsx',
      meta: { ts: { exportName: 'PingIsland', symbolKind: 'function' } },
    },
    {
      id: 'lib:pingIsland',
      kind: 'lib',
      file: 'src/components/ping-island.tsx',
      meta: { ts: { exportName: 'ping', symbolKind: 'function', exports: ['ping'] } },
    },
  ],
  edges: [{ from: 'handler:cmd/api', to: 'handler:internal/api', kind: 'uses' }],
};

describe('client parsing (wrappers, constants)', () => {
  const files = clientFiles(ctxOf(), { clients: CLIENTS });
  it('clientFiles globs', () => {
    expect(files).toEqual([
      'src/components/ping-island.tsx',
      'src/feature/orders/consts.ts',
      'src/feature/orders/request.ts',
      'src/lib/fetcher/client.ts',
      'src/lib/fetcher/index.ts',
    ]);
  });
  const r = parseClientFiles(
    files.map((f) => resolve(root, f)),
    { root },
  );
  it('detects wrappers transitively (fetcher → request → fetch, clientFetcher → fetch(fn(arg)))', () => {
    expect([...r.wrappers.keys()].sort()).toEqual(['clientFetcher', 'fetcher', 'request']);
    // listOrders(page) はパスをそのまま渡していないのでラッパーではない
    expect(r.wrappers.has('listOrders')).toBe(false);
    expect(r.wrappers.has('loadOrders')).toBe(false);
  });
  it('reads call sites with constants, encodeURIComponent and methods', () => {
    expect(r.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      'GET /unknown',
      'POST /ping',
      'GET /orders',
      'POST /orders',
      'DELETE /orders/{id}/',
    ]);
    expect(r.calls[2]).toMatchObject({ via: 'listOrders', top: 'listOrders' });
    // Map.get / toLocaleString / ラッパー内部の中継は呼び出しにしない
    expect(r.unreadable.some((u) => u.startsWith('toLocaleString'))).toBe(false);
  });
  it('apiPathMatches tolerates trailing slashes and Go / Express params', () => {
    expect(apiPathMatches('/orders/{id}', '/orders/{id}/')).toBe(true);
    expect(apiPathMatches('/orders/{id...}', '/orders/a/b')).toBe(true);
    expect(apiPathMatches('/orders/:id', '/orders/{x}')).toBe(true);
    expect(apiPathMatches('/', '/orders')).toBe(false);
  });
});

describe('api-link: endpoints, route handlers, targets', async () => {
  warnings.length = 0;
  const g = await extractor.extract(ctxOf(), upstream);
  const has = (from: string, to: string, kind: string, label?: string) =>
    g.edges.some(
      (e) => e.from === from && e.to === to && e.kind === kind && (!label || e.label === label),
    );

  it('detect: clients glob and api.repo', async () => {
    expect(await extractor.detect(ctxOf())).toBe(true);
    expect(await extractor.detect(ctxOf({ api: { repo: 'platform', clients: CLIENTS } }))).toBe(
      false,
    );
    expect(await extractor.detect(ctxOf({ api: { clients: ['nope/**'] } }))).toBe(false);
  });

  it('caller → endpoint (http, label) on the upstream node of the file', () => {
    expect(has('lib:request', 'endpoint:GET /orders', 'http', 'GET /orders')).toBe(true);
    expect(has('lib:request', 'endpoint:POST /orders', 'http')).toBe(true);
    expect(has('lib:request', 'endpoint:DELETE /orders/{id}', 'http')).toBe(true);
    const req = g.nodes.find((n) => n.id === 'lib:request')!;
    expect(req.kind).toBeUndefined();
    expect(req.meta?.['apiCalls']).toHaveLength(3);
  });

  it('endpoint → handler with meta.apiRoutes (not the POST / webhook)', () => {
    for (const ep of ['GET /orders', 'POST /orders', 'DELETE /orders/{id}'])
      expect(has(`endpoint:${ep}`, 'handler:internal/api', 'http')).toBe(true);
    expect(g.edges.some((e) => e.to === 'handler:cmd/webhook')).toBe(false);
  });

  it('caller → handler directly when there is no endpoint; picks the export that calls', () => {
    expect(has('lib:pingIsland', 'handler:internal/api', 'http', 'POST /ping')).toBe(true);
    expect(g.edges.some((e) => e.from === 'comp:PingIsland')).toBe(false);
  });

  it('creates lib nodes for client files without an upstream node', async () => {
    const g2 = await extractor.extract(ctxOf(), { nodes: upstream.nodes.slice(0, 3), edges: [] });
    expect(g2.nodes.find((n) => n.id === 'lib:request')).toMatchObject({
      kind: 'lib',
      file: 'src/feature/orders/request.ts',
    });
    expect(g2.nodes.find((n) => n.id === 'lib:pingIsland')?.kind).toBe('lib');
    // 中継しかしない fetcher/index.ts・client.ts はノードにしない
    expect(g2.nodes.some((n) => n.id === 'lib:fetcher' || n.id === 'lib:client')).toBe(false);
  });

  it('Function URL Lambda as the guessed target → deploy to every endpoint (warn)', () => {
    for (const ep of ['GET /orders', 'POST /orders', 'DELETE /orders/{id}'])
      expect(has('infra:fn/api', `endpoint:${ep}`, 'deploy')).toBe(true);
    expect(warnings.some((w) => w.startsWith('推定: client の呼び先 → infra:fn/api'))).toBe(true);
  });

  it('warns about unmatched calls', () => {
    expect(warnings.some((w) => w.includes('GET /unknown'))).toBe(true);
    expect(warnings.join('\n')).not.toContain('/orders');
  });

  it('explicit api.targets; several targets use deploy / uses reachability', async () => {
    warnings.length = 0;
    const g3 = await extractor.extract(
      ctxOf({
        api: { clients: CLIENTS, targets: ['infra:fn/api', 'infra:fn/webhook'] },
        deploy: { 'infra:fn/api': { nodes: ['handler:cmd/api'] } },
      }),
      upstream,
    );
    const deploys = g3.edges.filter((e) => e.kind === 'deploy').map((e) => `${e.from}>${e.to}`);
    expect(deploys.sort()).toEqual([
      'infra:fn/api>endpoint:DELETE /orders/{id}',
      'infra:fn/api>endpoint:GET /orders',
      'infra:fn/api>endpoint:POST /orders',
    ]);
    expect(warnings.some((w) => w.startsWith('推定'))).toBe(false);
  });
});

describe('API Gateway from tf-graph meta', () => {
  it('gatewayRoutesFromMeta + auto target', async () => {
    const gw = {
      id: 'infra:http',
      kind: 'infra',
      meta: {
        infra: {
          type: 'aws_apigatewayv2_api',
          apiRoutes: [
            { routeKey: 'GET /orders', lambdaId: 'infra:fn/api' },
            { routeKey: '$default' },
          ],
        },
      },
    };
    expect(gatewayRoutesFromMeta([gw])).toEqual([
      {
        routeKey: 'GET /orders',
        method: 'GET',
        path: '/orders',
        logicalId: 'GET /orders',
        stack: '',
        apiId: 'infra:http',
        lambdaId: 'infra:fn/api',
      },
      {
        routeKey: '$default',
        method: 'ANY',
        path: '/{proxy+}',
        logicalId: '$default',
        stack: '',
        apiId: 'infra:http',
      },
    ]);
    warnings.length = 0;
    const g = await extractor.extract(ctxOf(), { nodes: [...upstream.nodes, gw], edges: [] });
    // API Gateway があればそれが呼び先（Function URL の推定はしない）
    expect(g.edges.filter((e) => e.kind === 'deploy').every((e) => e.from === 'infra:http')).toBe(
      true,
    );
    expect(g.edges.filter((e) => e.kind === 'deploy')).toHaveLength(3);
    expect(warnings.some((w) => w.startsWith('推定'))).toBe(false);
  });
});

describe('several Function URL Lambdas', () => {
  it('guesses the one whose deploy / uses path reaches the endpoint handler', async () => {
    warnings.length = 0;
    const up: PartialGraph = {
      nodes: [
        ...upstream.nodes.filter((n) => !n.id.startsWith('infra:')),
        {
          id: 'infra:a',
          kind: 'infra',
          meta: { infra: { type: 'aws_lambda_function', functionUrl: true } },
        },
        {
          id: 'infra:b',
          kind: 'infra',
          meta: { infra: { type: 'aws_lambda_function', functionUrl: true } },
        },
        { id: 'handler:cmd/api', kind: 'handler' },
      ],
      edges: [...upstream.edges, { from: 'infra:b', to: 'handler:cmd/api', kind: 'deploy' }],
    };
    const g = await extractor.extract(ctxOf(), up);
    const froms = new Set(g.edges.filter((e) => e.kind === 'deploy').map((e) => e.from));
    expect([...froms]).toEqual(['infra:b']);
    expect(warnings.some((w) => w.startsWith('推定: client の呼び先 → infra:b'))).toBe(true);
  });
});
