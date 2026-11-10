// 切り口（docs/21 §2.1・§2.5・§3。D124・D127）: 正規の形、開く・畳む、初めの切り口、置き場
import { describe, expect, it } from 'vitest';
import type { GraphV2, Runtime } from '@stack-atlas/schema';
import { containmentOf, type Container, type Containment } from '../containment.js';
import {
  closeContainer,
  initialCut,
  innermostOpen,
  normalizeCut,
  openContainer,
  openTo,
  slicesOf,
  type Cut,
} from '../cut.js';
import { indexGraph } from '../graph-index.js';
import { boxIds, fbox, load, visibleUnits } from './fold-fixture.js';
import { synthetic } from '../synthetic.js';

const C = (id: string, parent?: string): Container => ({
  id,
  name: id,
  kind: 'dir',
  ...(parent === undefined ? {} : { parent }),
});
const tree = (list: Container[], boxes: [string, string][] = []): Containment => ({
  containers: new Map(list.map((x) => [x.id, x])),
  parentOfBox: new Map(boxes),
});
/**
 * 根 > a > (a1 > a11, a2)、根 > b > b1。箱は x（a11）・y（a1）・z（a2）・w（b1）・r（根の直下）
 */
const sample = () =>
  tree(
    [C('a'), C('a1', 'a'), C('a11', 'a1'), C('a2', 'a'), C('b'), C('b1', 'b')],
    [
      ['x', 'a11'],
      ['y', 'a1'],
      ['z', 'a2'],
      ['w', 'b1'],
    ],
  );
const list = (cut: Cut) => [...cut];

describe('slicesOf — 置き場', () => {
  it('host があれば host、無ければレーン。host の枠そのものは持たない', () => {
    const rt = (id: string, runtime: Runtime, host?: string) =>
      fbox(id, undefined, host === undefined ? {} : { host }, runtime);
    const graph: GraphV2 = {
      version: 2,
      nodes: [
        rt('actor:u', 'user'),
        rt('trigger:t', 'time'),
        rt('fn:b', 'browser'),
        rt('fn:e', 'edge'),
        rt('fn:s', 'server', 'infra:h'),
        rt('table:d', 'data', 'infra:h'),
        rt('fn:s2', 'server'),
        rt('external:x', 'external'),
        rt('infra:h', 'server'),
      ],
      wires: [],
    };
    expect([...slicesOf(indexGraph(graph))]).toEqual([
      ['actor:u', 'l:user'],
      ['trigger:t', 'l:user'],
      ['fn:b', 'l:browser'],
      ['fn:e', 'l:edge'],
      ['fn:s', 'h:infra:h'],
      ['table:d', 'h:infra:h'],
      ['fn:s2', 'l:server'],
      ['external:x', 'l:external'],
    ]);
  });

  it('poly-86: 置き場は 8 つ（host 4・レーン 4）。合成 300 は 14（host 12・レーン 2）', () => {
    const count = (graph: GraphV2) => {
      const keys = new Set(slicesOf(indexGraph(graph)).values());
      return {
        host: [...keys].filter((k) => k.startsWith('h:')).length,
        lane: [...keys].filter((k) => k.startsWith('l:')).length,
      };
    };
    expect(count(load('poly-86'))).toEqual({ host: 4, lane: 4 });
    expect(count(synthetic())).toEqual({ host: 12, lane: 2 });
  });
});

