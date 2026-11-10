import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { PartialGraph, RepoContext, StackAtlasConfig } from '@stack-atlas/core';
import {
  extractor,
  lambdaMatchesEntry,
  parseImports,
  parseRoutes,
  parseServeMuxPattern,
  readModulePath,
  stripComments,
} from './index.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../test/fixtures/shop');
const warnings: string[] = [];
const log = { debug() {}, info() {}, warn: (m: string) => warnings.push(m), error() {} };
function ctxOf(config: StackAtlasConfig = {}, repoName = 'shop'): RepoContext {
  return {
    root,
    config,
    repoName,
    repos: { [repoName]: root },
    configDir: root,
    log,
    resolve: (...s) => resolve(root, ...s),
  };
}

describe('parsers', () => {
  it('readModulePath', () => {
    expect(readModulePath('module example.com/shop\n\ngo 1.22\n')).toBe('example.com/shop');
    expect(readModulePath('// x\nmodule "a/b"\n')).toBe('a/b');
  });
  it('parseImports: single, block, alias', () => {
    const src = `package x\nimport "fmt"\nimport (\n\t"net/http"\n\tst "example.com/a/store"\n\t_ "embed"\n)\n`;
    expect(parseImports(src).sort()).toEqual(['embed', 'example.com/a/store', 'fmt', 'net/http']);
  });
  it('stripComments keeps strings and line numbers', () => {
    const s = stripComments('a // x\n"http://h" /* y\nz */ b');
    expect(s.split('\n')).toHaveLength(3);
    expect(s).toContain('"http://h"');
    expect(s).not.toContain('x');
  });
  it('parseServeMuxPattern', () => {
    expect(parseServeMuxPattern('GET /a/{id}')).toEqual({ method: 'GET', path: '/a/{id}' });
    expect(parseServeMuxPattern('/callback')).toEqual({ method: 'ANY', path: '/callback' });
    expect(parseServeMuxPattern('POST example.com/x')).toEqual({ method: 'POST', path: '/x' });
    expect(parseServeMuxPattern('nope')).toBeUndefined();
  });
  it('parseRoutes: ServeMux / chi / gin / echo / fiber / gorilla-style', () => {
    const src = [
      'mux.HandleFunc("GET /a", h)',
      'mux.Handle("POST /", h)',
      'mux.HandleFunc("/any", h)',
      'r.Get("/chi", h)',
      'e.GET("/echo/:id", h)',
      'app.Post("/fiber", h)',
      'router.Handle("PUT", "/m", h)',
      'r.Method(http.MethodPatch, "/p", h)',
      'http.Get("/client")',
      '// r.Get("/commented", h)',
    ].join('\n');
    expect(parseRoutes(src).map((r) => `${r.method} ${r.path}`)).toEqual([
      'GET /a',
      'POST /',
      'ANY /any',
      'GET /chi',
      'GET /echo/{id}',
      'POST /fiber',
      'PUT /m',
      'PATCH /p',
    ]);
  });
  it('lambdaMatchesEntry', () => {
    expect(lambdaMatchesEntry(['shop-dev-api'], 'api')).toBe(true);
    expect(lambdaMatchesEntry(['lambda_api/gmail_webhook'], 'gmail-webhook')).toBe(true);
    expect(lambdaMatchesEntry(['123.dkr.ecr/shop/worker:latest'], 'worker')).toBe(true);
    expect(lambdaMatchesEntry(['shop-dev-api'], 'worker')).toBe(false);
    expect(lambdaMatchesEntry(['lambda/api-gateway'], 'api')).toBe(false);
  });
});

