import { validateGraph } from '@stack-atlas/schema';
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
