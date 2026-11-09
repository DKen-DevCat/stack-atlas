import { describe, expect, it } from 'vitest';
import { mergePartialGraphs } from '../merge.js';

describe('mergePartialGraphs', () => {
  it('同じ ID のノードを deep merge する（先の値を残し、後続が欠けを埋める）', () => {
    const g = mergePartialGraphs([
      {
        nodes: [
          {
            id: 'route:/',
            kind: 'page',
            name: '/',
            meta: { extractors: ['nextjs-app'], next: { segment: '/' } },
          },
        ],
        edges: [],
      },
      {
        nodes: [
          {
            id: 'route:/',
            name: 'ignored',
            file: 'apps/web/app/page.tsx',
            meta: { extractors: ['ts-imports', 'nextjs-app'], next: { revalidate: 30 } },
          },
        ],
        edges: [],
      },
    ]);
    expect(g.nodes).toEqual([
      {
        id: 'route:/',
        kind: 'page',
        name: '/',
        file: 'apps/web/app/page.tsx',
        meta: { extractors: ['nextjs-app', 'ts-imports'], next: { segment: '/', revalidate: 30 } },
      },
    ]);
  });

  it('screen.regions は ref+x+y で、cache.rules は連結して重複排除', () => {
    const r = (ref: string, x: number, w = 10) => ({ ref, x, y: 0, w, h: 10 });
    const g = mergePartialGraphs([
      {
        nodes: [
          {
            id: 'route:/',
            screen: { width: 1, height: 1, regions: [r('comp:A', 0)] },
            cache: { tone: 'ok', badge: 'x', rules: [{ key: 'a', value: '1' }] },
          },
        ],
        edges: [],
      },
      {
        nodes: [
          {
            id: 'route:/',
            screen: { width: 2, height: 2, regions: [r('comp:A', 0, 99), r('comp:B', 5)] },
            cache: {
              tone: 'warn',
              badge: 'y',
              rules: [
                { key: 'a', value: '1' },
                { key: 'b', value: '2' },
              ],
            },
          },
        ],
        edges: [],
      },
    ]);
    const n = g.nodes[0]!;
    expect(n.screen).toEqual({ width: 1, height: 1, regions: [r('comp:A', 0), r('comp:B', 5)] });
    expect(n.cache).toEqual({
      tone: 'ok',
      badge: 'x',
      rules: [
        { key: 'a', value: '1' },
        { key: 'b', value: '2' },
      ],
    });
  });

  it('エッジは (from,to,kind) で重複排除し、label は最初に持っていたもの', () => {
    const g = mergePartialGraphs([
      {
        nodes: [],
        edges: [
          { from: 'a', to: 'b', kind: 'uses' },
          { from: 'a', to: 'b', kind: 'http' },
        ],
      },
      { nodes: [], edges: [{ from: 'a', to: 'b', kind: 'uses', label: 'L1' }] },
      { nodes: [], edges: [{ from: 'a', to: 'b', kind: 'uses', label: 'L2' }] },
    ]);
    expect(g.edges).toEqual([
      { from: 'a', to: 'b', kind: 'uses', label: 'L1' },
      { from: 'a', to: 'b', kind: 'http' },
    ]);
  });

  it('層は最初の定義が勝ち、順番を保つ', () => {
    const g = mergePartialGraphs([
      { layers: [{ id: 'a', name: 'A' }], nodes: [], edges: [] },
      {
        layers: [
          { id: 'b', name: 'B' },
          { id: 'a', name: 'A2' },
        ],
        nodes: [],
        edges: [],
      },
    ]);
    expect(g.layers).toEqual([
      { id: 'a', name: 'A' },
      { id: 'b', name: 'B' },
    ]);
  });

  it('入力を変更しない', () => {
    const part = { nodes: [{ id: 'x', meta: { extractors: ['a'] } }], edges: [] };
    const snapshot = JSON.stringify(part);
    mergePartialGraphs([part, { nodes: [{ id: 'x', meta: { extractors: ['b'] } }], edges: [] }]);
    expect(JSON.stringify(part)).toBe(snapshot);
  });
});

// 2026-11-09 追加（8-3b のレビュー）: 先に出た値を残す規則で screenshots の幅・高さが残り、screens.viewport が効かなかった
describe('mergeNodes の screen（HTML を出した側の幅・高さ）', () => {
  const shot = {
    id: 'route:/',
    screen: {
      screenshot: 'shots/index.png',
      width: 1280,
      height: 800,
      regions: [{ ref: 'comp:A', x: 0, y: 0, w: 100, h: 50 }],
    },
  };
  const html = (width: number, height: number) => ({
    id: 'route:/',
    screen: { html: 'screens/index/index.html', width, height, source: 'dir' as const },
  });

  it('screens.viewport が screenshots と違えば HTML の大きさにし、別の大きさで測った regions は捨てる（順は問わない）', () => {
    const expected = {
      id: 'route:/',
      screen: {
        screenshot: 'shots/index.png',
        html: 'screens/index/index.html',
        width: 375,
        height: 812,
        source: 'dir',
      },
    };
    for (const parts of [
      [shot, html(375, 812)],
      [html(375, 812), shot],
    ]) {
      const g = mergePartialGraphs(parts.map((n) => ({ nodes: [n], edges: [] })));
      expect(g.nodes[0]).toEqual(expected);
    }
  });

  it('大きさが同じなら regions を残す。HTML が無ければ従来どおり先の値', () => {
    const g = mergePartialGraphs([shot, html(1280, 800)].map((n) => ({ nodes: [n], edges: [] })));
    expect(g.nodes[0]!.screen).toMatchObject({
      width: 1280,
      height: 800,
      regions: shot.screen.regions,
    });
    const g2 = mergePartialGraphs(
      [shot, { id: 'route:/', screen: { width: 375, height: 812 } }].map((n) => ({
        nodes: [n],
        edges: [],
      })),
    );
    expect(g2.nodes[0]!.screen).toMatchObject({ width: 1280, height: 800 });
  });
});
