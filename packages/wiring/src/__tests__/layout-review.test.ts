// 8-3a のレビュー（2026-11-09）で見つかったことを固定する: 列の中の塊（初めの順）・切れている線の印・並べ方の悪さの
// 物差し・列の割り当て・同点の崩し方・トラックの割り当て・引数の展開・交差の数え方の NaN。
// 大きな入力での速さ（二乗の計算）は layout-perf.test.ts
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { GraphV2 } from '@stack-atlas/schema';
import { indexGraph } from '../graph-index.js';
import { arrange, layoutWiring, BROKEN_CUT } from '../layout/index.js';
import { assignLayers } from '../layout/layers.js';
import type { Cfg, Chain, ChainPoint } from '../layout/model.js';
import { inversions } from '../layout/place.js';
import { assignTracks, placeX, type VSeg } from '../layout/route.js';
import { I, N, P } from './fixture.js';
import { allRoutes, hostOverlaps } from './metrics.js';

const read = (rel: string) =>
  JSON.parse(readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')) as GraphV2;
const baseline = () => read('./fixtures/poly-82a.v2.json');
const today = () => read('../../../../examples/fixture-poly.today.v2.json');

const fn = (id: string, extra: Partial<Parameters<typeof N>[4]> = {}) =>
  N(id, 'fn', 'server', [P('in', 'in', [I('x', 'int')])], extra);

describe('列の中の塊は初めの順でも割らない（#1）', () => {
  // 線が無いので往復は初めの順より良くならず、初めの順がそのまま残る（以前は y の順だけで並べ、塊を割っていた）
  it('host の中の箱の間に外の箱を挟まない（枠が外の箱に重ならない）', () => {
    const g: GraphV2 = {
      version: 2,
      nodes: [
        N('infra:h', 'infra', 'server', []),
        fn('fn:a', { host: 'infra:h' }),
        fn('fn:z'),
        fn('fn:b', { host: 'infra:h' }),
      ],
      wires: [],
    };
    const l = layoutWiring(indexGraph(g));
    expect(hostOverlaps(l)).toEqual([]);
    const y = (id: string) => l.boxes.get(id)!.y;
    expect(y('fn:a') < y('fn:z')).toBe(y('fn:b') < y('fn:z'));
    expect(new Set([...l.boxes.values()].map((b) => b.col)).size).toBe(1);
  });

  it('同じ group の箱の間にほかの group の箱を挟まない', () => {
    const g: GraphV2 = {
      version: 2,
      nodes: [
        fn('fn:a', { group: 'g1' }),
        fn('fn:z', { group: 'g2' }),
        fn('fn:b', { group: 'g1' }),
      ],
      wires: [],
    };
    const l = layoutWiring(indexGraph(g));
    const y = (id: string) => l.boxes.get(id)!.y;
    expect(y('fn:a') < y('fn:z')).toBe(y('fn:b') < y('fn:z'));
  });

  it('見つかったこと: /today の例の 45 交差は group を割った並びだった（lib:fetcher が feature/spend の間）', () => {
    // 塊を割らない今は、fetcher は spend の 3 箱の外。api と store も host の中で group ごと
    const l = layoutWiring(indexGraph(today()));
    const inCol = (id: string) =>
      [...l.boxes.values()]
        .filter((b) => b.col === l.boxes.get(id)!.col)
        .sort((a, b) => a.y - b.y)
        .map((b) => b.id);
    const col2 = inCol('lib:fetcher');
    const spend = ['fn:getToday', 'fn:toTodayView', 'fn:createTransaction'].map((id) =>
      col2.indexOf(id),
    );
    expect(Math.max(...spend) - Math.min(...spend)).toBe(2);
    const col4 = inCol('fn:internal/api.handleToday');
    const api = col4.filter((id) => id.startsWith('fn:internal/api.'));
    const first = col4.indexOf(api[0]!);
    expect(col4.slice(first, first + api.length)).toEqual(api);
  });
});

describe('切れている線は印の手前で横の区間で終わる（#2）', () => {
  it.each([
    ['/today の例', today],
    ['基準の graph', baseline],
  ])(
    '%s: 最後の区間は横で BROKEN_CUT 以上。印（縦 ±5px）はどの線の縦の区間にも重ならない',
    (_n, make) => {
      const l = layoutWiring(indexGraph(make()));
      expect(l.broken.length).toBeGreaterThan(0);
      const vertical = allRoutes(l).flatMap((r) =>
        r.points.slice(1).flatMap((b, i) => {
          const a = r.points[i]!;
          return a.x === b.x && a.y !== b.y
            ? [{ x: a.x, y0: Math.min(a.y, b.y), y1: Math.max(a.y, b.y) }]
            : [];
        }),
      );
      for (const br of l.broken) {
        const pts = br.route.points;
        const a = pts[pts.length - 2]!;
        const z = pts[pts.length - 1]!;
        expect(a.y, br.key).toBe(z.y);
        expect(z.x - a.x, br.key).toBeGreaterThanOrEqual(BROKEN_CUT);
        for (const v of vertical)
          expect(v.x === z.x && v.y0 < z.y + 5 && z.y - 5 < v.y1, `${br.key} の印`).toBe(false);
      }
    },
  );

  it('見つかったこと: 以前は /today の b0 の印が、いちばん右のトラック（列の 16px 手前）の縦の区間の上にあった', () => {
    const l = layoutWiring(indexGraph(today()));
    const b0 = l.broken.find((b) => b.key === 'b0')!;
    const pts = b0.route.points;
    const tb = [...l.boxes.values()].find((b) => b.x - BROKEN_CUT === pts[pts.length - 1]!.x)!;
    // 切れている線の通り道は、いちばん右のトラックと箱の間に 2 × BROKEN_CUT 以上を空ける
    const ch = l.channels.find((c) => c.x + c.w === tb.x)!;
    const tracks = allRoutes(l)
      .flatMap((r) => r.points.filter((p, i) => i > 0 && r.points[i - 1]!.x === p.x))
      .map((p) => p.x)
      .filter((x) => x > ch.x && x < ch.x + ch.w);
    expect(tb.x - Math.max(...tracks)).toBeGreaterThanOrEqual(2 * BROKEN_CUT);
  });
});

describe('並べ方の悪さは並びだけで決まる（#3）', () => {
  it('score は今の y に依らない: 回の初めの PAVA の位置でも、往復の後の積んだ位置でも同じ', () => {
    // 以前は今の y で測ったので、2 回目からの基準（PAVA の位置）と往復の後（積んだ位置）で同じ列の中の線の長さが食い違った
    const { placer } = arrange(indexGraph(today()));
    const s = placer.score();
    for (let k = 0; k < placer.cols.length; k++) placer.stack(k);
    expect(placer.score()).toBe(s);
    for (const col of placer.cols) col.forEach((e, i) => (e.y = (i * 7919) % 1000));
    expect(placer.score()).toBe(s);
  });
});

describe('列の割り当て（#4。二分探索で引き、割り方の候補ごとに 1 回）', () => {
  it('どの箱も、自分のレーン（塊だけの列なら自分の host）の、層の範囲が合う列に入る', () => {
    const { m, specs } = arrange(indexGraph(baseline()));
    const own = new Set(specs.filter((s) => s.kind === 'host').map((s) => s.host));
    let inHost = 0;
    for (const b of m.boxes) {
      const s = specs[b.col]!;
      if (b.host && own.has(b.host)) {
        inHost++;
        expect([s.kind, s.host], b.id).toEqual(['host', b.host]);
        expect(s.lo <= b.ilayer && b.ilayer <= s.hi, b.id).toBe(true);
      } else {
        expect([s.kind, s.lane], b.id).toEqual(['shared', b.lane]);
        expect(s.lo <= b.unit.layer && b.unit.layer <= s.hi, b.id).toBe(true);
      }
    }
    // 見つかったこと: 基準の graph では Lambda（api）の塊の 3 箱（cmd/api と internal/api・auth）が塊だけの 2 列に入る
    expect(inHost).toBe(3);
  });
});

/** 区間の両端の点（ピンとして列だけを持つ。placeX は列と y しか見ない） */
const pin = (col: number) =>
  ({ kind: 'pin', box: { col }, ref: '', o: 0 }) as unknown as ChainPoint;
const slot = (col: number) =>
  ({ kind: 'slot', slot: { bundle: { col } } }) as unknown as ChainPoint;
const fakeChain = (seq: number, points: ChainPoint[]): Chain =>
  ({
    seq,
    cut: false,
    chans: points.slice(1).map((p) => (p.kind === 'pin' ? p.box.col : p.slot.bundle.col)),
    slots: [],
    xs: [],
    points,
  }) as unknown as Chain;
const cfg = { boxW: 300, rowH: 18, pitch: 8, aspect: 1.6, widthOf: () => 300 } as Cfg;

describe('トラックの同点の崩し方（#8）', () => {
  it('同点の区間は線の順、同じ線なら区間の順（区間が 64 を超える線でも食い違わない）', () => {
    // 線 a（seq 0）は列 0 → 66 を通り、通り道 66 の区間は 65 番目。線 b（seq 1）は列 65 → 66 で、通り道 66 の区間は 0 番目。
    // 2 本は同じ高さを下りる（同点）ので、seq の小さい a が左のトラック。以前の鍵 seq × 64 + j では b（64）が a（65）より先だった
    const a = fakeChain(0, [pin(0), ...Array.from({ length: 65 }, (_, i) => slot(i + 1)), pin(66)]);
    const b = fakeChain(1, [pin(65), pin(66)]);
    const cols = Array.from({ length: 67 }, () => []);
    placeX(cols, [a, b], cfg, (c, i) => (i === c.chans.length ? 200 : 100));
    expect(a.chans[65]).toBe(66);
    expect(a.xs[65]!).toBeLessThan(b.xs[0]!);
  });
});

/** 以前のトラックの割り当て（トラックごとに置いた区間を全部見る）。同じ答えになることを確かめる参照 */
function naiveTracks(segs: VSeg[], eps: number): number {
  const tracks: VSeg[][] = [];
  for (const s of segs) {
    let t = 0;
    for (let u = tracks.length - 1; u >= 0; u--)
      if (tracks[u]!.some((o) => o.lo < s.hi + eps && s.lo < o.hi + eps)) {
        t = u + 1;
        break;
      }
    while (tracks.length <= t) tracks.push([]);
    tracks[t]!.push(s);
    s.track = t;
  }
  return tracks.length;
}

describe('トラックの割り当て（S2。セグメント木）', () => {
  it('重なる区間の最大のトラック + 1（重ならなければ 0）: 以前の割り当てと同じ答え', () => {
    let seed = 7;
    const rnd = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32;
    for (let round = 0; round < 50; round++) {
      const n = 1 + Math.floor(rnd() * 60);
      const make = () =>
        Array.from({ length: n }, () => {
          // 端は 8 の倍数に寄せる（eps = 4 の境目ちょうどの組も作る）
          const lo = Math.floor(rnd() * 40) * 4;
          const hi = lo + Math.floor(rnd() * 30) * 4 + (rnd() < 0.2 ? 0.5 : 0);
          return { lo, hi, track: -1 } as VSeg;
        });
      const a = make();
      const b = a.map((s) => ({ ...s }));
      expect(assignTracks(a, 4)).toBe(naiveTracks(b, 4));
      expect(a.map((s) => s.track)).toEqual(b.map((s) => s.track));
    }
  });

  it('隙間が eps 未満の区間は重なるとみる。ちょうど eps 離れていれば同じトラック', () => {
    const segs = [
      { lo: 0, hi: 10 },
      { lo: 13, hi: 20 },
      { lo: 24, hi: 30 },
    ].map((s) => ({ ...s, track: -1 }) as VSeg);
    expect(assignTracks(segs, 4)).toBe(2);
    expect(segs.map((s) => s.track)).toEqual([0, 1, 0]);
  });
});

describe('引数の展開を使わない（10 万を超える線で RangeError にならない）', () => {
  it('assignLayers: 同じ 2 箱の間の層を決めない線 13 万本・後続 13 万の箱', () => {
    const many = 130_000;
    // b は層を決める線が無く、層を決めない線（戻り）で a に呼ばれる。以前は Math.max(...callers) に 13 万個を渡していた
    const weak = Array.from({ length: many }, () => ['a', 'b'] as const);
    const l = assignLayers(['a', 'b', 'c'], [['a', 'c']], weak, (s) => s.charCodeAt(0));
    expect(l.get('b')).toBe(1);
    // s は入ってくる線が無く、13 万の箱を呼ぶ（Math.min(...out)）
    const ids = Array.from({ length: many }, (_, i) => `t${i}`);
    const l2 = assignLayers(
      ['s', ...ids],
      ids.map((t) => ['s', t] as const),
      [],
      (x) => (x === 's' ? -1 : Number(x.slice(1))),
    );
    expect(l2.get('s')).toBe(0);
    expect(l2.get('t0')).toBe(1);
  });
});

describe('inversions は NaN でも止まる', () => {
  it('a に NaN があっても 1 つずつ進む（以前は a[i] === a[i] が偽で i が進まず、止まらなかった）', () => {
    expect(inversions([NaN, NaN, 1], [2, 1, 0])).toBeGreaterThanOrEqual(0);
  });
});
