// go-types（Go の言語アダプタ。docs/17 §3.3・§7）を小さな Go のモジュール（test/fixtures/shop・fw）に掛けて、
// 箱・口・項目・links・線・レシピ（net/http・認証・SQL・chi / gin）・自前の importer（replace・vendor・解けない外部）・
// 閉包（host）を確かめる。go が無い環境では go を使う所を飛ばす（STACK_ATLAS_REQUIRE_GO=1 なら失敗にする。D51）
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ItemV2 } from '@stack-atlas/schema';
import {
  createMemoryLogger,
  createRepoContext,
  type PartialGraph,
  type PartialNodeV2,
  type StackAtlasConfig,
} from '@stack-atlas/core';
import {
  createGoTypesExtractor,
  extractor,
  helperEnv,
  runHelper,
  type HelperOutput,
} from '../index.js';

const fixture = (name: string) =>
  fileURLToPath(new URL(`../../test/fixtures/${name}`, import.meta.url));

const hasGo = (() => {
  try {
    execFileSync('go', ['version'], { stdio: 'ignore' });
    return true;
  } catch {
    if (process.env['STACK_ATLAS_REQUIRE_GO'] === '1')
      throw new Error('go が見つかりません（STACK_ATLAS_REQUIRE_GO=1）');
    return false;
  }
})();

const ctxFor = (root: string, config: StackAtlasConfig, log = createMemoryLogger()) =>
  createRepoContext(root, config, log, {
    repoName: 'shop',
    repos: { shop: root },
    configDir: root,
  });

/** 口のパス（`in/path.id`）の一覧 */
function paths(n: Pick<PartialNodeV2, 'ports'>): string[] {
  const out: string[] = [];
  for (const port of n.ports) {
    const walk = (items: ItemV2[], pre: string) => {
      for (const it of items) {
        const p = pre ? `${pre}.${it.id}` : it.id;
        out.push(`${port.id}/${p}`);
        if (it.children) walk(it.children, p);
      }
    };
    walk(port.items, '');
  }
  return out;
}

const item = (n: Pick<PartialNodeV2, 'ports'>, ref: string): ItemV2 | undefined => {
  const [port, path] = ref.split('/') as [string, string];
  let list = n.ports.find((p) => p.id === port)?.items;
  let cur: ItemV2 | undefined;
  for (const seg of path.split('.')) {
    cur = list?.find((i) => i.id === seg);
    list = cur?.children;
  }
  return cur;
};

