// ts-types の規則を小さな合成のプロジェクトで固定する（docs/17 §3.2・§7 #3・#10・#11、docs/16 §4・§5、D41・D47・D54）
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Project } from 'ts-morph';
import { afterAll, describe, expect, it } from 'vitest';
import type { ItemV2 } from '@stack-atlas/schema';
import {
  createMemoryLogger,
  createRepoContext,
  type PartialGraphV2,
  type StackAtlasConfig,
} from '@stack-atlas/core';
import { extractor as tsImports } from '@stack-atlas/extractor-ts-imports';
import { buildV2, ensureReactTypes } from '../index.js';

const TSCONFIG = JSON.stringify({
  compilerOptions: {
    target: 'ES2022',
    lib: ['dom', 'esnext'],
    module: 'esnext',
    moduleResolution: 'bundler',
    jsx: 'preserve',
    strict: true,
    noEmit: true,
    skipLibCheck: true,
    baseUrl: '.',
    paths: { '@/*': ['src/*'] },
  },
  include: ['src/**/*.ts', 'src/**/*.tsx'],
});

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

/** 一時ディレクトリに TS のプロジェクトを作って ts-imports → ts-types を掛ける */
async function run(files: Record<string, string>, config: StackAtlasConfig = {}) {
  const root = mkdtempSync(join(tmpdir(), 'stack-atlas-ts-types-'));
  roots.push(root);
  for (const [p, src] of Object.entries({ 'tsconfig.json': TSCONFIG, ...files })) {
    mkdirSync(dirname(join(root, p)), { recursive: true });
    writeFileSync(join(root, p), src);
  }
  const log = createMemoryLogger();
  const ctx = createRepoContext(root, config, log, { repoName: 'app' });
  const up = await tsImports.extract(ctx, { nodes: [], edges: [] });
  const v2 = buildV2(ctx, up);
  return { v2, log, root, up, node: (id: string) => v2.nodes.find((n) => n.id === id)! };
}

const wireKeys = (v2: PartialGraphV2) => v2.wires.map((w) => `${w.from} → ${w.to}`);
const item = (items: ItemV2[] | undefined, id: string) => items?.find((i) => i.id === id);

describe('箱の id（D47）', () => {
  it('fn: の名前が複数ファイルにあればファイルで修飾し、ファイル名と同じ唯一の export は v1 の lib: の id のまま', async () => {
    const { v2 } = await run({
      'src/a.ts': 'export function load(): number { return 1; }',
      'src/b.ts': 'export function load(): number { return 2; }\nexport const other = () => 3;',
      'src/lib/fetcher/index.ts': 'export function fetcher(u: string): string { return u; }',
    });
    expect(v2.nodes.map((n) => [n.id, n.kind]).sort()).toEqual([
      ['fn:other', 'fn'],
      ['fn:src/a.ts~load', 'fn'],
      ['fn:src/b.ts~load', 'fn'],
      ['lib:fetcher', 'helper'],
    ]);
  });
});

