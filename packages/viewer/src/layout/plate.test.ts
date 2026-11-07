import { describe, expect, it } from 'vitest';
import { buildModel } from '../graph/model';
import { loadSampleGraph } from '../graph/testSample';
import { computeSceneLayout, layerBaseY, layerY } from './plate';

describe('layerBaseY', () => {
  it('N 層を 0 を中心に 7.5 間隔で並べ、index 0 が最上段', () => {
    expect([0, 1, 2, 3].map((i) => layerBaseY(i, 4))).toEqual([11.25, 3.75, -3.75, -11.25]);
    expect([0, 1].map((i) => layerBaseY(i, 2))).toEqual([3.75, -3.75]);
    expect(layerBaseY(0, 1)).toBe(0);
    const six = [0, 1, 2, 3, 4, 5].map((i) => layerBaseY(i, 6));
    expect(six[0]).toBe(18.75);
    expect(six.reduce((a, b) => a + b, 0)).toBe(0);
  });
  it('重ねると 7% に縮む', () => {
    expect(layerY(0, 4, 0)).toBeCloseTo(11.25 * 0.07);
    expect(layerY(0, 4, 1)).toBeCloseTo(11.25);
  });
});

describe('computeSceneLayout', () => {
  it('position のあるノードはそのまま', () => {
    const l = computeSceneLayout(buildModel(loadSampleGraph()));
    expect(l.positions.get('infra:cloudfront')).toEqual({ x: -11, z: 0 });
    expect(l.plate.width).toBeGreaterThanOrEqual(41);
    expect(l.plate.depth).toBeGreaterThanOrEqual(20);
  });
  it('position を全部消しても全ノードに座標が付く', () => {
    const g = loadSampleGraph();
    for (const n of g.nodes) delete n.position;
    const m = buildModel(g);
    const l = computeSceneLayout(m);
    for (const n of m.nodes) {
      const p = l.positions.get(n.id);
      expect(p, n.id).toBeDefined();
      expect(Number.isFinite(p!.x) && Number.isFinite(p!.z)).toBe(true);
    }
  });
});
