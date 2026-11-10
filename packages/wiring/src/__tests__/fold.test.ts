// 畳む（docs/21 §2.2・§2.3・§3。D125・D126・D128）: 見えている単位と線の写し・束・切れた線・選択の写し
import { describe, expect, it } from 'vitest';
import type { GraphV2, NodeV2, WireV2 } from '@stack-atlas/schema';
import { brokenEnds } from '../broken.js';
import { cleanContainment, containmentOf, type Containment } from '../containment.js';
import { initialCut, normalizeCut, openContainer, slicesOf, type Cut } from '../cut.js';
import { diffOverlayV2 } from '../diff.js';
import { foldView, lineActive, litOn, segmentOn, type FoldView } from '../fold.js';
import { indexGraph, type GraphIndex } from '../graph-index.js';
import { layoutWiring } from '../layout/index.js';
import { select } from '../select.js';
import { defaultState } from '../variants.js';
import { W } from './fixture.js';
import { boxIds, deepFreeze, fbox, load, spikeCuts, viewJson } from './fold-fixture.js';
import { synthetic } from './synthetic.js';

const setup = (graph: GraphV2) => {
  const index = indexGraph(graph);
  const c = containmentOf(graph);
  const slice = slicesOf(index);
  return { graph, index, c, slice, view: (cut: Cut) => foldView(index, c, cut, slice) };
};
/** 入れ物（と置き場）の畳んだ箱の id */
const unitId = (v: FoldView, container: string, slice?: string) => {
  const u = [...v.units.values()].find(
    (x) => x.container === container && (slice === undefined || x.slice === slice),
  );
  if (!u) throw new Error(`畳んだ箱が無い: ${container}`);
  return u.id;
};

/** 写しの約束: 全部の線が「見えている線 1 本」か「単位の中」のどちらか 1 つ。往復できる */
function expectPartition(index: GraphIndex, v: FoldView) {
  let hidden = 0;
  let visible = 0;
  const order = new Map(index.wires.map((w, i) => [w.key, i]));
  for (const w of index.wires) {
    const k = v.lineOf.get(w.key);
    expect(k, w.key).not.toBeUndefined();
    if (k === null) hidden++;
    else {
      visible++;
      expect(v.wiresOf.get(k!)).toContain(w.key);
    }
  }
  expect(hidden + visible).toBe(index.wires.length);
  expect([...v.wiresOf.values()].reduce((s, l) => s + l.length, 0)).toBe(visible);
  expect([...v.wiresOf.keys()]).toEqual(v.index.wires.map((w) => w.key));
  for (const [line, keys] of v.wiresOf) {
    for (const k of keys) expect(v.lineOf.get(k)).toBe(line);
    const at = keys.map((k) => order.get(k)!);
    expect(at).toEqual([...at].sort((a, b) => a - b));
  }
  // 全部の箱と host の枠が、畳んだ graph の箱 1 つに写る
  for (const id of index.nodes.keys()) {
    const u = v.unitOf.get(id);
    expect(u === id || v.units.has(u!), id).toBe(true);
    expect(v.index.nodes.has(u!)).toBe(true);
  }
  for (const u of v.units.values()) {
    expect(u.count).toBe(u.boxes.length);
    for (const b of u.boxes) expect(v.unitOf.get(b)).toBe(u.id);
  }
  return { hidden, visible };
}

