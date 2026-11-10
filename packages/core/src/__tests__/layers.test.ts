import { describe, expect, it } from 'vitest';
import { assignLayers } from '../layers.js';
import { DEFAULT_LAYERS } from '../types.js';

describe('assignLayers', () => {
  it('kind から既定の層を割り当てる', () => {
    const { graph, issues } = assignLayers(
      {
        nodes: [
          { id: 'infra:cdn', kind: 'infra' },
          { id: 'route:/', kind: 'page' },
          { id: 'comp:A', kind: 'component' },
          { id: 'type:T', kind: 'type' },
          { id: 'x', kind: 'component', layer: 'types' },
        ],
        edges: [],
      },
      {},
    );
    expect(graph.layers).toEqual(DEFAULT_LAYERS);
    expect(graph.nodes.map((n) => n.layer)).toEqual([
      'infra',
      'routes',
      'components',
      'types',
      'types',
    ]);
    expect(issues).toEqual([]);
  });

  it('config.layers と config.layerOf を使い、未知の kind は警告して最後の層', () => {
    const { graph, issues } = assignLayers(
      {
        nodes: [
          { id: 'q:1', kind: 'queue' },
          { id: 'h:1', kind: 'hook' },
          { id: 'w:1', kind: 'widget' },
        ],
        edges: [],
      },
      {
        layers: [
          { id: 'top', name: 'Top' },
          { id: 'bottom', name: 'Bottom' },
        ],
        layerOf: { queue: 'top', hook: 'top' },
      },
    );
    expect(graph.nodes.map((n) => n.layer)).toEqual(['top', 'top', 'bottom']);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ level: 'warning', path: '/nodes/2/layer' });
  });

  it('存在しない層を指すノードはエラー', () => {
    const { issues } = assignLayers(
      { nodes: [{ id: 'a', kind: 'infra', layer: 'nowhere' }], edges: [] },
      {},
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]!.level).toBe('error');
    expect(issues[0]!.message).toMatch(/nowhere/);
  });

  it('抽出器が出した層は既定の層の後ろに足す', () => {
    const { graph } = assignLayers(
      {
        layers: [
          { id: 'infra', name: 'X' },
          { id: 'extra', name: 'Extra' },
        ],
        nodes: [],
        edges: [],
      },
      {},
    );
    expect(graph.layers.map((l) => l.id)).toEqual([
      'infra',
      'routes',
      'components',
      'types',
      'extra',
    ]);
    expect(graph.layers[0]!.name).toBe('インフラ');
  });
});
