import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import type { PartialGraph, RepoContext, StackAtlasConfig } from '@stack-atlas/core';
import {
  extractor,
  MAX_NEXT_CONFIG_BYTES,
  parseSegmentConfig,
  readNextConfig,
  readNextOutput,
  segmentToUrl,
  stripJsComments,
} from './index.js';

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

describe('readNextConfig（8-3b: screens が trailingSlash・basePath・assetPrefix・distDir を使う）', () => {
  const app = (config: string) => {
    const dir = mkdtempSync(join(tmpdir(), 'stack-atlas-nextcfg-'));
    mkdirSync(join(dir, 'web', 'src', 'app'), { recursive: true });
    writeFileSync(join(dir, 'web', 'next.config.mjs'), config);
    return dir;
  };

  it('文字列と真偽値のリテラルを読む。next.config のディレクトリも返す', () => {
    const dir = app(
      [
        '/** @type {import("next").NextConfig} */',
        'export default {',
        '  output: "export",',
        "  distDir: 'build/site',",
        '  trailingSlash: true,',
        '  basePath: `/docs`,',
        "  assetPrefix: 'https://cdn.example.com',",
        '};',
      ].join('\n'),
    );
    expect(readNextConfig(dir, { appDir: 'web/src/app' })).toEqual({
      dir: 'web',
      file: 'web/next.config.mjs',
      output: 'export',
      distDir: 'build/site',
      trailingSlash: true,
      basePath: '/docs',
      assetPrefix: 'https://cdn.example.com',
    });
    expect(readNextOutput(dir, { appDir: 'web/src/app' })).toBe('export');
  });

  it('コメントの中の値と、環境変数などで決まる値（テンプレートの ${}）は読まない', () => {
    const dir = app(
      [
        'export default {',
        "  // basePath: '/old',",
        "  /* assetPrefix: 'https://old.example.com', */",
        '  assetPrefix: `${process.env.CDN}`,',
        '  trailingSlash: false,',
        '};',
      ].join('\n'),
    );
    expect(readNextConfig(dir, { appDir: 'web/src/app' })).toEqual({
      dir: 'web',
      file: 'web/next.config.mjs',
      trailingSlash: false,
    });
  });

  it('next.config が無ければ undefined', () => {
    const dir = mkdtempSync(join(tmpdir(), 'stack-atlas-nextcfg-'));
    expect(readNextConfig(dir, {})).toBeUndefined();
  });

  // 2026-11-09 追加（8-3b のレビュー）: 解析対象の repo の next.config は信用しない入力
  it('閉じていない /* が並んでも 2 乗にならない（以前は正規表現で 80 KB に 1.2 秒・40 KB の改行で同じく）', () => {
    const dir = app(`${'/* '.repeat(200_000)}\nexport default { output: 'export' }`);
    const t0 = performance.now();
    readNextConfig(dir, { appDir: 'web/src/app' });
    const blanks = app(`${'\n'.repeat(400_000)}export default { output: 'export' }`);
    expect(readNextConfig(blanks, { appDir: 'web/src/app' })?.output).toBe('export');
    expect(performance.now() - t0).toBeLessThan(1500);
  });

  it('stripJsComments: 閉じていない /* から後ろは残す（正規表現のときと同じ）。行頭の // の行は外す', () => {
    expect(stripJsComments('a /* x */ b /* y */ c')).toBe('a  b  c');
    expect(stripJsComments("a /* x */ b /* y\noutput: 'export'")).toBe(
      "a  b /* y\noutput: 'export'",
    );
    expect(stripJsComments("a\n  // basePath: '/old'\nb // keep")).toBe('a\nb // keep');
  });

  it(`${MAX_NEXT_CONFIG_BYTES / 1024 / 1024} MB を超える next.config は値を読まずに警告`, () => {
    const dir = app(`export default { output: 'export' }\n${' '.repeat(MAX_NEXT_CONFIG_BYTES)}`);
    const warns: string[] = [];
    // 2026-11-11（Phase 9-L0 のレビュー）: tooLarge を足した（読まなかったので read で申告しない）
    expect(readNextConfig(dir, { appDir: 'web/src/app' }, (m) => warns.push(m))).toEqual({
      dir: 'web',
      file: 'web/next.config.mjs',
      tooLarge: true,
    });
    expect(warns).toEqual([
      'web/next.config.mjs が 1 MB を超える（1025 KB）ので、output などの値を読みません',
    ]);
  });
});