describe('foldView — 写し（poly-86 の 13 通りの切り口・合成 300）', () => {
  const poly = setup(load('poly-86'));
  const cuts = spikeCuts(poly.c, poly.index, poly.slice);

  it('切り口は 13 通り（全部畳む・初めの切り口・そこから 1 つずつ開いた 2 ＋ 9 通り）', () => {
    expect(cuts).toHaveLength(13);
    expect(new Set(cuts.map(([, cut]) => [...cut].join())).size).toBe(13);
  });

  it('全部の線が「見えている線 1 本」か「単位の中」のどちらか 1 つに入る（合計が線の数）', () => {
    const facts = cuts.map(([label, cut]) => {
      const v = poly.view(cut);
      const { hidden, visible } = expectPartition(poly.index, v);
      return {
        label,
        units: v.index.nodes.size - poly.index.hosts.size,
        lines: v.index.wires.length,
        hidden,
        visible,
      };
    });
    // 見つかったことの固定（線 143 本）: 見える単位・見えている線・単位の中に入った線。
    // 全部畳むと 9 単位・線 20（単位の中 66）、初めの切り口で 16・39（同 31）、そこから platform/internal を開くと 22・59（同 8）
    expect(facts.map((f) => [f.units, f.lines, f.hidden])).toEqual([
      [9, 20, 66],
      [16, 39, 31],
      [13, 30, 54],
      [12, 29, 43],
      [17, 42, 31],
      [19, 44, 31],
      [21, 51, 28],
      [17, 42, 29],
      [23, 67, 31],
      [18, 44, 31],
      [17, 45, 31],
      [16, 47, 31],
      [22, 59, 8],
    ]);
    for (const f of facts) expect(f.hidden + f.visible).toBe(143);
  });

  it('合成 300: 初めの切り口（14 単位・線 82）と、根を 1 段開いた切り口（58 単位）', () => {
    const s = setup(synthetic());
    const init = s.view(initialCut(s.c, s.index, s.slice));
    expectPartition(s.index, init);
    expect(init.index.nodes.size - s.index.hosts.size).toBe(14);
    expect(init.index.wires).toHaveLength(82);
    const root = s.view(openContainer(s.c, new Set(), 'd:src'));
    expectPartition(s.index, root);
    expect(root.index.nodes.size - s.index.hosts.size).toBe(58);
  });

  it('畳んだ箱の id は切り口に依らない（入れ物 × 置き場ごとに 1 つ）', () => {
    const idOf = new Map<string, string>();
    for (const [, cut] of cuts) {
      for (const u of poly.view(cut).units.values()) {
        const k = `${u.container}\n${u.slice}`;
        expect(idOf.get(k) ?? u.id).toBe(u.id);
        idOf.set(k, u.id);
      }
    }
    expect(new Set(idOf.values()).size).toBe(idOf.size);
  });

  it('▾ に出す入れ物: いちばん内側の開いた入れ物。根の直下の単位には無い（初めの切り口）', () => {
    const v = poly.view(initialCut(poly.c, poly.index, poly.slice));
    const units = [...v.index.nodes.keys()].filter((id) => !poly.index.hosts.has(id));
    const crumbs = units.map((id) => v.crumbs.get(id));
    expect(crumbs.filter((x) => x === 'd:platform')).toHaveLength(11);
    expect(crumbs.filter((x) => x === 'd:web/src')).toHaveLength(4);
    // file の無い利用者の箱は根の直下
    expect(v.crumbs.has('actor:user')).toBe(false);
    expect(crumbs.filter((x) => x === undefined)).toHaveLength(1);
    for (const [id, cid] of v.crumbs) expect(v.open.has(cid), id).toBe(true);
  });

  it('全部開いた切り口: graph・索引は元のものそのもの、配置も平らな配置と同じ', () => {
    const all = normalizeCut(poly.c, poly.c.containers.keys());
    const v = poly.view(all);
    expect(v.folded).toBe(false);
    expect(v.graph).toBe(poly.graph);
    expect(v.index).toBe(poly.index);
    expect(v.units.size).toBe(0);
    expectPartition(poly.index, v);
    expect(JSON.stringify([...layoutWiring(v.index).boxes])).toBe(
      JSON.stringify([...layoutWiring(poly.index).boxes]),
    );
    // 見えている箱の ▾ は、その箱の入っている入れ物
    for (const [box, parent] of poly.c.parentOfBox) expect(v.crumbs.get(box)).toBe(parent);
  });

  it('graph の箱と線の順: 見えている箱・host の枠は元の順と元のオブジェクト、畳んだ箱は中の最初の箱の位置', () => {
    // platform/openapi だけ畳む（見えている箱どうしの線がある切り口）
    const v = poly.view(
      normalizeCut(
        poly.c,
        [...poly.c.containers.keys()].filter((x) => x !== 'd:platform/openapi'),
      ),
    );
    expect(v.units.size).toBe(1);
    const pos = new Map(poly.graph.nodes.map((n, i) => [n.id, i]));
    const at = v.graph.nodes.map((n) => pos.get(v.units.get(n.id)?.boxes[0] ?? n.id)!);
    expect(at).toEqual([...at].sort((a, b) => a - b));
    for (const n of v.graph.nodes) {
      if (!v.units.has(n.id)) expect(n).toBe(poly.graph.nodes[pos.get(n.id)!]);
    }
    // 1 本のままの線は元のオブジェクト
    const wires = new Map(poly.index.wires.map((w) => [w.key, w.wire]));
    let same = 0;
    for (const [line, keys] of v.wiresOf) {
      const w = v.index.wires.find((x) => x.key === line)!.wire;
      const a = v.index.nodes.has(wires.get(keys[0]!)!.from.split('#')[0]!);
      const b = v.index.nodes.has(wires.get(keys[0]!)!.to.split('#')[0]!);
      if (a && b) {
        expect(keys).toHaveLength(1);
        expect(w).toBe(wires.get(keys[0]!));
        same++;
      }
    }
    expect(same).toBeGreaterThan(0);
  });

  it('決定的で、入力を壊さない', () => {
    const g = deepFreeze(load('poly-86'));
    const a = setup(g);
    for (const [, cut] of cuts) {
      expect(viewJson(a.view(cut))).toBe(viewJson(setup(load('poly-86')).view(cut)));
    }
  });

  it('畳んでも、全体の索引でたどった結果は変わらない（foldView は索引を変えない）', () => {
    const state = defaultState(poly.index);
    const before = select(poly.index, state, { kind: 'box', id: 'route:/' })!;
    for (const [, cut] of cuts) poly.view(cut);
    const after = select(poly.index, state, { kind: 'box', id: 'route:/' })!;
    expect(after.segs.map((s) => s.key)).toEqual(before.segs.map((s) => s.key));
  });

  it('見えている箱だけを通る選択は、litOn で写したものと、畳んだ索引で選んだものが同じ（1 つだけ畳んだ 22 通りの切り口）', () => {
    const state = defaultState(poly.index);
    let matched = 0;
    for (const x of poly.c.containers.keys()) {
      const v = poly.view(
        normalizeCut(
          poly.c,
          [...poly.c.containers.keys()].filter((y) => y !== x),
        ),
      );
      for (const id of boxIds(poly.graph)) {
        if (v.unitOf.get(id) !== id) continue;
        const lit = select(poly.index, state, { kind: 'box', id })!;
        if (![...lit.boxes].every((b) => v.unitOf.get(b) === b)) continue;
        const onFold = litOn(v, lit);
        const direct = select(v.index, defaultState(v.index), { kind: 'box', id })!;
        expect(onFold.segs.map((s) => s.key)).toEqual(direct.segs.map((s) => s.key));
        expect([...onFold.boxes].sort()).toEqual([...direct.boxes].sort());
        expect([...onFold.items].sort()).toEqual([...direct.items].sort());
        expect([...onFold.flowStarts].sort()).toEqual([...direct.flowStarts].sort());
        matched++;
      }
    }
    // 見つかったことの固定: 22 通り × 見えている箱のうち、選択が見えている箱だけを通るもの
    expect(matched).toBe(733);
  });
});

