// 包含の木（docs/21 §2.1・§3。D123）: 今の graph の項目から木を作る、木を直す
import { describe, expect, it } from 'vitest';
import type { GraphV2 } from '@stack-atlas/schema';
import {
  cleanContainment,
  containmentOf,
  DIR_MAX_SEGMENTS,
  treeOf,
  type Container,
  type Containment,
} from '../containment.js';
import { deepFreeze, fbox, load } from './fold-fixture.js';
import { synthetic } from '../synthetic.js';

const g = (nodes: GraphV2['nodes'], groups?: GraphV2['groups']): GraphV2 => ({
  version: 2,
  nodes,
  wires: [],
  ...(groups ? { groups } : {}),
});
/** 木を読みやすい形に（入れ物: id・名前・親、箱の親） */
const shape = (c: Containment) => ({
  containers: [...c.containers.values()].map((x) => `${x.id} "${x.name}" < ${x.parent ?? '根'}`),
  boxes: [...c.parentOfBox].map(([b, p]) => `${b} < ${p}`),
});
const kinds = (c: Containment) => {
  const out: Record<string, number> = {};
  for (const x of c.containers.values()) out[x.kind] = (out[x.kind] ?? 0) + 1;
  return out;
};
const rootChildren = (c: Containment, graph: GraphV2) => {
  const hosts = new Set(graph.nodes.flatMap((n) => (n.host ? [n.host] : [])));
  const boxes = graph.nodes.filter((n) => !hosts.has(n.id) && !c.parentOfBox.has(n.id));
  return {
    containers: [...c.containers.values()].filter((x) => x.parent === undefined).length,
    boxes: boxes.map((b) => b.id),
  };
};

describe('containmentOf — 基準の graph', () => {
  it('poly-86: 入れ物 22（ディレクトリ 16・group 6）、根の子は 3（repo 2 つと、file の無い利用者の箱）', () => {
    const graph = load('poly-86');
    const c = containmentOf(graph);
    expect(c.containers.size).toBe(22);
    expect(kinds(c)).toEqual({ dir: 16, group: 6 });
    expect(rootChildren(c, graph)).toEqual({ containers: 2, boxes: ['actor:user'] });
    // 箱 67 のうち、根の直下は 1 つ。host の枠（4 つ）は木に入らない
    expect(c.parentOfBox.size).toBe(66);
    for (const n of graph.nodes) if (n.host) expect(c.parentOfBox.has(n.host)).toBe(false);
  });

  it('poly-82a（groups[] が無い）と合成 300: 親は必ず先に宣言される・group の入れ物には memo がある', () => {
    for (const graph of [load('poly-82a'), load('poly-86'), synthetic()]) {
      const c = containmentOf(graph);
      const seen = new Set<string>();
      for (const x of c.containers.values()) {
        if (x.parent !== undefined) expect(seen.has(x.parent)).toBe(true);
        seen.add(x.id);
        expect(x.kind === 'group' ? typeof x.memo : x.memo).toBe(
          x.kind === 'group' ? 'string' : undefined,
        );
      }
      for (const p of c.parentOfBox.values()) expect(c.containers.has(p)).toBe(true);
    }
    // 合成 300 は、レーンごとに src/m<n>/ へ 6 箱ずつ（いちばん多いブラウザで 25）: src の下に 25 のディレクトリ
    const s = containmentOf(synthetic());
    expect(kinds(s)).toEqual({ dir: 26 });
    expect([...s.containers.values()][0]).toEqual({ id: 'd:src', name: 'src', kind: 'dir' });
  });

  it('決定的で、入力を壊さない', () => {
    const graph = deepFreeze(load('poly-86'));
    const a = containmentOf(graph);
    const b = containmentOf(load('poly-86'));
    expect(shape(a)).toEqual(shape(b));
    expect([...a.containers.keys()]).toEqual([...b.containers.keys()]);
  });
});

