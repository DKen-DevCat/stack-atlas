/**
 * 二段キャッシュの最悪鮮度。
 *
 * 判定: route ノード R が `meta.next.revalidate = X`（正の数）を持ち、
 *   インフラノード I から `deploy` エッジ（I → R）があり、
 *   I に `flow` エッジで入ってくるノード C（CDN）の `cache.rules` に、R のパスに一致するキーがあって
 *   値に `s-maxage=Y` か `TTL Y` がある
 * → R の `cache.note` に「ISR(Xs) と CDN(Ys) が二段になるため最大 X+Y 秒古くなる」を足す。
 *
 * キーの一致（ゆるめ）:
 * - キーは CloudFront の path pattern とみなす（`/races/*` など。`*` は `/` もまたぐ）。
 *   R のパスの動的セグメントは具体値に置き換えて照合する（`/races/[id]` → `/races/id`、`(group)` は取り除く）
 * - `/` で始まらず `*` でもないキー（`Cache-Control` など）は無視
 * - いちばん長く一致したキーを使う。一致がなければ既定の behavior を表すキー
 *   （`/`・`*`・`/*`・`default`・`Default (*)` など）を使う
 * - 既定キーは `既定（*）` `デフォルト` のように default / 既定 / デフォルト で始まるものも含む
 * - 値は `s-maxage=Y` を優先し、無ければ `TTL Y` / `TTL: Y` / `TTL default=60s`（TTL の後の最初の数値、単位付き可）
 *
 * R に cache が無ければ `{ tone: 'warn', badge: 'ISR Xs' }` を作って note を付ける。
 */
import type { Cache, CacheRule, GraphNode } from '@stack-atlas/schema';
import { getRevalidateSeconds } from '../meta.js';
import type { Rule } from './types.js';
import { appendNote, incoming } from './util.js';

const DEFAULT_KEYS = new Set([
  '/',
  '*',
  '/*',
  'default',
  'default (*)',
  '(default)',
  'defaultcachebehavior',
]);

const isDefaultKey = (key: string) => {
  const k = key.trim().toLowerCase();
  return DEFAULT_KEYS.has(k) || /^(default|既定|デフォルト)/.test(k);
};

/** route ノードの URL パス（`route:` を外したもの。meta.next.segment があればそちら） */
export function routePath(node: GraphNode): string | undefined {
  const seg = (node.meta?.next as { segment?: unknown } | undefined)?.segment;
  if (typeof seg === 'string' && seg !== '') return seg.startsWith('/') ? seg : `/${seg}`;
  return node.id.startsWith('route:') ? node.id.slice('route:'.length) : undefined;
}

/** `/races/[id]` → `/races/id`、`/docs/[...slug]` → `/docs/slug/x`、`(group)` は除去 */
export function concretePath(path: string): string {
  const segs = path
    .split('/')
    .filter((s) => s !== '' && !/^\(.*\)$/.test(s))
    .map((s) => {
      const m = /^\[\[?(\.\.\.)?([^\]]+)\]\]?$/.exec(s);
      if (!m) return s;
      return m[1] ? `${m[2]}/x` : m[2];
    });
  return `/${segs.join('/')}`;
}

/** CloudFront の path pattern をパスに当てる（`*` は任意の文字列、`?` は 1 文字） */
export function matchPathPattern(pattern: string, path: string): boolean {
  const re = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${re}$`).test(path);
}

const UNIT_SECONDS: Record<string, number> = {
  s: 1,
  sec: 1,
  秒: 1,
  m: 60,
  min: 60,
  分: 60,
  h: 3600,
  時間: 3600,
  d: 86400,
  日: 86400,
};

/**
 * 値から CDN の秒数を取り出す。`s-maxage=N` を優先し、無ければ `TTL` の後ろ（20 文字以内）にある
 * 最初の数値（`default=` を挟んでもよい）。数値の直後の単位（s / m / h / d / 秒 / 分 / 時間 / 日）を秒に直す。
 */
export function cdnSeconds(value: string): number | undefined {
  const s = /s-maxage\s*[=:]\s*(\d+)/i.exec(value);
  if (s) return Number(s[1]);
  const t = /\bTTL\b[^\d]{0,20}?(\d+)\s*(sec|min|s|m|h|d|秒|分|時間|日)?/i.exec(value);
  if (!t) return undefined;
  return Number(t[1]) * (UNIT_SECONDS[(t[2] ?? 's').toLowerCase()] ?? 1);
}

/** path に当てはまる rule を選ぶ（最長一致 → 既定キー） */
export function pickRule(rules: CacheRule[], path: string): CacheRule | undefined {
  let best: CacheRule | undefined;
  for (const r of rules) {
    const key = r.key.trim();
    if (isDefaultKey(key) && key !== '/') continue;
    if (!key.startsWith('/') && !key.startsWith('*')) continue;
    if (matchPathPattern(key, path) && (!best || key.length > best.key.trim().length)) best = r;
  }
  return best ?? rules.find((r) => isDefaultKey(r.key));
}

export const twoTierStaleness: Rule = {
  id: 'two-tier-staleness',
  description:
    'ISR の revalidate と CDN の s-maxage / TTL が二段になるときの最悪鮮度を note に書く',
  apply(graph) {
    for (const route of graph.nodes) {
      const x = getRevalidateSeconds(route);
      const path = routePath(route);
      if (x === undefined || path === undefined) continue;
      const concrete = concretePath(path);
      const ys = new Set<number>();
      for (const host of incoming(graph, route.id, 'deploy')) {
        if (host.kind !== 'infra') continue;
        for (const cdn of incoming(graph, host.id, 'flow')) {
          const rule = cdn.cache?.rules ? pickRule(cdn.cache.rules, concrete) : undefined;
          const y = rule ? cdnSeconds(rule.value) : undefined;
          if (y !== undefined) ys.add(y);
        }
      }
      for (const y of ys) {
        const cache: Cache = (route.cache ??= { tone: 'warn', badge: `ISR ${x}s` });
        appendNote(cache, `ISR(${x}s) と CDN(${y}s) が二段になるため最大 ${x + y} 秒古くなる`);
      }
    }
  },
};
