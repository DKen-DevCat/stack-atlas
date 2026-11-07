import { describe, expect, it } from 'vitest';
import { buildModel } from '../graph/model';
import { makeSyntheticGraph } from '../graph/synthetic';
import { countText, kindsOf, matchNodes, normalizeQuery } from './search';

const nodes = [
  { id: 'comp:ResultTable', name: 'ResultTable', file: 'web/src/components/ResultTable.tsx' },
  { id: 'type:Race', name: 'Race', file: 'api/types/race.ts' },
  { id: 'infra:cloudfront', name: 'CloudFront' },
  { id: 'route:/races/[id]', name: '/races/[id]', file: 'web/app/races/[id]/page.tsx' },
];

describe('matchNodes', () => {
  it('空（空白だけ）の検索語は null（検索なし）', () => {
    expect(matchNodes(nodes, '')).toBeNull();
    expect(matchNodes(nodes, '   ')).toBeNull();
    expect(normalizeQuery('  Race ')).toBe('race');
  });
  it('name / id / file の部分一致。大文字小文字を区別しない', () => {
    expect(matchNodes(nodes, 'RACE')).toEqual(['type:Race', 'route:/races/[id]']);
    expect(matchNodes(nodes, 'components/')).toEqual(['comp:ResultTable']);
    expect(matchNodes(nodes, 'cloud')).toEqual(['infra:cloudfront']);
    expect(matchNodes(nodes, 'infra:')).toEqual(['infra:cloudfront']);
    expect(matchNodes(nodes, 'page.tsx')).toEqual(['route:/races/[id]']);
  });
  it('一致なしは空配列（0 件）', () => {
    expect(matchNodes(nodes, 'zzz')).toEqual([]);
    expect(countText([])).toBe('0 件');
    expect(countText(null)).toBe('');
    expect(countText(['a', 'b', 'c'])).toBe('3 件');
    expect(countText(['a', 'b', 'c'], 1)).toBe('2 / 3 件');
  });
});

describe('kindsOf', () => {
  it('出現する kind を出現順に、色と件数つきで返す', () => {
    const m = buildModel(makeSyntheticGraph());
    const ks = kindsOf(m.nodes);
    expect(ks.map((k) => k.kind)).toEqual([
      'actor',
      'infra',
      'layout',
      'page',
      'component',
      'hook',
      'lib',
      'handler',
      'endpoint',
      'schema',
      'type',
    ]);
    expect(ks.reduce((s, k) => s + k.count, 0)).toBe(m.nodes.length);
    expect(ks.find((k) => k.kind === 'type')!.color).toBe('#4ade80');
  });
});