/**
 * 束の確かめ用: src/a（a1・a2）と src/b（b1・b2）は入れ物、r・q は根の直下（file 無し）。
 * 切り口 {d:src} で、畳んだ箱は src/a と src/b
 */
function bundles(): GraphV2 {
  const nodes: NodeV2[] = [
    fbox('fn:a1', 'src/a/1.ts'),
    fbox('fn:a2', 'src/a/2.ts'),
    fbox('fn:b1', 'src/b/1.ts'),
    fbox('fn:b2', 'src/b/2.ts'),
    fbox('fn:r', undefined, { variants: [{ id: 'v', name: 'v', default: true }] }),
    fbox('fn:q', undefined),
  ];
  const on = { 'fn:r#v': true };
  const wires: WireV2[] = [
    /* w0 */ W('fn:a1#out/r', 'fn:r#in/a', 'deliver'),
    /* w1 */ W('fn:a2#out/r', 'fn:r#in/a', 'call'),
    /* w2 */ W('fn:r#out/r', 'fn:a1#in/a', 'return', true),
    /* w3 */ W('fn:r#out/r', 'fn:a2#in/a', 'call'),
    /* w4 */ W('fn:a1#out/r', 'fn:a2#in/a', 'call'),
    /* w5 */ W('fn:a1#out/r', 'fn:b1#in/a', 'call', false, on),
    /* w6 */ W('fn:a2#out/r', 'fn:b2#in/a', 'event', false, on),
    /* w7 */ W('fn:b1#out/r', 'fn:r#in/a', 'deliver'),
    /* w8 */ W('fn:r#out/r', 'fn:q#in/a', 'call'),
  ];
  return { version: 2, nodes, wires };
}

