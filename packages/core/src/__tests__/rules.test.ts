import type { Graph } from '@stack-atlas/schema';
import { describe, expect, it } from 'vitest';
import {
  cdnSeconds,
  concretePath,
  lambdaFsIsr,
  matchPathPattern,
  pickRule,
  runRules,
  twoTierStaleness,
} from '../rules/index.js';

function graph(): Graph {
  return {
    version: 1,
    layers: [{ id: 'l', name: 'L' }],
    nodes: [
      {
        id: 'infra:cdn',
        layer: 'l',
        kind: 'infra',
        name: 'cdn',
        cache: {
          tone: 'ok',
          badge: 'CDN',
          rules: [
            { key: '/_next/static/*', value: 'max-age=1年' },
            { key: '/races/*', value: 'オリジンの s-maxage=60 に従う' },
            { key: '/', value: 'default TTL 30s / max TTL 300s' },
            { key: '/admin/*', value: 'CachingDisabled' },
          ],
        },
      },
      {
        id: 'infra:next',
        layer: 'l',
        kind: 'infra',
        name: 'next',
        meta: {
          cdktf: { type: 'aws_lambda_function', logicalId: 'next', path: 'web/next', stack: 'web' },
          deployApp: 'next',
        },
      },
      {
        id: 'route:/races/[id]',
        layer: 'l',
        kind: 'page',
        name: '/races/[id]',
        cache: { tone: 'warn', badge: 'ISR 60s', note: '既存の注意' },
        meta: { next: { revalidate: 60, segment: '/races/[id]' } },
      },
      {
        id: 'route:/',
        layer: 'l',
        kind: 'page',
        name: '/',
        meta: { next: { revalidate: 10, segment: '/' } },
      },
      {
        id: 'route:/about',
        layer: 'l',
        kind: 'page',
        name: '/about',
        meta: { next: { revalidate: 5, segment: '/about' } },
      },
      {
        id: 'route:/static',
        layer: 'l',
        kind: 'page',
        name: '/static',
        meta: { next: { revalidate: false, segment: '/static' } },
      },
      {
        id: 'route:/orphan',
        layer: 'l',
        kind: 'page',
        name: '/orphan',
        meta: { next: { revalidate: 5, segment: '/orphan' } },
      },
    ],
    edges: [
      { from: 'infra:cdn', to: 'infra:next', kind: 'flow' },
      { from: 'infra:next', to: 'route:/races/[id]', kind: 'deploy' },
      { from: 'infra:next', to: 'route:/', kind: 'deploy' },
      { from: 'infra:next', to: 'route:/about', kind: 'deploy' },
      { from: 'infra:next', to: 'route:/static', kind: 'deploy' },
    ],
  };
}

const node = (g: Graph, id: string) => g.nodes.find((n) => n.id === id)!;

describe('two-tier-staleness', () => {
  it('ISR と CDN の二段を note に追記する（既存の note は残す）', () => {
    const g = graph();
    twoTierStaleness.apply(g, console);
    expect(node(g, 'route:/races/[id]').cache!.note).toBe(
      '既存の注意\nISR(60s) と CDN(60s) が二段になるため最大 120 秒古くなる',
    );
    // cache が無ければ作る。/ は既定 behavior（TTL 30）
    expect(node(g, 'route:/').cache).toEqual({
      tone: 'warn',
      badge: 'ISR 10s',
      note: 'ISR(10s) と CDN(30s) が二段になるため最大 40 秒古くなる',
    });
    // 一致するキーが無ければ既定キー "/" を使う
    expect(node(g, 'route:/about').cache!.note).toContain('最大 35 秒');
    // revalidate: false / deploy されていないルートは対象外
    expect(node(g, 'route:/static').cache).toBeUndefined();
    expect(node(g, 'route:/orphan').cache).toBeUndefined();
  });

  it('二度走らせても同じ文を重ねない', () => {
    const g = graph();
    runRules(g, [twoTierStaleness, twoTierStaleness]);
    expect(node(g, 'route:/races/[id]').cache!.note!.split('\n')).toHaveLength(2);
  });

  it('照合の部品', () => {
    expect(concretePath('/races/[id]')).toBe('/races/id');
    expect(concretePath('/(shop)/docs/[...slug]')).toBe('/docs/slug/x');
    expect(matchPathPattern('/races/*', '/races/id')).toBe(true);
    expect(matchPathPattern('/races/*', '/racesX')).toBe(false);
    expect(cdnSeconds('public, s-maxage=120, stale-while-revalidate')).toBe(120);
    expect(cdnSeconds('TTL: 45')).toBe(45);
    expect(cdnSeconds('honorOriginHeaders: TTL default=60s max=300s')).toBe(60);
    expect(cdnSeconds('CachingOptimized（TTL 既定 1日 / 最大 1年）')).toBe(86400);
    expect(cdnSeconds('CachingDisabled')).toBeUndefined();
    const rules = [
      { key: 'Default (*)', value: 'TTL 1' },
      { key: '/a/*', value: 'TTL 2' },
      { key: '/a/b/*', value: 'TTL 3' },
      { key: 'Cache-Control', value: 's-maxage=9' },
    ];
    expect(pickRule(rules, '/a/b/c')!.value).toBe('TTL 3');
    expect(pickRule(rules, '/a/x')!.value).toBe('TTL 2');
    expect(pickRule(rules, '/z')!.value).toBe('TTL 1');
    expect(pickRule([{ key: '既定（*）', value: 'TTL 7' }], '/q')!.value).toBe('TTL 7');
  });
});

describe('lambda-fs-isr', () => {
  it('Next を載せた Lambda に ISR /tmp の警告を付ける', () => {
    const g = graph();
    lambdaFsIsr.apply(g, console);
    expect(node(g, 'infra:next').cache).toMatchObject({ tone: 'warn', badge: 'ISR /tmp' });
    expect(node(g, 'infra:next').cache!.rules).toHaveLength(2);
    expect(node(g, 'infra:next').cache!.note).toMatch(/^インスタンスごとに別キャッシュ/);
  });

  it('cache が既にある・deployApp が無い・cacheHandler ありなら何もしない', () => {
    const g = graph();
    const next = node(g, 'infra:next');
    next.cache = { tone: 'ok', badge: 'shared' };
    lambdaFsIsr.apply(g, console);
    expect(next.cache).toEqual({ tone: 'ok', badge: 'shared' });

    const g2 = graph();
    delete node(g2, 'infra:next').meta!.deployApp;
    lambdaFsIsr.apply(g2, console);
    expect(node(g2, 'infra:next').cache).toBeUndefined();

    const g3 = graph();
    node(g3, 'infra:next').meta!.next = { cacheHandler: './cache-handler.mjs' };
    lambdaFsIsr.apply(g3, console);
    expect(node(g3, 'infra:next').cache).toBeUndefined();
  });

  it('runRules は失敗したルールをスキップする', () => {
    const g = graph();
    const warns: string[] = [];
    const log = { debug() {}, info() {}, error() {}, warn: (m: string) => warns.push(m) };
    runRules(
      g,
      [
        {
          id: 'boom',
          apply: () => {
            throw new Error('x');
          },
        },
        lambdaFsIsr,
      ],
      log,
    );
    expect(warns).toHaveLength(1);
    expect(node(g, 'infra:next').cache).toBeDefined();
  });
});