describe('口と項目（docs/16 §5）', () => {
  it('引数・分割代入はフィールド、引数の無い関数は in/call、Promise は剥がし、型の対応表（Date・配列・nullable・optional）', async () => {
    const { node } = await run({
      'src/types.ts': [
        'export type Row = { id: string; at: Date; tags: string[]; note?: string; parent: Row | null };',
      ].join('\n'),
      'src/api.ts': [
        "import type { Row } from './types';",
        'export async function load(): Promise<Row[]> { return []; }',
        'export function save({ id, at }: { id: string; at: Date }, dry = false): void { void id; void at; void dry; }',
      ].join('\n'),
    });
    const load = node('fn:load');
    expect(load.ports.map((p) => [p.id, p.items.map((i) => i.id)])).toEqual([
      ['in', ['call']],
      ['out', ['return']],
    ]);
    const ret = load.ports[1]!.items[0]!;
    expect(ret).toMatchObject({ type: 'Promise<Row[]>', wireType: 'array', typeRef: 'type:Row' });
    const kids = new Map(ret.children!.map((c) => [c.id, c]));
    expect(kids.get('at')).toMatchObject({ wireType: 'datetime', typeRef: 'type:Row' });
    expect(kids.get('at')!.children).toBeUndefined(); // repo の外の型（Date）は展開しない
    expect(kids.get('tags')).toMatchObject({ wireType: 'array', typeRef: 'type:Row' });
    expect(kids.get('note')).toMatchObject({ optional: true, wireType: 'string' });
    expect(kids.get('parent')).toMatchObject({
      nullable: true,
      wireType: 'object',
      typeRef: 'type:Row',
    });
    const save = node('fn:save');
    expect(save.ports[0]!.items.map((i) => [i.id, i.optional ?? false])).toEqual([
      ['id', false],
      ['at', false],
      ['dry', true],
    ]);
    // void の戻り値は wireType を書かない
    expect(save.ports[1]!.items[0]).toEqual({ id: 'return', name: 'return', type: 'void' });
  });

  it('展開の深さ（adapters.depth）と 1 箱の項目の上限（adapters.maxItems。超えたら警告して打ち切る）', async () => {
    const files = {
      'src/types.ts':
        'export type A = { b: { c: { d: string } }; x1: string; x2: string; x3: string };',
      'src/f.ts': "import type { A } from './types';\nexport function f(a: A): A { return a; }",
    };
    const deep = await run(files, { adapters: { depth: 1 } });
    const a = deep.node('lib:f').ports[0]!.items[0]!; // ファイル名と同じ唯一の export なので lib: の id
    expect(item(a.children, 'b')!.children).toBeUndefined();
    const capped = await run(files, { adapters: { maxItems: 3 } });
    expect(capped.log.of('warn')).toEqual(
      expect.arrayContaining([expect.stringContaining('lib:f の項目が上限（3）を超えた')]),
    );
  });
});

describe('同じ言語の中の線（D41）と links', () => {
  it('受ける側の子が名前で全部写るなら親 1 本、写らない子（optional で渡していない）があれば写る子ごと', async () => {
    const { v2, node } = await run({
      'src/f.ts': [
        'export function full(a: { x: string; y: number }): string { return a.x; }',
        'export function part(b: { x: string; w?: string }): string { return b.x; }',
        "export function caller(): string { return full({ x: 'a', y: 1 }) + part({ x: 'b' }); }",
      ].join('\n'),
    });
    expect(wireKeys(v2)).toEqual(
      expect.arrayContaining([
        'fn:caller#out/call_1.a → fn:full#in/a',
        'fn:caller#out/call_2.b.x → fn:part#in/b.x',
        'fn:full#out/return → fn:caller#in/ret_1',
      ]),
    );
    expect(wireKeys(v2)).not.toContain('fn:caller#out/call_2.b → fn:part#in/b');
    // return に入る呼び出しの戻り（exact）。引数がリテラルだけの呼び出しには起動の link（crude）
    expect(node('fn:caller').links).toEqual(
      expect.arrayContaining([
        { from: 'in/ret_1', to: 'out/return', confidence: 'exact' },
        { from: 'in/ret_2', to: 'out/return', confidence: 'exact' },
        { from: 'in/call', to: 'out/call_1', confidence: 'crude' },
        { from: 'in/call', to: 'out/call_2', confidence: 'crude' },
      ]),
    );
    // プロパティのたどりは項目のパスに（exact）
    expect(node('fn:full').links).toEqual([
      { from: 'in/a.x', to: 'out/return', confidence: 'exact' },
    ]);
  });

  it('ローカル変数・useState を経由する links は crude、.then のコールバックの引数は呼び出しの戻り（exact）', async () => {
    const { node } = await run({
      'src/data.ts':
        'export function get(): Promise<{ n: number }> { return Promise.resolve({ n: 1 }); }',
      'src/view.tsx': [
        "import { useEffect, useState } from 'react';",
        "import { get } from './data';",
        'export function Leaf({ n }: { n: number }) { return <i>{n}</i>; }',
        'export function View({ seed }: { seed: number }) {',
        '  const [v, setV] = useState<{ n: number } | null>(null);',
        '  const doubled = seed * 2;',
        '  useEffect(() => { get().then((r) => setV(r)); }, []);',
        '  if (!v) return null;',
        '  return <><Leaf n={v.n} /><Leaf n={doubled} /></>;',
        '}',
      ].join('\n'),
    });
    const view = node('comp:View');
    expect(view.links).toEqual(
      expect.arrayContaining([
        { from: 'in/ret_1.n', to: 'out/render_1.n', confidence: 'crude' },
        { from: 'in/seed', to: 'out/render_2.n', confidence: 'crude' },
        { from: 'in/seed', to: 'out/call_1', confidence: 'crude' },
      ]),
    );
  });

  it('呼び出しでも描画でもない参照（コールバック渡し・同じファイルの非 export の宣言を経由）は箱の単位の線（D53）', async () => {
    const { v2, node } = await run({
      'src/f.ts': [
        'export function helper(x: number): number { return x + 1; }',
        'const table = { inc: helper };',
        'export function run(xs: number[]): number[] { return xs.map(table.inc); }',
      ].join('\n'),
    });
    expect(wireKeys(v2)).toEqual(
      expect.arrayContaining(['fn:run#out/_ → fn:helper#in/_', 'fn:helper#out/_ → fn:run#in/_']),
    );
    expect(item(node('fn:helper').ports[0]!.items, '_')).toBeDefined();
  });

  it('引数の無い描画は呼び先の in/props、props を持つ部品を属性なしで描けば in/props を足す', async () => {
    const { v2, node } = await run({
      'src/c.tsx': [
        'export function Opt({ label }: { label?: string }) { return <b>{label}</b>; }',
        'export function Page() { return <main><Opt /></main>; }',
      ].join('\n'),
    });
    expect(wireKeys(v2)).toContain('comp:Page#out/render_1 → comp:Opt#in/props');
    expect(node('comp:Opt').ports[0]!.items.map((i) => i.id)).toEqual(['label', 'props']);
  });
});