describe('foldView — 束', () => {
  it('束は（from の端, to の端, 戻りか）ごと。via は向きを決める最初の線、無ければ最初の線', () => {
    const s = setup(bundles());
    const v = s.view(new Set(['d:src']));
    const a = unitId(v, 'd:src/a');
    const b = unitId(v, 'd:src/b');
    expectPartition(s.index, v);
    expect(v.graph.wires).toEqual([
      { from: `${a}#out/_`, to: 'fn:r#in/a', via: 'call' },
      { from: 'fn:r#out/r', to: `${a}#in/_`, via: 'return', reply: true },
      { from: 'fn:r#out/r', to: `${a}#in/_`, via: 'call' },
      { from: `${a}#out/_`, to: `${b}#in/_`, via: 'call' },
      { from: `${b}#out/_`, to: 'fn:r#in/a', via: 'deliver' },
      s.graph.wires[8],
    ]);
    expect([...v.wiresOf.values()]).toEqual([
      ['w0', 'w1'],
      ['w2'],
      ['w3'],
      ['w5', 'w6'],
      ['w7'],
      ['w8'],
    ]);
    expect(v.lineOf.get('w4')).toBeNull();
    // 束に when は付けない
    expect(v.graph.wires[3]!.when).toBeUndefined();
    // 畳んだ箱の名前は入れ物の名前、口は in/_ と out/_
    expect(v.units.get(a)).toMatchObject({
      name: 'a',
      kind: 'dir',
      count: 2,
      boxes: ['fn:a1', 'fn:a2'],
    });
    expect(
      v.graph.nodes
        .find((n) => n.id === a)!
        .ports.map((p) => `${p.id}/${p.items.map((i) => i.id).join()}`),
    ).toEqual(['in/_', 'out/_']);
    // 1 本のままの線は元のオブジェクト
    expect(v.graph.wires[5]).toBe(s.graph.wires[8]);
  });

  it('lineActive: 束は中の線が 1 本でも存在すれば存在する。全部止まれば止まった線', () => {
    const s = setup(bundles());
    const v = s.view(new Set(['d:src']));
    const keyOf = (w: string) => v.lineOf.get(w)!;
    const on = defaultState(s.index);
    const off = { ...on, 'fn:r#v': false };
    expect(lineActive(v, on, keyOf('w5'))).toBe(true);
    expect(lineActive(v, off, keyOf('w5'))).toBe(false);
    expect(lineActive(v, off, keyOf('w0'))).toBe(true);
    expect(lineActive(v, on, 'nowhere')).toBe(false);
  });

  it('切れた線: 見えている線へ path ごとに 1 つ（重い方）。単位の中の切れた線は件数といちばん重い level', () => {
    const g = bundles();
    g.wires[0] = { ...g.wires[0]!, broken: [{ path: '', level: 'warn', reason: 'w0' }] };
    g.wires[1] = {
      ...g.wires[1]!,
      broken: [
        { path: '', level: 'error', reason: 'w1' },
        { path: 'x', level: 'warn', reason: 'w1x' },
      ],
    };
    g.wires[4] = {
      ...g.wires[4]!,
      broken: [
        { path: '', level: 'warn', reason: 'w4' },
        { path: 'y', level: 'error', reason: 'w4y' },
      ],
    };
    const s = setup(g);
    const v = s.view(new Set(['d:src']));
    const a = unitId(v, 'd:src/a');
    expect(v.graph.wires[0]!.broken).toEqual([
      { path: '', level: 'error', reason: 'w1' },
      { path: 'x', level: 'warn', reason: 'w1x' },
    ]);
    expect([...v.hiddenBroken]).toEqual([[a, { count: 2, level: 'error' }]]);
    // 切れた端は畳んだ索引の上でも出せる（畳んだ箱の口）
    const ends = brokenEnds(v.index);
    expect(ends.map((e) => `${e.from.ref} → ${e.to.ref} ${e.broken.level}`)).toEqual([
      `${a}#out/_ → fn:r#in/a error`,
      `${a}#out/_ → fn:r#in/a warn`,
    ]);
    // 入力の broken は変えない
    expect(g.wires[0]!.broken).toEqual([{ path: '', level: 'warn', reason: 'w0' }]);
  });

  it('poly-86: 切れた線 4 本は、全部畳むと見えている線か単位の中のどちらかに必ず数えられる', () => {
    const s = setup(load('poly-86'));
    const brokenWires = s.index.wires.filter((w) => w.wire.broken?.length);
    expect(brokenWires).toHaveLength(4);
    for (const [, cut] of spikeCuts(s.c, s.index, s.slice)) {
      const v = s.view(cut);
      let n = 0;
      for (const w of brokenWires) {
        const line = v.lineOf.get(w.key);
        if (line === null) n += w.wire.broken!.length;
      }
      const hidden = [...v.hiddenBroken.values()].reduce((x, h) => x + h.count, 0);
      expect(hidden).toBe(n);
      const shown = new Set(
        brokenWires
          .map((w) => v.lineOf.get(w.key))
          .filter((k): k is string => typeof k === 'string'),
      );
      for (const k of shown)
        expect(v.index.wires.find((w) => w.key === k)!.wire.broken?.length).toBeGreaterThan(0);
    }
  });
});

