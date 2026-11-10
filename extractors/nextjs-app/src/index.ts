/**
 * nextjs-app 抽出器: App Router の app/ と Pages Router の pages/ → route:* / layout:* ノード、
 * route.ts と pages/api → handler:* ノード（meta.apiRoutes）、
 * route segment config（revalidate / dynamic / generateStaticParams）と `output: 'export'` → meta.next と cache、
 * Next を載せているインフラノード（Lambda でも S3 でも）→ 全ルートへの deploy エッジ。
 * 方法は docs/04-extractors.md §2・§5、一般化は docs/12 §3.7。
 */
import { readFileSync } from 'node:fs';
import type { Cache, CacheRule, Edge } from '@stack-atlas/schema';
import type { Extractor, PartialGraph, PartialNode, RepoContext } from '@stack-atlas/core';
import { sectionFor } from '@stack-atlas/core';
import { findNextDirs, listNextFiles, nextUrlToApiPath, readNextConfig } from './files.js';

export { segmentToUrl, findAppDir, listRouteFiles, routeNodeId } from '@stack-atlas/core';
export {
  exportedMethods,
  findNextDirs,
  findPagesDir,
  listNextFiles,
  listPagesFiles,
  nextUrlToApiPath,
  readNextOutput,
  readNextConfig,
  stripJsComments,
  MAX_NEXT_CONFIG_BYTES,
  NEXT_CONFIG_FILES,
  type NextConfigInfo,
  type NextDirs,
  type NextFile,
} from './files.js';

export const NAME = 'nextjs-app';

export interface SegmentConfig {
  revalidate?: number | false;
  dynamic?: string;
  generateStaticParams?: boolean;
}

