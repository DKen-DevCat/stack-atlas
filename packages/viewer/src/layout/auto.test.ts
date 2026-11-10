import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildModel } from '../graph/model';
import { makeSyntheticGraph } from '../graph/synthetic';
import {
  autoLayout,
  LABEL_W,
  targetRows,
  type LayoutEdgeInput,
  type LayoutNodeInput,
  type LayoutResult,
} from './auto';
import { footprintOf } from './plate';

const EPS = 1e-6;

function n(
  id: string,
  layer: number,
  w = 2,
  d = 1.3,
  fixed?: { x: number; z: number },
): LayoutNodeInput {
  return { id, layer, footprint: { w, d }, ...(fixed ? { fixed } : {}) };
}

function overlaps(nodes: readonly LayoutNodeInput[], res: LayoutResult): string[] {
  const bad: string[] = [];
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i]!;
      const b = nodes[j]!;
      if (a.layer !== b.layer) continue;
      const pa = res.positions.get(a.id)!;
      const pb = res.positions.get(b.id)!;
      const ox = (a.footprint.w + b.footprint.w) / 2 - Math.abs(pa.x - pb.x);
      const oz = (a.footprint.d + b.footprint.d) / 2 - Math.abs(pa.z - pb.z);
      if (ox > EPS && oz > EPS) bad.push(`${a.id} x ${b.id}`);
    }
  }
  return bad;
}

function outside(nodes: readonly LayoutNodeInput[], res: LayoutResult): string[] {
  const bad: string[] = [];
  for (const nd of nodes) {
    const p = res.positions.get(nd.id)!;
    if (
      Math.abs(p.x) + nd.footprint.w / 2 > res.plate.width / 2 + EPS ||
      Math.abs(p.z) + nd.footprint.d / 2 > res.plate.depth / 2 + EPS
    )
      bad.push(nd.id);
  }
  return bad;
}

function expectSane(nodes: readonly LayoutNodeInput[], res: LayoutResult): void {
  expect(res.positions.size).toBe(nodes.length);
  expect(overlaps(nodes, res)).toEqual([]);
  expect(outside(nodes, res)).toEqual([]);
}

