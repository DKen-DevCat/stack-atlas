import type { Graph } from '@stack-atlas/schema';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { diffGraphs, isEmptyDiff } from '../diff.js';
import { SAMPLE } from './helpers.js';

const sample = (): Graph => JSON.parse(readFileSync(SAMPLE, 'utf8')) as Graph;

describe('diffGraphs', () => {
  it('同じグラフなら差分なし', () => {
    expect(isEmptyDiff(diffGraphs(sample(), sample()))).toBe(true);
  });

  it('追加・削除・変更を検出する', () => {
    const a = sample();
    const b = sample();
    b.nodes = b.nodes.filter((n) => n.id !== 'comp:Pagination');
    b.edges = b.edges.filter((e) => e.from !== 'comp:Pagination' && e.to !== 'comp:Pagination');
    b.nodes.push({ id: 'comp:New', layer: 'components', kind: 'component', name: 'New' });
    b.edges.push({ from: 'route:/', to: 'comp:New', kind: 'uses' });
    const rid = b.nodes.find((n) => n.id === 'route:/races/[id]')!;
    rid.cache!.badge = 'ISR 30s';
    rid.file = 'x.tsx';
    const d = diffGraphs(a, b);
    expect(d.addedNodes).toEqual(['comp:New']);
    expect(d.removedNodes).toEqual(['comp:Pagination']);
    expect(d.addedEdges).toEqual([{ from: 'route:/', to: 'comp:New', kind: 'uses' }]);
    expect(d.removedEdges.length).toBeGreaterThan(0);
    expect(
      d.removedEdges.every((e) => e.from === 'comp:Pagination' || e.to === 'comp:Pagination'),
    ).toBe(true);
    expect(d.changedNodes).toEqual([{ id: 'route:/races/[id]', fields: ['file', 'cache.badge'] }]);
  });
});
