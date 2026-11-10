// 地図の射影と流れの、敵対的な graph.json での速さ・形（8-6 のセキュリティレビューの指摘。docs/20 §7.7）。
// - group の値の段の数: 以前は表示名の候補を「最後の 2 段〜全部」の全部作り、O(段²) の文字列でタブが落ちた
//   （64,000 段の group = 128KB の graph.json。`?prev=` も同じ道を通る）。候補は 8 つ以下、名前は NAME_MAX_LENGTH 以下
// - 同じ束に重なる線の数: mergeOverlaps が配列の includes で O(M²) だった
// - 接頭辞の表を `constructor` などで引くと、kind が関数になって v1 の検証を通らなかった
// 時間は壁時計ではなく CPU 時間で測る（pnpm -r の並列実行で待たされた分を数えない）。上限は遅い CI でも落ちない幅
import { describe, expect, it } from 'vitest';
import { validateGraph, type GraphV2, type NodeV2 } from '@stack-atlas/schema';
import { mapFlow } from '../map-flow.js';
import { edgeKey, NAME_MAX_LENGTH, projectMap, type MapProjection } from '../project-map.js';
import type { Schedule } from '../schedule.js';

const cpuMs = (f: () => void) => {
  const t0 = process.cpuUsage();
  f();
  const d = process.cpuUsage(t0);
  return (d.user + d.system) / 1000;
};

const fn = (id: string, extra: Partial<NodeV2> = {}): NodeV2 => ({
  id,
  kind: 'fn',
  name: id.slice(3),
  runtime: 'browser',
  ports: [],
  ...extra,
});

describe('group の値の段の数（直す前: 64,000 段で O(段²) の文字列を作ってタブが落ちた）', () => {
  it('64,000 段の group（128KB）: CPU 時間 100ms 未満、名前は NAME_MAX_LENGTH 以下', () => {
    const group = 'lib:' + Array.from({ length: 64_000 }, () => 'a').join('/');
    const g: GraphV2 = {
      version: 2,
      nodes: [fn('fn:a', { group }), fn('fn:b', { group })],
      wires: [],
    };
    let p: MapProjection | undefined;
    const ms = cpuMs(() => (p = projectMap(g)));
    expect(ms).toBeLessThan(100);
    expect(p!.graph.nodes).toHaveLength(1);
    expect(p!.graph.nodes[0]!.name).toBe('a/a');
  });

  it('最後の 8 段まで重なる深い group どうしは全部（頭を … にして NAME_MAX_LENGTH に収める）', () => {
    const deep = (head: string) =>
      `lib:${head}/` + Array.from({ length: 40 }, () => 'seg').join('/');
    const g: GraphV2 = {
      version: 2,
      nodes: [
        fn('fn:a', { group: deep('x') }),
        fn('fn:b', { group: deep('x') }),
        fn('fn:c', { group: deep('y') }),
        fn('fn:d', { group: deep('y') }),
      ],
      wires: [],
    };
    const names = projectMap(g).graph.nodes.map((n) => n.name);
    expect(names).toHaveLength(2);
    for (const n of names) {
      expect(n.length).toBe(NAME_MAX_LENGTH);
      expect(n.startsWith('…')).toBe(true);
    }
    expect(validateGraph(projectMap(g).graph).errors).toEqual([]);
  });

  it.each([
    [2000, 300],
    [500, 1000],
  ])('group %i 個 × %i 段: CPU 時間 500ms 未満（直す前は 1.9 秒・4.6 秒）', (G, S) => {
    const nodes = Array.from({ length: G }, (_, i) =>
      fn(`fn:f${i}`, { group: `lib:${i}/` + 'a/'.repeat(S) + 'x' }),
    );
    const g: GraphV2 = { version: 2, nodes, wires: [] };
    let p: MapProjection | undefined;
    const ms = cpuMs(() => (p = projectMap(g)));
    expect(p!.graph.nodes).toHaveLength(G);
    expect(ms).toBeLessThan(500);
  });
});

describe('mapFlow の同じ束に重なる線（直す前: O(M²)）', () => {
  it('1 つの束に 30,000 本の線が同時に重なる: 球 1 つ、CPU 時間 300ms 未満', () => {
    const M = 30_000;
    const wires = Array.from({ length: M }, (_, i) => `w${i}`);
    const p = {
      unitOf: new Map([
        ['fn:a', 'A'],
        ['fn:b', 'B'],
      ]),
      edges: new Map([[edgeKey('A', 'B'), { edge: { from: 'A', to: 'B', kind: 'uses' }, wires }]]),
    } as unknown as MapProjection;
    const balls = wires.map((key) => ({
      seg: {
        kind: 'wire',
        key,
        wire: { key },
        from: { node: { id: 'fn:a' } },
        to: { node: { id: 'fn:b' } },
      },
      t0: 0,
      dur: 1,
    }));
    const sched = { balls, end: 1, cycle: 1.6, skipped: [] } as unknown as Schedule;
    let f: ReturnType<typeof mapFlow> | undefined;
    const ms = cpuMs(() => (f = mapFlow(p, sched)));
    expect(f!.balls).toHaveLength(1);
    expect(f!.balls[0]!.wires).toHaveLength(M);
    expect(ms).toBeLessThan(300);
  });
});

describe('接頭辞の表は自分のプロパティだけ引く', () => {
  it('constructor: の id・group と __proto__ の group でも kind は文字列（v1 の検証を通る）', () => {
    const g: GraphV2 = {
      version: 2,
      nodes: [
        fn('constructor:x'),
        fn('fn:y', { group: 'constructor:grp' }),
        fn('fn:w', { group: '__proto__', runtime: 'server' }),
      ],
      wires: [],
    };
    const p = projectMap(g);
    expect(p.graph.nodes.map((n) => [n.id, n.kind])).toEqual([
      ['constructor:x', 'lib'],
      ['constructor:grp', 'lib'],
      ['group:__proto__', 'lib'],
    ]);
    expect(validateGraph(JSON.parse(JSON.stringify(p.graph))).errors).toEqual([]);
  });
});
