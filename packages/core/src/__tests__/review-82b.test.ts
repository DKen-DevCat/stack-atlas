// 8-2b のレビューの指摘（2026-11-09）を直したことを固定する（core の側）:
// S4・C9（合流の相手が多すぎるときの爆発と、直接の合流の曖昧さの警告）、C1〜C3（table の線の照合: 別名・JOIN・大文字小文字）、
// C2（JOIN した別のテーブルのカラムを最初のテーブルの key に結ばない）、C6（言語アダプタの箱 id の衝突）
import {
  validateGraphV2,
  type GraphV2,
  type ItemV2,
  type NodeV2,
  type PortV2,
} from '@stack-atlas/schema';
import { describe, expect, it } from 'vitest';
import { joinAll, MAX_JOIN_MATCHES } from '../join.js';
import { writeBroken } from '../broken-v2.js';
import { createMemoryLogger } from '../logger.js';
import { buildGraph } from '../pipeline.js';
import { disambiguateV2 } from '../v2-parts.js';
import type { Extractor, PartialGraph } from '../types.js';
import { tmpRepo } from './helpers.js';

const I = (id: string, type = 'string', extra: Partial<ItemV2> = {}): ItemV2 => ({
  id,
  name: id,
  type,
  ...extra,
});
const P = (id: string, dir: 'in' | 'out', items: ItemV2[]): PortV2 => ({ id, dir, items });
const endpoint = (method: string, path: string): NodeV2 => ({
  id: `endpoint:${method} ${path}`,
  kind: 'endpoint',
  name: `${method} ${path}`,
  runtime: 'server',
  meta: { api: { method, path } },
  ports: [
    P('in', 'in', [I('path', 'x', { wireType: 'object' })]),
    P('req', 'out', [I('path', 'x', { wireType: 'object' })]),
    P('res', 'in', [I('body', 'x', { wireType: 'object' })]),
    P('out', 'out', [I('body', 'x', { wireType: 'object' })]),
  ],
});
const handler = (id: string, path: string): NodeV2 => ({
  id,
  kind: 'fn',
  name: id,
  runtime: 'server',
  meta: { route: { method: 'GET', path } },
  ports: [
    P('in', 'in', [I('path', 'string', { wireType: 'string', meta: { http: 'path' } })]),
    P('out', 'out', [I('response', 'string', { wireType: 'string', meta: { http: 'response' } })]),
  ],
});
const caller = (id: string, path: string): NodeV2 => ({
  id,
  kind: 'fn',
  name: id,
  runtime: 'browser',
  ports: [
    P('in', 'in', [I('ret_1', 'x')]),
    P('out', 'out', [
      I('call_1', 'void', {
        meta: { http: { method: 'GET', path } },
        children: [I('path', 'string', { wireType: 'string', meta: { http: 'path' } })],
      }),
    ]),
  ],
});

