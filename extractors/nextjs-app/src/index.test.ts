import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import type { PartialGraph, RepoContext, StackAtlasConfig } from '@stack-atlas/core';
import { extractor, parseSegmentConfig, segmentToUrl } from './index.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../examples/fixture-repo');
const silent = { debug() {}, info() {}, warn() {}, error() {} };
function fixtureCtx(config?: StackAtlasConfig): RepoContext {
  return {
    root,
    config:
      config ??
      (parse(readFileSync(resolve(root, 'stack-atlas.config.yaml'), 'utf8')) as StackAtlasConfig),
    log: silent,
    resolve: (...s) => resolve(root, ...s),
  };
}

const upstream: PartialGraph = {
  nodes: [
    {
      id: 'infra:next',
      kind: 'infra',
      meta: {
        deployApp: 'next',
        cdktf: { type: 'aws_lambda_function', logicalId: 'next', path: 'web/next', stack: 'web' },
      },
    },
    { id: 'infra:api', kind: 'infra' },
  ],
  edges: [],
};

describe('segmentToUrl', () => {
  it('strips groups and keeps dynamic segments', () => {
    expect(segmentToUrl('')).toEqual({ url: '/' });
    expect(segmentToUrl('(shop)/cart')).toEqual({ url: '/cart' });
    expect(segmentToUrl('races/[id]')).toEqual({ url: '/races/[id]' });
    expect(segmentToUrl('docs/[...slug]')).toEqual({ url: '/docs/[...slug]' });
    expect(segmentToUrl('docs/[[...slug]]')).toEqual({ url: '/docs/[[...slug]]' });
    expect('skip' in segmentToUrl('@modal/login')).toBe(true);
    expect('skip' in segmentToUrl('feed/(.)photo')).toBe(true);
    expect('skip' in segmentToUrl('_lib')).toBe(true);
  });
});

describe('parseSegmentConfig', () => {
  it('reads literals', () => {
    expect(parseSegmentConfig('export const revalidate = 60; // ISR')).toEqual({ revalidate: 60 });
    expect(parseSegmentConfig('export const revalidate = false')).toEqual({ revalidate: false });
    expect(parseSegmentConfig("export const dynamic = 'force-dynamic'")).toEqual({
      dynamic: 'force-dynamic',
    });
    expect(parseSegmentConfig('export async function generateStaticParams() {}')).toEqual({
      generateStaticParams: true,
    });
  });
});

describe('nextjs-app extractor', async () => {
  const ctx = fixtureCtx();
  const g = await extractor.extract(ctx, upstream);
  const byId = new Map(g.nodes.map((n) => [n.id, n]));

  it('detects the fixture', async () => {
    expect(await extractor.detect(ctx)).toBe(true);
    expect(await extractor.detect(fixtureCtx({ next: { appDir: 'nope' } }))).toBe(false);
  });

  it('emits routes and layouts', () => {
    expect([...byId.keys()].sort()).toEqual(
      [
        'layout:/',
        'route:/',
        'route:/admin/entry',
        'route:/login',
        'route:/races',
        'route:/races/[id]',
      ].sort(),
    );
    expect(byId.get('route:/races/[id]')).toMatchObject({
      kind: 'page',
      name: '/races/[id]',
      file: 'apps/web/app/races/[id]/page.tsx',
      line: 1,
    });
    expect(byId.get('layout:/')?.kind).toBe('layout');
    expect(byId.get('layout:/')?.meta).toEqual({
      extractors: ['nextjs-app'],
      next: { segment: '' },
    });
  });

  it('captures segment config', () => {
    expect(byId.get('route:/')?.meta?.['next']).toMatchObject({ revalidate: 30, segment: '' });
    expect(byId.get('route:/races/[id]')?.meta?.['next']).toMatchObject({
      revalidate: 60,
      segment: 'races/[id]',
      generateStaticParams: true,
    });
    expect(byId.get('route:/admin/entry')?.meta?.['next']).toMatchObject({
      dynamic: 'force-dynamic',
    });
  });

  it('builds cache', () => {
    const isr = byId.get('route:/races/[id]')!.cache!;
    expect(isr).toMatchObject({ tone: 'warn', badge: 'ISR 60s' });
    expect(isr.rules).toContainEqual({ key: 'revalidate', value: '60秒' });
    expect(isr.rules).toContainEqual({
      key: 'generateStaticParams',
      value: 'あり（ビルド時に生成）',
    });
    expect(byId.get('route:/admin/entry')?.cache).toMatchObject({ tone: 'off', badge: 'dynamic' });
    expect(byId.get('route:/races')?.cache).toBeUndefined();
  });

  it('deploy edges from the Next Lambda to every route and layout', () => {
    expect(g.edges).toHaveLength(6);
    for (const id of byId.keys()) {
      expect(g.edges).toContainEqual({ from: 'infra:next', to: id, kind: 'deploy' });
    }
  });

  it('no deploy edges and ok-ISR without a Lambda host', async () => {
    const g2 = await extractor.extract(fixtureCtx({ next: { appDir: 'apps/web/app' } }), {
      nodes: [],
      edges: [],
    });
    expect(g2.edges).toEqual([]);
    expect(g2.nodes.find((n) => n.id === 'route:/')?.cache).toMatchObject({
      tone: 'ok',
      badge: 'ISR 30s',
    });
  });
});
