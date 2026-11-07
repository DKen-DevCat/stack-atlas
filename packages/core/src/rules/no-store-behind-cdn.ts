/**
 * force-dynamic なのに CDN 側でキャッシュされうるルートの警告。
 *
 * 判定: route ノード R が `meta.next.dynamic === 'force-dynamic'` で、
 *   インフラノード I から `deploy` エッジ（I → R）があり、I に `flow` エッジで入ってくる CDN ノード C の
 *   `cache.rules` から R のパスに当たる rule（{@link pickRule}：最長一致 → 既定 behavior）を選び、
 *   その値がキャッシュ無効（CachingDisabled / no-store / キャッシュなし / 素通し / TTL 0）でない
 * → R の `cache.tone = 'warn'`、note に「force-dynamic だが CDN 側 (<pattern>) はキャッシュ有効。Cache-Control を確認」。
 *   R に cache が無ければ `{ tone: 'warn', badge: 'force-dynamic' }` を作る。
 *
 * パスの照合は two-tier-staleness と同じ（routePath → concretePath → pickRule）。
 */
import type { Cache } from '@stack-atlas/schema';
import { getNextMeta } from '../meta.js';
import { cdnSeconds, concretePath, pickRule, routePath } from './two-tier-staleness.js';
import type { Rule } from './types.js';
import { appendNote, incoming } from './util.js';

const DISABLED =
  /(CachingDisabled|no-store|no-cache|\bprivate\b|キャッシュなし|キャッシュしない|キャッシュ無効|素通し)/i;

/** CDN の rule の値がキャッシュ無効を表すか（名前か、TTL / s-maxage が 0） */
export function isCachingDisabled(value: string): boolean {
  return DISABLED.test(value) || cdnSeconds(value) === 0;
}

export const noStoreBehindCdn: Rule = {
  id: 'no-store-behind-cdn',
  description:
    'force-dynamic のルートが、キャッシュ有効な CloudFront behavior の後ろにある構成を警告する',
  apply(graph) {
    for (const route of graph.nodes) {
      if (getNextMeta(route)?.dynamic !== 'force-dynamic') continue;
      const path = routePath(route);
      if (path === undefined) continue;
      const concrete = concretePath(path);
      const patterns = new Set<string>();
      for (const host of incoming(graph, route.id, 'deploy')) {
        if (host.kind !== 'infra') continue;
        for (const cdn of incoming(graph, host.id, 'flow')) {
          const rule = cdn.cache?.rules ? pickRule(cdn.cache.rules, concrete) : undefined;
          if (rule && !isCachingDisabled(rule.value)) patterns.add(rule.key);
        }
      }
      for (const pattern of patterns) {
        const cache: Cache = (route.cache ??= { tone: 'warn', badge: 'force-dynamic' });
        cache.tone = 'warn';
        appendNote(
          cache,
          `force-dynamic だが CDN 側 (${pattern}) はキャッシュ有効。Cache-Control を確認`,
        );
      }
    }
  },
};
