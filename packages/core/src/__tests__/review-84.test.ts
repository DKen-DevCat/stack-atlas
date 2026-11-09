// 2026-11-10（8-4 のレビュー）: 直す前に失敗したもの。手書きの線の端・ルートごとの unjoined・nodes のパッチの原子性・
// when のキー・failed の言語アダプタ・retarget（補いの線で置き換わったもの・重複）・既定の links と意味の参照の上限（DoS）・
// 補いの数の上限・秘密らしいファイルの code
import { validateGraphV2, type GraphV2, type ItemV2, type PortV2 } from '@stack-atlas/schema';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { HAND_LIMITS } from '../hand-graph.js';
import { createMemoryLogger } from '../logger.js';
import { buildGraph, type BuildGraphResult } from '../pipeline.js';
import { strictIssues } from '../strict.js';
import {
  applySupplementsA,
  applySupplementsB,
  MAX_DEFAULT_LINKS,
  MAX_SUPPLEMENTS_PER_KIND,
} from '../supplements.js';
import type { Extractor, PartialGraph, PartialNodeV2 } from '../types.js';
import { tmpRepo } from './helpers.js';

const I = (id: string, type = 'string', extra: Partial<ItemV2> = {}): ItemV2 => ({
  id,
  name: id,
  type,
  ...extra,
});
const P = (id: string, dir: 'in' | 'out', items: ItemV2[]): PortV2 => ({ id, dir, items });
const stub = (name: string, out: PartialGraph, v2Role?: Extractor['v2Role']): Extractor => ({
  name,
  ...(v2Role ? { v2Role } : {}),
  detect: async () => true,
  extract: async () => structuredClone(out),
});
const build = (files: Record<string, string>, extractors: Extractor[]): Promise<BuildGraphResult> =>
  buildGraph({
    root: tmpRepo({ 'stack-atlas.config.yaml': 'project: { name: r84 }\n', ...files }),
    extractors,
    log: createMemoryLogger(),
    commit: false,
    now: new Date('2026-11-10T00:00:00Z'),
  });
const fn = (id: string, ports: PortV2[], extra: Partial<PartialNodeV2> = {}): PartialNodeV2 => ({
  id,
  kind: 'fn',
  name: id.slice(3),
  runtime: 'server',
  ports,
  ...extra,
});
const endpoint = (method: string, path: string): PartialNodeV2 => ({
  id: `endpoint:${method} ${path}`,
  kind: 'endpoint',
  name: `${method} ${path}`,
  runtime: 'server',
  meta: { api: { method, path } },
  ports: [
    P('in', 'in', [I('body', 'object', { wireType: 'object' })]),
    P('req', 'out', [I('body', 'object', { wireType: 'object' })]),
    P('res', 'in', []),
    P('out', 'out', []),
  ],
});
const rulesOf = (r: BuildGraphResult) => strictIssues(r).errors.map((e) => e.rule);