describe.skipIf(!hasGo)(
  'go-types: test/fixtures/shop（net/http・SQL・replace・vendor・外部）',
  () => {
    const root = fixture('shop');
    const log = createMemoryLogger();
    let part: PartialGraph;
    let byId: Map<string, PartialNodeV2>;
    beforeAll(async () => {
      const config: StackAtlasConfig = { deploy: { 'infra:lambda/server': { go: 'cmd/server' } } };
      const upstream: PartialGraph = {
        nodes: [{ id: 'infra:lambda/server', kind: 'infra', name: 'server' }],
        edges: [],
      };
      const ctx = ctxFor(root, config, log);
      expect(await extractor.detect(ctx)).toBe(true);
      part = await extractor.extract(ctx, upstream);
      byId = new Map(part.v2!.nodes.map((n) => [n.id, n]));
    }, 120_000);

    it('v1 は出さない（go 抽出器が出す）。箱は関数とメソッド、kind fn・runtime server、meta.go.pkg', () => {
      expect(part.nodes).toEqual([]);
      expect(part.edges).toEqual([]);
      expect([...byId.keys()].sort()).toEqual([
        'fn:cmd/server.main',
        'fn:internal/auth.Require',
        'fn:internal/store.FindUser',
        'fn:internal/store.ListOrders',
        'fn:internal/store.SaveOrder',
        // 名前が衝突したメソッドだけレシーバを付ける（関数の Get はそのまま）
        'fn:internal/web.Get',
        'fn:internal/web.Orders.Get',
        'fn:internal/web.Routes',
        'fn:internal/web.Users.Get',
        'fn:internal/web.createItem',
        'fn:internal/web.health',
      ]);
      const n = byId.get('fn:internal/web.Users.Get')!;
      expect(n).toMatchObject({
        kind: 'fn',
        runtime: 'server',
        name: 'web.Users.Get',
        file: 'internal/web/handlers.go',
        meta: { go: { pkg: 'internal/web', name: 'web', func: 'Get', recv: 'Users' } },
      });
      expect(byId.get('fn:cmd/server.main')!.meta).toMatchObject({ entry: 'cmd/server' });
    });

    it('net/http: ルート（method の無いパターンは ANY）と、mux 全体を包む認証の middleware → meta.auth', () => {
      const route = (id: string) => byId.get(id)!.meta?.['route'];
      expect(route('fn:internal/web.Users.Get')).toEqual({ method: 'GET', path: '/users/{id}' });
      expect(route('fn:internal/web.Orders.Get')).toEqual({ method: 'GET', path: '/orders' });
      expect(route('fn:internal/web.createItem')).toEqual({ method: 'POST', path: '/items' });
      expect(route('fn:internal/web.health')).toEqual({ method: 'ANY', path: '/health' });
      for (const id of ['Users.Get', 'Orders.Get', 'createItem', 'health'])
        expect(byId.get(`fn:internal/web.${id}`)!.meta).toMatchObject({
          auth: 'login',
          authBy: { fn: 'fn:internal/auth.Require', header: 'Authorization', status: 401 },
        });
      // 401 は契約の状態コードにしない（middleware に out/status を作らない）
      expect(paths(byId.get('fn:internal/auth.Require')!)).toEqual(['in/next', 'out/return']);
    });

    it('レシピ: PathValue → in/path、Query().Get → in/query（optional）、Encode の変数 → out/<変数名>、map のリテラル → キーで展開', () => {
      const u = byId.get('fn:internal/web.Users.Get')!;
      expect(paths(u)).toEqual([
        'in/path',
        'in/path.id',
        'in/ret_1',
        'in/ret_1.id',
        'in/ret_1.name',
        'in/ret_1.createdAt',
        'in/ret_1.tags',
        'out/call_1',
        'out/call_1.id',
        'out/u',
        'out/u.id',
        'out/u.name',
        'out/u.createdAt',
        'out/u.tags',
      ]);
      // ctx と w は項目にしない。レシピの項目がある handler は r を持たない
      expect(item(u, 'in/r')).toBeUndefined();
      expect(item(u, 'out/u')).toMatchObject({
        type: '*store.User',
        wireType: 'object',
        nullable: true,
        typeRef: 'type:User',
      });
      // 型の表: time.Time は datetime（展開しない）、slice は array（nullable にしない）、omitempty は optional
      expect(item(u, 'out/u.createdAt')).toMatchObject({ type: 'time.Time', wireType: 'datetime' });
      expect(item(u, 'out/u.createdAt')!.children).toBeUndefined();
      expect(item(u, 'out/u.tags')).toEqual({
        id: 'tags',
        name: 'Tags',
        type: '[]string',
        wireType: 'array',
        optional: true,
        typeRef: 'type:User',
        meta: { json: 'tags' },
      });
      // 小文字のフィールド（password）は JSON に出ないので項目にしない
      expect(item(u, 'out/u.password')).toBeUndefined();

      const o = byId.get('fn:internal/web.Orders.Get')!;
      expect(item(o, 'in/query')).toMatchObject({ wireType: 'object', meta: { http: 'query' } });
      expect(item(o, 'in/query.status')).toMatchObject({ type: 'string', optional: true });
      expect(item(o, 'out/response')).toMatchObject({ type: 'map[string]any', wireType: 'object' });
      expect(item(o, 'out/response.orders')).toMatchObject({
        type: '[]store.Order',
        wireType: 'array',
      });
      expect(item(o, 'out/response.count')).toMatchObject({ type: 'int', wireType: 'integer' });
      expect(o.links).toEqual([
        { from: 'in/query.status', to: 'out/call_1.status', confidence: 'exact' },
        { from: 'in/ret_1', to: 'out/response.orders', confidence: 'exact' },
        // len(list) は値を作り直すので crude
        { from: 'in/ret_1', to: 'out/response.count', confidence: 'crude' },
      ]);
    });

    it('自前の importer: replace => ./x と vendor の型を展開し、解けない外部の import があっても解析を続ける', () => {
      const c = byId.get('fn:internal/web.createItem')!;
      // Decode(&in) → in/body（replace の local.Thing。`-` は除く、omitempty は optional、pointer は nullable、タグ無しは Go の名前）
      expect(item(c, 'in/body')).toMatchObject({
        type: 'local.Thing',
        wireType: 'object',
        typeRef: 'type:Thing',
        meta: { http: 'body' },
      });
      expect(item(c, 'in/body')!.children!.map((x) => x.id)).toEqual(['id', 'note', 'Tags']);
      expect(item(c, 'in/body.note')).toMatchObject({
        type: '*string',
        wireType: 'string',
        optional: true,
        nullable: true,
      });
      // vendor の lib.Item（Encode の変数 item）
      expect(item(c, 'out/item')).toMatchObject({
        type: 'lib.Item',
        wireType: 'object',
        typeRef: 'type:Item',
      });
      expect(item(c, 'out/item.count')).toMatchObject({ wireType: 'integer', optional: true });
      // WriteHeader → out/status（エラーの http.Error は数えない）
      expect(item(c, 'out/status')).toEqual({
        id: 'status',
        name: 'status',
        type: 'http.StatusCreated',
        wireType: 'integer',
        meta: { http: 'status' },
      });
      expect(item(c, 'in/r')).toBeUndefined();
      expect(c.links).toContainEqual({
        from: 'in/body.id',
        to: 'out/item.name',
        confidence: 'exact',
      });
      expect(c.links).toContainEqual({
        from: 'in/body.id',
        to: 'out/call_1.o.id',
        confidence: 'exact',
      });
      // status はその前に戻った呼び出しからも（crude）
      expect(c.links).toContainEqual({ from: 'in/ret_1', to: 'out/status', confidence: 'crude' });
      expect(
        log
          .of('info')
          .some((m) => m.includes('外部のモジュール 1 個') && m.includes('github.com/ext/unknown')),
      ).toBe(true);
    });

    it('レシピの項目が無い handler は in/r を残す（起動の項目）', () => {
      const h = byId.get('fn:internal/web.health')!;
      expect(item(h, 'in/r')).toEqual({
        id: 'r',
        name: 'r',
        type: '*http.Request',
        wireType: 'unknown',
        nullable: true,
      });
      expect(h.links).toEqual([{ from: 'in/r', to: 'out/status', confidence: 'crude' }]);
    });

    it('SQL: meta.sql・out/query_n（WHERE）・in/row（SELECT）・out/insert_n。カラムの型はマイグレーションで埋める', () => {
      const f = byId.get('fn:internal/store.FindUser')!;
      expect(f.meta?.['sql']).toEqual({
        table: 'users',
        op: 'select',
        read: ['id', 'name', 'created_at'],
        write: [],
        where: ['id'],
        item: 'query_1',
        row: 'row',
        const: 'findUser',
      });
      expect(item(f, 'out/query_1')).toMatchObject({
        name: 'findUser',
        type: 'SELECT … WHERE id = $1',
        wireType: 'object',
      });
      expect(item(f, 'out/query_1.id')).toEqual({
        id: 'id',
        name: 'id',
        type: 'TEXT',
        wireType: 'string',
        typeRef: 'table:users',
      });
      expect(item(f, 'in/row')).toMatchObject({
        type: 'record',
        wireType: 'object',
        meta: { sql: { table: 'users', query: 'query_1' } },
      });
      expect(item(f, 'in/row.created_at')).toEqual({
        id: 'created_at',
        name: 'created_at',
        type: 'TIMESTAMPTZ',
        wireType: 'datetime',
        typeRef: 'table:users',
      });
      // Scan(&u.ID, &u.Name, &u.CreatedAt): 引数の順 → カラム → フィールド。$1 ← id
      expect(f.links).toEqual([
        { from: 'in/row.id', to: 'out/return.id', confidence: 'exact' },
        { from: 'in/row.name', to: 'out/return.name', confidence: 'exact' },
        { from: 'in/row.created_at', to: 'out/return.createdAt', confidence: 'exact' },
        { from: 'in/id', to: 'out/query_1.id', confidence: 'exact' },
      ]);
      const s = byId.get('fn:internal/store.SaveOrder')!;
      expect(s.meta?.['sql']).toMatchObject({
        table: 'orders',
        op: 'insert',
        write: ['id', 'status'],
      });
      expect(item(s, 'out/insert_1.status')).toMatchObject({
        type: 'VARCHAR(20)',
        wireType: 'string',
      });
      // プレースホルダと値の数が合う: $1 ← o.ID、$2 ← o.Status（exact）
      expect(s.links).toContainEqual({
        from: 'in/o.id',
        to: 'out/insert_1.id',
        confidence: 'exact',
      });
      expect(s.links).toContainEqual({
        from: 'in/o.status',
        to: 'out/insert_1.status',
        confidence: 'exact',
      });
      // error だけを返す関数の return は type error・nullable
      expect(item(s, 'out/return')).toEqual({
        id: 'return',
        name: 'return',
        type: 'error',
        nullable: true,
      });
      // 印（_sql）は残さない
      expect(JSON.stringify(part.v2)).not.toContain('_sql');
    });

    it('同じ言語の中の線: call_n.<引数> → 呼び先#in/<引数>（call）、呼び先#out/return → ret_n（return、reply）', () => {
      const w = part.v2!.wires.map((x) => `${x.from} → ${x.to} ${x.via}${x.reply ? ' reply' : ''}`);
      expect(w).toEqual([
        'fn:cmd/server.main#out/call_1 → fn:internal/web.Routes#in/call call',
        'fn:internal/web.Routes#out/return → fn:cmd/server.main#in/ret_1 return reply',
        'fn:internal/web.Users.Get#out/call_1.id → fn:internal/store.FindUser#in/id call',
        'fn:internal/store.FindUser#out/return → fn:internal/web.Users.Get#in/ret_1 return reply',
        'fn:internal/web.Orders.Get#out/call_1.status → fn:internal/store.ListOrders#in/status call',
        'fn:internal/store.ListOrders#out/return → fn:internal/web.Orders.Get#in/ret_1 return reply',
        'fn:internal/web.createItem#out/call_1.o → fn:internal/store.SaveOrder#in/o call',
        'fn:internal/store.SaveOrder#out/return → fn:internal/web.createItem#in/ret_1 return reply',
        'fn:internal/web.Routes#out/call_1.next → fn:internal/auth.Require#in/next call',
        'fn:internal/auth.Require#out/return → fn:internal/web.Routes#in/ret_1 return reply',
      ]);
    });

    it('host: 入口（cmd/server）からの閉包（HandleFunc に渡した handler も）。どこからも呼ばれない関数は host 無し', () => {
      for (const n of part.v2!.nodes)
        if (n.id === 'fn:internal/web.Get') expect(n.host).toBeUndefined();
        else expect(n.host, n.id).toBe('infra:lambda/server');
      expect(byId.get('fn:internal/web.health')!.meta).toMatchObject({
        go: { entries: ['cmd/server'] },
      });
    });

    it('types: 名前付きの struct（モジュール・replace・vendor）は type:<名前>（source go）', () => {
      const ids = (part.v2!.types ?? []).map((t) => `${t.id} ${t.source} ${t.file}`);
      expect(ids).toContain('type:User go internal/store/store.go');
      expect(ids).toContain('type:Thing go x/local.go');
      expect(ids).toContain('type:Item go vendor/github.com/vend/lib/lib.go');
    });
  },
);

