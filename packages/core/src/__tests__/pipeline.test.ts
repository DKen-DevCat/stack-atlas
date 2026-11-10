import { validateGraph, validateGraphV2 } from '@stack-atlas/schema';
import { describe, expect, it } from 'vitest';
import { createMemoryLogger } from '../logger.js';
import { buildGraph } from '../pipeline.js';
import type { Extractor, PartialGraph } from '../types.js';
import { FIXTURE, tmpRepo } from './helpers.js';

const stub = (
  name: string,
  out: PartialGraph | ((up: Readonly<PartialGraph>) => PartialGraph),
  detect = true,
): Extractor => ({
  name,
  detect: async () => detect,
  extract: async (_ctx, up) => (typeof out === 'function' ? out(up) : out),
});

const NOW = new Date('2026-11-07T00:00:00Z');

describe('buildGraph（スタブ抽出器）', () => {
  it('順に走らせ、upstream を渡し、マージして検証する', async () => {
    const root = tmpRepo({
      'stack-atlas.config.yaml': 'project: { name: demo }\nextractors: { off: false }\n',
    });
    let seen: string[] = [];
    const log = createMemoryLogger();
    const res = await buildGraph({
      root,
      log,
      now: NOW,
      commit: false,
      extractors: [
        stub('a', { nodes: [{ id: 'infra:fn', kind: 'infra', file: 'infra/fn.ts' }], edges: [] }),
        stub('off', { nodes: [{ id: 'never:x' }], edges: [] }),
        stub('nope', { nodes: [{ id: 'never:y' }], edges: [] }, false),
        stub('b', (up) => {
          seen = up.nodes.map((n) => n.id);
          return {
            nodes: [
              { id: 'comp:Card', file: 'apps/web/Card.tsx' },
              { id: 'infra:fn', name: 'Function' },
            ],
            edges: [{ from: 'infra:fn', to: 'comp:Card', kind: 'deploy' }],
          };
        }),
      ],
    });
    expect(seen).toEqual(['infra:fn']);
    expect(res.issues).toEqual([]);
    expect(res.reports.map((r) => r.status)).toEqual(['ok', 'disabled', 'not-detected', 'ok']);
    expect(Object.keys(res.partials)).toEqual(['a', 'b']);
    expect(res.graph.project).toEqual({
      name: 'demo',
      generatedAt: '2026-11-07T00:00:00.000Z',
      sources: ['infra', 'apps'],
    });
    expect(res.graph.nodes).toEqual([
      {
        id: 'infra:fn',
        layer: 'infra',
        kind: 'infra',
        name: 'Function',
        file: 'infra/fn.ts',
        meta: { extractors: ['a', 'b'] },
      },
      {
        id: 'comp:Card',
        layer: 'components',
        kind: 'component',
        name: 'Card',
        file: 'apps/web/Card.tsx',
        meta: { extractors: ['b'] },
      },
    ]);
    expect(validateGraph(res.graph).ok).toBe(true);
  });

  it('抽出器の例外はエラーとして集め、続きは走らせる', async () => {
    const res = await buildGraph({
      root: tmpRepo(),
      commit: false,
      extractors: [
        {
          name: 'bad',
          detect: async () => true,
          extract: async () => {
            throw new Error('boom');
          },
        },
        stub('ok', { nodes: [{ id: 'lib:x' }], edges: [] }),
      ],
    });
    expect(res.issues).toHaveLength(1);
    expect(res.issues[0]!.message).toContain('boom');
    expect(res.graph.nodes.map((n) => n.id)).toEqual(['lib:x']);
  });

  it('抽出器の報告（PartialGraph.issues。8-3b）は issues に入る。error は warning にする（抽出器はビルドを止めない）', async () => {
    const res = await buildGraph({
      root: tmpRepo(),
      commit: false,
      extractors: [
        stub('s', {
          nodes: [{ id: 'lib:x' }],
          edges: [],
          issues: [
            { level: 'info', path: 'screens:/', message: 'カバー率' },
            { level: 'error' as 'warning', path: 'screens:/a', message: '止めない' },
          ],
        }),
      ],
    });
    expect(res.issues).toEqual([
      { level: 'info', path: 'screens:/', message: 'カバー率' },
      { level: 'warning', path: 'screens:/a', message: '止めない' },
    ]);
  });

  it('検証エラー（存在しないノードへのエッジ）は issues に入る', async () => {
    const res = await buildGraph({
      root: tmpRepo(),
      commit: false,
      extractors: [
        stub('a', {
          nodes: [{ id: 'lib:x' }],
          edges: [{ from: 'lib:x', to: 'lib:ghost', kind: 'uses' }],
        }),
      ],
    });
    expect(res.issues.some((i) => i.level === 'error' && i.message.includes('lib:ghost'))).toBe(
      true,
    );
  });
});

