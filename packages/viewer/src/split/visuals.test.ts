// 2 面の地図の見た目（Q20 のモックの提案の規則。docs/20 §6）: 範囲は不透明度だけ、閉包の赤と橙を使わない、hover は沈めない
import { describe, expect, it } from 'vitest';
import type { Graph } from '@stack-atlas/schema';
import { edgeKey } from '@stack-atlas/wiring';
import { buildModel } from '../graph/model';
import { HIGHLIGHT_COLORS, initialState } from '../state';
import { DIM_EDGE_OPACITY, LIT_EDGE_OPACITY, linkedVisuals } from './visuals';

const graph: Graph = {
  version: 1,
  layers: [
    { id: 'browser', name: 'ブラウザ' },
    { id: 'server', name: 'サーバー' },
  ],
  nodes: [
    { id: 'route:/', layer: 'browser', kind: 'page', name: '/' },
    { id: 'lib:fetcher', layer: 'browser', kind: 'lib', name: 'fetcher' },
    { id: 'endpoint:GET /a', layer: 'server', kind: 'endpoint', name: 'GET /a' },
    { id: 'lib:other', layer: 'browser', kind: 'lib', name: 'other' },
  ],
  edges: [
    { from: 'route:/', to: 'lib:fetcher', kind: 'uses' },
    { from: 'lib:fetcher', to: 'endpoint:GET /a', kind: 'http' },
    { from: 'lib:other', to: 'lib:fetcher', kind: 'uses' },
  ],
};
const model = buildModel(graph);

describe('linkedVisuals（8-6）', () => {
  it('配線図の選択を写したものだけが通常の色で光り、ほかは沈む。線は不透明度だけ（赤と橙にしない）', () => {
    const state = { ...initialState(2, 4), selectedId: 'route:/', hoverId: 'lib:other' };
    const v = linkedVisuals(model, state, null, {
      nodes: new Set(['route:/', 'lib:fetcher', 'endpoint:GET /a']),
      edges: new Set([
        edgeKey('route:/', 'lib:fetcher'),
        edgeKey('lib:fetcher', 'endpoint:GET /a'),
      ]),
      starts: new Set(['route:/']),
    });
    expect(v.hl.a).toBeNull();
    expect(v.nodes.get('route:/')!.visual).toBe('normal');
    expect(v.nodes.get('endpoint:GET /a')!.visual).toBe('normal');
    // hover（lib:other）は効かない
    expect(v.nodes.get('lib:other')!.visual).toBe('dim');
    expect(v.edges.map((e) => e.opacity)).toEqual([
      LIT_EDGE_OPACITY,
      LIT_EDGE_OPACITY,
      DIM_EDGE_OPACITY,
    ]);
    const colors = new Set(v.edges.map((e) => e.color));
    expect(colors.has(HIGHLIGHT_COLORS.down)).toBe(false);
    expect(colors.has(HIGHLIGHT_COLORS.up)).toBe(false);
  });

  it('選択が無いときの hover は、つながる線を少し明るくするだけ（ほかを沈めない）', () => {
    const state = { ...initialState(2, 4), hoverId: 'lib:fetcher' };
    const v = linkedVisuals(model, state, null, null);
    expect([...v.nodes.values()].every((n) => n.visual === 'normal')).toBe(true);
    const base = linkedVisuals(model, initialState(2, 4), null, null);
    expect(v.edges[0]!.opacity).toBeGreaterThan(base.edges[0]!.opacity);
    expect(v.edges[2]!.opacity).toBeGreaterThan(base.edges[2]!.opacity);
  });
});
