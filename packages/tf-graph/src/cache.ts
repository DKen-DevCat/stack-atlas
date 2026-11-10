/**
 * CloudFront / API Gateway / Lambda@Edge / CloudFront Function の `cache`（docs/04 §5）。
 */
import type { Cache, CacheRule } from '@stack-atlas/schema';
import { collectRefs, isObject } from './refs.js';
import type { JsonObject, TfResource } from './types.js';
import { arr, num, one, str } from './util.js';

/** AWS 管理のキャッシュポリシー */
export const MANAGED_CACHE_POLICIES: Record<string, string> = {
  '4135ea2d-6df8-44a3-9df3-4b5a84be39ad': 'CachingDisabled（素通し）',
  '658327ea-f89d-4fab-a63d-7f88639e58f6': 'CachingOptimized（TTL 既定 1日 / 最大 1年）',
  'b2884449-e4de-46a7-ac36-70bc7f1ddd6d': 'CachingOptimizedForUncompressedObjects',
  '08627262-05a9-4f76-9ded-b50ca2e3a84f': 'Elemental-MediaPackage',
};
const CACHING_DISABLED = '4135ea2d-6df8-44a3-9df3-4b5a84be39ad';

function ttlSummary(policy: JsonObject): { value: string; cookies: boolean } {
  const min = num(policy['min_ttl']) ?? 0;
  const def = num(policy['default_ttl']);
  const max = num(policy['max_ttl']);
  const params = one(policy['parameters_in_cache_key_and_forwarded_to_origin']);
  let cookies = false;
  const cc = params ? one(params['cookies_config']) : undefined;
  if (cc) {
    const cb = str(cc['cookie_behavior']);
    cookies = cb !== undefined && cb !== 'none';
  }
  if (min === 0 && (def ?? 0) === 0) return { value: 'オリジンの Cache-Control に従う', cookies };
  const parts = [`default=${def ?? '?'}s`, `max=${max ?? '?'}s`];
  if (min !== 0) parts.push(`min=${min}s`);
  return { value: `TTL ${parts.join(' ')}`, cookies };
}

function behaviorSummary(
  beh: JsonObject,
  policies: Map<string, TfResource>,
): { value: string; cookies: boolean; disabled: boolean } {
  const target = str(beh['target_origin_id']);
  const suffix = target ? ` → ${target}` : '';
  const pid = str(beh['cache_policy_id']);
  if (pid) {
    const managed = MANAGED_CACHE_POLICIES[pid];
    if (managed)
      return { value: managed + suffix, cookies: false, disabled: pid === CACHING_DISABLED };
    const ref = collectRefs(pid).find((r) => r.type === 'aws_cloudfront_cache_policy');
    const pol = ref ? policies.get(ref.logicalId) : undefined;
    if (pol) {
      const s = ttlSummary(pol.body);
      return {
        value: `${pol.logicalId}: ${s.value}${suffix}`,
        cookies: s.cookies,
        disabled: false,
      };
    }
    return { value: `cache policy ${pid}${suffix}`, cookies: false, disabled: false };
  }
  // 旧式の forwarded_values + TTL
  const fv = one(beh['forwarded_values']);
  let cookies = false;
  const ck = fv ? one(fv['cookies']) : undefined;
  if (ck) {
    const fwd = str(ck['forward']);
    cookies = fwd !== undefined && fwd !== 'none';
  }
  const s = ttlSummary(beh);
  return { value: `${s.value}${suffix}`, cookies, disabled: false };
}

/** behavior の一覧（既定 → ordered） */
export function behaviors(r: TfResource): Array<{ key: string; pattern: string; beh: JsonObject }> {
  const out: Array<{ key: string; pattern: string; beh: JsonObject }> = [];
  const def = one(r.body['default_cache_behavior']);
  if (def) out.push({ key: '既定（*）', pattern: '*', beh: def });
  for (const b of arr(r.body['ordered_cache_behavior'])) {
    if (isObject(b)) {
      const p = str(b['path_pattern']) ?? '/';
      out.push({ key: p, pattern: p, beh: b });
    }
  }
  return out;
}

