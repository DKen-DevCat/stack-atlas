import type { Graph, GraphNode } from '@stack-atlas/schema';
import { describe, expect, it } from 'vitest';
import {
  COOKIE_CACHE_KEY_NOTE,
  DEFAULT_RULES,
  cookieCacheKey,
  isCachingDisabled,
  noStoreBehindCdn,
  runRules,
} from '../rules/index.js';
import { pickRule, ruleKeyToPattern } from '../rules/two-tier-staleness.js';

const cdktf = (type: string, logicalId: string) => ({
  cdktf: { type, logicalId, path: `web/${logicalId}`, stack: 'web' },
});

function graph(cdnRules: Array<{ key: string; value: string }>, extra: GraphNode[] = []): Graph {
  return {
    version: 1,
    layers: [{ id: 'l', name: 'L' }],
    nodes: [
      {
        id: 'infra:cdn',
        layer: 'l',
        kind: 'infra',
        name: 'cdn',
        meta: cdktf('aws_cloudfront_distribution', 'cdn'),
        cache: { tone: 'ok', badge: 'CDN', rules: cdnRules },
      },
      {
        id: 'infra:next',
        layer: 'l',
        kind: 'infra',
        name: 'next',
        meta: { ...cdktf('aws_lambda_function', 'next'), deployApp: 'next' },
      },
      {
        id: 'route:/admin/entry',
        layer: 'l',
        kind: 'page',
        name: '/admin/entry',
        meta: { next: { segment: 'admin/entry', dynamic: 'force-dynamic' } },
        cache: { tone: 'off', badge: 'dynamic' },
      },
      {
        id: 'route:/me',
        layer: 'l',
        kind: 'page',
        name: '/me',
        meta: { next: { segment: 'me', dynamic: 'force-dynamic' } },
      },
      {
        id: 'route:/news',
        layer: 'l',
        kind: 'page',
        name: '/news',
        meta: { next: { segment: 'news', dynamic: 'auto' } },
      },
      ...extra,
    ],
    edges: [
      { from: 'infra:cdn', to: 'infra:next', kind: 'flow' },
      { from: 'infra:next', to: 'route:/admin/entry', kind: 'deploy' },
      { from: 'infra:next', to: 'route:/me', kind: 'deploy' },
      { from: 'infra:next', to: 'route:/news', kind: 'deploy' },
    ],
  };
}

const node = (g: Graph, id: string) => g.nodes.find((n) => n.id === id)!;

describe('cookie-cache-key', () => {
  it('rules に Cookie がキャッシュキーに入っていれば warn と note を付ける（重ねない）', () => {
    const g = graph([
      { key: '既定（*）', value: 'TTL default=60s' },
      { key: 'キャッシュキー', value: 'Cookie: session_id' },
    ]);
    runRules(g, [cookieCacheKey, cookieCacheKey]);
    expect(node(g, 'infra:cdn').cache).toMatchObject({ tone: 'warn', note: COOKIE_CACHE_KEY_NOTE });
  });

  it('cdktf 抽出器の note がすでにあれば tone だけ warn にそろえる', () => {
    const g = graph([{ key: '/', value: 'TTL 30' }]);
    node(g, 'infra:cdn').cache!.tone = 'off';
    node(g, 'infra:cdn').cache!.note = `前の注意\n${COOKIE_CACHE_KEY_NOTE}`;
    cookieCacheKey.apply(g, console);
    expect(node(g, 'infra:cdn').cache).toMatchObject({
      tone: 'warn',
      note: `前の注意\n${COOKIE_CACHE_KEY_NOTE}`,
    });
  });

  it('Cookie が否定されている・CDN でない・cache が無いなら何もしない', () => {
    const g = graph(
      [{ key: 'Cookie', value: 'none（キャッシュキーに含めない）' }],
      [
        {
          id: 'infra:api',
          layer: 'l',
          kind: 'infra',
          name: 'api',
          meta: cdktf('aws_lambda_function', 'api'),
          cache: { tone: 'ok', badge: 'x', rules: [{ key: 'Cookie', value: 'session' }] },
        },
      ],
    );
    cookieCacheKey.apply(g, console);
    expect(node(g, 'infra:cdn').cache).toEqual({
      tone: 'ok',
      badge: 'CDN',
      rules: [{ key: 'Cookie', value: 'none（キャッシュキーに含めない）' }],
    });
    expect(node(g, 'infra:api').cache!.note).toBeUndefined();
  });

  it('meta.cdktf が無くても id が cloudfront なら CDN とみなす（手書きのサンプル）', () => {
    const g: Graph = {
      version: 1,
      layers: [{ id: 'l', name: 'L' }],
      nodes: [
        {
          id: 'infra:cloudfront',
          layer: 'l',
          kind: 'infra',
          name: 'CloudFront',
          cache: {
            tone: 'ok',
            badge: 'CDN',
            rules: [{ key: '/races/*', value: 'cookies=whitelist(session)' }],
            note: 'キャッシュキーに Cookie を含めない設定にしておく',
          },
        },
      ],
      edges: [],
    };
    cookieCacheKey.apply(g, console);
    expect(g.nodes[0]!.cache!.tone).toBe('warn');
    expect(g.nodes[0]!.cache!.note!.split('\n')).toHaveLength(2);
  });
});