describe('HTTP の呼び出し（D45、§7 #2）', () => {
  it('ラッパー（api-link の自動検出）と生の fetch: パスの定数とテンプレート、クエリ、body（JSON.stringify を剥がす）、中継は呼び出しにしない', async () => {
    const { v2, node } = await run({
      'src/http.ts': [
        "const BASE = '/api';",
        'export async function http<T>(path: string, init?: RequestInit): Promise<T> {',
        '  const res = await fetch(`${BASE}${path}`, init);',
        '  return (await res.json()) as T;',
        '}',
      ].join('\n'),
      'src/items.ts': [
        "import { http } from './http';",
        "const ITEMS = '/items';",
        'export function list(limit: number) { return http<string[]>(`${ITEMS}?limit=${limit}&sort=new`); }',
        "export function add(item: { name: string }) { return http<void>(ITEMS, { method: 'POST', body: JSON.stringify(item) }); }",
        "export function ping() { return fetch('/health'); }",
      ].join('\n'),
    });
    // ラッパーの中の fetch（パスを引数のまま渡す）は呼び出しにしない
    expect(
      node('lib:http')
        .ports.find((p) => p.id === 'out')!
        .items.map((i) => i.id),
    ).toEqual(['return']);
    const list = node('fn:list')
      .ports.find((p) => p.id === 'out')!
      .items.find((i) => i.id === 'call_1')!;
    expect(list.meta).toEqual({ http: { method: 'GET', path: '/items' } });
    expect(list.children!.map((c) => [c.id, c.meta])).toEqual([
      ['path', { http: 'path' }],
      ['query', { http: 'query' }],
    ]);
    expect(list.children![1]!.children!.map((c) => [c.id, c.wireType])).toEqual([
      ['limit', 'number'],
      ['sort', 'string'],
    ]);
    const add = node('fn:add')
      .ports.find((p) => p.id === 'out')!
      .items.find((i) => i.id === 'call_1')!;
    expect(add.meta).toEqual({ http: { method: 'POST', path: '/items' } });
    // 子の optional は実引数から（呼び先の init? を写さない）
    expect(add.children!.map((c) => [c.id, c.type, c.optional ?? false])).toEqual([
      ['path', 'string', false],
      ['body', '{ name: string; }', false],
    ]);
    expect(wireKeys(v2)).toEqual(
      expect.arrayContaining([
        'fn:add#out/call_1.body → lib:http#in/init',
        'fn:list#out/call_1.query → lib:http#in/path',
      ]),
    );
    const ping = node('fn:ping')
      .ports.find((p) => p.id === 'out')!
      .items.find((i) => i.id === 'call_1')!;
    expect(ping.meta).toEqual({ http: { method: 'GET', path: '/health' } });
    expect(node('fn:ping').ports[0]!.items.map((i) => i.id)).toEqual(['call', 'ret_1']);
  });
});

