/**
 * nextjs-app 抽出器: App Router の app/ ディレクトリ → route:* / layout:* ノード、
 * route segment config（revalidate / dynamic / generateStaticParams）→ meta.next と cache、
 * Next を載せている Lambda → 全ルートへの deploy エッジ。方法は docs/04-extractors.md §2・§5。
 */
import { readFileSync } from 'node:fs';
import type { Cache, CacheRule, Edge } from '@stack-atlas/schema';
import type { Extractor, PartialGraph, PartialNode } from '@stack-atlas/core';
import { findAppDir, listRouteFiles } from './routes.js';

export { segmentToUrl, findAppDir, listRouteFiles } from './routes.js';

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

export const extractor: Extractor = {
  name: NAME,
  async detect(ctx) {
    return findAppDir(ctx.root, ctx.config.next?.appDir) !== undefined;
  },
  async extract(ctx, upstream): Promise<PartialGraph> {
    const appDir = findAppDir(ctx.root, ctx.config.next?.appDir);
    if (!appDir) {
      ctx.log.warn('nextjs-app: app ディレクトリが見つかりません');
      return { nodes: [], edges: [] };
    }
    const { files, skipped } = listRouteFiles(ctx.root, appDir);
    if (skipped.length > 0)
      ctx.log.info(`nextjs-app: 対象外のルート ${skipped.length} 件（${skipped.join(' / ')}）`);

    // Next を載せているインフラノード
    const upstreamIds = new Set(upstream.nodes.map((n) => n.id));
    const hosts = new Set(
      upstream.nodes.filter((n) => n.meta?.['deployApp'] === 'next').map((n) => n.id),
    );
    for (const [id, d] of Object.entries(ctx.config.deploy ?? {})) {
      if (d.app !== 'next') continue;
      if (upstreamIds.has(id)) hosts.add(id);
      else ctx.log.warn(`nextjs-app: config.deploy の ${id} がインフラ側に見つかりません`);
    }
    const hostNodes = upstream.nodes.filter((n) => hosts.has(n.id));
    const onLambda = hostNodes.some(
      (n) => (n.meta?.['cdktf'] as { type?: string } | undefined)?.type === 'aws_lambda_function',
    );

    const nodes: PartialNode[] = [];
    const edges: Edge[] = [];
    for (const f of files) {
      const src = readFileSync(f.abs, 'utf8');
      const sc = parseSegmentConfig(src);
      const next: Record<string, unknown> = { segment: f.segment };
      if (sc.revalidate !== undefined) next['revalidate'] = sc.revalidate;
      if (sc.dynamic !== undefined) next['dynamic'] = sc.dynamic;
      if (sc.generateStaticParams) next['generateStaticParams'] = true;
      const node: PartialNode = {
        id: f.id,
        kind: f.kind,
        name: f.url,
        file: f.rel,
        line: 1,
        code: codeExcerpt(src),
        meta: { extractors: [NAME], next },
      };
      const cache = segmentCache(sc, onLambda);
      if (cache) node.cache = cache;
      nodes.push(node);
      for (const h of hosts) edges.push({ from: h, to: f.id, kind: 'deploy' });
    }
    if (hosts.size === 0)
      ctx.log.info(
        'nextjs-app: Next を載せているインフラノードが無いので deploy エッジは張りません',
      );
    ctx.log.info(`nextjs-app: ${appDir} から ${nodes.length} ノード`);
    return { nodes, edges };
  },
};

export default extractor;