function seeded(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

describe('autoLayout basics', () => {
  it('handles 0 nodes', () => {
    const r = autoLayout([], []);
    expect(r.positions.size).toBe(0);
    expect(r.plate.width).toBeGreaterThanOrEqual(41);
    expect(r.plate.depth).toBeGreaterThanOrEqual(20);
  });

  it('handles an empty edge list', () => {
    const nodes = [n('a', 0), n('b', 0), n('c', 1), n('d', 1), n('e', 2)];
    expectSane(nodes, autoLayout(nodes, []));
  });

  it('places a single child directly below its single parent', () => {
    const nodes = [n('p', 0), n('q', 0), n('c', 1)];
    const r = autoLayout(nodes, [{ from: 'q', to: 'c' }]);
    expect(Math.abs(r.positions.get('c')!.x - r.positions.get('q')!.x)).toBeLessThan(0.01);
    expectSane(nodes, r);
  });

  it('places a child at the mean x of two parents', () => {
    const nodes = [n('a', 0), n('b', 0), n('c', 0), n('k', 1)];
    const edges: LayoutEdgeInput[] = [
      { from: 'a', to: 'k' },
      { from: 'k', to: 'c' }, // either direction counts
    ];
    const r = autoLayout(nodes, edges);
    const mean = (r.positions.get('a')!.x + r.positions.get('c')!.x) / 2;
    expect(Math.abs(r.positions.get('k')!.x - mean)).toBeLessThan(0.01);
  });

  it('works with 2 layers and with 6 layers', () => {
    const two = [n('a', 0), n('b', 1)];
    expectSane(two, autoLayout(two, [{ from: 'a', to: 'b' }]));
    const six: LayoutNodeInput[] = [];
    const edges: LayoutEdgeInput[] = [];
    for (let l = 0; l < 6; l++) {
      for (let i = 0; i < 5; i++) {
        six.push(n(`n${l}_${i}`, l));
        if (l > 0) edges.push({ from: `n${l - 1}_${i}`, to: `n${l}_${i}` });
      }
    }
    const r = autoLayout(six, edges);
    expectSane(six, r);
    expect(Math.abs(r.positions.get('n5_2')!.x - r.positions.get('n0_2')!.x)).toBeLessThan(0.5);
  });

  it('never moves fixed nodes and keeps free nodes off them', () => {
    const fx = { x: 0, z: 0 };
    const nodes = [n('top', 0), n('fx', 1, 2, 1.3, fx), n('a', 1), n('b', 1), n('c', 1)];
    const edges: LayoutEdgeInput[] = ['a', 'b', 'c'].map((to) => ({ from: 'top', to }));
    const r = autoLayout(nodes, edges);
    expect(r.positions.get('fx')).toEqual(fx);
    expectSane(nodes, r);
  });

  it('keeps fixed nodes inside the plate by growing it', () => {
    const nodes = [n('far', 0, 2, 1.3, { x: 100, z: -40 }), n('a', 0)];
    expectSane(nodes, autoLayout(nodes, []));
  });

  it('splits into z rows when a layer is too wide, preferring screens in their own rows', () => {
    const nodes: LayoutNodeInput[] = [n('root', 0)];
    const edges: LayoutEdgeInput[] = [];
    for (let i = 0; i < 8; i++) {
      nodes.push(n(`s${i}`, 1, 6.4, 4.2));
      edges.push({ from: 'root', to: `s${i}` });
    }
    for (let i = 0; i < 3; i++) nodes.push(n(`c${i}`, 1));
    const r = autoLayout(nodes, edges);
    expectSane(nodes, r);
    const zs = new Set(
      nodes.filter((x) => x.id.startsWith('s')).map((x) => r.positions.get(x.id)!.z),
    );
    expect(zs.size).toBeGreaterThan(1);
    for (const x of nodes.filter((q) => q.id.startsWith('c'))) {
      expect(zs.has(r.positions.get(x.id)!.z)).toBe(false);
    }
  });

  it('respects plate options', () => {
    const r = autoLayout([n('a', 0)], [], { minPlateWidth: 80, minPlateDepth: 50 });
    expect(r.plate.width).toBeGreaterThanOrEqual(80);
    expect(r.plate.depth).toBeGreaterThanOrEqual(50);
  });
});

describe('label-aware spacing', () => {
  it('keeps same-row non-screen centers at least LABEL_W + gap apart', () => {
    const nodes: LayoutNodeInput[] = [];
    for (let i = 0; i < 12; i++) nodes.push(n(`a${i}`, 0, 1.6, 1.2));
    for (let i = 0; i < 4; i++) nodes.push(n(`b${i}`, 1, 2, 1.3));
    const r = autoLayout(nodes, []);
    for (const layer of [0, 1]) {
      const ps = nodes.filter((x) => x.layer === layer).map((x) => r.positions.get(x.id)!);
      for (let i = 0; i < ps.length; i++)
        for (let j = i + 1; j < ps.length; j++)
          if (Math.abs(ps[i]!.z - ps[j]!.z) < 1e-6)
            expect(Math.abs(ps[i]!.x - ps[j]!.x)).toBeGreaterThanOrEqual(LABEL_W + 1.6 - 1e-6);
    }
  });

  it('spreads a 9-node layer over rows or a wide plate, centered on z = 0', () => {
    const nodes = [n('top', 0), ...Array.from({ length: 9 }, (_, i) => n(`i${i}`, 1, 2.6, 1.8))];
    const edges = nodes.slice(1).map((x) => ({ from: 'top', to: x.id }));
    const r = autoLayout(nodes, edges);
    expectSane(nodes, r);
    const zs = new Set(nodes.slice(1).map((x) => r.positions.get(x.id)!.z));
    expect(zs.size >= 2 || r.plate.width >= 9 * (LABEL_W + 1.6)).toBe(true);
    const zl = [...zs];
    expect(Math.min(...zl) + Math.max(...zl)).toBeCloseTo(0, 6);
    expect(r.plate.depth).toBeLessThanOrEqual(20 + EPS);
  });

  it('keeps screens at least 1.0 apart and in two rows of three for six screens', () => {
    const nodes = [n('top', 0), ...Array.from({ length: 6 }, (_, i) => n(`s${i}`, 1, 6.4, 4.2))];
    const r = autoLayout(
      nodes,
      nodes.slice(1).map((x) => ({ from: 'top', to: x.id })),
    );
    expectSane(nodes, r);
    const byZ = new Map<number, number[]>();
    for (const x of nodes.slice(1)) {
      const p = r.positions.get(x.id)!;
      byZ.set(
        p.z,
        [...(byZ.get(p.z) ?? []), p.x].sort((a, b) => a - b),
      );
    }
    expect([...byZ.values()].map((v) => v.length)).toEqual([3, 3]);
    for (const xs of byZ.values())
      for (let i = 1; i < xs.length; i++)
        expect(xs[i]! - xs[i - 1]! - 6.4).toBeGreaterThanOrEqual(1);
  });
});

describe('determinism', () => {
  const make = () => {
    const rnd = seeded(7);
    const nodes: LayoutNodeInput[] = [];
    const edges: LayoutEdgeInput[] = [];
    for (let l = 0; l < 4; l++)
      for (let i = 0; i < 12; i++) nodes.push(n(`n${l}_${i}`, l, 1.6 + (i % 3) * 0.3, 1.2));
    for (let l = 1; l < 4; l++)
      for (let i = 0; i < 12; i++)
        edges.push({ from: `n${l - 1}_${Math.floor(rnd() * 12)}`, to: `n${l}_${i}` });
    return { nodes, edges };
  };

  it('same input gives deep-equal output', () => {
    const { nodes, edges } = make();
    expect(autoLayout(nodes, edges)).toEqual(autoLayout(nodes, edges));
  });

  it('is independent of input order (ties are broken by id)', () => {
    const { nodes, edges } = make();
    const rnd = seeded(99);
    const shuffle = <T>(a: readonly T[]): T[] => {
      const out = [...a];
      for (let i = out.length - 1; i > 0; i--) {
        const j = Math.floor(rnd() * (i + 1));
        [out[i], out[j]] = [out[j]!, out[i]!];
      }
      return out;
    };
    const a = autoLayout(nodes, edges);
    const b = autoLayout(shuffle(nodes), shuffle(edges));
    expect(b.plate).toEqual(a.plate);
    for (const [id, p] of a.positions) expect(b.positions.get(id)).toEqual(p);
  });
});

interface GraphFile {
  layers: { id: string }[];
  nodes: { id: string; layer: string; kind: string; position?: unknown }[];
  edges: { from: string; to: string }[];
}

const FOOTPRINTS: Record<string, { w: number; d: number }> = {
  actor: { w: 1.6, d: 1.6 },
  infra: { w: 2.6, d: 1.8 },
  component: { w: 2.0, d: 1.3 },
  hook: { w: 1.8, d: 1.2 },
  lib: { w: 2.0, d: 1.3 },
  type: { w: 1.7, d: 1.1 },
  schema: { w: 1.9, d: 1.2 },
  handler: { w: 2.2, d: 1.4 },
};

describe('race-site sample', () => {
  const path = resolve(__dirname, '../../../../examples/race-site.graph.json');
  const g = JSON.parse(readFileSync(path, 'utf8')) as GraphFile;
  const layerIndex = new Map(g.layers.map((l, i) => [l.id, i]));
  const nodes: LayoutNodeInput[] = g.nodes.map((nd) => ({
    id: nd.id,
    layer: layerIndex.get(nd.layer)!,
    footprint:
      nd.kind === 'page' || nd.kind === 'layout'
        ? { w: 6.4, d: 4.2 }
        : (FOOTPRINTS[nd.kind] ?? { w: 2, d: 1.3 }),
  }));
  const res = autoLayout(nodes, g.edges);

  it('has no overlaps and stays inside the plate', () => {
    expectSane(nodes, res);
  });

  it('puts the route screens under Lambda (Next)', () => {
    const lambdaX = res.positions.get('infra:lambdaNext')!.x;
    const routes = nodes.filter((x) => x.layer === 1);
    const mean = routes.reduce((s, x) => s + res.positions.get(x.id)!.x, 0) / routes.length;
    expect(Math.abs(mean - lambdaX)).toBeLessThan(6);
  });

  it('prints an ASCII summary', () => {
    const lines = [`plate ${res.plate.width.toFixed(1)} x ${res.plate.depth.toFixed(1)}`];
    g.layers.forEach((l, li) => {
      const items = nodes
        .filter((x) => x.layer === li)
        .map((x) => ({ id: x.id, ...res.positions.get(x.id)! }))
        .sort((a, b) => a.z - b.z || a.x - b.x);
      lines.push(`[${li}] ${l.id}`);
      let lastZ = NaN;
      let row = '';
      for (const it of items) {
        if (it.z !== lastZ) {
          if (row) lines.push(row);
          row = `  z=${it.z.toFixed(1).padStart(5)} |`;
          lastZ = it.z;
        }
        row += ` ${it.id}@${it.x.toFixed(1)}`;
      }
      if (row) lines.push(row);
    });
    console.log(lines.join('\n'));
    expect(lines.length).toBeGreaterThan(4);
  });
});

describe('scale', () => {
  it('lays out 600 nodes over 4 layers quickly', () => {
    const rnd = seeded(12345);
    const nodes: LayoutNodeInput[] = [];
    const edges: LayoutEdgeInput[] = [];
    const per = 150;
    for (let l = 0; l < 4; l++) {
      for (let i = 0; i < per; i++) {
        const screen = l === 1 && i % 5 === 0;
        nodes.push(
          n(
            `n${l}_${i}`,
            l,
            screen ? 6.4 : 1.6 + Math.floor(rnd() * 4) * 0.3,
            screen ? 4.2 : 1.1 + rnd() * 0.5,
          ),
        );
      }
    }
    for (let l = 0; l < 4; l++) {
      for (let i = 0; i < per; i++) {
        if (l > 0) {
          const k = 1 + Math.floor(rnd() * 2);
          for (let c = 0; c < k; c++)
            edges.push({ from: `n${l - 1}_${Math.floor(rnd() * per)}`, to: `n${l}_${i}` });
        } else if (rnd() < 0.5) {
          edges.push({ from: `n0_${i}`, to: `n0_${Math.floor(rnd() * per)}` });
        }
      }
    }
    const t0 = performance.now();
    const r = autoLayout(nodes, edges);
    const ms = performance.now() - t0;
    expect(ms).toBeLessThan(500);
    expectSane(nodes, r);
  });
});

describe('growth (Phase 7: 中身に合わせて板を広げる)', () => {
  const synth = () => {
    const g = makeSyntheticGraph();
    const m = buildModel(g);
    const nodes: LayoutNodeInput[] = m.nodes.map((x) => ({
      id: x.id,
      layer: x.layerIndex,
      footprint: footprintOf(x),
      screen: x.isScreen,
    }));
    return { m, nodes, edges: g.edges.map((e) => ({ from: e.from, to: e.to })) };
  };
  const rowsOf = (nodes: readonly LayoutNodeInput[], res: LayoutResult, layer: number) => {
    const zs = new Map<number, number[]>();
    for (const x of nodes) {
      if (x.layer !== layer) continue;
      const p = res.positions.get(x.id)!;
      const k = Math.round(p.z * 1000) / 1000;
      zs.set(
        k,
        [...(zs.get(k) ?? []), p.x].sort((a, b) => a - b),
      );
    }
    return [...zs.entries()].sort((a, b) => a[0] - b[0]).map(([, xs]) => xs);
  };

  it('targetRows: ceil(sqrt(n / 6)) を 1..4 に収める', () => {
    expect([0, 1, 6, 7, 24, 25, 54, 55, 96, 97, 300].map(targetRows)).toEqual([
      1, 1, 1, 2, 2, 3, 3, 4, 4, 4, 4,
    ]);
  });

  it('250 ノードの合成 graph: 板が広がり、段は 4 以下、重なりなし、ラベル幅のピッチを守る', () => {
    const { nodes, edges } = synth();
    expect(nodes.length).toBe(250);
    const r = autoLayout(nodes, edges);
    expectSane(nodes, r);
    expect(r.plate.width).toBeGreaterThan(100);
    expect(r.plate.depth).toBeGreaterThan(20);
    for (const layer of [0, 2, 3]) {
      const rows = rowsOf(
        nodes.filter((x) => !x.screen),
        r,
        layer,
      );
      expect(rows.length, `layer ${layer}`).toBeLessThanOrEqual(4);
      for (const xs of rows)
        for (let i = 1; i < xs.length; i++)
          expect(xs[i]! - xs[i - 1]!).toBeGreaterThanOrEqual(LABEL_W + 1.6 - 1e-6);
    }
    // 画面（14 枚）は 1 段 3 枚まで → 5 段
    const screens = rowsOf(
      nodes.filter((x) => x.screen),
      r,
      1,
    );
    expect(screens.length).toBe(5);
    for (const xs of screens) expect(xs.length).toBeLessThanOrEqual(3);
  });

  it('画面 12 枚は 4 段になり、板の奥行きが 20 を超える', () => {
    const nodes = [n('top', 0), ...Array.from({ length: 12 }, (_, i) => n(`s${i}`, 1, 6.4, 4.2))];
    const r = autoLayout(
      nodes,
      nodes.slice(1).map((x) => ({ from: 'top', to: x.id })),
    );
    expectSane(nodes, r);
    expect(rowsOf(nodes.slice(1), r, 1).map((xs) => xs.length)).toEqual([3, 3, 3, 3]);
    expect(r.plate.depth).toBeGreaterThan(20);
  });

  it('小さな graph は 41 × 20 のまま（fixture の見た目を変えない）', () => {
    const nodes = [n('a', 0), n('b', 0), n('c', 1), n('d', 1), n('e', 2)];
    const r = autoLayout(nodes, [{ from: 'a', to: 'c' }]);
    expect(r.plate).toEqual({ width: 41, depth: 20 });
  });

  it('決定的で、全体が x の中央に寄っている', () => {
    const { nodes, edges } = synth();
    const a = autoLayout(nodes, edges);
    expect(autoLayout(nodes, edges)).toEqual(a);
    let lo = Infinity;
    let hi = -Infinity;
    for (const x of nodes) {
      const p = a.positions.get(x.id)!;
      const w = Math.max(x.footprint.w, LABEL_W);
      lo = Math.min(lo, p.x - w / 2);
      hi = Math.max(hi, p.x + w / 2);
    }
    expect(Math.abs(lo + hi)).toBeLessThan(1e-6);
  });
});