describe('foldView — 見つかったことの固定と敵対的な入力', () => {
  it('host が混ざる入れ物は host（と置き場）ごとに割れる。割った結果が 1 箱でも畳んだ箱', () => {
    const nodes: NodeV2[] = [
      fbox('fn:s1', 'srv/1.ts', { host: 'infra:h1' }, 'server'),
      fbox('fn:s2', 'srv/2.ts', { host: 'infra:h1' }, 'server'),
      fbox('fn:s3', 'srv/3.ts', { host: 'infra:h2' }, 'server'),
      fbox('fn:s4', 'srv/4.ts', { host: 'infra:h2' }, 'server'),
      fbox('fn:w', 'srv/w.ts', {}, 'browser'),
      fbox('infra:h1', undefined, {}, 'server'),
      fbox('infra:h2', undefined, {}, 'server'),
    ];
    const s = setup({ version: 2, nodes, wires: [] });
    const v = s.view(new Set());
    expect(
      [...v.units.values()].map((u) => [
        u.container,
        u.slice,
        u.count,
        v.graph.nodes.find((n) => n.id === u.id)!.host,
      ]),
    ).toEqual([
      ['d:srv', 'h:infra:h1', 2, 'infra:h1'],
      ['d:srv', 'h:infra:h2', 2, 'infra:h2'],
      ['d:srv', 'l:browser', 1, undefined],
    ]);
    // host の枠は畳まない
    expect(v.unitOf.get('infra:h1')).toBe('infra:h1');
  });

  it('file の無い箱は根の直下で見える。畳めるものが無い graph は元と同じもの', () => {
    const g: GraphV2 = {
      version: 2,
      nodes: [fbox('fn:a', undefined), fbox('fn:b', undefined)],
      wires: [W('fn:a#out/r', 'fn:b#in/a', 'call')],
    };
    const s = setup(g);
    const v = s.view(new Set(['*', 'd:nowhere']));
    expect(v.folded).toBe(false);
    expect(v.graph).toBe(g);
    expect(v.index).toBe(s.index);
    expect(v.open.size).toBe(0);
    expect(v.crumbs.size).toBe(0);
    expectPartition(s.index, v);
  });

  it('箱の id が畳んだ箱の id と同じなら、重ならなくなるまで `~` を足す', () => {
    const nodes = [
      fbox('fold:0:0', undefined),
      fbox('fold:0:0~', undefined),
      fbox('fn:a', 'src/a.ts'),
      fbox('fn:b', 'src/b.ts'),
    ];
    const s = setup({ version: 2, nodes, wires: [W('fn:a#out/r', 'fold:0:0#in/a', 'call')] });
    const v = s.view(new Set());
    expect([...v.units.keys()]).toEqual(['fold:0:0~~']);
    expect(v.graph.wires).toEqual([{ from: 'fold:0:0~~#out/_', to: 'fold:0:0#in/a', via: 'call' }]);
    expectPartition(s.index, v);
  });

  it('差分の幽霊を足した graph: 幽霊だけの入れ物・足しただけの入れ物・混ざった入れ物も、ほかと同じに畳む', () => {
    const prev: GraphV2 = {
      version: 2,
      nodes: [
        fbox('fn:o1', 'old/1.ts'),
        fbox('fn:o2', 'old/2.ts'),
        fbox('fn:m1', 'mix/1.ts'),
        fbox('fn:k', 'mix/k.ts'),
      ],
      wires: [W('fn:o1#out/r', 'fn:k#in/a', 'call')],
    };
    const next: GraphV2 = {
      version: 2,
      nodes: [
        fbox('fn:n1', 'new/1.ts'),
        fbox('fn:n2', 'new/2.ts'),
        fbox('fn:m2', 'mix/2.ts'),
        fbox('fn:k', 'mix/k.ts'),
      ],
      wires: [W('fn:n1#out/r', 'fn:k#in/a', 'call')],
    };
    const overlay = diffOverlayV2(prev, next).graph;
    const s = setup(overlay);
    expect([...s.c.containers.keys()].sort()).toEqual(['d:mix', 'd:new', 'd:old']);
    const v = s.view(new Set());
    expect([...v.units.values()].map((u) => `${u.container}:${u.boxes.join('+')}`).sort()).toEqual([
      'd:mix:fn:m2+fn:k+fn:m1',
      'd:new:fn:n1+fn:n2',
      'd:old:fn:o1+fn:o2',
    ]);
    expectPartition(s.index, v);
  });

  it('`__proto__` という id の入れ物・箱、置き場の表に無い箱でも落ちない', () => {
    const nodes = [
      fbox('__proto__', 'x/1.ts'),
      fbox('constructor', 'x/2.ts'),
      fbox('fn:c', 'y/1.ts'),
      fbox('fn:d', 'y/2.ts'),
    ];
    const g: GraphV2 = {
      version: 2,
      nodes,
      wires: [
        W('__proto__#out/r', 'fn:c#in/a', 'call'),
        W('constructor#out/r', '__proto__#in/a', 'call'),
      ],
    };
    const index = indexGraph(g);
    const c: Containment = cleanContainment(
      {
        containers: new Map([
          ['__proto__', { id: '__proto__', name: '__proto__', kind: 'dir' }],
          ['toString', { id: 'toString', name: 'toString', kind: 'dir', parent: 'toString' }],
        ]),
        parentOfBox: new Map([
          ['__proto__', '__proto__'],
          ['constructor', '__proto__'],
          ['fn:c', 'toString'],
        ]),
      },
      index.nodes.keys(),
    );
    const v = foldView(index, c, new Set(), new Map());
    expect([...v.units.values()].map((u) => [u.container, u.slice, u.boxes])).toEqual([
      ['__proto__', '', ['__proto__', 'constructor']],
      ['toString', '', ['fn:c']],
    ]);
    expectPartition(index, v);
    expect(v.lineOf.get('w1')).toBeNull();
  });
});