/** route segment config を正規表現で読む（値がリテラルのときだけ） */
export function parseSegmentConfig(src: string): SegmentConfig {
  const out: SegmentConfig = {};
  const rv = /export\s+const\s+revalidate\s*(?::[^=]+)?=\s*(\d+|false)\b/.exec(src);
  if (rv) out.revalidate = rv[1] === 'false' ? false : Number(rv[1]);
  const dy = /export\s+const\s+dynamic\s*(?::[^=]+)?=\s*["'`]([^"'`]+)["'`]/.exec(src);
  if (dy) out.dynamic = dy[1];
  if (
    /export\s+(async\s+)?function\s+generateStaticParams\b/.test(src) ||
    /export\s+(const|let)\s+generateStaticParams\b/.test(src)
  )
    out.generateStaticParams = true;
  return out;
}

export function segmentCache(sc: SegmentConfig, onLambda: boolean): Cache | undefined {
  let cache: Cache | undefined;
  if (sc.dynamic === 'force-dynamic' || sc.revalidate === 0) {
    cache = {
      tone: 'off',
      badge: 'dynamic',
      rules: [
        sc.dynamic === 'force-dynamic'
          ? { key: 'dynamic', value: 'force-dynamic（毎回 SSR）' }
          : { key: 'revalidate', value: '0（毎回 SSR）' },
      ],
    };
  } else if (typeof sc.revalidate === 'number') {
    cache = {
      tone: onLambda ? 'warn' : 'ok',
      badge: `ISR ${sc.revalidate}s`,
      rules: [{ key: 'revalidate', value: `${sc.revalidate}秒` }],
    };
  } else if (sc.revalidate === false || sc.dynamic === 'force-static' || sc.dynamic === 'error') {
    const rules: CacheRule[] = [];
    if (sc.revalidate === false) rules.push({ key: 'revalidate', value: 'false（再生成しない）' });
    if (sc.dynamic) rules.push({ key: 'dynamic', value: sc.dynamic });
    cache = { tone: 'ok', badge: 'static', rules };
  }
  if (sc.generateStaticParams) {
    const rule = { key: 'generateStaticParams', value: 'あり（ビルド時に生成）' };
    if (cache) (cache.rules ??= []).push(rule);
    else cache = { tone: 'ok', badge: 'SSG', rules: [rule] };
  }
  return cache;
}

/** `export default function X(` までの行、なければ先頭 25 行 */
function codeExcerpt(src: string): string {
  const lines = src.split('\n');
  return lines.slice(0, 25).join('\n');
}

/** infra ノードの Terraform 型（cdktf / terraform / cloudformation のどれでも） */
function infraType(n: PartialNode): string | undefined {
  for (const key of ['infra', 'cdktf']) {
    const v = n.meta?.[key] as { type?: unknown } | undefined;
    if (v && typeof v.type === 'string') return v.type;
  }
  return undefined;
}

export const STATIC_EXPORT_CACHE: Cache = {
  tone: 'ok',
  badge: 'static export',
  rules: [{ key: 'output', value: 'export（ビルド時に静的生成）' }],
};

/** Next を載せているインフラノード（meta.deployApp、config.deploy の app: next、無ければ static export の S3 を推定） */
function nextHosts(
  ctx: RepoContext,
  upstream: Readonly<PartialGraph>,
  output: string | undefined,
): string[] {
  const upstreamIds = new Set(upstream.nodes.map((n) => n.id));
  const hosts = new Set(
    upstream.nodes.filter((n) => n.meta?.['deployApp'] === 'next').map((n) => n.id),
  );
  for (const [id, d] of Object.entries(ctx.config.deploy ?? {})) {
    if (d.app !== 'next') continue;
    if (upstreamIds.has(id)) hosts.add(id);
    else ctx.log.warn(`nextjs-app: config.deploy の ${id} がインフラ側に見つかりません`);
  }
  if (hosts.size === 0 && output === 'export') {
    // CloudFront の origin になっている S3 が 1 つだけならそれ
    const byId = new Map(upstream.nodes.map((n) => [n.id, n]));
    const buckets = new Set<string>();
    for (const e of upstream.edges) {
      const from = byId.get(e.from);
      const to = byId.get(e.to);
      if (
        from &&
        to &&
        infraType(from) === 'aws_cloudfront_distribution' &&
        infraType(to) === 'aws_s3_bucket'
      )
        buckets.add(to.id);
    }
    if (buckets.size === 1) {
      const id = [...buckets][0]!;
      hosts.add(id);
      ctx.log.warn(`推定: ${id} → Next（output: export。deploy で明示できます）`);
    } else if (buckets.size > 1)
      ctx.log.info(
        `nextjs-app: CloudFront の origin の S3 が ${buckets.size} 個あるので deploy で指定してください`,
      );
  }
  return [...hosts];
}

export const extractor: Extractor = {
  name: NAME,
  async detect(ctx) {
    if (ctx.config.next?.repo && !sectionFor(ctx, ctx.config.next)) return false;
    const dirs = findNextDirs(ctx.root, sectionFor(ctx, ctx.config.next) ?? {});
    return dirs.appDir !== undefined || dirs.pagesDir !== undefined;
  },
  async extract(ctx, upstream): Promise<PartialGraph> {
    const cfg = sectionFor(ctx, ctx.config.next) ?? {};
    const dirs = findNextDirs(ctx.root, cfg);
    if (!dirs.appDir && !dirs.pagesDir) {
      ctx.log.warn('nextjs-app: app / pages ディレクトリが見つかりません');
      return { nodes: [], edges: [] };
    }
    const { files, skipped } = listNextFiles(ctx.root, dirs);
    if (skipped.length > 0)
      ctx.log.info(`nextjs-app: 対象外のルート ${skipped.length} 件（${skipped.join(' / ')}）`);
    const nextConfig = readNextConfig(ctx.root, dirs, (m) => ctx.log.warn(`nextjs-app: ${m}`));
    const output = nextConfig?.output;

    const hosts = nextHosts(ctx, upstream, output);
    const hostNodes = upstream.nodes.filter((n) => hosts.includes(n.id));
    const onLambda = hostNodes.some((n) => infraType(n) === 'aws_lambda_function');

    const nodes: PartialNode[] = [];
    const edges: Edge[] = [];
    for (const f of files) {
      const src = readFileSync(f.abs, 'utf8');
      const node: PartialNode = {
        id: f.id,
        kind: f.kind,
        name: f.url,
        file: f.rel,
        line: 1,
        code: codeExcerpt(src),
        meta: { extractors: [NAME] },
      };
      if (f.kind === 'handler') {
        const routes = (f.methods ?? ['ANY']).map((method) => ({
          method,
          path: nextUrlToApiPath(f.url),
        }));
        node.meta = {
          ...node.meta,
          apiRoutes: routes,
          api: routes[0],
          next: { segment: f.segment, router: f.router },
        };
        nodes.push(node);
        continue;
      }
      const sc = parseSegmentConfig(src);
      const next: Record<string, unknown> = { segment: f.segment };
      if (f.router === 'pages') next['router'] = 'pages';
      if (sc.revalidate !== undefined) next['revalidate'] = sc.revalidate;
      if (sc.dynamic !== undefined) next['dynamic'] = sc.dynamic;
      if (sc.generateStaticParams) next['generateStaticParams'] = true;
      if (output === 'export') next['output'] = 'export';
      node.meta = { ...node.meta, next };
      const cache =
        segmentCache(sc, onLambda) ??
        (output === 'export' ? structuredClone(STATIC_EXPORT_CACHE) : undefined);
      if (cache) node.cache = cache;
      nodes.push(node);
      for (const h of hosts) edges.push({ from: h, to: f.id, kind: 'deploy' });
    }
    if (hosts.length === 0)
      ctx.log.info(
        'nextjs-app: Next を載せているインフラノードが無いので deploy エッジは張りません',
      );
    ctx.log.info(
      `nextjs-app: ${[dirs.appDir, dirs.pagesDir].filter(Boolean).join(' + ')} から ${nodes.length} ノード${output ? `（output: ${output}）` : ''}`,
    );
    // 読んだ next.config（output・trailingSlash を読む。docs/23 §3.1）
    return {
      nodes,
      edges,
      ...(nextConfig && !nextConfig.tooLarge ? { read: [nextConfig.file] } : {}),
    };
  },
};

export default extractor;
