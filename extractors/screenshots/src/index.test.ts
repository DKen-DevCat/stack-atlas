import { describe, expect, it } from 'vitest';
import { resolveRegionRef as sharedResolveRegionRef, type RepoContext } from '@stack-atlas/core';
import {
  LAUNCH_OPTIONS,
  clipRegion,
  extractor,
  isDynamicRoute,
  joinUrl,
  resolveRegionRef,
  routeToUrls,
  slugify,
  uniqueSlug,
} from './index.js';

describe('routeToUrls', () => {
  it('returns static routes as-is', () => {
    expect(routeToUrls('/')).toEqual(['/']);
    expect(routeToUrls('/admin/entry', ['x'])).toEqual(['/admin/entry']);
  });
  it('substitutes a single param with each sample', () => {
    expect(routeToUrls('/races/[id]', ['42', '7'])).toEqual(['/races/42', '/races/7']);
  });
  it('returns [] for a dynamic route without samples', () => {
    expect(routeToUrls('/races/[id]')).toEqual([]);
    expect(routeToUrls('/races/[id]', [])).toEqual([]);
    expect(routeToUrls('/docs/[...slug]')).toEqual([]);
  });
  it('drops an optional catch-all when there are no samples', () => {
    expect(routeToUrls('/docs/[[...slug]]')).toEqual(['/docs']);
    expect(routeToUrls('/[[...slug]]')).toEqual(['/']);
  });
  it('fills catch-alls with multi-segment samples', () => {
    expect(routeToUrls('/docs/[...slug]', ['a/b/c'])).toEqual(['/docs/a/b/c']);
    expect(routeToUrls('/[org]/[...rest]', ['acme/x/y'])).toEqual(['/acme/x/y']);
  });
  it('maps multiple params in order', () => {
    expect(routeToUrls('/u/[user]/p/[post]', ['alice/9'])).toEqual(['/u/alice/p/9']);
  });
  it('uses samples starting with / as full paths and encodes values', () => {
    expect(routeToUrls('/races/[id]', ['/races/42?tab=1'])).toEqual(['/races/42?tab=1']);
    expect(routeToUrls('/s/[q]', ['a b'])).toEqual(['/s/a%20b']);
  });
  it('isDynamicRoute', () => {
    expect(isDynamicRoute('/races/[id]')).toBe(true);
    expect(isDynamicRoute('/races')).toBe(false);
  });
});

describe('slugify', () => {
  it('follows the documented rules', () => {
    expect(slugify('/')).toBe('index');
    expect(slugify('/races')).toBe('races');
    expect(slugify('/races/[id]')).toBe('races-id');
    expect(slugify('/admin/entry')).toBe('admin-entry');
    expect(slugify('/docs/[...slug]')).toBe('docs-slug');
    expect(slugify('/docs/[[...slug]]')).toBe('docs-slug');
  });
});

describe('uniqueSlug', () => {
  it('同じ名前になるルートには 2 本目からハッシュを足す（以前はスクショが上書きされていた）', () => {
    const used = new Map<string, string>();
    expect(uniqueSlug('/races/[id]', used)).toBe('races-id');
    // 同じパターンをもう一度聞いても同じ名前
    expect(uniqueSlug('/races/[id]', used)).toBe('races-id');
    const second = uniqueSlug('/races/id', used);
    expect(second).toMatch(/^races-id-[0-9a-f]{6}$/);
    expect(uniqueSlug('/a-b', used)).toBe('a-b');
    expect(uniqueSlug('/a/b', used)).toMatch(/^a-b-[0-9a-f]{6}$/);
    // 決定的
    expect(uniqueSlug('/races/id', new Map([['races-id', '/races/[id]']]))).toBe(second);
  });

  it('英数字で始まらない・100 文字を超える名前は r-<ハッシュ>（2026-11-09（8-3b のレビュー）: screens の screenSlug と一本にした）', () => {
    const used = new Map<string, string>();
    expect(uniqueSlug('/..', used)).toMatch(/^r-[0-9a-f]{8}$/);
    expect(uniqueSlug('/_assets', used)).toMatch(/^r-[0-9a-f]{8}$/);
    expect(uniqueSlug('/.well-known', used)).toMatch(/^r-[0-9a-f]{8}$/);
    expect(uniqueSlug(`/${'a'.repeat(101)}`, used)).toMatch(/^r-[0-9a-f]{8}$/);
    expect(uniqueSlug(`/${'a'.repeat(100)}`, used)).toBe('a'.repeat(100));
    expect(uniqueSlug('/_assets', used)).toBe(uniqueSlug('/_assets', new Map()));
  });
});