describe('segmentOn・litOn', () => {
  it('何も畳んでいなければ、渡したものをそのまま返す', () => {
    const s = setup(load('poly-86'));
    const v = s.view(normalizeCut(s.c, s.c.containers.keys()));
    const lit = select(s.index, defaultState(s.index), { kind: 'box', id: 'route:/' })!;
    expect(litOn(v, lit)).toBe(lit);
    expect(segmentOn(v, lit.segs[0]!)).toBe(lit.segs[0]);
  });

  it('畳んだ箱の中の箱を選ぶ: 光るのは畳んだ箱、始点の箱は畳んだ箱、単位の中の区間は無い', () => {
    const s = setup(bundles());
    const v = s.view(new Set(['d:src']));
    const a = unitId(v, 'd:src/a');
    const lit = select(s.index, defaultState(s.index), { kind: 'box', id: 'fn:a1' })!;
    const f = litOn(v, lit);
    expect(f.startBoxes).toEqual(new Set([a]));
    expect(f.boxes.has(a)).toBe(true);
    expect(f.boxes.has('fn:a1')).toBe(false);
    // 区間はどれも畳んだ索引の線の上。束に写った区間は 1 つ
    const lines = new Set(v.index.wires.map((w) => w.key));
    for (const seg of f.segs) if (seg.kind === 'wire') expect(lines.has(seg.wire!.key)).toBe(true);
    expect(new Set(f.segs.map((x) => x.key)).size).toBe(f.segs.length);
    // 畳んだ箱の口は、光る線の端のときだけ光る
    for (const ref of f.items) {
      const id = ref.split('#')[0]!;
      if (v.units.has(id))
        expect(f.segs.some((x) => x.from.ref === ref || x.to.ref === ref)).toBe(true);
      else expect(v.unitOf.get(id)).toBe(id);
    }
    // 単位の中の線（w4: a1 → a2）をクリック: 始点の区間は無い
    const w4 = select(s.index, defaultState(s.index), {
      kind: 'wire',
      from: 'fn:a1#out/r',
      to: 'fn:a2#in/a',
    })!;
    const f4 = litOn(v, w4);
    expect(w4.startSeg).toBeDefined();
    expect(f4.startSeg).toBeUndefined();
  });
});