describe('normalizeCut — 正規の形', () => {
  it('知らない id・祖先が開いていない id を捨てて、木の宣言の順に並べる', () => {
    const c = sample();
    expect(list(normalizeCut(c, ['b', 'a1', 'a', 'nowhere', '*', '', 'a']))).toEqual([
      'a',
      'a1',
      'b',
    ]);
    // a が開いていないので a1・a11 は捨てる。a1 が開いていないので a11 は捨てる
    expect(list(normalizeCut(c, ['a1', 'a11', 'b1']))).toEqual([]);
    expect(list(normalizeCut(c, ['a', 'a11']))).toEqual(['a']);
    expect(list(normalizeCut(c, []))).toEqual([]);
  });

  it('2 回掛けても同じ。入力の集合は変えない。文字列でない値は捨てる', () => {
    const c = sample();
    const input = new Set(['a11', 'a', 'zzz', 'a1']);
    const once = normalizeCut(c, input);
    expect(list(once)).toEqual(['a', 'a1', 'a11']);
    expect(list(normalizeCut(c, once))).toEqual(list(once));
    expect([...input]).toEqual(['a11', 'a', 'zzz', 'a1']);
    expect(list(normalizeCut(c, [7, null, undefined, {}, 'b'] as unknown as string[]))).toEqual([
      'b',
    ]);
  });

  it('`__proto__`・`constructor` という id の入れ物も、ふつうの入れ物として扱う', () => {
    const c = tree([C('__proto__'), C('constructor', '__proto__'), C('toString', 'nowhere')]);
    expect(list(normalizeCut(c, ['constructor', '__proto__', 'hasOwnProperty']))).toEqual([
      '__proto__',
      'constructor',
    ]);
  });

  it('親の循環・無い親のある木でも、直した木（根の直下に付け直したもの）で正規の形にする', () => {
    // p → q → r → p の輪は、最初に宣言された p を根の直下にして切る（r < p、q < r）
    const c = tree([C('p', 'q'), C('q', 'r'), C('r', 'p'), C('lost', 'nowhere')]);
    expect(list(normalizeCut(c, ['q', 'lost']))).toEqual(['lost']);
    expect(list(normalizeCut(c, ['q', 'r', 'p']))).toEqual(['p', 'q', 'r']);
    expect(list(normalizeCut(c, ['q', 'p']))).toEqual(['p']);
  });
});

describe('openContainer・closeContainer', () => {
  it('1 段開く。見えていない入れ物（祖先が開いていない）・知らない id は開けない', () => {
    const c = sample();
    const empty: Cut = new Set();
    expect(list(openContainer(c, empty, 'a'))).toEqual(['a']);
    expect(list(openContainer(c, empty, 'a1'))).toEqual([]);
    expect(list(openContainer(c, empty, 'nowhere'))).toEqual([]);
    expect(list(openContainer(c, new Set(['a']), 'a1'))).toEqual(['a', 'a1']);
    expect(list(empty)).toEqual([]);
  });

  it('畳むと、その下で開いていたものを忘れる（開き直すと 1 段だけ開く）', () => {
    const c = sample();
    const cut = normalizeCut(c, ['a', 'a1', 'a11', 'a2', 'b']);
    const closed = closeContainer(c, cut, 'a');
    expect(list(closed)).toEqual(['b']);
    expect(list(openContainer(c, closed, 'a'))).toEqual(['a', 'b']);
    // 途中の段を畳む: その下だけ忘れる
    expect(list(closeContainer(c, cut, 'a1'))).toEqual(['a', 'a2', 'b']);
    // 開いていない入れ物・知らない id を畳んでも変わらない
    expect(list(closeContainer(c, cut, 'b1'))).toEqual(list(cut));
    expect(list(closeContainer(c, cut, 'nowhere'))).toEqual(list(cut));
    expect(list(cut)).toEqual(['a', 'a1', 'a11', 'a2', 'b']);
  });

  it('開いて閉じると元の切り口と同じ（poly-86 の初めの切り口から、見えている入れ物を 1 つずつ）', () => {
    const graph = load('poly-86');
    const index = indexGraph(graph);
    const c = containmentOf(graph);
    const init = initialCut(c, index, slicesOf(index));
    let tried = 0;
    for (const id of c.containers.keys()) {
      const opened = openContainer(c, init, id);
      if (opened.size === init.size) continue;
      tried++;
      expect(list(closeContainer(c, opened, id))).toEqual(list(init));
    }
    expect(tried).toBe(9);
  });

  it('開く順に依らない（同じ入れ物を、順を変えて開いても同じ切り口）', () => {
    const c = sample();
    const openAll = (ids: string[]) =>
      ids.reduce<Cut>((cut, id) => openContainer(c, cut, id), new Set());
    const a = openAll(['a', 'b', 'a1', 'a2', 'b1', 'a11']);
    const b = openAll(['b', 'b1', 'a', 'a2', 'a1', 'a11']);
    expect(list(a)).toEqual(list(b));
    expect(list(a)).toEqual(['a', 'a1', 'a11', 'a2', 'b', 'b1']);
  });
});

