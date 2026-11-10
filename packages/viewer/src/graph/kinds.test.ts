import { describe, expect, it } from 'vitest';
import type { Graph } from '@stack-atlas/schema';
import { createKindRegistry, KINDS, kindMeta } from './kinds';
import { buildModel } from './model';

describe('kind レジストリ', () => {
  it('既定の kind（endpoint / queue / db / cron / service を含む）と未知の kind', () => {
    expect(kindMeta('endpoint')).toMatchObject({ ja: 'API エンドポイント', color: '#38bdf8' });
    for (const k of ['queue', 'db', 'cron', 'service']) expect(KINDS[k]).toBeDefined();
    expect(kindMeta('widget')).toEqual({ ja: 'widget', color: '#9ca3af', size: [2.0, 0.5, 1.3] });
  });

  it('graph.kinds の名前・色・大きさで上書き・追加する。形の違う値は無視する', () => {
    const reg = createKindRegistry({
      lib: { name: 'Python', color: '#112233' },
      widget: { name: 'ウィジェット', size: [1, 2, 3], layer: 'types' },
      bad: { color: 'red', size: [1, 2] as unknown as [number, number, number] },
    });
    expect(reg('lib')).toEqual({ ja: 'Python', color: '#112233', size: KINDS.lib!.size });
    expect(reg('widget')).toEqual({ ja: 'ウィジェット', color: '#9ca3af', size: [1, 2, 3] });
    expect(reg('bad')).toEqual({ ja: 'bad', color: '#9ca3af', size: [2.0, 0.5, 1.3] });
    expect(reg('page')).toBe(reg('page'));
    expect(reg('toString')).toMatchObject({ ja: 'toString' });
    // 既定の表は書き換えない
    expect(KINDS.lib!.ja).toBe('ライブラリ');
  });

  it('buildModel は graph.kinds を使う', () => {
    const graph: Graph = {
      version: 1,
      layers: [{ id: 'a', name: 'A' }],
      nodes: [{ id: 'job:x', layer: 'a', kind: 'job', name: 'x' }],
      edges: [],
      kinds: { job: { name: 'ジョブ', color: '#abcdef' } },
    };
    expect(buildModel(graph).byId.get('job:x')!.kind).toMatchObject({
      ja: 'ジョブ',
      color: '#abcdef',
    });
  });
});
