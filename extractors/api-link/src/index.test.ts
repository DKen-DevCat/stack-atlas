import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import type { PartialGraph, RepoContext, StackAtlasConfig } from '@stack-atlas/core';
import {
  extractor,
  nameMatchesRoute,
  parseClientCalls,
  pathMatches,
  pickMostSpecific,
  routeSpecificity,
  toPath,
} from './index.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../examples/fixture-repo');
const warnings: string[] = [];
const log = { debug() {}, info() {}, warn: (m: string) => warnings.push(m), error() {} };
function fixtureCtx(config?: StackAtlasConfig): RepoContext {
  return {
    root,
    config:
      config ??
      (parse(readFileSync(resolve(root, 'stack-atlas.config.yaml'), 'utf8')) as StackAtlasConfig),
    repoName: 'fixture',
    repos: { fixture: root },
    configDir: root,
    log,
    resolve: (...s) => resolve(root, ...s),
  };
}

const cdktf = (type: string, logicalId: string) => ({
  cdktf: { type, logicalId, path: `web/${logicalId}`, stack: 'web' },
});
/** cdktf + ts-imports の結果のうち api-link が見る部分 */
const upstream: PartialGraph = {
  nodes: [
    { id: 'infra:api', kind: 'infra', meta: cdktf('aws_lambda_function', 'api') },
    { id: 'infra:httpApi', kind: 'infra', meta: cdktf('aws_apigatewayv2_api', 'httpApi') },
    { id: 'infra:racesTable', kind: 'infra', meta: cdktf('aws_dynamodb_table', 'racesTable') },
    { id: 'lib:apiClient', kind: 'lib', file: 'apps/web/lib/apiClient.ts' },
    {
      id: 'handler:getRaces',
      kind: 'handler',
      file: 'apps/api/src/handlers/getRaces.ts',
      meta: { ts: { exportName: 'getRaces', symbolKind: 'function' } },
    },
    {
      id: 'handler:postResult',
      kind: 'handler',
      file: 'apps/api/src/handlers/postResult.ts',
      meta: { ts: { exportName: 'postResult', symbolKind: 'function' } },
    },
    { id: 'schema:RaceItem', kind: 'schema' },
  ],
  edges: [
    { from: 'infra:api', to: 'infra:racesTable', kind: 'flow' },
    { from: 'handler:getRaces', to: 'schema:RaceItem', kind: 'uses' },
    { from: 'handler:postResult', to: 'schema:RaceItem', kind: 'uses' },
  ],
};

describe('helpers', () => {
  it('toPath strips base urls and query concatenation', () => {
    expect(toPath('/races')).toBe('/races');
    expect(toPath('{BASE}/races/{id}')).toBe('/races/{id}');
    expect(toPath('https://api.example.com/v1/x?y=1')).toBe('/v1/x');
    expect(toPath('/races{qs}')).toBe('/races');
    expect(toPath('{BASE}{path}')).toBeUndefined();
  });
  it('pathMatches', () => {
    expect(pathMatches('/races/{id}', '/races/{id}')).toBe(true);
    expect(pathMatches('/races/{id}', '/races/42')).toBe(true);
    expect(pathMatches('/races', '/races/{id}')).toBe(false);
    expect(pathMatches('/{proxy+}', '/a/b')).toBe(true);
    // greedy は 1 セグメント以上（API Gateway と同じ）。以前は 0 セグメントにも当たっていた
    expect(pathMatches('/races/{proxy+}', '/races/1/results')).toBe(true);
    expect(pathMatches('/races/{proxy+}', '/races')).toBe(false);
    expect(pathMatches('/{proxy+}', '/')).toBe(false);
  });
  it('pickMostSpecific: リテラル > パラメータ > greedy > $default。以前は全部に http エッジを張っていた', () => {
    const r = (routeKey: string) => {
      const [method = 'ANY', path = routeKey] =
        routeKey === '$default' ? ['ANY', '/{proxy+}'] : routeKey.split(' ');
      return { routeKey, method, path, logicalId: routeKey, stack: 'web' };
    };
    const all = [r('$default'), r('GET /{proxy+}'), r('GET /races/{id}'), r('ANY /races/{id}')];
    const match = all.filter((x) => pathMatches(x.path, '/races/42'));
    expect(pickMostSpecific(match).map((x) => x.routeKey)).toEqual(['GET /races/{id}']);
    expect(pickMostSpecific([r('$default'), r('GET /{proxy+}')]).map((x) => x.routeKey)).toEqual([
      'GET /{proxy+}',
    ]);
    expect(pickMostSpecific([r('$default')]).map((x) => x.routeKey)).toEqual(['$default']);
    // 同点は全部残す
    expect(pickMostSpecific([r('GET /a/{x}'), r('GET /{y}/b')])).toHaveLength(2);
    expect(routeSpecificity(r('GET /races/{id}'))).toEqual([1, 1, 1, 1]);
  });
  it('nameMatchesRoute', () => {
    expect(nameMatchesRoute('getRaces', 'GET', '/races')).toBe(true);
    expect(nameMatchesRoute('getRaces', 'GET', '/races/{id}')).toBe(true);
    expect(nameMatchesRoute('postResult', 'POST', '/results')).toBe(true);
    expect(nameMatchesRoute('getRaces', 'POST', '/results')).toBe(false);
    expect(nameMatchesRoute('postResult', 'GET', '/results')).toBe(false);
  });
  it('parseClientCalls reads the fixture client', () => {
    const { calls } = parseClientCalls(resolve(root, 'apps/web/lib/apiClient.ts'));
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      'GET /races',
      'GET /races/{id}',
      'POST /results',
    ]);
    expect(calls[1]).toMatchObject({ via: 'getRace', revalidate: 60, tags: ['race-{id}'] });
    expect(calls[2]).toMatchObject({ via: 'postResult', cache: 'no-store' });
  });
});

