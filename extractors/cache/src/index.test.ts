import {
  LAMBDA_FS_ISR_NOTE,
  type PartialGraph,
  type RepoContext,
  type StackAtlasConfig,
} from '@stack-atlas/core';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import {
  extractor,
  findFetchCalls,
  findFetchHookCalls,
  formatMs,
  hookCache,
  nextAppDirCandidates,
  parseNextConfig,
  routeFetchCache,
} from './index.js';

const fixture = resolve(dirname(fileURLToPath(import.meta.url)), '../../../examples/fixture-repo');
const log = { debug() {}, info() {}, warn() {}, error() {} };

function ctxAt(root: string, config?: StackAtlasConfig): RepoContext {
  return {
    root,
    config:
      config ??
      (parse(readFileSync(resolve(root, 'stack-atlas.config.yaml'), 'utf8')) as StackAtlasConfig),
    log,
    resolve: (...s) => resolve(root, ...s),
  };
}

function tmpRepo(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'stack-atlas-cache-'));
  for (const [p, content] of Object.entries(files)) {
    const abs = join(root, p);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  return root;
}

/** cdktf / nextjs-app / ts-imports / api-link の結果のうち cache 抽出器が見る部分 */
const upstream: PartialGraph = {
  nodes: [
    {
      id: 'infra:next',
      kind: 'infra',
      meta: {
        cdktf: { type: 'aws_lambda_function', logicalId: 'next', path: 'web/next', stack: 'web' },
        deployApp: 'next',
      },
    },
    {
      id: 'infra:cdn',
      kind: 'infra',
      cache: { tone: 'ok', badge: 'CDN 5 behaviors', rules: [{ key: '/', value: 'TTL 60' }] },
    },
    { id: 'infra:api', kind: 'infra' },
    {
      id: 'hook:useRaces',
      kind: 'hook',
      file: 'apps/web/hooks/useRaces.ts',
      meta: { ts: { exportName: 'useRaces', symbolKind: 'function' } },
    },
    {
      id: 'hook:useSession',
      kind: 'hook',
      file: 'apps/web/hooks/useSession.ts',
      meta: { ts: { exportName: 'useSession', symbolKind: 'function' } },
    },
    {
      id: 'route:/races/[id]',
      kind: 'page',
      file: 'apps/web/app/races/[id]/page.tsx',
      cache: { tone: 'warn', badge: 'ISR 60s' },
    },
    { id: 'route:/admin/entry', kind: 'page', file: 'apps/web/app/admin/entry/page.tsx' },
    {
      id: 'lib:apiClient',
      kind: 'lib',
      file: 'apps/web/lib/apiClient.ts',
      cache: { tone: 'info', badge: 'fetch cache' },
    },
  ],
  edges: [],
};