export function distributionCache(r: TfResource, policies: Map<string, TfResource>): Cache {
  const list = behaviors(r);
  const rules: CacheRule[] = [];
  let cookies = false;
  let allDisabled = list.length > 0;
  for (const { key, beh } of list) {
    const s = behaviorSummary(beh, policies);
    rules.push({ key, value: s.value });
    cookies ||= s.cookies;
    allDisabled &&= s.disabled;
  }
  const cache: Cache = {
    tone: cookies ? 'warn' : allDisabled ? 'off' : 'ok',
    badge: `CDN ${list.length} behaviors`,
    rules,
  };
  if (cookies) cache.note = 'キャッシュキーに Cookie を含めている（HIT 率に注意）';
  return cache;
}

export interface Association {
  /** 関連付けられた Lambda / CloudFront Function の論理 ID */
  target: string;
  /** 参照の `mod:` 修飾 */
  module?: string;
  eventType: string;
  pathPattern: string;
}

/** Lambda@Edge（lambda_function_association）と CloudFront Function（function_association） */
export function associations(
  r: TfResource,
  block: 'lambda_function_association' | 'function_association',
): Association[] {
  const attr = block === 'lambda_function_association' ? 'lambda_arn' : 'function_arn';
  const type =
    block === 'lambda_function_association' ? 'aws_lambda_function' : 'aws_cloudfront_function';
  const out: Association[] = [];
  for (const { pattern, beh } of behaviors(r)) {
    for (const a of arr(beh[block])) {
      if (!isObject(a)) continue;
      const ref = collectRefs(a[attr] ?? null).find((x) => x.type === type);
      if (ref) {
        const as: Association = {
          target: ref.logicalId,
          eventType: str(a['event_type']) ?? '?',
          pathPattern: pattern,
        };
        if (ref.module !== undefined) as.module = ref.module;
        out.push(as);
      }
    }
  }
  return out;
}

const triggerText = (e: string) =>
  e === 'viewer-request'
    ? 'viewer-request（HIT/MISS 判定より前に毎回実行）'
    : e === 'origin-request'
      ? 'origin-request（MISS のときだけ実行）'
      : e;

/** Lambda@Edge / CloudFront Function 自身の cache */
export function associationCache(
  assocs: Association[],
  what: 'Edge' | 'CloudFront Function',
): Cache {
  const events = [...new Set(assocs.map((a) => a.eventType))];
  const patterns = [...new Set(assocs.map((a) => a.pathPattern))];
  const beforeCache = events.some((e) => e.startsWith('viewer-'));
  const cache: Cache = {
    tone: 'info',
    badge: beforeCache ? 'キャッシュ判定の前' : 'MISS 時のみ',
    rules: [
      { key: 'トリガー', value: events.map(triggerText).join(', ') },
      { key: '範囲', value: `${patterns.join(', ')} に関連付け` },
    ],
  };
  if (beforeCache && patterns.includes('*'))
    cache.note = `全パスに付いているので、HIT するリクエストでも毎回 ${what} が起動する`;
  return cache;
}

/** CloudFront の cache に CloudFront Function の関連付けを足す */
export function addFunctionNote(
  cache: Cache,
  assocs: Association[],
  nameOf: (a: Association) => string,
): void {
  for (const a of assocs) {
    cache.rules = [
      ...(cache.rules ?? []),
      { key: `${a.eventType} (${a.pathPattern})`, value: `CloudFront Function ${nameOf(a)}` },
    ];
  }
  const viewer = assocs.filter((a) => a.eventType.startsWith('viewer-'));
  if (viewer.length > 0 && !cache.note) {
    const names = [...new Set(viewer.map(nameOf))].join(', ');
    cache.note = `CloudFront Function（${names}）がキャッシュ判定の前に毎回実行される（URL の書き換えなど）`;
  }
}