describe('#1 手書きの線の端が解けない（typo）: ファイルを解けない補いにする（黙って落とさない）', () => {
  const hand = (to: string) => `
nodes:
  - id: "external:x"
    kind: external
    name: x
    runtime: external
    ports: [{ id: out, dir: out, items: [{ id: ev, name: ev, type: E, wireType: object }] }]
wires:
  - { from: "external:x#out/ev", to: "${to}", via: http }
`;
  const lang = stub(
    'lang',
    {
      nodes: [],
      edges: [],
      v2: { nodes: [fn('fn:h', [P('in', 'in', [I('body', 'B')])])], wires: [] },
    },
    'language',
  );
  it('箱の typo・項目の typo は unresolved（strict のエラー）、正しい線は効く', async () => {
    for (const to of ['fn:hh#in/body', 'fn:h#in/bodyy']) {
      const res = await build({ '.stack-atlas/graph/x.v2.yaml': hand(to) }, [lang]);
      const r = res.harness!.supplements.find((s) => s.kind === 'hand')!;
      expect(r.status).toBe('unresolved');
      expect(r.message).toContain(to);
      expect(rulesOf(res)).toContain('supplements');
      expect(res.graphV2!.wires.some((w) => w.to === to)).toBe(false);
      expect(validateGraphV2(res.graphV2).errors).toEqual([]);
    }
    const ok = await build({ '.stack-atlas/graph/x.v2.yaml': hand('fn:h#in/body') }, [lang]);
    expect(ok.harness!.supplements.find((s) => s.kind === 'hand')!.status).toBe('applied');
    expect(ok.graphV2!.wires).toContainEqual(
      expect.objectContaining({ from: 'external:x#out/ev', to: 'fn:h#in/body' }),
    );
  });

  it('#10 全部のファイルが解けないなら checked.hand は failed（ok にしない）', async () => {
    const res = await build(
      {
        '.stack-atlas/graph/a.v2.yaml': 'nodes: 1\n',
        '.stack-atlas/graph/b.v2.yaml': hand('fn:nope#in/body'),
      },
      [lang],
    );
    expect(res.harness!.checked.hand).toMatchObject({ status: 'failed', role: 'language' });
    const half = await build(
      {
        '.stack-atlas/graph/a.v2.yaml': 'nodes: 1\n',
        '.stack-atlas/graph/b.v2.yaml': hand('fn:h#in/body'),
      },
      [lang],
    );
    expect(half.harness!.checked.hand).toMatchObject({ status: 'ok' });
    expect(half.harness!.checked.hand!.reason).toMatch(/2 ファイルのうち 1 が解けません/);
  });
});

describe('#2 OpenAPI に無いルートはルートごと（結べたルートが同じ箱の別のルートを隠さない）', () => {
  const run = (overrides = '', handFiles: Record<string, string> = {}) =>
    build({ 'stack-atlas.overrides.yaml': overrides, ...handFiles }, [
      stub(
        'lang',
        {
          nodes: [],
          edges: [],
          v2: {
            nodes: [
              fn(
                'fn:h',
                [P('in', 'in', [I('body', 'B')]), P('out', 'out', [I('return', 'error')])],
                {
                  meta: { routes: ['POST /a', 'POST /hook'] },
                },
              ),
            ],
            wires: [],
          },
        },
        'language',
      ),
      stub(
        'contract',
        { nodes: [], edges: [], v2: { nodes: [endpoint('POST', '/a')], wires: [] } },
        'contract',
      ),
    ]);
  const sender = `
nodes:
  - id: "external:s"
    kind: external
    name: s
    runtime: external
    ports: [{ id: out, dir: out, items: [{ id: ev, name: ev, type: E, wireType: object }] }]
`;
  it('POST /a は endpoint と結べ、POST /hook は残る。label で POST /hook を名指しした線で消える', async () => {
    const res = await run();
    expect(res.harness!.unjoined.routesWithoutEndpoint).toEqual([
      { box: 'fn:h', method: 'POST', path: '/hook' },
    ]);
    // 名指しの無い http の線は、ルートが 2 つある箱ではどちらのルートか決まらない（残す）
    const vague = await run(
      'v2:\n  wires:\n    - { from: "external:s#out/ev", to: "fn:h#in/body", via: http, reason: r }\n',
      { '.stack-atlas/graph/s.v2.yaml': sender },
    );
    expect(vague.harness!.unjoined.routesWithoutEndpoint).toHaveLength(1);
    const named = await run(
      'v2:\n  wires:\n    - { from: "external:s#out/ev", to: "fn:h#in/body", via: http, label: "POST /hook", reason: r }\n',
      { '.stack-atlas/graph/s.v2.yaml': sender },
    );
    expect(named.harness!.unjoined.routesWithoutEndpoint).toEqual([]);
  });
});

/** 段 A / B の単体の世界 */
function world(): GraphV2 {
  return {
    version: 2,
    nodes: [
      {
        id: 'fn:a',
        kind: 'fn',
        name: 'a',
        runtime: 'browser',
        ports: [
          P('in', 'in', [I('call', 'void'), I('ret_1', 'R')]),
          P('out', 'out', [I('call_1', 'R', { name: 'b()' }), I('rows', 'Row[]')]),
        ],
      },
      {
        id: 'fn:b',
        kind: 'fn',
        name: 'b',
        runtime: 'browser',
        ports: [P('in', 'in', [I('call', 'void')]), P('out', 'out', [I('ret', 'R')])],
      },
    ],
    wires: [
      { from: 'fn:a#out/call_1', to: 'fn:b#in/call', via: 'call' },
      { from: 'fn:b#out/ret', to: 'fn:a#in/ret_1', via: 'return', reply: true },
    ],
  };
}