describe('cache 抽出器（フィクスチャ）', () => {
  it('hook:useRaces に SWR のオプションから cache を付ける', async () => {
    const g = await extractor.extract(ctxAt(fixture), upstream);
    const races = g.nodes.find((n) => n.id === 'hook:useRaces');
    expect(races).toEqual({
      id: 'hook:useRaces',
      cache: {
        tone: 'ok',
        badge: 'SWR 2s',
        rules: [
          { key: 'dedupingInterval', value: '2秒' },
          { key: 'revalidateOnFocus', value: 'true' },
          { key: 'refreshInterval', value: 'なし' },
        ],
      },
    });
  });

  it('データ取得ライブラリを呼ばない hook（useSession は Cookie を読むだけ）には付けない', async () => {
    const g = await extractor.extract(ctxAt(fixture), upstream);
    expect(g.nodes.find((n) => n.id === 'hook:useSession')).toBeUndefined();
  });

  it('Next を載せた Lambda に ISR /tmp（warn）を付ける（next.config に cacheHandler が無い）', async () => {
    const g = await extractor.extract(ctxAt(fixture), upstream);
    const next = g.nodes.find((n) => n.id === 'infra:next');
    expect(next?.cache).toMatchObject({
      tone: 'warn',
      badge: 'ISR /tmp',
      note: LAMBDA_FS_ISR_NOTE,
    });
    expect(next?.cache?.rules).toEqual(
      expect.arrayContaining([
        { key: 'cacheHandler', value: 'なし（ファイルシステム）' },
        { key: 'isrMemoryCacheSize', value: '既定（50MB）' },
        { key: 'output', value: 'standalone' },
        { key: '設定', value: 'apps/web/next.config.mjs' },
      ]),
    );
  });

  it('cache が既にあるノードは出さない・出すのは {id, cache} だけ', async () => {
    const g = await extractor.extract(ctxAt(fixture), upstream);
    const ids = g.nodes.map((n) => n.id).sort();
    // admin/entry の fetch はオプションに cache / next が無いので対象外
    expect(ids).toEqual(['hook:useRaces', 'infra:next']);
    for (const n of g.nodes) expect(Object.keys(n).sort()).toEqual(['cache', 'id']);
    expect(g.edges).toEqual([]);
  });

  it('detect: フィクスチャは true、空のリポジトリは false。upstream が空なら何も出さない', async () => {
    expect(await extractor.detect(ctxAt(fixture))).toBe(true);
    const empty = tmpRepo({});
    expect(await extractor.detect(ctxAt(empty, {}))).toBe(false);
    expect(await extractor.extract(ctxAt(fixture), { nodes: [], edges: [] })).toEqual({
      nodes: [],
      edges: [],
    });
  });

  it('next.config の場所は config.next.appDir と route の file から推定する', () => {
    const dirs = nextAppDirCandidates(ctxAt(fixture), upstream);
    expect(dirs[0]).toBe('apps/web');
    expect(dirs).toContain('.');
    const src = nextAppDirCandidates(ctxAt(fixture, { next: { appDir: 'web/src/app' } }), {
      nodes: [{ id: 'route:/', file: 'app/page.tsx' }],
      edges: [],
    });
    expect(src).toEqual(['web/src', 'web', '.']);
  });

  it('hostId を渡すと、その Lambda に deploy された route の app/ だけを候補にする（Next アプリが複数のモノレポ）', () => {
    const up: PartialGraph = {
      nodes: [
        { id: 'infra:web', meta: { deployApp: 'next' } },
        { id: 'infra:admin', meta: { deployApp: 'next' } },
        { id: 'route:/', file: 'apps/web/app/page.tsx' },
        { id: 'route:/admin', file: 'apps/admin/app/page.tsx' },
      ],
      edges: [
        { from: 'infra:web', to: 'route:/', kind: 'deploy' },
        { from: 'infra:admin', to: 'route:/admin', kind: 'deploy' },
      ],
    };
    // config.next.appDir（フィクスチャは apps/web/app）は Lambda に関係なく先頭に入るので、ここでは外す
    const ctx = ctxAt(fixture, {});
    expect(nextAppDirCandidates(ctx, up, 'infra:web')).toEqual(['apps/web', '.']);
    expect(nextAppDirCandidates(ctx, up, 'infra:admin')).toEqual(['apps/admin', '.']);
    // deploy エッジが無い Lambda は全部の route を見る（従来どおり）
    expect(nextAppDirCandidates(ctx, up, 'infra:other')).toEqual(['apps/web', 'apps/admin', '.']);
  });
});

describe('next.config', () => {
  it('cacheHandler（require.resolve）と cacheMaxMemorySize を読む → ISR custom handler（ok）', async () => {
    const root = tmpRepo({
      'web/next.config.js': `module.exports = {
        // cacheHandler: 'commented-out'
        cacheHandler: require.resolve('./cache-handler.mjs'),
        cacheMaxMemorySize: 0,
      };`,
    });
    const g = await extractor.extract(ctxAt(root, { next: { appDir: 'web/app' } }), {
      nodes: [{ id: 'infra:fn', meta: { deployApp: 'next' } }],
      edges: [],
    });
    expect(g.nodes[0]?.cache).toEqual({
      tone: 'ok',
      badge: 'ISR custom handler',
      rules: [
        { key: 'cacheHandler', value: './cache-handler.mjs' },
        { key: 'cacheMaxMemorySize', value: '0（メモリキャッシュ無効）' },
        { key: '設定', value: 'web/next.config.js' },
      ],
    });
  });

  it('experimental.incrementalCacheHandlerPath と isrMemoryCacheSize（旧名）も読む', () => {
    const cfg = parseNextConfig(
      'next.config.mjs',
      `export default { experimental: { incrementalCacheHandlerPath: "./h.js", isrMemoryCacheSize: 50 * 1024 * 1024 } }`,
    );
    expect(cfg).toEqual({
      cacheHandler: './h.js',
      cacheHandlerKey: 'incrementalCacheHandlerPath',
      memorySize: { key: 'isrMemoryCacheSize', value: '50MB' },
    });
    // コメントだけ・undefined は未設定
    expect(
      parseNextConfig('a.js', '// cacheHandler: x\nexport default { cacheHandler: undefined }'),
    ).toEqual({});
  });

  it('next.config が見つからなければ出さない（core の lambdaFsIsr に任せる）', async () => {
    const root = tmpRepo({});
    const g = await extractor.extract(ctxAt(root, {}), {
      nodes: [{ id: 'infra:fn', meta: { deployApp: 'next' } }],
      edges: [],
    });
    expect(g.nodes).toEqual([]);
  });
});