describe('openTo・innermostOpen', () => {
  it('openTo: その箱の祖先を全部開く。ほかの入れ物は変えない', () => {
    const c = sample();
    expect(list(openTo(c, new Set(), ['x']))).toEqual(['a', 'a1', 'a11']);
    expect(list(openTo(c, new Set(['b']), ['y']))).toEqual(['a', 'a1', 'b']);
    expect(list(openTo(c, new Set(['a']), ['z', 'w']))).toEqual(['a', 'a2', 'b', 'b1']);
    // 根の直下の箱・知らない箱・箱が空なら変わらない
    expect(list(openTo(c, new Set(['a']), ['r', 'nowhere']))).toEqual(['a']);
    expect(list(openTo(c, new Set(['a']), []))).toEqual(['a']);
  });

  it('openTo のあとは、その箱が見えている（poly-86 の全部の箱）', () => {
    const graph = load('poly-86');
    const c = containmentOf(graph);
    const slice = slicesOf(indexGraph(graph));
    for (const box of boxIds(graph)) {
      const cut = openTo(c, new Set(), [box]);
      expect(visibleUnits(c, cut, [box], slice)).toEqual([box]);
      expect(list(normalizeCut(c, cut))).toEqual(list(cut));
    }
  });

  it('innermostOpen: 箱を全部含む、いちばん内側の開いた入れ物', () => {
    const c = sample();
    const all = normalizeCut(c, ['a', 'a1', 'a11', 'a2', 'b', 'b1']);
    expect(innermostOpen(c, all, ['x'])).toBe('a11');
    expect(innermostOpen(c, all, ['x', 'y'])).toBe('a1');
    expect(innermostOpen(c, all, ['x', 'z'])).toBe('a');
    expect(innermostOpen(c, all, ['y', 'x', 'z', 'x'])).toBe('a');
    // 共通の祖先が無い・根の直下の箱を含む・知らない箱を含む・箱が空
    expect(innermostOpen(c, all, ['x', 'w'])).toBeUndefined();
    expect(innermostOpen(c, all, ['x', 'r'])).toBeUndefined();
    expect(innermostOpen(c, all, ['nowhere'])).toBeUndefined();
    expect(innermostOpen(c, all, [])).toBeUndefined();
    // 閉じた入れ物の中なら、その上のいちばん近い開いた入れ物。どれも開いていなければ無い
    expect(innermostOpen(c, new Set(['a']), ['x'])).toBe('a');
    expect(innermostOpen(c, new Set(['a']), ['x', 'y'])).toBe('a');
    expect(innermostOpen(c, new Set(), ['x'])).toBeUndefined();
    expect(innermostOpen(c, new Set(['b']), ['x'])).toBeUndefined();
  });
});