/** フィクスチャの overrides / flows が参照するノードを出すスタブ（本物の抽出器の代わり） */
const fixtureStub = stub('stub', {
  nodes: [
    ...['cdn', 'authEdge', 'admins', 'static', 'httpApi', 'racesTable'].map((id) => ({
      id: `infra:${id}`,
      kind: 'infra',
      file: 'infra/stacks/x.ts',
    })),
    {
      id: 'infra:cdn',
      cache: {
        tone: 'ok' as const,
        badge: 'CDN',
        rules: [{ key: '/races/*', value: 'オリジンの s-maxage=60 に従う' }],
      },
    },
    {
      id: 'infra:next',
      kind: 'infra',
      meta: {
        cdktf: { type: 'aws_lambda_function', logicalId: 'next', path: 'web/next', stack: 'web' },
      },
    },
    {
      id: 'infra:api',
      kind: 'infra',
      meta: {
        cdktf: { type: 'aws_lambda_function', logicalId: 'api', path: 'web/api', stack: 'web' },
      },
    },
    { id: 'layout:/', kind: 'layout', file: 'apps/web/app/layout.tsx' },
    {
      id: 'route:/',
      kind: 'page',
      file: 'apps/web/app/page.tsx',
      meta: { next: { revalidate: 30, segment: '/' } },
    },
    {
      id: 'route:/races/[id]',
      kind: 'page',
      file: 'apps/web/app/races/[id]/page.tsx',
      meta: { next: { revalidate: 60, segment: '/races/[id]' } },
    },
    {
      id: 'route:/admin/entry',
      kind: 'page',
      meta: { next: { dynamic: 'force-dynamic', segment: '/admin/entry' } },
    },
    { id: 'route:/login', kind: 'page' },
    { id: 'comp:ResultTable', kind: 'component', file: 'apps/web/components/ResultTable.tsx' },
    { id: 'comp:EntryForm', kind: 'component' },
    { id: 'lib:apiClient', kind: 'lib' },
    { id: 'type:RaceResult', kind: 'type', file: 'packages/types/src/result.ts' },
    { id: 'handler:getRaces', kind: 'handler', file: 'apps/api/src/handlers/getRaces.ts' },
    { id: 'handler:postResult', kind: 'handler', file: 'apps/api/src/handlers/postResult.ts' },
  ],
  edges: [
    { from: 'infra:cdn', to: 'infra:next', kind: 'flow' },
    { from: 'infra:cdn', to: 'infra:authEdge', kind: 'flow' },
  ],
});