describe('runtime と複製（D54、docs/16 §4、§7 #11）', () => {
  const next = {
    'next.config.js': "module.exports = { output: 'export' };",
    'src/app/page.tsx': [
      "import { Shared } from '@/components/shared';",
      "import { Island } from '@/components/island';",
      'export default function Home() { return <main><Shared /><Island /></main>; }',
    ].join('\n'),
    'src/components/shared.tsx': 'export function Shared() { return <p>shared</p>; }',
    'src/components/island.tsx': [
      "'use client';",
      "import { Shared } from './shared';",
      'export function Island() { return <div><Shared /></div>; }',
    ].join('\n'),
    'src/components/only-server.tsx': 'export function OnlyServer() { return <p />; }',
  };

  it('画面は browser、use client の閉包は browser、server component の閉包は build（静的エクスポート）。両方から使う箱は複製する', async () => {
    const { v2, node } = await run(next, { next: { appDir: 'src/app' } });
    expect(node('route:/').runtime).toBe('browser');
    expect(node('comp:Island').runtime).toBe('browser');
    expect(node('comp:Shared@browser')).toMatchObject({
      runtime: 'browser',
      meta: { sharedOf: 'comp:Shared' },
    });
    expect(node('comp:Shared@build')).toMatchObject({
      runtime: 'build',
      meta: { sharedOf: 'comp:Shared' },
    });
    expect(v2.nodes.some((n) => n.id === 'comp:Shared')).toBe(false);
    // どこからも使われない部品は決めない（upgrade の値が残る）
    expect(node('comp:OnlyServer').runtime).toBeUndefined();
    // 使う側の runtime の複製へ（画面は server component なので build の複製を描く）
    expect(wireKeys(v2)).toEqual(
      expect.arrayContaining([
        'route:/#out/render_1 → comp:Shared@build#in/props',
        'route:/#out/render_2 → comp:Island#in/props',
        'comp:Island#out/render_1 → comp:Shared@browser#in/props',
      ]),
    );
    expect(v2.groups).toMatchObject({
      'comp:Shared@browser': 'comp:Shared',
      'comp:Shared@build': 'comp:Shared',
    });
  });

  it('静的エクスポートでなければ server component の閉包は server', async () => {
    const { node } = await run(
      { ...next, 'next.config.js': 'module.exports = {};' },
      { next: { appDir: 'src/app' } },
    );
    expect(node('comp:Shared@server').runtime).toBe('server');
  });
});

describe('react の型（§7 #10）', () => {
  it('react が解けるときは stub を足さない（node_modules/@types/react）。解けなければ足す', () => {
    const root = mkdtempSync(join(tmpdir(), 'stack-atlas-react-'));
    roots.push(root);
    const files = {
      'tsconfig.json': TSCONFIG,
      'src/a.tsx':
        "import { useState } from 'react';\nexport const A = () => { useState(1); return null; };",
      'node_modules/@types/react/package.json':
        '{"name":"@types/react","version":"19.0.0","types":"index.d.ts"}',
      'node_modules/@types/react/index.d.ts':
        'export function useState<S>(s: S): [S, (s: S) => void];',
    };
    for (const [p, src] of Object.entries(files)) {
      mkdirSync(dirname(join(root, p)), { recursive: true });
      writeFileSync(join(root, p), src);
    }
    const project = new Project({ tsConfigFilePath: join(root, 'tsconfig.json') });
    const tsx = project.getSourceFiles().map((f) => f.getFilePath());
    expect(ensureReactTypes(project, tsx)).toBe(false);
    rmSync(join(root, 'node_modules'), { recursive: true, force: true });
    const bare = new Project({ tsConfigFilePath: join(root, 'tsconfig.json') });
    expect(
      ensureReactTypes(
        bare,
        bare.getSourceFiles().map((f) => f.getFilePath()),
      ),
    ).toBe(true);
  });
});

describe('tsconfig（§7 #10）', () => {
  it('extends（node_modules の共有設定など）が解けなければ警告する（paths が黙って消えるため）', async () => {
    const { log, v2 } = await run({
      'tsconfig.json': JSON.stringify({
        extends: '@acme/tsconfig/base.json',
        compilerOptions: { strict: true },
        include: ['src/**/*.ts'],
      }),
      'src/a.ts': 'export function f(): number { return 1; }',
    });
    expect(log.of('warn')).toEqual(
      expect.arrayContaining([
        expect.stringContaining('extends（@acme/tsconfig/base.json）を解けません'),
      ]),
    );
    // 解けなくても箱は出る（tsconfig の残りの設定で読む）
    expect(v2.nodes.map((n) => n.id)).toEqual(['fn:f']);
  });
});
