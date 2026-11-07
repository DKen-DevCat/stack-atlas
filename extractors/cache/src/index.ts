/**
 * cache 抽出器: 先行の抽出器（cdktf / nextjs-app / ts-imports / api-link）が作ったノードに `cache` を足す。
 * 方法は docs/04-extractors.md §5。
 *
 * - hook:   SWR（useSWR / useSWRInfinite / useSWRImmutable）・React Query（useQuery / useInfiniteQuery …）の
 *           オプション（dedupingInterval・revalidateOnFocus・refreshInterval・staleTime・gcTime など）
 * - infra:  `meta.deployApp === 'next'` の Lambda。next.config の cacheHandler / isrMemoryCacheSize を読み、
 *           無ければ「ISR /tmp」（warn）、あれば「ISR custom handler」（ok）
 * - route:  server component の `fetch(url, { cache, next: { revalidate, tags } })`
 *
 * すでに cache のあるノードには何もしない（出すのは `{ id, cache }` の部分ノードだけ）。
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import type { Cache } from '@stack-atlas/schema';
import {
  getDeployApp,
  getTsMeta,
  type Extractor,
  type PartialGraph,
  type PartialNode,
  type RepoContext,
} from '@stack-atlas/core';
import { findFetchCalls, routeFetchCache } from './fetch.js';
import { findFetchHookCalls, hookCache } from './hooks.js';
import { lambdaNextCache, NEXT_CONFIG_FILES, parseNextConfig } from './next-config.js';

export { findFetchHookCalls, hookCache, type FetchHookCall } from './hooks.js';
export {
  parseNextConfig,
  lambdaNextCache,
  NEXT_CONFIG_FILES,
  type NextCacheConfig,
} from './next-config.js';
export { findFetchCalls, routeFetchCache, type FetchCall } from './fetch.js';
export { formatMs, shortMs } from './ast.js';

export const NAME = 'cache';

const FETCH_LIBS = /"(swr|@tanstack\/react-query|react-query|next)"\s*:/;

function readText(abs: string): string | undefined {
  try {
    return readFileSync(abs, 'utf8');
  } catch {
    return undefined;
  }
}

/** next.config を探すディレクトリの候補（root からの相対、posix） */
export function nextAppDirCandidates(
  ctx: RepoContext,
  upstream: Readonly<PartialGraph>,
  /** この Lambda から deploy エッジでつながる route だけを見る（モノレポで Next アプリが複数あるとき） */
  hostId?: string,
): string[] {
  const dirs: string[] = [];
  const add = (d: string) => {
    const n = posix.normalize(d || '.').replace(/\/+$/, '') || '.';
    if (!dirs.includes(n)) dirs.push(n);
  };
  const fromAppDir = (appDir: string) => {
    const parent = posix.dirname(appDir);
    add(parent);
    if (posix.basename(parent) === 'src') add(posix.dirname(parent));
  };
  if (ctx.config.next?.appDir) fromAppDir(ctx.config.next.appDir.replace(/\\/g, '/'));
  const deployed =
    hostId === undefined
      ? undefined
      : new Set(
          upstream.edges.filter((e) => e.kind === 'deploy' && e.from === hostId).map((e) => e.to),
        );
  for (const n of upstream.nodes) {
    if (!n.file || !(n.id.startsWith('route:') || n.id.startsWith('layout:'))) continue;
    if (deployed && deployed.size > 0 && !deployed.has(n.id)) continue;
    const f = n.file.replace(/\\/g, '/');
    const m = /^(.*?)(?:^|\/)app\//.exec(f);
    if (m) fromAppDir(`${m[1] ? m[1] : '.'}/app`);
  }
  add('.');
  return dirs;
}

/** 候補ディレクトリから最初に見つかった next.config（root からの相対パス） */
export function findNextConfig(root: string, dirs: string[]): string | undefined {
  for (const d of dirs) {
    for (const f of NEXT_CONFIG_FILES) {
      const rel = d === '.' ? f : `${d}/${f}`;
      if (existsSync(join(root, rel))) return rel;
    }
  }
  return undefined;
}

export const extractor: Extractor = {
  name: NAME,
  /**
   * detect には upstream が渡らないので、Next / TS の設定があるか、ルートの package.json が
   * SWR・React Query・Next に依存しているかで判定する（upstream に hook: / infra: が無ければ extract は何も出さない）
   */
  async detect(ctx) {
    const c = ctx.config;
    if (c.next || c.ts || c.deploy) return true;
    if (NEXT_CONFIG_FILES.some((f) => existsSync(ctx.resolve(f)))) return true;
    const pkg = readText(ctx.resolve('package.json'));
    return pkg !== undefined && FETCH_LIBS.test(pkg);
  },

  async extract(ctx: RepoContext, upstream): Promise<PartialGraph> {
    const out: PartialNode[] = [];
    const emit = (id: string, cache: Cache | undefined) => {
      if (cache) out.push({ id, cache });
    };
    const fileText = (rel: string) => readText(ctx.resolve(rel));

    // next.config は Lambda ごとに探す（apps/web と apps/admin が別の Lambda に載っていれば別の設定）。
    // 候補ディレクトリが同じなら結果を使い回す
    const nextConfigByDirs = new Map<string, string | undefined>();
    const findNextConfigFor = (hostId: string) => {
      const dirs = nextAppDirCandidates(ctx, upstream, hostId);
      const key = dirs.join('\0');
      if (!nextConfigByDirs.has(key)) nextConfigByDirs.set(key, findNextConfig(ctx.root, dirs));
      return nextConfigByDirs.get(key);
    };

    for (const n of upstream.nodes) {
      if (n.cache) continue;
      try {
        if (n.id.startsWith('hook:') && n.file) {
          const text = fileText(n.file);
          if (text === undefined) continue;
          const calls = findFetchHookCalls(n.file, text, getTsMeta(n)?.exportName);
          emit(n.id, hookCache(calls));
        } else if (n.id.startsWith('infra:') && getDeployApp(n) === 'next') {
          const rel = findNextConfigFor(n.id);
          if (!rel) {
            ctx.log.debug(
              `cache: ${n.id} の next.config が見つかりません（core のルールに任せる）`,
            );
            continue;
          }
          const text = fileText(rel) ?? '';
          emit(n.id, lambdaNextCache(parseNextConfig(rel, text), rel));
        } else if ((n.id.startsWith('route:') || n.id.startsWith('layout:')) && n.file) {
          const text = fileText(n.file);
          if (text === undefined) continue;
          emit(n.id, routeFetchCache(findFetchCalls(n.file, text)));
        }
      } catch (e) {
        ctx.log.warn(`cache: ${n.id} を解析できません（スキップ）: ${(e as Error).message}`);
      }
    }
    ctx.log.info(`cache: ${out.length} nodes`);
    return { nodes: out, edges: [] };
  },
};

export default extractor;