describe('containmentOf — 木の作り方', () => {
  it('子が 1 つだけの段はつぶす（a/b/c で 1 つ）。箱 1 つだけの段は消えて、箱が上に付く', () => {
    const c = containmentOf(
      g([
        fbox('fn:x', 'repo/a/b/c/x.ts'),
        fbox('fn:y', 'repo/a/b/c/y.ts'),
        fbox('fn:z', 'repo/a/b/d/e/z.ts'),
        fbox('fn:top', 'repo/top.ts'),
      ]),
    );
    expect(shape(c)).toEqual({
      containers: [
        'd:repo "repo" < 根',
        'd:repo/a/b "a/b" < d:repo',
        'd:repo/a/b/c "c" < d:repo/a/b',
      ],
      boxes: ['fn:x < d:repo/a/b/c', 'fn:y < d:repo/a/b/c', 'fn:z < d:repo/a/b', 'fn:top < d:repo'],
    });
  });

  it('箱が 1 つだけの graph・全部が同じディレクトリの graph', () => {
    expect(shape(containmentOf(g([fbox('fn:x', 'a/b/x.ts')])))).toEqual({
      containers: [],
      boxes: [],
    });
    expect(shape(containmentOf(g([fbox('fn:x', 'a/b/x.ts'), fbox('fn:y', 'a/b/y.ts')])))).toEqual({
      containers: ['d:a/b "a/b" < 根'],
      boxes: ['fn:x < d:a/b', 'fn:y < d:a/b'],
    });
  });

  it('group: 中の箱が 2 つ以上なら入れ物（名前は groups[].name、memo は group の値）。1 箱だけの group は入れ物にならない', () => {
    const c = containmentOf(
      g(
        [
          fbox('fn:a', 'web/src/lib/a.ts', { group: 'lib:a' }),
          fbox('fn:b', 'web/src/lib/a.ts', { group: 'lib:a' }),
          fbox('fn:c', 'web/src/lib/c.ts', { group: 'lib:c' }),
          fbox('fn:d', 'web/src/d.ts'),
        ],
        [
          { id: 'lib:a', name: 'a のまとまり', kind: 'file', file: 'web/src/lib/a.ts' },
          { id: 'lib:c', name: 'c', kind: 'file', file: 'web/src/lib/c.ts' },
        ],
      ),
    );
    expect(shape(c)).toEqual({
      containers: [
        'd:web/src "web/src" < 根',
        'd:web/src/lib "lib" < d:web/src',
        'g:lib:a "a のまとまり" < d:web/src/lib',
      ],
      boxes: ['fn:a < g:lib:a', 'fn:b < g:lib:a', 'fn:c < d:web/src/lib', 'fn:d < d:web/src'],
    });
    expect(c.containers.get('g:lib:a')).toEqual({
      id: 'g:lib:a',
      name: 'a のまとまり',
      kind: 'group',
      parent: 'd:web/src/lib',
      memo: 'lib:a',
    });
  });

  it('group の置き場: groups[].file のディレクトリ、無ければ中の箱の共通のディレクトリ。名前が無ければ group の値', () => {
    const c = containmentOf(
      g(
        [
          fbox('fn:a', 'p/x/one/a.go', { group: 'pkg' }),
          fbox('fn:b', 'p/x/two/b.go', { group: 'pkg' }),
          fbox('fn:c', 'p/y/c.go', { group: 'q' }),
          fbox('fn:d', 'p/y/d.go', { group: 'q' }),
          fbox('fn:e', 'p/y/e.go'),
        ],
        [{ id: 'q', name: 'キュー', kind: 'package', file: 'p/z/q.go' }],
      ),
    );
    expect(shape(c)).toEqual({
      // pkg は共通の p/x に置く（中の箱の one・two の段は作らない）。q は groups[].file の p/z に置く
      containers: ['d:p "p" < 根', 'g:pkg "pkg" < d:p', 'g:q "キュー" < d:p'],
      boxes: ['fn:a < g:pkg', 'fn:b < g:pkg', 'fn:c < g:q', 'fn:d < g:q', 'fn:e < d:p'],
    });
  });

  it('file の無い箱は根の直下（1 箱だけの group は groups[].file を置き場に使う）', () => {
    const c = containmentOf(
      g(
        [
          fbox('actor:user', undefined),
          fbox('fn:a', 'a/a.ts'),
          fbox('fn:b', 'a/b.ts'),
          fbox('fn:c', undefined, { group: 'solo' }),
        ],
        [{ id: 'solo', name: 'solo', kind: 'file', file: 'a/solo.ts' }],
      ),
    );
    expect(shape(c)).toEqual({
      containers: ['d:a "a" < 根'],
      boxes: ['fn:a < d:a', 'fn:b < d:a', 'fn:c < d:a'],
    });
  });

  it('host の枠は木に入らない。中の箱は file で入る', () => {
    const c = containmentOf(
      g([
        fbox('infra:fn', 'infra/main.tf', {}, 'server'),
        fbox('fn:a', 'api/a.go', { host: 'infra:fn' }, 'server'),
        fbox('fn:b', 'api/b.go', { host: 'infra:fn' }, 'server'),
      ]),
    );
    expect(shape(c)).toEqual({
      containers: ['d:api "api" < 根'],
      boxes: ['fn:a < d:api', 'fn:b < d:api'],
    });
  });

  it('空の段・`.`・先頭の `/` は飛ばす。ディレクトリの無い file は根の直下', () => {
    const c = containmentOf(
      g([fbox('fn:a', '/a//b/./a.ts'), fbox('fn:b', './a/b/b.ts'), fbox('fn:c', 'c.ts')]),
    );
    expect(shape(c)).toEqual({
      containers: ['d:a/b "a/b" < 根'],
      boxes: ['fn:a < d:a/b', 'fn:b < d:a/b'],
    });
  });

  it('畳めるものが無い graph（file も group も無い）は空の木', () => {
    const c = containmentOf(g([fbox('fn:a', undefined), fbox('fn:b', undefined)]));
    expect(c.containers.size).toBe(0);
    expect(c.parentOfBox.size).toBe(0);
    expect(containmentOf(g([])).containers.size).toBe(0);
  });
});