describe('buildGraph（examples/fixture-repo の config / overrides / flows）', () => {
  it('検証エラー 0 で graph を組み立てる', async () => {
    const log = createMemoryLogger();
    const res = await buildGraph({ root: FIXTURE, extractors: [fixtureStub], log, now: NOW });
    expect(res.issues.filter((i) => i.level === 'error')).toEqual([]);
    expect(validateGraph(res.graph).errors.filter((e) => e.level === 'error')).toEqual([]);
    const g = res.graph;
    expect(g.project?.name).toBe('race-results');
    expect(g.project?.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(g.layers.map((l) => l.source)).toEqual([
      'infra/ · CDKtf',
      'apps/web/app · Next.js',
      'apps/web/components',
      'packages/types · apps/api',
    ]);
    expect(g.flows?.map((f) => f.id)).toEqual(['miss', 'hit', 'entry']);
    expect(g.nodes.find((n) => n.id === 'actor:user')).toMatchObject({
      layer: 'infra',
      name: 'Browser',
    });

    const has = (from: string, to: string, kind: string) =>
      g.edges.some((e) => e.from === from && e.to === to && e.kind === kind);
    expect(has('actor:user', 'infra:cdn', 'flow')).toBe(true);
    // config.deploy: infra:next → 全ルート・レイアウト、infra:api → handlers glob
    expect(has('infra:next', 'route:/races/[id]', 'deploy')).toBe(true);
    expect(has('infra:next', 'layout:/', 'deploy')).toBe(true);
    expect(has('infra:api', 'handler:getRaces', 'deploy')).toBe(true);

    // ルール
    const next = g.nodes.find((n) => n.id === 'infra:next')!;
    expect(next.meta?.deployApp).toBe('next');
    expect(next.cache?.badge).toBe('ISR /tmp');
    const rid = g.nodes.find((n) => n.id === 'route:/races/[id]')!;
    expect(rid.cache?.note).toBe('ISR(60s) と CDN(60s) が二段になるため最大 120 秒古くなる');
    expect(g.project?.sources).toEqual(['infra', 'apps', 'packages']);
  });

  it('v2（graphV2）も返す: v1 を upgradeGraph で変換し、v2 の検証エラーは issues、警告は v2Warnings', async () => {
    const res = await buildGraph({ root: FIXTURE, extractors: [fixtureStub], now: NOW });
    const v2 = res.graphV2!;
    expect(v2.version).toBe(2);
    // 8-1 のレビューで変更: v2 の project には変換の印 generator.v2 = "upgrade" が付く（ほかは v1 と同じ）
    expect(v2.project).toEqual({ ...res.graph.project, generator: { v2: 'upgrade' } });
    expect(validateGraphV2(v2).errors).toEqual([]);
    expect(res.issues.filter((i) => i.path.startsWith('v2:'))).toEqual([]);
    // 箱の単位なので、口の単位の線の警告が出る（項目まで下げるのは 8-2 の言語アダプタ）
    expect(res.v2Warnings.length).toBeGreaterThan(0);
    // 箱 id は v1 のまま。type: は types[] へ
    const v1Boxes = res.graph.nodes.filter((n) => n.kind !== 'type').map((n) => n.id);
    expect(v2.nodes.map((n) => n.id)).toEqual(v1Boxes);
    expect(v2.views?.map((v) => v.id)).toEqual(['miss', 'hit', 'entry']);
    expect(v2.nodes.find((n) => n.id === 'infra:cdn')).toMatchObject({ kind: 'cache' });
    expect(v2.nodes.find((n) => n.id === 'route:/races/[id]')).toMatchObject({
      kind: 'screen',
      host: 'infra:next',
    });
  });

  /** v1 では正しいが、v2 では型 ID の形が違う（kind type で接頭辞が type: でない）ので v2 の検証エラーになる */
  const v2Bad = stub('bad', { nodes: [{ id: 'comp:T', kind: 'type', name: 'T' }], edges: [] });

  it('v2 の検証エラーは issues にだけ入れ、log には出さない（build の要約で 1 回だけ出る）', async () => {
    // 以前は log.error にも出していたので、build の要約と合わせて 2 回出ていた
    const log = createMemoryLogger();
    const res = await buildGraph({ root: tmpRepo({}), extractors: [v2Bad], log, commit: false });
    const v2errors = res.issues.filter((i) => i.path.startsWith('v2:') && i.level === 'error');
    expect(v2errors).toHaveLength(1);
    expect(v2errors[0]!.path).toBe('v2:/types/0/id');
    expect(log.of('error')).toEqual([]);
  });

  it('v1Only（build --v1）は v2 への変換と検証をしない: v2 のエラーで失敗しない', async () => {
    const res = await buildGraph({
      root: tmpRepo({}),
      extractors: [v2Bad],
      commit: false,
      v1Only: true,
    });
    expect(res.graphV2).toBeUndefined();
    expect(res.v2Warnings).toEqual([]);
    expect(res.issues).toEqual([]);
    expect(res.graph.nodes.map((n) => n.id)).toEqual(['comp:T']);
  });

  it('flows.yaml が未知ノードを参照するとエラー', async () => {
    const res = await buildGraph({
      root: FIXTURE,
      commit: false,
      extractors: [stub('tiny', { nodes: [{ id: 'infra:cdn' }], edges: [] })],
    });
    const errs = res.issues.filter((i) => i.level === 'error');
    expect(errs.some((e) => e.path.startsWith('stack-atlas.overrides.yaml#'))).toBe(true);
    expect(errs.some((e) => e.path.startsWith('flows.yaml#') && e.message.includes('"miss"'))).toBe(
      true,
    );
  });
});
