import { describe, expect, it } from 'vitest';
import type { Graph } from '@stack-atlas/schema';
import { buildModel, SCREEN_BASE_HEIGHT, SCREEN_BASE_WIDTH } from './model';
import { loadSampleGraph } from './testSample';

describe('buildModel (sample)', () => {
  const graph = loadSampleGraph();
  const model = buildModel(graph);

  it('全ノード・全エッジ・全フローを取り込む', () => {
    expect(model.nodes).toHaveLength(graph.nodes.length);
    expect(model.edges).toHaveLength(graph.edges.length);
    expect(model.flows.map((f) => f.id)).toEqual(['miss', 'hit', 'entry']);
  });

  it('out / inn の隣接リスト', () => {
    const api = model.byId.get('lib:apiClient')!;
    expect(api.out.map((e) => e.to).sort()).toEqual(
      [
        'handler:getRaces',
        'handler:postResult',
        'type:ApiResponse',
        'type:EntryInput',
        'type:Race',
        'type:RaceResult',
      ].sort(),
    );
    expect(api.inn.map((e) => e.from).sort()).toEqual(
      ['hook:useRaces', 'route:/admin/entry', 'route:/races/[id]'].sort(),
    );
  });

  it('layerIndex は layers の順番', () => {
    expect(model.byId.get('infra:cloudfront')!.layerIndex).toBe(0);
    expect(model.byId.get('route:/races')!.layerIndex).toBe(1);
    expect(model.byId.get('comp:Header')!.layerIndex).toBe(2);
    expect(model.byId.get('type:Race')!.layerIndex).toBe(3);
  });

  it('画面ノードはサンプルの 6 つ', () => {
    expect(model.nodes.filter((n) => n.isScreen).map((n) => n.id)).toEqual([
      'layout:/',
      'route:/login',
      'route:/admin/entry',
      'route:/',
      'route:/races',
      'route:/races/[id]',
    ]);
    expect(model.byId.get('route:/admin/entry')!.regions.map((r) => r.ref)).toContain(
      'comp:ResultTable',
    );
  });

  it('kind のメタを解決する', () => {
    expect(model.byId.get('infra:cloudfront')!.kind.ja).toBe('インフラリソース');
    expect(model.byId.get('type:Race')!.kind.size).toEqual([1.7, 0.35, 1.1]);
  });
});

describe('buildModel (edge cases)', () => {
  const g: Graph = {
    version: 1,
    layers: [
      { id: 'a', name: 'A' },
      { id: 'b', name: 'B' },
    ],
    nodes: [
      { id: 'p', layer: 'a', kind: 'page', name: '/p' },
      {
        id: 's',
        layer: 'a',
        kind: 'component',
        name: 'S',
        screen: {
          width: 100,
          height: 50,
          regions: [
            { ref: 'x', x: 0, y: 0, w: 1, h: 1 },
            { ref: 'p', x: 0, y: 0, w: 1, h: 1 },
          ],
        },
      },
      { id: 'w', layer: 'b', kind: 'widget', name: 'W' },
      { id: 'orphan', layer: 'nope', kind: 'type', name: 'O' },
      { id: 'w', layer: 'a', kind: 'type', name: 'dup' },
    ],
    edges: [
      { from: 'p', to: 'w', kind: 'uses' },
      { from: 'p', to: 'missing', kind: 'uses' },
      { from: 'orphan', to: 'w', kind: 'uses' },
    ],
    flows: [
      {
        id: 'f1',
        name: 'ok',
        steps: [
          { node: 'p', text: '' },
          { node: 'missing', text: '' },
          { node: 'w', text: '' },
        ],
      },
      {
        id: 'f2',
        name: 'short',
        steps: [
          { node: 'p', text: '' },
          { node: 'missing', text: '' },
        ],
      },
    ],
  };
  const m = buildModel(g);

  it('page / layout は screen がなくても画面（regions なしのプレースホルダ）', () => {
    const p = m.byId.get('p')!;
    expect(p.isScreen).toBe(true);
    expect(p.screen).toEqual({ width: SCREEN_BASE_WIDTH, height: SCREEN_BASE_HEIGHT, regions: [] });
  });

  it('screen フィールドがあれば kind に関係なく画面。存在しない ref の region は捨てる', () => {
    const s = m.byId.get('s')!;
    expect(s.isScreen).toBe(true);
    expect(s.regions.map((r) => r.ref)).toEqual(['p']);
  });

  it('未知の kind は汎用ボックス', () => {
    const w = m.byId.get('w')!;
    expect(w.isScreen).toBe(false);
    expect(w.kind).toEqual({ ja: 'widget', color: '#9ca3af', size: [2.0, 0.5, 1.3] });
  });

  it('未知の層のノード、重複 ID、端点のないエッジ、短くなったフローは取り除く', () => {
    expect(m.nodes.map((n) => n.id)).toEqual(['p', 's', 'w']);
    expect(m.byId.get('w')!.node.name).toBe('W');
    expect(m.edges).toHaveLength(1);
    expect(m.byId.get('w')!.inn).toHaveLength(1);
    expect(m.flows.map((f) => f.id)).toEqual(['f1']);
    expect(m.flows[0]!.steps.map((s) => s.node)).toEqual(['p', 'w']);
  });
});