describe.skipIf(!hasGo)(
  'go-types: test/fixtures/fw（chi / gin はルートの登録を AST と import パスで）',
  () => {
    let out: HelperOutput;
    beforeAll(async () => {
      out = JSON.parse(
        await runHelper(['-root', fixture('fw'), '-entry', 'cmd/api']),
      ) as HelperOutput;
    }, 120_000);

    it('gin の Group の接頭辞と :id、chi の Route の接頭辞。gin の r.Use(Auth()) は gin のルートだけ login', () => {
      expect(
        out.routes.map((r) => `${r.method} ${r.path} ${r.handler} ${r.framework} ${r.auth ?? '-'}`),
      ).toEqual([
        'GET /api/items/{id} fn:internal/h.GetItem gin login',
        'POST /api/items fn:internal/h.CreateItem gin login',
        'GET /v2/things/{id} fn:internal/h.Thing chi -',
      ]);
    });

    it('gin の c.Param / ShouldBindJSON / c.JSON、chi.URLParam。エラーの c.JSON(400, nil) は応答にしない', () => {
      const b = (id: string) => out.boxes.find((x) => x.id === id)!;
      expect(paths(b('fn:internal/h.GetItem'))).toEqual([
        'in/path',
        'in/path.id',
        'out/status',
        'out/response',
        'out/response.id',
        'out/response.name',
      ]);
      expect(paths(b('fn:internal/h.CreateItem'))).toEqual([
        'in/body',
        'in/body.id',
        'in/body.name',
        'out/status',
        'out/in',
        'out/in.id',
        'out/in.name',
      ]);
      expect(item(b('fn:internal/h.CreateItem'), 'out/status')!.type).toBe('http.StatusCreated');
      expect(paths(b('fn:internal/h.Thing'))).toEqual(['in/path', 'in/path.id']);
      // 解けない外部の型は unknown（invalid type と書かない）
      expect(JSON.stringify(out)).not.toContain('invalid type');
    });
  },
);