describe('S4・C9: 合流の相手が多すぎるとき・複数のとき', () => {
  it('S4: `/{x}` の handler が N 個あっても endpoint × handler の線を引かず、数だけを 1 回警告する（N = 1500）', () => {
    // 以前は endpoint ごとに全部の handler と結び、handler の id を全部並べた警告を endpoint ごとに出していた
    // （N² 本の線と N² 個の id。セキュリティのレビューの実測で N = 2000 でメモリが尽きた）
    const N = 1500;
    const g: GraphV2 = { version: 2, nodes: [], wires: [] };
    for (let i = 0; i < N; i++) g.nodes.push(endpoint('GET', `/a${i}`));
    for (let i = 0; i < N; i++) g.nodes.push(handler(`fn:cmd/api.h${i}`, '/{x}'));
    const t0 = performance.now();
    const r = joinAll(g);
    const ms = performance.now() - t0;
    expect(ms).toBeLessThan(10_000);
    expect(r.wires).toEqual([]);
    expect(r.server.matched).toBe(0);
    const crowded = r.issues.filter((i) => i.message.includes(`${MAX_JOIN_MATCHES} を超えて`));
    expect(crowded).toHaveLength(1);
    expect(crowded[0]!.message).toContain(`endpoint ${N} 件は結びません`);
    // 警告の文の総量は N に比例しない
    expect(r.issues.reduce((s, i) => s + i.message.length, 0)).toBeLessThan(2000);
    // 相手が多すぎた handler のルートを「OpenAPI に無いルート」とは数えない
    expect(r.server.unmatched).toEqual([]);
  }, 30_000);

  it('S4: 上限（8）までは全部と結んで警告する（従来どおり）', () => {
    const g: GraphV2 = { version: 2, nodes: [endpoint('GET', '/a')], wires: [] };
    for (let i = 0; i < MAX_JOIN_MATCHES; i++) g.nodes.push(handler(`fn:h${i}`, '/{x}'));
    const r = joinAll(g);
    expect(r.server.matched).toBe(MAX_JOIN_MATCHES);
    expect(r.issues.some((i) => i.message.includes(`合う handler が ${MAX_JOIN_MATCHES} つ`))).toBe(
      true,
    );
  });

  it('C9: OpenAPI の無い直接の合流でも、複数の handler と結ぶときは警告する。上限を超えれば結ばない', () => {
    const g: GraphV2 = {
      version: 2,
      nodes: [caller('fn:web', '/x'), handler('fn:a', '/{p}'), handler('fn:b', '/{q}')],
      wires: [],
    };
    const r = joinAll(g);
    // 以前は警告なしで両方と結んでいた
    expect(r.client.direct).toBe(1);
    expect(
      r.issues.some((i) => i.message.includes('fn:web#out/call_1 に合う handler が 2 つ')),
    ).toBe(true);
    const many: GraphV2 = { version: 2, nodes: [], wires: [] };
    for (let i = 0; i < 300; i++) many.nodes.push(caller(`fn:web${i}`, `/c${i}`));
    for (let i = 0; i < 300; i++) many.nodes.push(handler(`fn:h${i}`, '/{x}'));
    const rm = joinAll(many);
    expect(rm.wires).toEqual([]);
    expect(rm.client.direct).toBe(0);
    expect(rm.issues.some((i) => i.message.includes('HTTP 呼び出し 300 件は結びません'))).toBe(
      true,
    );
    // 結べない呼び出しの並びは 20 件まで（残りは数）
    const left = rm.issues.find((i) => i.message.startsWith('endpoint・handler と結べない'))!;
    expect(left.message).toContain('ほか 280 件');
  });
});

/** table（users）と、それを読む関数の箱 */
function tableWorld(rowChildren: ItemV2[], rowMeta: Record<string, unknown> = {}): GraphV2 {
  const col = (id: string, wireType: ItemV2['wireType'], extra: Partial<ItemV2> = {}) =>
    I(id, 'TEXT', { wireType, typeRef: 'table:users', ...extra });
  const cols = (o: { nullable?: boolean; optional?: boolean } = {}) => [
    col('id', 'string', o.optional ? {} : {}),
    col('name', 'string', o.nullable ? { nullable: true } : o.optional ? { optional: true } : {}),
    col(
      'UserID',
      'integer',
      o.nullable ? { nullable: true } : o.optional ? { optional: true } : {},
    ),
  ];
  const row = (children: ItemV2[]) =>
    I('row', 'record', { wireType: 'object', typeRef: 'table:users', children });
  return {
    version: 2,
    nodes: [
      {
        id: 'schema:users',
        kind: 'table',
        name: 'users',
        runtime: 'data',
        meta: { sql: { table: 'users' } },
        ports: [
          P('key', 'in', cols()),
          P('write', 'in', [row(cols({ optional: true }))]),
          P('read', 'out', [row(cols({ nullable: true }))]),
        ],
      },
      {
        id: 'fn:store.find',
        kind: 'fn',
        name: 'store.find',
        runtime: 'server',
        ports: [
          P('in', 'in', [
            I('row', 'record', {
              wireType: 'object',
              meta: { sql: { table: 'users', query: 'query_1', ...rowMeta } },
              children: rowChildren,
            }),
          ]),
          P('out', 'out', [
            I('query_1', 'SELECT …', {
              wireType: 'object',
              meta: {
                sql: { table: 'users', op: 'select', where: [], item: 'query_1', row: 'row' },
              },
              children: [
                I('id', 'TEXT', { wireType: 'string', typeRef: 'table:users' }),
                // JOIN した orders のカラム（WHERE o.total > $1）
                I('total', 'BIGINT', { wireType: 'integer', typeRef: 'table:orders' }),
              ],
            }),
            I('insert_1', 'INSERT INTO users', {
              wireType: 'object',
              meta: { sql: { table: 'users', op: 'insert', where: [], item: 'insert_1' } },
              children: [
                I('id', 'TEXT', { wireType: 'string', typeRef: 'table:users' }),
                I('userid', 'BIGINT', { wireType: 'integer', typeRef: 'table:users' }),
              ],
            }),
          ]),
        ],
      },
    ],
    wires: [],
  };
}

