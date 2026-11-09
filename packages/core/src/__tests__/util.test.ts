/**
 * glob と Next ルート列挙（core に一本化したもの）。
 * レビュー（PR #1）で見つかった「core の glob が `{a,b}` を知らない」「route group の layout が
 * root の layout と同じ ID になる」をここで固定する。
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { listRouteFiles, routeNodeId, segmentToUrl } from '../next-routes.js';
import { globBase, globToRegExp, pathWithin, toArray } from '../util.js';

describe('globToRegExp（core と抽出器で共用）', () => {
  it('** は / をまたぎ、* と ? はまたがない', () => {
    const re = globToRegExp('apps/api/src/handlers/**/*.ts');
    expect(re.test('apps/api/src/handlers/getRaces.ts')).toBe(true);
    expect(re.test('apps/api/src/handlers/v2/getRaces.ts')).toBe(true);
    expect(re.test('apps/api/src/index.ts')).toBe(false);
    expect(globToRegExp('src/*.ts').test('src/a/b.ts')).toBe(false);
    expect(globToRegExp('src/?.ts').test('src/a.ts')).toBe(true);
  });

  it('{ts,tsx} を選択として扱う（以前の core 版はリテラルとして照合して deploy エッジが張られなかった）', () => {
    const re = globToRegExp('apps/api/src/handlers/**/*.{ts,tsx}');
    expect(re.test('apps/api/src/handlers/getRaces.ts')).toBe(true);
    expect(re.test('apps/api/src/handlers/getRaces.tsx')).toBe(true);
    expect(re.test('apps/api/src/handlers/getRaces.js')).toBe(false);
    // 閉じていない { はリテラル
    expect(globToRegExp('a/{b.ts').test('a/{b.ts')).toBe(true);
  });

  it('globBase と toArray', () => {
    expect(globBase('apps/api/src/handlers/**/*.ts')).toBe('apps/api/src/handlers');
    expect(globBase('src/*.{ts,tsx}')).toBe('src');
    expect(globBase('a/b/c.ts')).toBe('a/b');
    expect(toArray(undefined)).toEqual([]);
    expect(toArray('x')).toEqual(['x']);
    expect(toArray(['x', 'y'])).toEqual(['x', 'y']);
  });
});

describe('Next ルートの ID', () => {
  it('segmentToUrl は group を除く。keepGroups なら残す', () => {
    expect(segmentToUrl('(shop)/cart')).toEqual({ url: '/cart' });
    expect(segmentToUrl('(shop)/cart', { keepGroups: true })).toEqual({ url: '/(shop)/cart' });
    expect(segmentToUrl('')).toEqual({ url: '/' });
    expect('skip' in segmentToUrl('@modal/login')).toBe(true);
  });

  it('page は URL、layout は group を残した ID（root と group の layout が別ノードになる）', () => {
    expect(routeNodeId('page', '(shop)/cart')).toBe('route:/cart');
    expect(routeNodeId('layout', '')).toBe('layout:/');
    expect(routeNodeId('layout', '(shop)')).toBe('layout:/(shop)');
    expect(routeNodeId('layout', '(shop)/cart')).toBe('layout:/(shop)/cart');
    expect(routeNodeId('layout', 'races/[id]')).toBe('layout:/races/[id]');
    expect(routeNodeId('page', '_lib')).toBeUndefined();
  });

  it('listRouteFiles: app/layout.tsx と app/(shop)/layout.tsx の ID が衝突しない', () => {
    const root = mkdtempSync(join(tmpdir(), 'stack-atlas-routes-'));
    const app = join(root, 'app');
    mkdirSync(join(app, '(shop)', 'cart'), { recursive: true });
    for (const f of ['layout.tsx', 'page.tsx', '(shop)/layout.tsx', '(shop)/cart/page.tsx'])
      writeFileSync(join(app, f), 'export default function X() {}\n');
    const { files } = listRouteFiles(root, 'app');
    const ids = files.map((f) => f.id).sort();
    expect(ids).toEqual(['layout:/', 'layout:/(shop)', 'route:/', 'route:/cart']);
    expect(new Set(ids).size).toBe(ids.length);
    // url は実際の URL（group 抜き）のまま
    expect(files.find((f) => f.id === 'layout:/(shop)')?.url).toBe('/');
  });
});

// 2026-11-09 追加（8-3b のレビュー）: build の出力先の検査と screens 抽出器の読み書きで別々に書いていた判定を一本にした
describe('pathWithin', () => {
  it('中だけ（allowSame で自身も）。`..` で始まる名前は中', () => {
    expect(pathWithin('/a/b', '/a/b/c')).toBe(true);
    expect(pathWithin('/a/b', '/a/b')).toBe(false);
    expect(pathWithin('/a/b', '/a/b', true)).toBe(true);
    expect(pathWithin('/a/b', '/a/bc')).toBe(false);
    expect(pathWithin('/a/b', '/a')).toBe(false);
    expect(pathWithin('/a/b', '/a/b/../c')).toBe(false);
    expect(pathWithin('/a/b', '/a/b/..x')).toBe(true);
  });
});
