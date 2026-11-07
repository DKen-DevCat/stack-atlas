import { describe, expect, it } from 'vitest';
import type { Graph } from '@stack-atlas/schema';
import { describeChange, diffGraphs, diffMarks, diffPillText, edgeKey, isEmptyDiff } from './diff';
import { loadSampleGraph } from './testSample';

type G = Pick<Graph, 'nodes' | 'edges'>;

const base: G = {
  nodes: [
    { id: 'a', layer: 'l0', kind: 'page', name: 'A', file: 'a.tsx' },
    { id: 'b', layer: 'l1', kind: 'component', name: 'B', cache: { tone: 'ok', badge: 'HIT' } },
    { id: 'c', layer: 'l1', kind: 'type', name: 'C' },
  ],
  edges: [
    { from: 'a', to: 'b', kind: 'uses' },
    { from: 'b', to: 'c', kind: 'uses' },
  ],
};

describe('diffGraphs', () => {
  it('同じ graph なら空', () => {
    const d = diffGraphs(base, structuredClone(base));
    expect(isEmptyDiff(d)).toBe(true);
    expect(diffPillText(d)).toBe('差分 +0 −0 ~0');
  });

  it('追加・削除・変更ノードとエッジを出す', () => {
    const next: G = structuredClone(base);
    next.nodes = next.nodes.filter((n) => n.id !== 'c');
    next.nodes.push({ id: 'd', layer: 'l1', kind: 'hook', name: 'D' });
    next.nodes[0]!.file = 'a2.tsx';
    next.nodes[1]!.cache = { tone: 'warn', badge: 'MISS' };
    next.nodes[1]!.name = 'B2';
    // 説明（code など比較対象外）の変更は無視する
    next.nodes[0]!.code = 'x';
    next.edges = [
      { from: 'a', to: 'b', kind: 'uses', label: 'ラベルは無視' },
      { from: 'a', to: 'd', kind: 'uses' },
      // kind が違えば別のエッジ
      { from: 'b', to: 'c', kind: 'http' },
    ];
    const d = diffGraphs(base, next);
    expect(d.addedNodes).toEqual(['d']);
    expect(d.removedNodes).toEqual(['c']);
    expect(d.changedNodes).toEqual([
      { id: 'a', fields: ['file'] },
      { id: 'b', fields: ['name', 'cache.badge'] },
    ]);
    expect(d.addedEdges.map(edgeKey)).toEqual([
      edgeKey({ from: 'a', to: 'd', kind: 'uses' }),
      edgeKey({ from: 'b', to: 'c', kind: 'http' }),
    ]);
    expect(d.removedEdges).toEqual([{ from: 'b', to: 'c', kind: 'uses' }]);
    expect(diffPillText(d)).toBe('差分 +1 −1 ~2');
    expect(describeChange(base.nodes[1], next.nodes[1], ['name', 'cache.badge'])).toBe(
      '名前: B → B2・キャッシュ: HIT → MISS',
    );
    expect(describeChange(base.nodes[2], { ...base.nodes[2]!, file: 'c.ts' }, ['file'])).toBe(
      'ファイル: — → c.ts',
    );
    const m = diffMarks(d);
    expect(m.added.has('d')).toBe(true);
    expect(m.changed.get('b')).toEqual(['name', 'cache.badge']);
  });

  it('層・種類の変更、cache の追加も変更として扱う', () => {
    const next: G = structuredClone(base);
    next.nodes[2] = {
      id: 'c',
      layer: 'l0',
      kind: 'schema',
      name: 'C',
      cache: { tone: 'ok', badge: 'x' },
    };
    expect(diffGraphs(base, next).changedNodes).toEqual([
      { id: 'c', fields: ['kind', 'layer', 'cache.badge'] },
    ]);
  });

  it('サンプルから 1 ノード消して 1 ノード足す', () => {
    const prev = loadSampleGraph();
    const next = structuredClone(prev);
    const removed = next.nodes.shift()!;
    next.edges = next.edges.filter((e) => e.from !== removed.id && e.to !== removed.id);
    next.nodes.push({ id: 'type:New', layer: next.layers.at(-1)!.id, kind: 'type', name: 'New' });
    const d = diffGraphs(prev, next);
    expect(d.removedNodes).toEqual([removed.id]);
    expect(d.addedNodes).toEqual(['type:New']);
    expect(d.removedEdges.length).toBe(
      prev.edges.filter((e) => e.from === removed.id || e.to === removed.id).length,
    );
    expect(d.addedEdges).toEqual([]);
  });
});
