import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import type { RepoContext, StackAtlasConfig } from '@stack-atlas/core';
import { extractor, NODE_RESOURCE_TYPES } from './index.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../examples/fixture-repo');
const silent = { debug() {}, info() {}, warn() {}, error() {} };
function fixtureCtx(config?: StackAtlasConfig): RepoContext {
  return {
    root,
    config:
      config ??
      (parse(readFileSync(resolve(root, 'stack-atlas.config.yaml'), 'utf8')) as StackAtlasConfig),
    repoName: 'fixture',
    repos: { fixture: root },
    configDir: root,
    log: silent,
    resolve: (...s) => resolve(root, ...s),
  };
}

describe('cdktf extractor', async () => {
  const ctx = fixtureCtx();
  const g = await extractor.extract(ctx, { nodes: [], edges: [] });
  const byId = new Map(g.nodes.map((n) => [n.id, n]));
  const hasEdge = (from: string, to: string) =>
    g.edges.some((e) => e.from === from && e.to === to && e.kind === 'flow');

  it('detects the fixture', async () => {
    expect(await extractor.detect(ctx)).toBe(true);
    expect(await extractor.detect(fixtureCtx({ cdktf: { out: 'nope' } }))).toBe(false);
  });

  it('emits one node per allowlisted resource', () => {
    expect([...byId.keys()].sort()).toEqual(
      [
        'infra:admins',
        'infra:api',
        'infra:authEdge',
        'infra:cdn',
        'infra:httpApi',
        'infra:next',
        'infra:racesTable',
        'infra:static',
      ].sort(),
    );
    for (const n of g.nodes) {
      expect(n.kind).toBe('infra');
      expect(n.layer).toBeUndefined();
      const meta = n.meta as { extractors: string[]; cdktf: { type: string } };
      expect(meta.extractors).toEqual(['cdktf']);
      expect(NODE_RESOURCE_TYPES).toContain(meta.cdktf.type);
    }
  });

  it('does not emit non-allowlisted resources (IAM, routes, stages, function urls)', () => {
    for (const id of [
      'apiRole',
      'apiIntegration',
      'getRaces',
      'httpApiDefault',
      'nextUrl',
      'adminsWebClient',
      'apiInvoke',
      'honorOriginHeaders',
    ]) {
      expect(byId.has(`infra:${id}`)).toBe(false);
    }
  });

  it('follows references, including the Function URL hop', () => {
    expect(hasEdge('infra:cdn', 'infra:next')).toBe(true);
    expect(hasEdge('infra:cdn', 'infra:static')).toBe(true);
    expect(hasEdge('infra:cdn', 'infra:authEdge')).toBe(true);
    expect(hasEdge('infra:httpApi', 'infra:api')).toBe(true);
    expect(hasEdge('infra:api', 'infra:racesTable')).toBe(true);
    expect(hasEdge('infra:next', 'infra:httpApi')).toBe(true);
    expect(hasEdge('infra:authEdge', 'infra:admins')).toBe(true);
    expect(g.edges).toHaveLength(7);
    const table = g.edges.find((e) => e.from === 'infra:api' && e.to === 'infra:racesTable');
    expect(table?.label).toBe('environment.TABLE');
    expect(g.edges.find((e) => e.to === 'infra:next')?.label).toBe('origin.domain_name');
  });

  it('labels and meta', () => {
    expect(byId.get('infra:cdn')?.name).toBe('CloudFront');
    expect(byId.get('infra:next')?.name).toBe('Lambda: next');
    expect(byId.get('infra:authEdge')?.name).toBe('Lambda@Edge: authEdge');
    expect(byId.get('infra:httpApi')?.name).toBe('API Gateway (HTTP)');
    expect(byId.get('infra:static')?.name).toBe('S3 race-web-static');
    expect(byId.get('infra:admins')?.name).toBe('Cognito race-admins');
    expect(byId.get('infra:next')?.meta?.['deployApp']).toBe('next');
    expect(byId.get('infra:api')?.meta?.['deployApp']).toBeUndefined();
    expect(byId.get('infra:cdn')?.meta?.['cdktf']).toEqual({
      type: 'aws_cloudfront_distribution',
      logicalId: 'cdn',
      path: 'web/cdn',
      stack: 'web',
    });
  });

  it('resolves source file and line by construct id', () => {
    const cdn = byId.get('infra:cdn')!;
    expect(cdn.file).toBe('infra/stacks/cdn.ts');
    expect(cdn.line).toBeGreaterThan(1);
    expect(cdn.code).toContain('new CloudfrontDistribution(scope, "cdn"');
    expect(byId.get('infra:next')?.file).toBe('infra/stacks/web.ts');
    expect(byId.get('infra:api')?.file).toBe('infra/stacks/api.ts');
  });

  it('summarises CloudFront cache behaviors', () => {
    const c = byId.get('infra:cdn')!.cache!;
    expect(c.badge).toBe('CDN 5 behaviors');
    expect(c.tone).toBe('ok');
    const rule = (k: string) => c.rules?.find((r) => r.key === k)?.value;
    expect(rule('/admin/*')).toContain('CachingDisabled（素通し）');
    expect(rule('/_next/static/*')).toContain('CachingOptimized');
    expect(rule('/races/*')).toContain('TTL default=60s max=300s');
    expect(c.note).toBeUndefined();
  });

  it('cache for API Gateway and Lambda@Edge', () => {
    expect(byId.get('infra:httpApi')?.cache).toMatchObject({
      tone: 'off',
      badge: 'キャッシュなし',
    });
    const edge = byId.get('infra:authEdge')!.cache!;
    expect(edge).toMatchObject({ tone: 'info', badge: 'キャッシュ判定の前' });
    expect(edge.rules?.[1]?.value).toContain('/admin/*');
  });

  it('honours config.deploy app=next', async () => {
    const g2 = await extractor.extract(
      fixtureCtx({ cdktf: { out: 'infra/cdktf.out' }, deploy: { 'infra:api': { app: 'next' } } }),
      { nodes: [], edges: [] },
    );
    expect(g2.nodes.find((n) => n.id === 'infra:api')?.meta?.['deployApp']).toBe('next');
  });
});

describe('read の申告（docs/23 §3.1。2026-11-11 Phase 9-L0 のレビュー）', () => {
  it('申告するのはスタックの cdk.tf.json だけ（sourceDir の .ts は construct id を探すだけで、TS として読まない）', async () => {
    const g = await extractor.extract(fixtureCtx(), { nodes: [], edges: [] });
    expect(g.read).toEqual(['infra/cdktf.out/stacks/web/cdk.tf.json']);
  });
});
