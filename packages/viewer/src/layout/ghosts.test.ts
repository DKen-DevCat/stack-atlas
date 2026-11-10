import { describe, expect, it } from 'vitest';
import { buildModel } from '../graph/model';
import { loadSampleGraph } from '../graph/testSample';
import { GHOST_SIZE, placeGhosts, plateWithGhosts } from './ghosts';
import { computeSceneLayout, footprintOf } from './plate';

describe('placeGhosts', () => {
  const prev = loadSampleGraph();
  const next = structuredClone(prev);
  const removedIds = next.nodes.filter((n) => n.kind === 'type').map((n) => n.id);
  next.nodes = next.nodes.filter((n) => !removedIds.includes(n.id));
  next.edges = next.edges.filter((e) => !removedIds.includes(e.from) && !removedIds.includes(e.to));
  // 削除した場所に新しいノードを置き、重なりを避けるか見る
  const first = prev.nodes.find((n) => n.id === removedIds[0])!;
  next.nodes.push({ ...first, id: 'type:Taken', name: 'Taken' });
  const model = buildModel(next);
  const layout = computeSceneLayout(model);

  it('削除ノードを今の層に割り当て、今のノードと重ならない位置に置く', () => {
    const g = placeGhosts(model, layout.positions, prev, removedIds);
    expect([...g.keys()].sort()).toEqual([...removedIds].sort());
    const typeLayer = model.layers.findIndex((l) => l.id === first.layer);
    for (const p of g.values()) expect(p.layerIndex).toBe(typeLayer);
    for (const n of model.nodes.filter((m) => m.layerIndex === typeLayer)) {
      const p = layout.positions.get(n.id)!;
      const f = footprintOf(n);
      for (const q of g.values()) {
        const apart =
          Math.abs(p.x - q.x) >= (f.w + GHOST_SIZE[0]) / 2 ||
          Math.abs(p.z - q.z) >= (f.d + GHOST_SIZE[2]) / 2;
        expect(apart).toBe(true);
      }
    }
    // ゴースト同士も重ならない
    const list = [...g.values()];
    for (let i = 0; i < list.length; i++)
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i]!;
        const b = list[j]!;
        expect(Math.abs(a.x - b.x) >= GHOST_SIZE[0] || Math.abs(a.z - b.z) >= GHOST_SIZE[2]).toBe(
          true,
        );
      }
    const plate = plateWithGhosts(layout.plate, g.values());
    for (const p of g.values()) expect(Math.abs(p.x)).toBeLessThan(plate.width / 2);
  });

  it('今の graph に無い層のノードは置かない', () => {
    const p2 = structuredClone(prev);
    p2.layers.push({ id: 'gone', name: 'gone', color: '#000000' });
    p2.nodes.push({ id: 'x:gone', layer: 'gone', kind: 'lib', name: 'G' });
    expect(placeGhosts(model, layout.positions, p2, ['x:gone']).size).toBe(0);
  });
});