describe('containmentOf — 敵対的な入力', () => {
  it('入れ物の id が箱・host の id と同じになったら、重ならなくなるまで `~` を足す', () => {
    const c = containmentOf(
      g([
        fbox('d:a', 'a/x.ts'),
        fbox('d:a~', 'a/y.ts'),
        fbox('g:lib', 'a/z.ts', { group: 'lib' }),
        fbox('fn:w', 'a/w.ts', { group: 'lib' }),
      ]),
    );
    expect([...c.containers.keys()]).toEqual(['d:a~~', 'g:lib~']);
    expect(c.parentOfBox.get('g:lib')).toBe('g:lib~');
    expect(c.containers.get('g:lib~')!.memo).toBe('lib');
  });

  it('`d:` で始まる group の値はディレクトリと重ならない（名前空間が違う）', () => {
    const c = containmentOf(
      g([
        fbox('fn:a', 'a/x.ts', { group: 'd:a' }),
        fbox('fn:b', 'a/y.ts', { group: 'd:a' }),
        fbox('fn:c', 'a/z.ts'),
      ]),
    );
    expect(shape(c).containers).toEqual(['d:a "a" < 根', 'g:d:a "d:a" < d:a']);
  });

  it('`__proto__`・`constructor` という id・group・段でも落ちない（Map のキーで持つ）', () => {
    const c = containmentOf(
      g(
        [
          fbox('__proto__', '__proto__/constructor/a.ts', { group: '__proto__' }),
          fbox('constructor', '__proto__/constructor/b.ts', { group: '__proto__' }),
          fbox('toString', '__proto__/toString/c.ts'),
          fbox('fn:d', '__proto__/toString/d.ts'),
        ],
        [{ id: '__proto__', name: '__proto__', kind: 'file' }],
      ),
    );
    expect(shape(c)).toEqual({
      containers: [
        'd:__proto__ "__proto__" < 根',
        'g:__proto__ "__proto__" < d:__proto__',
        'd:__proto__/toString "toString" < d:__proto__',
      ],
      boxes: [
        '__proto__ < g:__proto__',
        'constructor < g:__proto__',
        'toString < d:__proto__/toString',
        'fn:d < d:__proto__/toString',
      ],
    });
    expect(Object.getPrototypeOf({})).toBe(Object.prototype);
  });

  it(`ディレクトリの段は ${DIR_MAX_SEGMENTS} まで（それより深い所は、その段の入れ物に入る）`, () => {
    const deep = (n: number, leaf: string) =>
      Array.from({ length: n }, (_, i) => `s${i}`).join('/') + `/${leaf}`;
    const c = containmentOf(
      g([
        fbox('fn:a', deep(40, 'a.ts')),
        fbox('fn:b', deep(50, 'b.ts')),
        fbox('fn:c', deep(31, 'c.ts')),
      ]),
    );
    // 31 段目までが共通（fn:c の置き場）。a と b は 32 段目で打ち切られて、同じ入れ物に入る
    const ids = [...c.containers.keys()];
    expect(ids).toHaveLength(2);
    expect(ids[0]!.split('/')).toHaveLength(31);
    expect(ids[1]!.split('/')).toHaveLength(DIR_MAX_SEGMENTS);
    expect(c.parentOfBox.get('fn:a')).toBe(ids[1]);
    expect(c.parentOfBox.get('fn:b')).toBe(ids[1]);
    expect(c.parentOfBox.get('fn:c')).toBe(ids[0]);
  });

  it('64,000 段のパスの箱が 200 あっても、段の数に比例する時間で終わる', () => {
    const long = Array.from({ length: 64_000 }, (_, i) => `s${i % 7}`).join('/');
    const nodes = Array.from({ length: 200 }, (_, i) => fbox(`fn:${i}`, `${long}/f${i}.ts`));
    const t0 = performance.now();
    const c = containmentOf(g(nodes));
    const ms = performance.now() - t0;
    expect(c.containers.size).toBe(1);
    expect(c.parentOfBox.size).toBe(200);
    expect(ms).toBeLessThan(2000);
  });

  it('120 文字を超える名前は、地図と同じ上限に収める（頭を落とす）', () => {
    const seg = 'x'.repeat(300);
    const c = containmentOf(
      g(
        [
          fbox('fn:a', `${seg}/a.ts`, { group: 'G' }),
          fbox('fn:b', `${seg}/b.ts`, { group: 'G' }),
          fbox('fn:c', `${seg}/c.ts`),
        ],
        [{ id: 'G', name: 'n'.repeat(500), kind: 'file' }],
      ),
    );
    for (const x of c.containers.values()) {
      expect(x.name.length).toBeLessThanOrEqual(120);
      expect(x.name.startsWith('…')).toBe(true);
    }
    expect(c.containers.has(`d:${seg}`)).toBe(true);
  });

  it('file・group・groups[] の値が文字列でなくても落ちない', () => {
    const bad = g(
      [
        fbox('fn:a', 'a/a.ts', { group: 7 as unknown as string }),
        fbox('fn:b', 42 as unknown as string, { group: 7 as unknown as string }),
        fbox('fn:c', 'a/c.ts'),
      ],
      [{ id: 7 as unknown as string, name: null as unknown as string, kind: 'file' }],
    );
    // 文字列でない group は group として扱わない（箱は file の置き場に入る。file も読めなければ根の直下）
    expect(shape(containmentOf(bad))).toEqual({
      containers: ['d:a "a" < 根'],
      boxes: ['fn:a < d:a', 'fn:c < d:a'],
    });
  });
});