describe('resolveRegionRef', () => {
  const ids = [
    'comp:Header',
    'hook:useSession',
    'comp:Dup',
    'hook:Dup',
    'lib:apiClient',
    'route:/',
  ];
  it('prefers comp:, then hook:, then any :<name> suffix', () => {
    expect(resolveRegionRef('Header', ids)).toBe('comp:Header');
    expect(resolveRegionRef('useSession', ids)).toBe('hook:useSession');
    expect(resolveRegionRef('Dup', ids)).toBe('comp:Dup');
    expect(resolveRegionRef('apiClient', ids)).toBe('lib:apiClient');
  });
  it('accepts a full node id and returns undefined when unknown', () => {
    expect(resolveRegionRef('hook:useSession', ids)).toBe('hook:useSession');
    expect(resolveRegionRef('Nope', ids)).toBeUndefined();
  });
  it('ビューアと同じ規則（2026-11-09、8-3b: 正本は @stack-atlas/wiring。core の再 export をそのまま出す）', () => {
    // ビューアは画面の HTML の data-component を wiring の resolveRegionRef で解く。抽出器と食い違わないよう同じ関数
    expect(resolveRegionRef).toBe(sharedResolveRegionRef);
    for (const name of ['Header', 'useSession', 'Dup', 'apiClient', 'hook:useSession', 'Nope', '/'])
      expect(resolveRegionRef(name, ids)).toBe(sharedResolveRegionRef(name, ids));
  });
});

describe('clipRegion / joinUrl', () => {
  const vp = { width: 1280, height: 800 };
  it('rounds, clips to the viewport and drops off-screen elements', () => {
    expect(clipRegion({ name: 'A', x: 10.4, y: 20.6, w: 100.2, h: 50 }, vp)).toEqual({
      name: 'A',
      x: 10,
      y: 21,
      w: 101,
      h: 50,
    });
    expect(clipRegion({ name: 'B', x: 0, y: 700, w: 1280, h: 400 }, vp)).toEqual({
      name: 'B',
      x: 0,
      y: 700,
      w: 1280,
      h: 100,
    });
    expect(clipRegion({ name: 'C', x: 0, y: 900, w: 10, h: 10 }, vp)).toBeUndefined();
    expect(clipRegion({ name: 'D', x: 5, y: 5, w: 0, h: 10 }, vp)).toBeUndefined();
  });
  it('joins base URLs with or without a path', () => {
    expect(joinUrl('http://h:1/', '/races')).toBe('http://h:1/races');
    expect(joinUrl('http://h:1/app', '/races')).toBe('http://h:1/app/races');
  });
});

describe('detect', () => {
  const ctx = (config: RepoContext['config']): RepoContext => ({
    root: '/x',
    repoName: 'x',
    repos: { x: '/x' },
    configDir: '/x',
    config,
    log: { debug() {}, info() {}, warn() {}, error() {} },
    resolve: (...s) => ['/x', ...s].join('/'),
  });
  it('is true only with screenshots.baseUrl', async () => {
    expect(await extractor.detect(ctx({ screenshots: { baseUrl: 'http://localhost:4173' } }))).toBe(
      true,
    );
    expect(await extractor.detect(ctx({ screenshots: {} }))).toBe(false);
    expect(await extractor.detect(ctx({}))).toBe(false);
  });
});

// 2026-11-10 追加（8-4 のレビュー S1）: 直す前は { headless: true } だけで、Playwright の既定の --no-sandbox で開いていた
describe('Chromium の起動', () => {
  it('サンドボックスを有効にする（chromiumSandbox: true）', () => {
    expect(LAUNCH_OPTIONS).toEqual({ headless: true, chromiumSandbox: true });
  });
});