const brokenOf = (g: GraphV2, from: string, to: string) =>
  g.wires
    .find((w) => w.from === from && w.to === to)
    ?.broken?.map((b) => `${b.path} ${b.level} ${b.reason}`);

describe('C1〜C3: table の線の照合（broken-v2）', () => {
  it('C1: 別名（`name AS user_name`）は元のカラム（meta.sql.column）で組にする。型が食い違えば error', () => {
    const g = tableWorld([
      I('id', 'TEXT', { wireType: 'string', typeRef: 'table:users', nullable: true }),
      I('user_name', 'TEXT', {
        wireType: 'string',
        typeRef: 'table:users',
        nullable: true,
        meta: { sql: { column: 'name' } },
      }),
    ]);
    joinAll(g);
    writeBroken(g);
    // 以前は user_name が「送る側（users）に無い。受ける側では必須」の error だった
    expect(brokenOf(g, 'schema:users#read/row', 'fn:store.find#in/row')).toBeUndefined();
    // 組にした上で型を比べる（path は送る側のカラム）
    const row = g.nodes[1]!.ports[0]!.items[0]!;
    row.children![1]!.wireType = 'boolean';
    writeBroken(g);
    expect(brokenOf(g, 'schema:users#read/row', 'fn:store.find#in/row')).toEqual([
      'name error wireType が互換でない（string → boolean）',
    ]);
  });

  it('C3: カラムの名前は大文字小文字を区別しない（引用符の無い識別子は畳まれる）。読む線も INSERT も', () => {
    const g = tableWorld([
      I('userid', 'BIGINT', { wireType: 'integer', typeRef: 'table:users', nullable: true }),
    ]);
    joinAll(g);
    writeBroken(g);
    // 以前は userid（受ける側）と UserID（テーブル）が別のカラムとして error になった
    expect(brokenOf(g, 'schema:users#read/row', 'fn:store.find#in/row')).toBeUndefined();
    expect(brokenOf(g, 'fn:store.find#out/insert_1', 'schema:users#write/row')).toBeUndefined();
    // INSERT で name（必須でない）を省くのは良いが、無いカラムを書けば error（従来どおり）
    const ins = g.nodes[1]!.ports[1]!.items[1]!;
    ins.children!.push(I('nope', 'TEXT', { wireType: 'string' }));
    writeBroken(g);
    expect(brokenOf(g, 'fn:store.find#out/insert_1', 'schema:users#write/row')).toEqual([
      'nope error 受ける側（users）に無い',
    ]);
  });

  it('C2: JOIN した行（meta.sql.tables）は、そのテーブルのカラムだけを比べる。別のテーブルの WHERE のカラムは key に結ばない', () => {
    const g = tableWorld(
      [
        I('id', 'TEXT', { wireType: 'string', typeRef: 'table:users', nullable: true }),
        I('total', 'BIGINT', { wireType: 'integer', typeRef: 'table:orders' }),
        // どのテーブルか決められなかったカラム（typeRef 無し）も比べない
        I('note', 'unknown', { wireType: 'unknown' }),
      ],
      { tables: ['users', 'orders'] },
    );
    const r = joinAll(g);
    writeBroken(g);
    // 以前は total・note が「送る側（users）に無い」の error だった
    expect(brokenOf(g, 'schema:users#read/row', 'fn:store.find#in/row')).toBeUndefined();
    expect(g.wires.map((w) => `${w.from} → ${w.to}`)).toContain(
      'fn:store.find#out/query_1.id → schema:users#key/id',
    );
    // 以前は total を users#key に探して「users にカラム total がありません」と警告していた
    expect(g.wires.some((w) => w.from.endsWith('query_1.total'))).toBe(false);
    expect(r.issues.some((i) => i.message.includes('カラム total'))).toBe(false);
    expect(validateGraphV2(g).errors).toEqual([]);
  });
});