describe('#3 v2.nodes のパッチは全部を確かめてから当てる（解けないなら何も変えない）', () => {
  it('kind が語彙に無いパッチは name も変えない', () => {
    const g = world();
    const a = applySupplementsA(g, {
      nodes: [{ id: 'fn:b', name: '新しい名前', kind: 'bogus', reason: 'r' }],
    });
    expect(a.results.map((r) => r.status)).toEqual(['unresolved']);
    expect(g.nodes.find((n) => n.id === 'fn:b')!.name).toBe('b');
  });
});

describe('#4 when のキーは宣言した分岐で解く（解けなければ名指しの解けない補い。最後の検証のエラーにしない）', () => {
  it('links・when・線の when の宣言の無いキーは unresolved。graph は検証を通る', () => {
    const g = world();
    const a = applySupplementsA(g, {
      wires: [
        {
          from: 'fn:a#out/rows',
          to: 'fn:b#in/call',
          via: 'call',
          when: { ghost: true },
          reason: 'r',
        },
        {
          from: 'fn:b#out/ret',
          to: 'fn:a#in/call',
          via: 'call',
          when: { flag: true },
          reason: 'r',
        },
      ],
    });
    const b = applySupplementsB(
      g,
      {
        variants: [{ node: 'fn:b', id: 'flag', name: 'フラグ', reason: 'r' }],
        links: [
          { node: 'fn:a', from: 'in/call', to: 'out/rows', when: { nope: true }, reason: 'r' },
        ],
        when: [
          {
            node: 'fn:b',
            link: { from: 'in/call', to: 'out/ret' },
            when: { missing: false },
            reason: 'r',
          },
        ],
      },
      a,
    );
    const all = [...a.results, ...b];
    expect(all.map((r) => `${r.kind}:${r.status}`)).toEqual([
      'wires:unresolved',
      'wires:applied',
      'variants:applied',
      'links:unresolved',
      'when:unresolved',
    ]);
    expect(all[0]!.message).toContain('ghost');
    expect(all[3]!.message).toContain('nope');
    expect(all[4]!.message).toContain('missing');
    // 解けない when の線は足さない（条件の無い線にしない）。宣言のある flag の線は残る
    expect(g.wires.some((w) => w.from === 'fn:a#out/rows')).toBe(false);
    expect(g.wires.find((w) => w.from === 'fn:b#out/ret' && w.to === 'fn:a#in/call')!.when).toEqual(
      { flag: true },
    );
    expect(validateGraphV2(g).errors).toEqual([]);
  });
});

describe('#4 手書きの線の when のキーも宣言した分岐で解く', () => {
  it('解けない when の手書きの線は足さず、そのファイルを解けない補いにする（最後の検証のエラーにしない）', async () => {
    const res = await build(
      {
        '.stack-atlas/graph/x.v2.yaml': `
nodes:
  - id: "external:x"
    kind: external
    name: x
    runtime: external
    ports: [{ id: out, dir: out, items: [{ id: ev, name: ev, type: E, wireType: object }] }]
  - id: "external:y"
    kind: external
    name: y
    runtime: external
    ports: [{ id: in, dir: in, items: [{ id: ev, name: ev, type: E, wireType: object }] }]
wires:
  - { from: "external:x#out/ev", to: "external:y#in/ev", via: http, when: { ghost: true } }
`,
      },
      [],
    );
    const r = res.harness!.supplements.find((s) => s.kind === 'hand')!;
    expect(r.status).toBe('unresolved');
    expect(r.message).toContain('ghost');
    expect(res.graphV2!.wires.some((w) => w.from === 'external:x#out/ev')).toBe(false);
    expect(res.issues.filter((i) => i.level === 'error')).toEqual([]);
  });
});