describe('hooks', () => {
  it('React Query（v5 のオブジェクト引数）', () => {
    const calls = findFetchHookCalls(
      'h.ts',
      `import { useQuery as q } from '@tanstack/react-query';
       export function useA() { return q({ queryKey: ['a'], queryFn, staleTime: 5 * 60 * 1000, gcTime: 600000, refetchOnWindowFocus: false }); }
       export function useB() { return q({ queryKey: ['b'], queryFn }); }`,
      'useA',
    );
    expect(calls).toHaveLength(1);
    expect(hookCache(calls)).toEqual({
      tone: 'ok',
      badge: 'React Query stale 5m',
      rules: [
        { key: 'staleTime', value: '5分' },
        { key: 'gcTime', value: '10分' },
        { key: 'refetchOnWindowFocus', value: 'false' },
        { key: 'refetchInterval', value: 'なし' },
      ],
    });
    const b = hookCache(
      findFetchHookCalls(
        'h.ts',
        `import { useQuery } from '@tanstack/react-query'; export const useB = () => useQuery({ queryKey: ['b'], queryFn });`,
        'useB',
      ),
    );
    expect(b?.badge).toBe('React Query');
    expect(b?.note).toMatch(/staleTime 未指定/);
  });

  it('useSWRInfinite（default import）・refreshInterval・オプション無し', () => {
    const c = hookCache(
      findFetchHookCalls(
        'h.ts',
        `import useSWRInfinite from 'swr/infinite';
         export function useList() { return useSWRInfinite(getKey, fetcher, { refreshInterval: 30000, revalidateIfStale: false }); }`,
      ),
    );
    expect(c).toEqual({
      tone: 'ok',
      badge: 'SWR infinite',
      rules: [
        { key: 'revalidateIfStale', value: 'false' },
        { key: 'refreshInterval', value: '30秒' },
      ],
    });
    const plain = hookCache(
      findFetchHookCalls(
        'h.ts',
        `import useSWR from 'swr'; export const useX = () => useSWR('/x', f);`,
      ),
    );
    expect(plain).toEqual({
      tone: 'ok',
      badge: 'SWR',
      rules: [{ key: 'refreshInterval', value: 'なし' }],
    });
    expect(hookCache(findFetchHookCalls('h.ts', 'export const useY = () => 1;'))).toBeUndefined();
  });

  it('formatMs', () => {
    expect(formatMs(2000)).toBe('2秒');
    expect(formatMs(500)).toBe('500ms');
    expect(formatMs(3_600_000)).toBe('1時間');
    expect(formatMs(Infinity)).toBe('無期限');
  });
});

describe('route の fetch', () => {
  it('cache が無い route に fetch の next.revalidate / tags / cache を付ける', async () => {
    const root = tmpRepo({
      'app/news/page.tsx': `export default async function Page() {
        const a = await fetch('https://cms/news', { next: { revalidate: 300, tags: ['news'] } });
        const b = await fetch(url);
        return null;
      }`,
      'app/me/page.tsx': `export default async function Page() { await fetch('/api/me', { cache: 'no-store' }); return null; }`,
    });
    const g = await extractor.extract(ctxAt(root, { next: { appDir: 'app' } }), {
      nodes: [
        { id: 'route:/news', file: 'app/news/page.tsx' },
        { id: 'route:/me', file: 'app/me/page.tsx' },
        { id: 'route:/old', file: 'app/news/page.tsx', cache: { tone: 'warn', badge: 'ISR 60s' } },
      ],
      edges: [],
    });
    expect(g.nodes).toEqual([
      {
        id: 'route:/news',
        cache: {
          tone: 'info',
          badge: 'fetch 300s',
          rules: [{ key: 'fetch https://cms/news', value: 'revalidate 300s / tags news' }],
        },
      },
      {
        id: 'route:/me',
        cache: expect.objectContaining({
          tone: 'off',
          badge: 'fetch no-store',
          rules: [{ key: 'fetch /api/me', value: 'cache: no-store' }],
        }),
      },
    ]);
  });

  it('revalidate: false・オプションの無い fetch は数えない', () => {
    const calls = findFetchCalls(
      'p.tsx',
      `fetch('/a', { next: { revalidate: false } }); fetch('/b', { method: 'POST' });`,
    );
    expect(calls).toHaveLength(1);
    expect(routeFetchCache(calls)?.rules).toEqual([
      { key: 'fetch /a', value: 'revalidate なし（無期限）' },
    ]);
  });
});