describe('read の申告（docs/23 §3.1。2026-11-11 Phase 9-L0 のレビュー）', () => {
  const run = async (config: string) => {
    const dir = mkdtempSync(join(tmpdir(), 'stack-atlas-nextread-'));
    mkdirSync(join(dir, 'web', 'src', 'app'), { recursive: true });
    writeFileSync(join(dir, 'web', 'src', 'app', 'page.tsx'), 'export default function P() {}\n');
    writeFileSync(join(dir, 'web', 'next.config.mjs'), config);
    const ctx: RepoContext = {
      root: dir,
      config: { next: { appDir: 'web/src/app' } },
      repoName: 'r',
      repos: { r: dir },
      configDir: dir,
      log: { debug() {}, info() {}, warn() {}, error() {} },
      resolve: (...s) => resolve(dir, ...s),
    };
    return extractor.extract(ctx, { nodes: [], edges: [] });
  };
  it('読んだ next.config を申告し、大きすぎて読まなかったものは申告しない', async () => {
    expect((await run("export default { output: 'export' }\n")).read).toEqual([
      'web/next.config.mjs',
    ]);
    expect(
      (await run(`export default {}\n${' '.repeat(MAX_NEXT_CONFIG_BYTES)}`)).read,
    ).toBeUndefined();
  });
});

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

const fixtures = resolve(dirname(fileURLToPath(import.meta.url)), '../test/fixtures');
function ctxAt(
  dir: string,
  config: StackAtlasConfig = {},
  warn?: (m: string) => void,
): RepoContext {
  const r = resolve(fixtures, dir);
  return {
    root: r,
    config,
    repoName: dir,
    repos: { [dir]: r },
    configDir: r,
    log: { ...silent, warn: warn ?? (() => {}) },
    resolve: (...s) => resolve(r, ...s),
  };
}

describe('static export + route handlers', async () => {
  const warnings: string[] = [];
  const up: PartialGraph = {
    nodes: [
      { id: 'infra:cdn', kind: 'infra', meta: { infra: { type: 'aws_cloudfront_distribution' } } },
      { id: 'infra:site', kind: 'infra', meta: { infra: { type: 'aws_s3_bucket' } } },
      { id: 'infra:logs', kind: 'infra', meta: { infra: { type: 'aws_s3_bucket' } } },
    ],
    edges: [{ from: 'infra:cdn', to: 'infra:site', kind: 'flow' }],
  };
  const g = await extractor.extract(
    ctxAt('export-app', {}, (m) => warnings.push(m)),
    up,
  );
  const byId = new Map(g.nodes.map((n) => [n.id, n]));

  it('output: export → static export cache unless the segment has its own', () => {
    expect(byId.get('route:/')?.cache).toEqual({
      tone: 'ok',
      badge: 'static export',
      rules: [{ key: 'output', value: 'export（ビルド時に静的生成）' }],
    });
    expect(byId.get('route:/')?.meta?.['next']).toMatchObject({ output: 'export' });
    expect(byId.get('layout:/')?.cache?.badge).toBe('static export');
    expect(byId.get('route:/items/[id]')?.cache?.badge).toBe('static');
  });

  it('route.ts → handler with meta.apiRoutes from exported methods', () => {
    const h = byId.get('handler:/api/health')!;
    expect(h).toMatchObject({ kind: 'handler', file: 'src/app/api/health/route.ts' });
    expect(h.meta?.['apiRoutes']).toEqual([
      { method: 'GET', path: '/api/health' },
      { method: 'POST', path: '/api/health' },
    ]);
    expect(h.cache).toBeUndefined();
  });

  it('guesses the S3 origin of CloudFront as the host (warn)', () => {
    expect(
      g.edges
        .filter((e) => e.kind === 'deploy')
        .map((e) => `${e.from}>${e.to}`)
        .sort(),
    ).toEqual(['infra:site>layout:/', 'infra:site>route:/', 'infra:site>route:/items/[id]']);
    expect(warnings.some((w) => w.startsWith('推定: infra:site'))).toBe(true);
  });

  it('config.deploy app: next on any node type wins over the guess', async () => {
    const g2 = await extractor.extract(
      ctxAt('export-app', { deploy: { 'infra:logs': { app: 'next' } } }),
      up,
    );
    expect(new Set(g2.edges.map((e) => e.from))).toEqual(new Set(['infra:logs']));
  });

  it('next.repo scopes the extractor', async () => {
    expect(await extractor.detect(ctxAt('export-app', { next: { repo: 'other' } }))).toBe(false);
    expect(await extractor.detect(ctxAt('export-app', { next: { repo: 'export-app' } }))).toBe(
      true,
    );
  });
});

describe('Pages Router', async () => {
  const g = await extractor.extract(ctxAt('pages-app'), { nodes: [], edges: [] });
  const byId = new Map(g.nodes.map((n) => [n.id, n]));
  it('route / layout / handler ids', async () => {
    expect(await extractor.detect(ctxAt('pages-app'))).toBe(true);
    expect([...byId.keys()].sort()).toEqual([
      'handler:/api/users/[id]',
      'layout:/',
      'route:/',
      'route:/races',
      'route:/races/[id]',
    ]);
    expect(byId.get('layout:/')?.file).toBe('pages/_app.tsx');
    expect(byId.get('route:/races/[id]')).toMatchObject({
      kind: 'page',
      file: 'pages/races/[id].tsx',
    });
    expect(byId.get('handler:/api/users/[id]')?.meta?.['apiRoutes']).toEqual([
      { method: 'ANY', path: '/api/users/{id}' },
    ]);
    expect(byId.get('route:/')?.cache).toBeUndefined();
  });
});