describe('no-store-behind-cdn', () => {
  it('force-dynamic のルートが CachingDisabled でない behavior に当たれば warn', () => {
    const g = graph([
      { key: '既定（*）', value: 'honorOriginHeaders: TTL default=60s max=300s → nextOrigin' },
      { key: '/admin/*', value: 'CachingDisabled（素通し） → nextOrigin' },
    ]);
    runRules(g, [noStoreBehindCdn, noStoreBehindCdn]);
    // /admin/* は CachingDisabled → そのまま
    expect(node(g, 'route:/admin/entry').cache).toEqual({ tone: 'off', badge: 'dynamic' });
    // /me は既定 behavior（キャッシュ有効）→ cache を作る
    expect(node(g, 'route:/me').cache).toEqual({
      tone: 'warn',
      badge: 'force-dynamic',
      note: 'force-dynamic だが CDN 側 (既定（*）) はキャッシュ有効。Cache-Control を確認',
    });
    // force-dynamic でない route は対象外
    expect(node(g, 'route:/news').cache).toBeUndefined();
  });

  it('既存の cache は tone を warn にして note を足す。パスは最長一致', () => {
    const g = graph([
      { key: '既定（*）', value: 'CachingDisabled' },
      { key: '/admin/*', value: 'TTL default=60s max=300s' },
    ]);
    noStoreBehindCdn.apply(g, console);
    expect(node(g, 'route:/admin/entry').cache).toEqual({
      tone: 'warn',
      badge: 'dynamic',
      note: 'force-dynamic だが CDN 側 (/admin/*) はキャッシュ有効。Cache-Control を確認',
    });
    expect(node(g, 'route:/me').cache).toBeUndefined();
  });

  it('path_pattern が先頭の / 無し（admin/*）でも当たる。以前は既定 behavior に落ちて誤って warn していた', () => {
    const g = graph([
      { key: '既定（*）', value: 'TTL default=86400s' },
      { key: 'admin/*', value: 'CachingDisabled（素通し） → nextOrigin' },
    ]);
    noStoreBehindCdn.apply(g, console);
    expect(node(g, 'route:/admin/entry').cache).toEqual({ tone: 'off', badge: 'dynamic' });
    expect(node(g, 'route:/me').cache?.tone).toBe('warn');
  });

  it('ruleKeyToPattern / pickRule', () => {
    expect(ruleKeyToPattern('admin/*')).toBe('/admin/*');
    expect(ruleKeyToPattern('/admin/*')).toBe('/admin/*');
    expect(ruleKeyToPattern('*.png')).toBe('*.png');
    expect(ruleKeyToPattern('既定（*）')).toBeUndefined();
    expect(ruleKeyToPattern('')).toBeUndefined();
    const rules = [
      { key: '既定（*）', value: 'default' },
      { key: '_next/static/*', value: 'static' },
      { key: '_next/*', value: 'next' },
    ];
    expect(pickRule(rules, '/_next/static/a.js')?.value).toBe('static');
    expect(pickRule(rules, '/_next/data/x')?.value).toBe('next');
    expect(pickRule(rules, '/about')?.value).toBe('default');
  });

  it('キャッシュ無効の判定', () => {
    expect(isCachingDisabled('CachingDisabled（素通し） → nextOrigin')).toBe(true);
    expect(isCachingDisabled('private, no-store')).toBe(true);
    expect(isCachingDisabled('TTL default=0s max=0s')).toBe(true);
    expect(isCachingDisabled('TTL default=60s max=300s')).toBe(false);
    expect(isCachingDisabled('オリジンの s-maxage=60 に従う')).toBe(false);
    expect(isCachingDisabled('オリジンの Cache-Control に従う')).toBe(false);
  });

  it('DEFAULT_RULES に入っている', () => {
    expect(DEFAULT_RULES).toContain(cookieCacheKey);
    expect(DEFAULT_RULES).toContain(noStoreBehindCdn);
  });
});