describe('#5 failed の言語アダプタは strict のエラー（skipped で隠さない）', () => {
  it('ある repo で飛ばし、別の repo で失敗した: checked は failed、strict のエラー', async () => {
    const root = tmpRepo({
      'stack-atlas.config.yaml': 'project: { name: m }\nrepos: { a: a, b: b }\n',
      'a/x.txt': 'a',
      'b/x.txt': 'b',
    });
    const flaky: Extractor = {
      name: 'flaky',
      v2Role: 'language',
      detect: async () => true,
      extract: async (ctx) => {
        if (ctx.repoName === 'b') throw new Error('壊れた');
        return { nodes: [], edges: [], skipped: '道具が無い' };
      },
    };
    const res = await buildGraph({ root, extractors: [flaky], commit: false });
    expect(res.harness!.checked.flaky!.status).toBe('failed');
    expect(strictIssues(res).errors.map((e) => e.rule)).toContain('failed');
  });
});

describe('#6・#7 retarget', () => {
  const v1api: PartialGraph = {
    nodes: [
      { id: 'lib:api', kind: 'lib', file: 'src/api.ts', meta: { ts: { exports: ['getA'] } } },
      { id: 'endpoint:GET /a', kind: 'endpoint', meta: { api: { method: 'GET', path: '/a' } } },
    ],
    edges: [{ from: 'lib:api', to: 'endpoint:GET /a', kind: 'http' }],
  };
  const adapter: PartialGraph = {
    nodes: [],
    edges: [],
    v2: {
      nodes: [
        {
          ...fn('fn:getA', [
            P('in', 'in', [I('call', 'void')]),
            P('out', 'out', [
              I('call_1', 'R', {
                meta: { http: { method: 'GET', path: '/zzz' } },
                children: [I('path', 'string', { meta: { http: 'path' } })],
              }),
            ]),
          ]),
          file: 'src/api.ts',
          runtime: 'browser',
          meta: { ts: { exportName: 'getA' } },
        },
      ],
      wires: [],
    },
  };
  const ep: PartialGraph = {
    nodes: [],
    edges: [],
    v2: {
      nodes: [
        {
          ...endpoint('GET', '/a'),
          ports: [P('in', 'in', [I('path', 'string')]), P('req', 'out', [I('path', 'string')])],
        },
      ],
      wires: [],
    },
  };
  const run = (overrides: string) =>
    build({ 'stack-atlas.overrides.yaml': overrides }, [
      stub('v1', v1api),
      stub('lang', adapter, 'language'),
      stub('contract', ep, 'contract'),
    ]);
  it('#6 補いの線（段 A）で箱の単位の線が置き換わった group と peer の retarget は、満たされたもの（解けない補いにしない）', async () => {
    // 片道の線（部品を描く render。戻りの線が無いので retarget は戻りでも使われない）
    const comp: PartialGraph = {
      nodes: [
        { id: 'lib:api', kind: 'lib', file: 'src/api.ts', meta: { ts: { exports: ['getA'] } } },
        { id: 'comp:X', kind: 'component', file: 'src/X.tsx' },
      ],
      edges: [{ from: 'lib:api', to: 'comp:X', kind: 'uses' }],
    };
    const res = await build(
      {
        'stack-atlas.overrides.yaml':
          'v2:\n  wires:\n    - { from: { ref: "fn:getA#out/call_1", expect: { http: GET /zzz } }, to: "comp:X#in/_", via: render, reason: r }\n  retarget:\n    - { group: lib:api, peer: "comp:X", to: [fn:getA], reason: r }\n',
      },
      [stub('v1', comp), stub('lang', adapter, 'language')],
    );
    // 箱の単位の線（lib:api → comp:X）は補いの線で置き換わった
    expect(res.graphV2!.wires.filter((w) => w.to.startsWith('comp:X#'))).toEqual([
      expect.objectContaining({
        from: 'fn:getA#out/call_1',
        meta: expect.objectContaining({ by: 'overrides' }),
      }),
    ]);
    const rt = res.harness!.supplements.find((s) => s.kind === 'retarget')!;
    expect(rt.status).toBe('applied');
    expect(rt.message).toMatch(/補いの線/);
    expect(rulesOf(res)).not.toContain('supplements');
  });
  it('#7 同じ group と peer の retarget の 2 つ目は解けない（重複。1 つ目を使う）', async () => {
    const res = await run(
      'v2:\n  retarget:\n    - { group: lib:api, peer: "endpoint:GET /a", to: [fn:getA], reason: r }\n    - { group: lib:api, peer: "endpoint:GET /a", to: [fn:getA], reason: r2 }\n',
    );
    const rts = res.harness!.supplements.filter((s) => s.kind === 'retarget');
    expect(rts.map((r) => r.status)).toEqual(['applied', 'unresolved']);
    expect(rts[1]!.message).toMatch(/v2\.retarget\[0\] と同じ group と peer/);
  });
});