describe('C6: 言語アダプタの箱 id の衝突', () => {
  const lang = (name: string, file: string, port: string): Extractor => ({
    name,
    v2Role: 'language',
    detect: async () => true,
    extract: async (): Promise<PartialGraph> => ({
      nodes: [],
      edges: [],
      v2: {
        nodes: [
          {
            id: 'fn:api.list',
            kind: 'fn',
            name: `${name} の api.list`,
            file,
            runtime: name === 'go' ? 'server' : 'browser',
            ports: [P('in', 'in', [I(port)]), P('out', 'out', [I('return')])],
          },
          {
            id: `fn:${name}.caller`,
            kind: 'fn',
            name: 'caller',
            file,
            ports: [P('out', 'out', [I('call_1', 'void', { children: [I(port)] })])],
          },
        ],
        wires: [
          {
            from: `fn:${name}.caller#out/call_1.${port}`,
            to: `fn:api.list#in/${port}`,
            via: 'call',
          },
        ],
        refs: { [`fn:${name}.caller`]: ['fn:api.list'] },
      },
    }),
  });

  it('後に出したアダプタの箱を `fn:<file>~<名前>` にして、線と refs も付け替え、警告する（黙って混ぜない）', async () => {
    const log = createMemoryLogger();
    const res = await buildGraph({
      root: tmpRepo(),
      log,
      commit: false,
      config: {},
      extractors: [lang('ts', 'src/api.ts', 'q'), lang('go', 'list.go', 'limit')],
    });
    const g = res.graphV2!;
    const a = g.nodes.find((n) => n.id === 'fn:api.list')!;
    const b = g.nodes.find((n) => n.id === 'fn:list.go~api.list')!;
    // 以前は 1 つの箱に混ざり、in に q と limit の両方があった
    expect(a.name).toBe('ts の api.list');
    expect(a.ports.find((p) => p.id === 'in')!.items.map((i) => i.id)).toEqual(['q']);
    expect(b.name).toBe('go の api.list');
    expect(b.ports.find((p) => p.id === 'in')!.items.map((i) => i.id)).toEqual(['limit']);
    expect(g.wires.map((w) => `${w.from} → ${w.to}`)).toEqual(
      expect.arrayContaining([
        'fn:ts.caller#out/call_1.q → fn:api.list#in/q',
        'fn:go.caller#out/call_1.limit → fn:list.go~api.list#in/limit',
      ]),
    );
    expect(
      log.of('warn').some((m) => m.includes('fn:api.list') && m.includes('fn:list.go~api.list')),
    ).toBe(true);
    expect(res.issues.some((i) => i.path === 'v2:node:fn:list.go~api.list')).toBe(true);
    expect(res.issues.filter((i) => i.level === 'error')).toEqual([]);
  });

  it('同じ持ち主（同じアダプタ・同じ repo）の箱は付け替えない。refs と groups の参照も付け替える', () => {
    const owners = new Map<string, string>([['fn:x', 'ts@web']]);
    const same = disambiguateV2(
      { nodes: [{ id: 'fn:x', kind: 'fn', name: 'x', ports: [] }], wires: [] },
      owners,
      'ts@web',
    );
    expect(same.renamed).toEqual([]);
    const other = disambiguateV2(
      {
        nodes: [{ id: 'fn:x', kind: 'fn', name: 'x', ports: [] }],
        wires: [],
        refs: { 'fn:x': ['fn:x'] },
        groups: { 'fn:x': 'handler:pkg' },
      },
      owners,
      'go@platform',
    );
    expect(other.renamed).toEqual([{ from: 'fn:x', to: 'fn:x~2', other: 'ts@web' }]);
    expect(other.part.refs).toEqual({ 'fn:x~2': ['fn:x~2'] });
    expect(other.part.groups).toEqual({ 'fn:x~2': 'handler:pkg' });
    expect(owners.get('fn:x~2')).toBe('go@platform');
  });
});