describe('go extractor', async () => {
  const upstream: PartialGraph = {
    nodes: [
      {
        id: 'infra:fn_api/this',
        kind: 'infra',
        meta: { infra: { type: 'aws_lambda_function', attrs: { function_name: 'shop-dev-api' } } },
      },
      {
        id: 'infra:worker',
        kind: 'infra',
        meta: {
          cdktf: { type: 'aws_lambda_function', logicalId: 'worker', path: 'x', stack: 'x' },
        },
      },
      { id: 'infra:bucket', kind: 'infra', meta: { infra: { type: 'aws_s3_bucket' } } },
    ],
    edges: [],
  };
  warnings.length = 0;
  const g = await extractor.extract(ctxOf(), upstream);
  const byId = new Map(g.nodes.map((n) => [n.id, n]));
  const edge = (from: string, to: string, kind: string) =>
    g.edges.some((e) => e.from === from && e.to === to && e.kind === kind);

  it('detects by go.mod / section repo', async () => {
    expect(await extractor.detect(ctxOf())).toBe(true);
    expect(await extractor.detect(ctxOf({ go: { repo: 'other' } }))).toBe(false);
    expect(await extractor.detect(ctxOf({ go: { repo: 'shop' } }))).toBe(true);
  });

  it('one node per package, skipping tests / vendor / testdata', () => {
    expect([...byId.keys()].sort()).toEqual([
      'handler:cmd/api',
      'handler:cmd/worker',
      'handler:internal/admin',
      'handler:internal/api',
      'schema:internal/store',
      'type:internal/domain',
    ]);
    const api = byId.get('handler:cmd/api')!;
    expect(api).toMatchObject({ name: 'cmd/api', file: 'cmd/api/main.go', line: 1 });
    expect(api.meta?.['go']).toMatchObject({ pkg: 'cmd/api', name: 'main' });
    expect(api.code?.split('\n').length).toBeLessThanOrEqual(25);
    expect(api.meta?.['extractors']).toEqual(['go']);
  });

  it('meta.apiRoutes from ServeMux method patterns and chi', () => {
    const s = byId.get('handler:internal/api')!;
    expect(s.meta?.['apiRoutes']).toEqual([
      { method: 'GET', path: '/orders' },
      { method: 'POST', path: '/orders' },
      { method: 'DELETE', path: '/orders/{id}' },
    ]);
    expect(s.meta?.['api']).toEqual({ method: 'GET', path: '/orders' });
    expect(byId.get('handler:internal/admin')?.meta?.['apiRoutes']).toEqual([
      { method: 'GET', path: '/admin/users' },
      { method: 'POST', path: '/admin/users/{id}/ban' },
    ]);
    expect(byId.get('handler:cmd/api')?.meta?.['apiRoutes']).toBeUndefined();
  });

  it('uses edges for module-internal imports', () => {
    expect(edge('handler:cmd/api', 'handler:internal/api', 'uses')).toBe(true);
    expect(edge('handler:cmd/api', 'schema:internal/store', 'uses')).toBe(true);
    expect(edge('handler:internal/api', 'type:internal/domain', 'uses')).toBe(true);
    expect(edge('schema:internal/store', 'type:internal/domain', 'uses')).toBe(true);
    expect(g.edges.filter((e) => e.kind === 'uses')).toHaveLength(6);
  });

  it('guesses deploy from Lambda names and warns', () => {
    expect(edge('infra:fn_api/this', 'handler:cmd/api', 'deploy')).toBe(true);
    expect(edge('infra:worker', 'handler:cmd/worker', 'deploy')).toBe(true);
    expect(warnings.filter((w) => w.startsWith('推定:'))).toHaveLength(2);
  });

  it('config.deploy[*].go is explicit and suppresses the guess', async () => {
    warnings.length = 0;
    const g2 = await extractor.extract(
      ctxOf({ deploy: { 'infra:worker': { go: 'cmd/api' } } }),
      upstream,
    );
    expect(g2.edges).toContainEqual({
      from: 'infra:worker',
      to: 'handler:cmd/api',
      kind: 'deploy',
    });
    expect(g2.edges.some((e) => e.from === 'infra:worker' && e.to === 'handler:cmd/worker')).toBe(
      false,
    );
    expect(warnings.filter((w) => w.startsWith('推定:'))).toHaveLength(1);
  });

  it('classify rules, entries and module override', async () => {
    const g3 = await extractor.extract(
      ctxOf({
        go: { entries: ['cmd/api'] },
        classify: [
          { glob: 'internal/domain/**', kind: 'schema', layer: 'types' },
          { glob: 'internal/api/**', kind: 'lib' }, // ルート登録は classify より強い
          { glob: 'cmd/worker', kind: 'lib', repo: 'other' },
        ],
      }),
      { nodes: [], edges: [] },
    );
    const ids = g3.nodes.map((n) => n.id);
    expect(ids).toContain('schema:internal/domain');
    expect(g3.nodes.find((n) => n.id === 'schema:internal/domain')?.layer).toBe('types');
    expect(ids).toContain('handler:internal/api');
    // package main は entries に無くても handler
    expect(ids).toContain('handler:cmd/worker');
    const g4 = await extractor.extract(ctxOf({ go: { module: 'other.example/x' } }), {
      nodes: [],
      edges: [],
    });
    expect(g4.edges.filter((e) => e.kind === 'uses')).toHaveLength(0);
  });
});