describe('initialCut — 初めの切り口', () => {
  const units = (graph: GraphV2, opts?: { max?: number; min?: number }) => {
    const index = indexGraph(graph);
    const c = containmentOf(graph);
    const slice = slicesOf(index);
    const cut = initialCut(c, index, slice, opts);
    expect(list(normalizeCut(c, cut))).toEqual(list(cut));
    return { open: cut.size, units: visibleUnits(c, cut, boxIds(graph), slice).length };
  };

  it('poly-86: 全部畳むと 9、上限 24 の切り口は 16（repo の 2 つ = platform と web/src を開く）。合成 300 は 14（何も開かない）', () => {
    const graph = load('poly-86');
    const c = containmentOf(graph);
    const slice = slicesOf(indexGraph(graph));
    expect(visibleUnits(c, new Set(), boxIds(graph), slice)).toHaveLength(9);
    expect(units(graph)).toEqual({ open: 2, units: 16 });
    expect(units(load('poly-82a'))).toEqual({ open: 2, units: 16 });
    expect(units(synthetic())).toEqual({ open: 0, units: 14 });
  });

  it('上限: 次の段を開くと上限を超えるなら、手前で止まる', () => {
    const graph = load('poly-86');
    // 段ごとの見える単位: 9 → 16 → 25 → …（上限を 25 にすると、もう 1 段開く）
    expect(units(graph, { max: 15 })).toEqual({ open: 0, units: 9 });
    expect(units(graph, { max: 16 })).toEqual({ open: 2, units: 16 });
    expect(units(graph, { max: 24 })).toEqual({ open: 2, units: 16 });
    const next = units(graph, { max: 1000 });
    expect(next.units).toBe(67);
    expect(next.open).toBe(22);
  });

  it('下限: 見える単位が 4 未満なら、上限を超えても 1 段だけ開く（根の下が 1 つだけの graph で 1 → 25）', () => {
    // app/ の下に 25 のディレクトリ（2 箱ずつ）。全部畳むと畳んだ箱 1 つ
    const nodes = Array.from({ length: 50 }, (_, i) =>
      fbox(`fn:${i}`, `app/m${Math.floor(i / 2)}/f${i}.ts`),
    );
    const graph: GraphV2 = { version: 2, nodes, wires: [] };
    expect(units(graph)).toEqual({ open: 1, units: 25 });
    // 下限を 1 にすると開かない（1 は 1 未満でない）。1 段だけなので、その下（50 箱）までは開かない
    expect(units(graph, { min: 1 })).toEqual({ open: 0, units: 1 });
    expect(units(graph, { min: 100 })).toEqual({ open: 1, units: 25 });
  });

  it('畳めるものが無い graph・空の graph は空の切り口', () => {
    const flat: GraphV2 = { version: 2, nodes: [fbox('fn:a', undefined)], wires: [] };
    expect(units(flat)).toEqual({ open: 0, units: 1 });
    expect(units({ version: 2, nodes: [], wires: [] })).toEqual({ open: 0, units: 0 });
  });

  it('置き場で割れる入れ物は、置き場ごとに 1 つと数える', () => {
    // 1 つのディレクトリに、ブラウザ 2・サーバー 2・データ 2 の箱: 畳むと 3 つ
    const rts: Runtime[] = ['browser', 'browser', 'server', 'server', 'data', 'data'];
    const nodes = rts.map((rt, i) => fbox(`fn:${i}`, `app/f${i}.ts`, {}, rt));
    const graph: GraphV2 = { version: 2, nodes, wires: [] };
    const index = indexGraph(graph);
    const c = containmentOf(graph);
    expect(visibleUnits(c, new Set(), boxIds(graph), slicesOf(index))).toHaveLength(3);
    // 3 は下限（4）未満なので 1 段開く（6 箱）
    expect(units(graph)).toEqual({ open: 1, units: 6 });
    // 置き場を 1 つにすれば 1 つ
    expect(visibleUnits(c, new Set(), boxIds(graph), new Map())).toHaveLength(1);
  });

  it('決定的（同じ graph から同じ切り口）', () => {
    const a = load('poly-86');
    const ia = indexGraph(a);
    const ca = containmentOf(a);
    expect(list(initialCut(ca, ia, slicesOf(ia)))).toEqual(
      list(initialCut(containmentOf(load('poly-86')), ia, slicesOf(ia))),
    );
    expect(list(initialCut(ca, ia, slicesOf(ia)))).toEqual(['d:platform', 'd:web/src']);
  });
});
