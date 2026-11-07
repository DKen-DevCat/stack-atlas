/**
 * キャッシュキーに Cookie が入っている CloudFront の警告。
 *
 * 判定: CDN ノード（`meta.cdktf.type === 'aws_cloudfront_distribution'`、または id / name に cloudfront・cdn を含む infra）で、
 *   - `cache.note` に cdktf 抽出器の文言「キャッシュキーに Cookie を含めている」がある、または
 *   - `cache.rules` のキーか値に Cookie が出てきて、否定（none / なし / 含めない / 含まない / 除外 / 転送しない）でない
 * → `cache.tone = 'warn'` にし、note に {@link COOKIE_CACHE_KEY_NOTE} を（無ければ）足す。
 *
 * cdktf 抽出器は cookie_behavior / forwarded_values.cookies が none 以外のとき tone warn と同じ note を付けるので、
 * そのときは何も変わらない（overrides や他の抽出器で書いた rules を拾うためのルール）。
 */
import type { GraphNode } from '@stack-atlas/schema';
import { getCdktfMeta } from '../meta.js';
import type { Rule } from './types.js';
import { appendNote } from './util.js';

export const COOKIE_CACHE_KEY_NOTE = 'キャッシュキーに Cookie を含めている（HIT 率に注意）';

const NEGATED = /(\bnone\b|なし|含めない|含まない|除外|転送しない|入れない|\bno\b|\bfalse\b)/i;

export function isCdnNode(n: GraphNode): boolean {
  const type = getCdktfMeta(n)?.type;
  if (type) return type === 'aws_cloudfront_distribution';
  return (
    n.kind === 'infra' && /cloudfront|\bcdn\b/i.test(`${n.id.replace(/^infra:/, '')} ${n.name}`)
  );
}

/** cache の rules / note から、キャッシュキーに Cookie を入れているか */
export function hasCookieInCacheKey(n: GraphNode): boolean {
  const c = n.cache;
  if (!c) return false;
  if (c.note?.includes('キャッシュキーに Cookie を含めている')) return true;
  return (c.rules ?? []).some((r) => {
    const text = `${r.key} ${r.value}`;
    return /cookie/i.test(text) && !NEGATED.test(text);
  });
}

export const cookieCacheKey: Rule = {
  id: 'cookie-cache-key',
  description: 'CloudFront のキャッシュキーに Cookie が入っている構成を警告する（HIT 率が下がる）',
  apply(graph) {
    for (const n of graph.nodes) {
      if (!n.cache || !isCdnNode(n) || !hasCookieInCacheKey(n)) continue;
      n.cache.tone = 'warn';
      appendNote(n.cache, COOKIE_CACHE_KEY_NOTE);
    }
  },
};