describe('api-link extractor', async () => {
  const ctx = fixtureCtx();
  const g = await extractor.extract(ctx, upstream);
  const byId = new Map(g.nodes.map((n) => [n.id, n]));
  const edge = (from: string, to: string, kind: string) =>
    g.edges.find((e) => e.from === from && e.to === to && e.kind === kind);

  it('detects the fixture', async () => {
    expect(await extractor.detect(ctx)).toBe(true);
    expect(await extractor.detect(fixtureCtx({ cdktf: { out: 'nope' } }))).toBe(false);
  });

  it('http edges from the client to handlers', () => {
    expect(edge('lib:apiClient', 'handler:getRaces', 'http')?.label).toBe(
      'GET /races, GET /races/{id}',
    );
    expect(edge('lib:apiClient', 'handler:postResult', 'http')?.label).toBe('POST /results');
    expect(warnings).toEqual([]);
  });

  it('deploy edges from the API Lambda', () => {
    expect(edge('infra:api', 'handler:getRaces', 'deploy')).toBeDefined();
    expect(edge('infra:api', 'handler:postResult', 'deploy')).toBeDefined();
  });

  it('schema edge from the table to the schema used by its handlers', () => {
    expect(edge('infra:racesTable', 'schema:RaceItem', 'schema')).toBeDefined();
    expect(g.edges).toHaveLength(5);
  });

  it('meta.apiCalls and fetch cache on the client', () => {
    const c = byId.get('lib:apiClient')!;
    expect(c.meta?.['apiCalls']).toEqual([
      { method: 'GET', path: '/races' },
      { method: 'GET', path: '/races/{id}' },
      { method: 'POST', path: '/results' },
    ]);
    expect(c.meta?.['extractors']).toEqual(['api-link']);
    expect(c.kind).toBeUndefined(); // 上流にあるので id + meta だけ
    expect(c.cache).toEqual({
      tone: 'info',
      badge: 'fetch cache',
      rules: [
        { key: 'GET /races/{id}', value: 'revalidate 60s / tags race-{id}' },
        { key: 'POST /results', value: 'no-store' },
      ],
    });
  });

  it('meta.api on handlers', () => {
    expect(byId.get('handler:getRaces')?.meta?.['api']).toEqual({
      method: 'GET',
      path: '/races/{id}',
    });
    expect(byId.get('handler:getRaces')?.meta?.['apiRoutes']).toHaveLength(2);
    expect(byId.get('handler:postResult')?.meta?.['api']).toEqual({
      method: 'POST',
      path: '/results',
    });
  });

  it('works without upstream (creates handler and client nodes itself)', async () => {
    const g2 = await extractor.extract(ctx, { nodes: [], edges: [] });
    const h = g2.nodes.find((n) => n.id === 'handler:getRaces');
    expect(h).toMatchObject({ kind: 'handler', file: 'apps/api/src/handlers/getRaces.ts' });
    expect(g2.nodes.find((n) => n.id === 'lib:apiClient')?.kind).toBe('lib');
    expect(g2.edges.some((e) => e.kind === 'http' && e.to === 'handler:postResult')).toBe(true);
  });

  it('warns about client calls without a route', async () => {
    warnings.length = 0;
    await extractor.extract(fixtureCtx({ api: { client: 'apps/web/lib/apiClient.ts' } }), upstream);
    expect(warnings.join('\n')).toContain('GET /races');
  });
});
