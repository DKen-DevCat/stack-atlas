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
  itemId as coreItemId,
  underscoreItem,
  type PartialGraphV2,
  type StackAtlasConfig,
} from '@stack-atlas/core';
import { analyzeTsRepo, extractor as tsImports } from '@stack-atlas/extractor-ts-imports';
import { buildV2, ensureReactTypes, itemId } from '../index.js';

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
  return { v2, log, root, up, ctx, node: (id: string) => v2.nodes.find((n) => n.id === id)! };
}

/** node_modules の react の型（DOM の属性が多い。repo の外で宣言されたプロパティ） */
function fakeReact(nProps = 270): Record<string, string> {
  const props = Array.from({ length: nProps }, (_, i) => `  aria${i}?: string;`).join('\n');
  return {
    'node_modules/@types/react/package.json':
      '{"name":"@types/react","version":"19.0.0","types":"index.d.ts"}',
    'node_modules/@types/react/index.d.ts': [
      'export function useState<S>(s: S): [S, (s: S) => void];',
      'export interface DOMAttributes<T> { onClick?: (e: T) => void; children?: unknown }',
      `export interface HTMLAttributes<T> extends DOMAttributes<T> {\n  className?: string;\n${props}\n}`,
      "export interface ButtonHTMLAttributes<T> extends HTMLAttributes<T> { disabled?: boolean; type?: 'button' | 'submit' }",
      'declare global { namespace JSX { interface IntrinsicElements { [k: string]: unknown } } }',
    ].join('\n'),
  };
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

describe('repo の外のプロパティと項目の上限（2026-11-09 レビュー C3）', () => {
  it('React の DOM の属性（node_modules で宣言）は引数ごと不透明な 1 項目 props にまとめ、{...rest} も 1 項目で渡す', async () => {
    const { v2, node } = await run({
      ...fakeReact(),
      'src/ui.tsx': [
        "import type { ButtonHTMLAttributes } from 'react';",
        'export function Button(props: ButtonHTMLAttributes<HTMLButtonElement>) { return <button {...props} />; }',
        'export function Fancy({ label, ...rest }: { label: string } & ButtonHTMLAttributes<HTMLButtonElement>) {',
        '  return <Button {...rest}>{label}</Button>;',
        '}',
        'export function Page() { return <Fancy label="x" onClick={() => {}} />; }',
      ].join('\n'),
    });
    const ins = (id: string) => node(id).ports.find((p) => p.id === 'in')!.items;
    expect(ins('comp:Button').map((i) => [i.id, i.name, i.wireType, i.children])).toEqual([
      ['props', 'props', 'object', undefined],
    ]);
    expect(ins('comp:Button')[0]!.type).toBe('ButtonHTMLAttributes<HTMLButtonElement>');
    expect(ins('comp:Fancy').map((i) => i.id)).toEqual(['label', 'props']);
    const render = node('comp:Fancy')
      .ports.find((p) => p.id === 'out')!
      .items.find((i) => i.id === 'render_1')!;
    expect(render.children!.map((c) => c.id)).toEqual(['props']);
    expect(wireKeys(v2)).toEqual(
      expect.arrayContaining([
        'comp:Fancy#out/render_1.props → comp:Button#in/props',
        'comp:Page#out/render_1.label → comp:Fancy#in/label',
        // 名前で当たらない属性（repo の外の onClick）は受ける側の不透明な props へ
        'comp:Page#out/render_1.onClick → comp:Fancy#in/props',
      ]),
    );
    // ...rest の links は不透明な props から
    expect(node('comp:Fancy').links).toEqual(
      expect.arrayContaining([{ from: 'in/props', to: 'out/render_1.props', confidence: 'exact' }]),
    );
    const total = v2.nodes.reduce((n, b) => n + b.ports.reduce((m, p) => m + p.items.length, 0), 0);
    expect(total).toBeLessThan(20);
  });

  it('上限（adapters.maxItems）に着いたら in の項目も止め、残りは不透明な props にまとめて警告する（引数・{...x}）', async () => {
    const fields = Array.from({ length: 50 }, (_, i) => `f${i}: string`).join('; ');
    const { node, log, v2 } = await run(
      {
        'src/big.tsx': [
          `export type Big = { ${fields} };`,
          'export function Wide(p: Big) { return <i>{p.f0}</i>; }',
          'export function Outer(p: Big) { return <Wide {...p} />; }',
        ].join('\n'),
      },
      { adapters: { maxItems: 10 } },
    );
    const wide = node('comp:Wide').ports.find((p) => p.id === 'in')!.items;
    expect(wide.length).toBeLessThanOrEqual(11);
    expect(wide.at(-1)).toMatchObject({ id: 'props', name: 'p', type: 'Big', wireType: 'object' });
    const render = node('comp:Outer')
      .ports.find((p) => p.id === 'out')!
      .items.find((i) => i.id === 'render_1')!;
    expect(render.children!.length).toBeLessThanOrEqual(11);
    expect(render.children!.at(-1)!.id).toBe('props');
    expect(wireKeys(v2)).toContain('comp:Outer#out/render_1.props → comp:Wide#in/props');
    expect(log.of('warn')).toEqual(
      expect.arrayContaining([
        expect.stringContaining('comp:Wide の項目が上限（10）を超えた'),
        expect.stringContaining('comp:Outer の項目が上限（10）を超えた'),
      ]),
    );
  });
});

describe('HTTP の呼び出しはクライアントだけ（2026-11-09 レビュー C4）', () => {
  it('サーバーのルートの登録（app.get(path, handler)・router.post(path, (req, res) => …)）は呼び出しにしない。既知の動詞はクライアントファイルの中だけ', async () => {
    const { node } = await run(
      {
        'src/server.ts': [
          'declare const app: { get(p: string, h?: unknown): void; post(p: string, h: unknown): void };',
          'function handler(req: unknown, res: unknown): void { void req; void res; }',
          "export function register() { app.get('/races/:id', handler); app.post('/races', (req: unknown) => req); app.get('/x'); }",
        ].join('\n'),
        'src/client.ts': [
          'declare const axios: { get(p: string): Promise<unknown> };',
          "export function listItems() { return axios.get('/items'); }",
        ].join('\n'),
        'src/other.ts': [
          'declare const axios: { get(p: string): Promise<unknown> };',
          "export function notClient() { return axios.get('/items'); }",
          "export function raw() { return fetch('/health'); }",
        ].join('\n'),
      },
      { api: { clients: ['src/client.ts'] } },
    );
    const calls = (id: string) =>
      (node(id).ports.find((p) => p.id === 'out')?.items ?? [])
        .filter((i) => i.meta?.http)
        .map((i) => i.meta!.http);
    expect(calls('fn:register')).toEqual([]);
    expect(calls('fn:notClient')).toEqual([]);
    expect(calls('fn:listItems')).toEqual([{ method: 'GET', path: '/items' }]);
    expect(calls('fn:raw')).toEqual([{ method: 'GET', path: '/health' }]);
  });
});

describe('型の id（2026-11-09 レビュー C7）と refs（C6）', () => {
  it('typeRef は ts-imports の id（衝突の退避は ~）。export していない型はファイルで修飾し、同じ名前の別の型・OpenAPI の型と重ならない', async () => {
    const { v2, up, node } = await run({
      'src/a.ts':
        'export type Row = { a: string };\nexport function fa(r: Row): string { return r.a; }',
      'src/b.ts':
        'export type Row = { b: number };\nexport function fb(r: Row): number { return r.b; }',
      'src/c.ts': [
        'type Order = { id: string };',
        'export type Today = { total: number };',
        'export function fc(o: Order, t: Today): string { return o.id + t.total; }',
      ].join('\n'),
    });
    // ts-imports の衝突の退避
    expect(up.nodes.map((n) => n.id)).toEqual(
      expect.arrayContaining(['type:src/a.ts#Row', 'type:src/b.ts#Row', 'type:Today']),
    );
    const ref = (id: string, item: string) =>
      node(id)
        .ports.find((p) => p.id === 'in')!
        .items.find((i) => i.id === item)!.typeRef;
    expect(ref('fn:fa', 'r')).toBe('type:src/a.ts~Row');
    expect(ref('fn:fb', 'r')).toBe('type:src/b.ts~Row');
    expect(ref('fn:fc', 'o')).toBe('type:src/c.ts~Order');
    expect(ref('fn:fc', 't')).toBe('type:Today');
    expect(v2.types!.map((t) => [t.id, t.file]).sort()).toEqual([
      ['type:Today', 'src/c.ts'],
      ['type:src/a.ts~Row', 'src/a.ts'],
      ['type:src/b.ts~Row', 'src/b.ts'],
      ['type:src/c.ts~Order', 'src/c.ts'],
    ]);
    // refs: 型の注釈も参照として数える（掃除の付け替え先の手がかり。graph.json には出ない）
    expect(v2.refs!['fn:fc']).toEqual(expect.arrayContaining(['type:Today']));
  });

  it('refs: 呼び出し・呼び出しでない参照の相手を箱ごとに出す', async () => {
    const { v2 } = await run({
      'src/f.ts': [
        'export function helper(x: number): number { return x + 1; }',
        'export function other(): number { return 2; }',
        'const table = { inc: helper };',
        'export function run(xs: number[]): number[] { return xs.map(table.inc).concat([other()]); }',
      ].join('\n'),
    });
    expect([...v2.refs!['fn:run']!].sort()).toEqual(['fn:helper', 'fn:other']);
    expect(v2.refs!['fn:helper']).toBeUndefined();
  });
});

describe('ts-imports の解析を使い回す（2026-11-09 レビュー C10）', () => {
  it('Next のファイルと tsconfig の extends の結果は TsRepoAnalysis から（buildV2 は読み直さない）', async () => {
    const { ctx, up } = await run(
      {
        'next.config.js': "module.exports = { output: 'export' };",
        'src/app/page.tsx': 'export default function Home() { return <main />; }',
      },
      { next: { appDir: 'src/app' } },
    );
    const a = analyzeTsRepo(ctx, up);
    expect(a.nextFiles.map((f) => f.id)).toEqual(['route:/']);
    expect(a.projects.map((p) => p.unresolvedExtends)).toEqual([[]]);
    expect(buildV2(ctx, up, a).nodes.map((n) => n.id)).toEqual(['route:/']);
    // 解析の結果だけを見る: Next のファイルを空にすれば画面は出ず、extends の結果を足せば警告する
    const log = createMemoryLogger();
    const ctx2 = { ...ctx, log };
    const v2 = buildV2(ctx2, up, {
      ...a,
      nextFiles: [],
      projects: a.projects.map((p) => ({ ...p, unresolvedExtends: ['@x/base.json'] })),
    });
    expect(v2.nodes.map((n) => n.id)).toEqual([]);
    expect(log.of('warn')).toEqual([
      expect.stringContaining('tsconfig.json の extends（@x/base.json）を解けません'),
    ]);
  });
});

describe('道具は core の 1 つの定義（2026-11-09 レビュー C9）', () => {
  it('itemId・置き場の項目 `_` は core のもの', async () => {
    expect(itemId).toBe(coreItemId);
    // 呼び出しでない参照の `_` は core の underscoreItem と同じ形
    const { node } = await run({
      'src/f.ts': [
        'export function helper(x: number): number { return x + 1; }',
        'export function run(xs: number[]): number[] { return xs.map(helper); }',
      ].join('\n'),
    });
    expect(node('fn:helper').ports[0]!.items.find((i) => i.id === '_')).toEqual(underscoreItem());
  });
});