describe('S3 DoS: 既定の links の実体化・意味の参照・補いと手書きの線の数に上限', () => {
  const wide = (nIn: number, nOut: number): GraphV2 => ({
    version: 2,
    nodes: [
      {
        id: 'fn:w',
        kind: 'fn',
        name: 'w',
        runtime: 'server',
        ports: [
          P(
            'in',
            'in',
            Array.from({ length: nIn }, (_, k) => I(`i${k}`)),
          ),
          P(
            'out',
            'out',
            Array.from({ length: nOut }, (_, k) => I(`o${k}`)),
          ),
        ],
      },
    ],
    wires: [],
  });
  it('既定の links が上限を超える箱の links の補いは解けない（mode: replace を勧める）。replace は効く', () => {
    const n = Math.ceil(Math.sqrt(MAX_DEFAULT_LINKS)) + 5;
    const g = wide(n, n);
    const r = applySupplementsB(g, {
      links: [{ node: 'fn:w', from: 'in/i0', to: 'out/o0', reason: 'r' }],
    });
    expect(r[0]!.status).toBe('unresolved');
    expect(r[0]!.message).toContain('mode: replace');
    expect(g.nodes[0]!.links).toBeUndefined();
    const g2 = wide(n, n);
    const r2 = applySupplementsB(g2, {
      links: [{ node: 'fn:w', from: 'in/i0', to: 'out/o0', mode: 'replace', reason: 'r' }],
    });
    expect(r2[0]!.status).toBe('applied');
    expect(g2.nodes[0]!.links).toHaveLength(1);
  });

  it('掃除（linkUnderscores）も既定の links を上限を超えて書き出さない（警告）', async () => {
    const n = Math.ceil(Math.sqrt(MAX_DEFAULT_LINKS)) + 5;
    const res = await build({}, [
      stub('v1', {
        nodes: [
          { id: 'lib:x', kind: 'lib', file: 'src/x.ts' },
          { id: 'lib:y', kind: 'lib', file: 'src/y.ts' },
        ],
        edges: [{ from: 'lib:y', to: 'lib:x', kind: 'uses' }],
      }),
      stub(
        'lang',
        {
          nodes: [],
          edges: [],
          v2: {
            nodes: [
              {
                ...fn('lib:x', [
                  P(
                    'in',
                    'in',
                    Array.from({ length: n }, (_, k) => I(`i${k}`)),
                  ),
                  P(
                    'out',
                    'out',
                    Array.from({ length: n }, (_, k) => I(`o${k}`)),
                  ),
                ]),
                kind: 'helper',
              },
            ],
            wires: [],
          },
        },
        'language',
      ),
    ]);
    const x = res.graphV2!.nodes.find((nd) => nd.id === 'lib:x')!;
    expect((x.links ?? []).length).toBeLessThanOrEqual(MAX_DEFAULT_LINKS);
    expect(res.issues.some((i) => i.message.includes('既定の links'))).toBe(true);
  });

  it('意味の参照は箱の線を参照ごとに全部見ない（3000 本の線の箱に 20 の参照で 1.5 秒未満。直す前は 6 秒台）', () => {
    const N = 3000;
    const outs = Array.from({ length: N }, (_, k) => I(`o${k}`, 'T'));
    const g: GraphV2 = {
      version: 2,
      nodes: [
        {
          id: 'fn:a',
          kind: 'fn',
          name: 'a',
          runtime: 'server',
          ports: [P('in', 'in', [I('call', 'v')]), P('out', 'out', outs)],
        },
        {
          id: 'fn:t',
          kind: 'fn',
          name: 't',
          runtime: 'server',
          ports: [
            P(
              'in',
              'in',
              outs.map((o) => ({ ...o })),
            ),
          ],
        },
      ],
      wires: outs.map((o) => ({ from: `fn:a#out/${o.id}`, to: `fn:t#in/${o.id}`, via: 'call' })),
    };
    const t = Date.now();
    const a = applySupplementsA(g, {
      wires: Array.from({ length: 20 }, () => ({
        from: { call: { in: 'fn:a', to: 'fn:nope' } },
        to: 'fn:t#in/o1',
        via: 'call',
        reason: 'r',
      })),
    });
    expect(Date.now() - t).toBeLessThan(1500);
    expect(a.results.every((r) => r.status === 'unresolved')).toBe(true);
  }, 30_000);

  it('補いは種類ごとに上限まで（超えた分は 1 件の解けない補いにまとめて無視）', () => {
    const g = world();
    const a = applySupplementsA(g, {
      wires: Array.from({ length: MAX_SUPPLEMENTS_PER_KIND + 3 }, () => ({ reason: 'r' })),
    });
    expect(a.results).toHaveLength(MAX_SUPPLEMENTS_PER_KIND + 1);
    const cap = a.results.filter((r) => r.index === MAX_SUPPLEMENTS_PER_KIND);
    expect(cap).toEqual([
      expect.objectContaining({
        kind: 'wires',
        status: 'unresolved',
        message: expect.stringMatching(/上限/),
      }),
    ]);
  });

  it('手書きの線は全部のファイルで上限まで（超えたファイルは読まない）', async () => {
    const n = HAND_LIMITS.wires + 1;
    const lines = Array.from(
      { length: n },
      (_, k) => `  - { from: "external:x#out/ev", to: "external:y#in/i${k % 2}", via: http }`,
    );
    const yaml = `nodes:
  - { id: "external:x", kind: external, name: x, runtime: external, ports: [{ id: out, dir: out, items: [{ id: ev, name: ev, type: E }] }] }
  - { id: "external:y", kind: external, name: y, runtime: external, ports: [{ id: in, dir: in, items: [{ id: i0, name: i0, type: E }, { id: i1, name: i1, type: E }] }] }
wires:
${lines.join('\n')}
`;
    const res = await build({ [join('.stack-atlas', 'graph', 'big.v2.yaml')]: yaml }, []);
    const r = res.harness!.supplements.find((s) => s.kind === 'hand')!;
    expect(r.status).toBe('unresolved');
    expect(r.message).toMatch(/上限/);
  }, 30_000);
});

describe('S2 秘密らしいファイル・repo の外のファイルの code は graph に入れない（箱は残す）', () => {
  it('.env・*.pem・id_rsa・*secret*・.npmrc・credentials と ../ の file の code を外す', async () => {
    const files = [
      '.env.local',
      'keys/server.pem',
      'keys/id_rsa',
      'config/app-secret.json',
      '.npmrc',
      'aws/credentials',
      '../outside/x.ts',
      'src/ok.ts',
    ];
    const res = await build({}, [
      stub('v1', {
        nodes: files.map((f, k) => ({
          id: `lib:f${k}`,
          kind: 'lib',
          file: f,
          code: 'canary-7f3a9c1d',
        })),
        edges: [],
      }),
    ]);
    const code = (g: { nodes: Array<{ file?: string; code?: string }> }) =>
      g.nodes.filter((nd) => nd.code).map((nd) => nd.file);
    expect(code(res.graph)).toEqual(['src/ok.ts']);
    expect(code(res.graphV2!)).toEqual(['src/ok.ts']);
    expect(res.graph.nodes).toHaveLength(files.length);
  });
});