describe.skipIf(!hasGo)('go-types: 安全の約束（シンボリックリンク・上限・時間）', () => {
  let dir: string;
  let outside: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'go-types-mod-'));
    outside = mkdtempSync(join(tmpdir(), 'go-types-out-'));
    writeFileSync(join(dir, 'go.mod'), 'module example.com/m\n\ngo 1.21\n');
    mkdirSync(join(dir, 'a'));
    writeFileSync(join(dir, 'a', 'a.go'), 'package a\n\nfunc A() int { return 1 }\n');
    writeFileSync(join(dir, 'a', 'b.go'), 'package a\n\nfunc B() int { return A() }\n');
    writeFileSync(join(outside, 'evil.go'), 'package a\n\nfunc Evil() {}\n');
    symlinkSync(join(outside, 'evil.go'), join(dir, 'a', 'evil.go'));
    mkdirSync(join(outside, 'pkg'));
    writeFileSync(join(outside, 'pkg', 'p.go'), 'package pkg\n\nfunc P() {}\n');
    symlinkSync(join(outside, 'pkg'), join(dir, 'linked'));
  });
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  it('モジュールの根の外を指すシンボリックリンクは読まない（ファイルもディレクトリも）', async () => {
    const out = JSON.parse(await runHelper(['-root', dir])) as HelperOutput;
    expect(out.boxes.map((b) => b.id).sort()).toEqual(['fn:a.A', 'fn:a.B']);
    expect(out.warnings.some((w) => w.level === 'warn' && w.message.includes('a/evil.go'))).toBe(
      true,
    );
  }, 120_000);

  it('ファイルの数の上限に着いたら残りは読まずに警告する', async () => {
    const out = JSON.parse(await runHelper(['-root', dir, '-max-files', '1'])) as HelperOutput;
    expect(out.boxes).toHaveLength(1);
    expect(out.warnings.some((w) => w.message.includes('上限'))).toBe(true);
  }, 120_000);

  it('時間の上限を守る（止めて、延ばし方を書いたエラー）', async () => {
    await expect(runHelper(['-root', dir], { timeoutMs: 1 })).rejects.toThrow(/上限で止まりました/);
  });
});