describe('treeOf・cleanContainment — 木を直す', () => {
  const C = (id: string, parent?: string, extra: Partial<Container> = {}): Container => ({
    id,
    name: id,
    kind: 'dir',
    ...(parent === undefined ? {} : { parent }),
    ...extra,
  });
  const tree = (list: Container[], boxes: [string, string][] = []): Containment => ({
    containers: new Map(list.map((x) => [x.id, x])),
    parentOfBox: new Map(boxes),
  });

  it('無い親・自分自身が親の入れ物は、根の直下に付け直す', () => {
    const c = cleanContainment(
      tree([C('a', 'nowhere'), C('b', 'b'), C('c', 'a')], [['fn:x', 'c']]),
      ['fn:x'],
    );
    expect(shape(c)).toEqual({
      containers: ['a "a" < 根', 'b "b" < 根', 'c "c" < a'],
      boxes: ['fn:x < c'],
    });
  });

  it('親の循環は、輪の中で最初に宣言された入れ物を根の直下に付け直して切る', () => {
    const c = cleanContainment(
      tree([
        C('tail', 'p'),
        C('p', 'q'),
        C('q', 'r'),
        C('r', 'p'),
        C('solo', 'solo2'),
        C('solo2', 'solo'),
      ]),
      [],
    );
    expect(shape(c).containers).toEqual([
      'tail "tail" < p',
      'p "p" < 根',
      'q "q" < r',
      'r "r" < p',
      'solo "solo" < 根',
      'solo2 "solo2" < solo',
    ]);
    const t = treeOf(c);
    expect(t.depth).toEqual([1, 0, 2, 1, 0, 1]);
    // 浅い順（親が必ず先）
    expect(t.byDepth.map((i) => t.ids[i])).toEqual(['p', 'solo', 'tail', 'r', 'solo2', 'q']);
  });

  it('知らない箱・無い入れ物を指す箱は外す。名前は上限に収める。入力は変えない', () => {
    const src = deepFreeze(
      tree(
        [C('a', undefined, { name: 'n'.repeat(400), memo: 'm' })],
        [
          ['fn:x', 'a'],
          ['fn:gone', 'a'],
          ['fn:y', 'nowhere'],
        ],
      ),
    );
    // Map は凍結しても set できるので、中身も比べる
    const before = JSON.stringify([[...src.containers], [...src.parentOfBox]]);
    const c = cleanContainment(src, ['fn:x', 'fn:y']);
    expect([...c.parentOfBox]).toEqual([['fn:x', 'a']]);
    expect(c.containers.get('a')!.name.length).toBe(120);
    expect(c.containers.get('a')!.memo).toBe('m');
    expect(JSON.stringify([[...src.containers], [...src.parentOfBox]])).toBe(before);
  });

  it('`__proto__` という id の入れ物・32 段より深い木・10 万段の親の鎖でも落ちない（再帰しない）', () => {
    const chain: Container[] = [];
    for (let i = 0; i < 100_000; i++) chain.push(C(`c${i}`, i ? `c${i - 1}` : undefined));
    const t = treeOf(
      tree([C('__proto__'), C('child', '__proto__'), ...chain], [['b', '__proto__']]),
    );
    expect(t.depth[1]).toBe(1);
    expect(t.depth[t.ids.length - 1]).toBe(99_999);
    expect(t.boxParent.get('b')).toBe(0);
    // 逆順に宣言した鎖（子が先）でも同じ深さになる
    const rev = treeOf(tree([...chain].reverse()));
    expect(rev.depth[0]).toBe(99_999);
    expect(rev.byDepth[0]).toBe(99_999);
  });

  it('containmentOf の結果は、直しても変わらない', () => {
    const graph = load('poly-86');
    const c = containmentOf(graph);
    const cleaned = cleanContainment(
      c,
      graph.nodes.map((n) => n.id),
    );
    expect(shape(cleaned)).toEqual(shape(c));
  });
});