describe('go-types: go が無いとき（D51）', () => {
  const root = fixture('shop');
  const missing = { goBin: join(tmpdir(), 'no-such-dir', 'go') };

  it('警告して何も出さない', async () => {
    const log = createMemoryLogger();
    const ex = createGoTypesExtractor({ ...missing, env: {} });
    const part = await ex.extract(ctxFor(root, {}, log), { nodes: [], edges: [] });
    expect(part).toEqual({ nodes: [], edges: [] });
    expect(log.of('warn').some((m) => m.startsWith('go-types: go が見つかりません'))).toBe(true);
  });

  it('STACK_ATLAS_REQUIRE_GO=1（か requireGo）なら失敗にする', async () => {
    const ctx = ctxFor(root, {});
    const viaEnv = createGoTypesExtractor({ ...missing, env: { STACK_ATLAS_REQUIRE_GO: '1' } });
    await expect(viaEnv.extract(ctx, { nodes: [], edges: [] })).rejects.toThrow(
      /STACK_ATLAS_REQUIRE_GO=1 なので失敗にします/,
    );
    const viaOpt = createGoTypesExtractor({ ...missing, env: {}, requireGo: true });
    await expect(viaOpt.extract(ctx, { nodes: [], edges: [] })).rejects.toThrow(
      /go が見つかりません/,
    );
  });

  it('helper の環境: 解析対象の go.mod を書き換えず、ネットワークもツールチェーンの取得もしない（D48）', () => {
    const env = helperEnv({ GOFLAGS: '-mod=mod', GOOS: 'windows', GOARCH: 'arm', HOME: '/home/x' });
    expect(env).toMatchObject({
      GOFLAGS: '-mod=readonly',
      GOPROXY: 'off',
      GOWORK: 'off',
      GOTOOLCHAIN: 'local',
      CGO_ENABLED: '0',
    });
    expect(env['GOOS']).toBeUndefined();
    expect(env['GOARCH']).toBeUndefined();
    expect(env['GOCACHE']).toBeUndefined();
    // HOME も GOCACHE も無いときは OS の一時ディレクトリに
    expect(helperEnv({})['GOCACHE']).toBe(join(tmpdir(), 'stack-atlas-go-cache'));
  });
});
