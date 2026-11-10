// 8-2b のレビューの指摘（2026-11-09）を直したことを固定する（go-types の側）。
// セキュリティ: S1（時間・出力の上限で helper が残る）、S2a（無名の struct の入れ子の型の文字列）、S2b（定数の文字列の連結）、
// S2c（SQL の式・同じ名前の並び）、S3（fillSqlColumns の O(n²)）、S5（import パスで GOROOT の外へ）。
// コードレビュー: C1・C2・C4・C5（SQL の別名・JOIN・副問い合わせ・`*`）、C7（複数の入口の host）、C8（Mount・StripPrefix）、
// C10（正規表現を関数の中で作らない）。
// 敵対的な入力は、もとのコードなら時間の上限（か標準出力の上限）を超える大きさにしてある（セキュリティのレビューの実測より大きく）。
// go が無い環境では go を使う所を飛ばす（STACK_ATLAS_REQUIRE_GO=1 なら失敗にする。D51）
import { execFile, execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ItemV2 } from '@stack-atlas/schema';
import {
  createMemoryLogger,
  createRepoContext,
  mergeV2,
  type PartialNodeV2,
} from '@stack-atlas/core';
import {
  ensureHelper,
  extractor,
  fillSqlColumns,
  HELPER_DIR,
  runHelper,
  toPartialV2,
  type HelperBox,
  type HelperOutput,
} from '../index.js';

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

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
/** 一時ディレクトリにファイルを並べる */
function tree(files: Record<string, string>, prefix = 'go-types-review-'): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(root);
  for (const [p, body] of Object.entries(files)) {
    mkdirSync(join(root, p, '..'), { recursive: true });
    writeFileSync(join(root, p), body);
  }
  return root;
}
const mod = (files: Record<string, string>) =>
  tree({ 'go.mod': 'module example.com/m\n\ngo 1.21\n', ...files });

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

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!hasGo)('S1: 時間・出力の上限で止めた helper は残らない', () => {
  // 時間が経っても終わらない「helper」（最初に自分の pid を書く）。SLEEPER_FLOOD=1 なら標準出力に 1MB 書いてから眠る。
  // SIGPIPE は無視する（読む側が閉じても書き込みのエラーになるだけで、自分からは終わらない）
  const sleeper = () =>
    tree({
      'go.mod': 'module example.com/sleeper\n\ngo 1.21\n',
      'main.go': `package main

import (
	"fmt"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"
)

func main() {
	signal.Ignore(syscall.SIGPIPE)
	os.WriteFile(os.Args[len(os.Args)-1], []byte(fmt.Sprint(os.Getpid())), 0o600)
	if os.Getenv("SLEEPER_FLOOD") == "1" {
		fmt.Print(strings.Repeat("x", 1<<20))
	}
	time.Sleep(60 * time.Second)
	fmt.Println("{}")
}
`,
    });

  it('時間の上限: 実行ファイルを SIGKILL する（`go run` だと go だけが止まり、helper の子が ppid=1 で残っていた）', async () => {
    const dir = sleeper();
    const cacheDir = tree({});
    const pidFile = join(cacheDir, 'pid');
    await ensureHelper({ helperDir: dir, cacheDir }); // ビルドの時間は上限の外
    await expect(
      runHelper(['-root', dir, pidFile], { helperDir: dir, cacheDir, timeoutMs: 1500 }),
    ).rejects.toThrow(/上限で止まりました/);
    const pid = Number(readFileSync(pidFile, 'utf8'));
    await sleep(300);
    expect(alive(pid)).toBe(false);
  }, 120_000);

  it('標準出力の上限: 超えたら同じく SIGKILL する', async () => {
    const dir = sleeper();
    const cacheDir = tree({});
    const pidFile = join(cacheDir, 'pid');
    await expect(
      runHelper(['-root', dir, pidFile], {
        helperDir: dir,
        cacheDir,
        timeoutMs: 30_000,
        maxBuffer: 64 * 1024,
        env: { ...process.env, SLEEPER_FLOOD: '1' },
      }),
    ).rejects.toThrow(/出力が上限を超えました/);
    const pid = Number(readFileSync(pidFile, 'utf8'));
    await sleep(300);
    expect(alive(pid)).toBe(false);
  }, 120_000);

  it('helper 自身も -timeout で止まる（最後の守り。終了コード 3）。実行ファイルは利用者ごとのキャッシュに 1 つ', async () => {
    const { bin } = await ensureHelper();
    expect(bin).toMatch(/stack-atlas-go-helper-[0-9a-f]{20}$/);
    const code = await new Promise<number | null>((resolve) =>
      execFile(bin, ['-timeout', '1ms', '-root', HELPER_DIR], (err) =>
        resolve(err ? ((err as { code?: number }).code ?? null) : 0),
      ),
    );
    expect(code).toBe(3);
    // 2 回目はビルドしない（同じ実行ファイル）
    expect((await ensureHelper()).bin).toBe(bin);
  }, 120_000);
});

describe.skipIf(!hasGo)('S2・S5: 敵対的な Go のソースでも時間と出力が抑えられる', () => {
  it('S2a: 無名の struct の入れ子（深さ 22）の型の文字列は短くする（もとは 356MB で出力の上限を超えた）', async () => {
    const nest = (d: number): string => (d === 0 ? 'int' : `struct{ A, B ${nest(d - 1)} }`);
    const dir = mod({
      'cmd/api/main.go': `package main\n\ntype T struct{ A, B ${nest(21)} }\n\nfunc F(x ${nest(22)}) {}\n\nfunc main() { F(T{}) }\n`,
    });
    const t0 = performance.now();
    const raw = await runHelper(['-root', dir], { timeoutMs: 20_000 });
    expect(performance.now() - t0).toBeLessThan(20_000);
    expect(raw.length).toBeLessThan(1_000_000);
    const out = JSON.parse(raw) as HelperOutput;
    const f = out.boxes.find((b) => b.id === 'fn:cmd/api.F')!;
    expect(item(f, 'in/x')!.type).toBe('struct{…}');
    // 短い型はそのまま（types.TypeString と同じ）
    const m = out.boxes.find((b) => b.id === 'fn:cmd/api.main')!;
    expect(item(m, 'out/call_1')!.type).toBe('void');
  }, 60_000);

  it('S2b: 倍々に重ねた定数の文字列（16 文字 × 2^26 = 1GB）を平らにしない。型の検査の前に空にして警告する', async () => {
    const consts = ['const A0 = "xxxxxxxxxxxxxxxx"'];
    for (let k = 1; k <= 26; k++) consts.push(`const A${k} = A${k - 1} + A${k - 1}`);
    const dir = mod({
      'cmd/api/main.go': `package main

import (
	"database/sql"
	"fmt"
)

${consts.join('\n')}

// 連結の SQL（上限より短い）は従来どおり読む
const q = "SELECT id " + "FROM users WHERE id = $1"

func P() { fmt.Println(A26) }

func L() int { return len(A26) + len(A12+A12) }

func Q(db *sql.DB) { db.Query(q, 1) }

func main() { P(); L(); Q(nil) }
`,
    });
    // もとのコードは len(A26) で go/types が、Println(A26) で constString が 1GB を平らにした（実測 16 秒・1.5GB）
    const t0 = performance.now();
    const out = JSON.parse(await runHelper(['-root', dir], { timeoutMs: 8000 })) as HelperOutput;
    expect(performance.now() - t0).toBeLessThan(8000);
    expect(out.warnings.some((w) => w.message.includes('長すぎる文字列の定数'))).toBe(true);
    const q = out.boxes.find((b) => b.id === 'fn:cmd/api.Q')!;
    expect(q.meta?.['sql']).toMatchObject({ table: 'users', op: 'select', where: ['id'] });
  }, 60_000);

  it('S2c: SQL の同じ名前の並び（`SELECT a, a, …` 3 万）と長い式（`a+a+…` 2.5 万）でも線形', async () => {
    // もとは uniqueID が番号を 2 から数え直し（O(n²)）、式の文字列を += でつないでいた（O(n²)）
    const dup = `SELECT ${Array(30_000).fill('a').join(',')} FROM t WHERE id = $1`;
    const expr = `SELECT ${Array(25_000).fill('a').join('+')} AS x FROM t`;
    expect(dup.length).toBeLessThan(64 * 1024);
    expect(expr.length).toBeLessThan(64 * 1024);
    const dir = mod({
      'cmd/api/main.go': `package main

import "database/sql"

const dup = "${dup}"
const expr = "${expr}"

func D(db *sql.DB) { db.Query(dup, 1) }

func E(db *sql.DB) { db.Query(expr) }

func main() { D(nil); E(nil) }
`,
    });
    const t0 = performance.now();
    const out = JSON.parse(await runHelper(['-root', dir], { timeoutMs: 10_000 })) as HelperOutput;
    expect(performance.now() - t0).toBeLessThan(10_000);
    const d = out.boxes.find((b) => b.id === 'fn:cmd/api.D')!;
    const row = item(d, 'in/row')!;
    // 1 箱の項目の上限で切る。id は a, a_2, a_3 …
    expect(row.children!.slice(0, 3).map((c) => c.id)).toEqual(['a', 'a_2', 'a_3']);
    expect(d.truncated).toBe(true);
    const e = out.boxes.find((b) => b.id === 'fn:cmd/api.E')!;
    expect(item(e, 'in/row.x')!.meta?.['_sql']).toMatchObject({
      expr: expect.stringMatching(/^a\+a\+/),
    });
  }, 60_000);

  it('S5: import パスの `..` で GOROOT の外を読まない（`x/../../<外>` は外部のモジュール扱い）', async () => {
    const goroot = execFileSync('go', ['env', 'GOROOT'], { encoding: 'utf8' }).trim();
    const outside = tree({
      'secretpkg/s.go': 'package secretpkg\n\ntype Secret struct{ Token string }\n',
    });
    const rel = relative(join(goroot, 'src'), join(outside, 'secretpkg')).split('\\').join('/');
    const dir = mod({
      'cmd/api/main.go': `package main

import sp "x/../${rel}"

func Leak(s sp.Secret) sp.Secret { return s }

func main() { Leak(sp.Secret{}) }
`,
    });
    const out = JSON.parse(await runHelper(['-root', dir])) as HelperOutput;
    // もとは GOROOT/src/x/../<外> を標準ライブラリとして読み、型 secretpkg.Secret（とフィールド Token）が出ていた
    // （警告の文には断った import パスが出る）
    const read = JSON.stringify({ boxes: out.boxes, types: out.types });
    expect(read).not.toContain('secretpkg');
    expect(read).not.toContain('Token');
    expect(out.stats.stdPackages).toBe(0);
    const leak = out.boxes.find((b) => b.id === 'fn:cmd/api.Leak')!;
    expect(item(leak, 'in/s')).toMatchObject({ type: 'unknown', wireType: 'unknown' });
    expect(out.warnings.some((w) => w.message.includes('外部のモジュール'))).toBe(true);
  }, 60_000);
});

describe.skipIf(!hasGo)(
  'C1・C2・C4・C5: SQL の別名・JOIN・副問い合わせ・`*`（マイグレーションのスキーマを helper に渡す）',
  () => {
    let byId: Map<string, PartialNodeV2>;
    beforeAll(async () => {
      const root = mod({
        'migrations/000001_init.up.sql': `CREATE TABLE users (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL
);
CREATE TABLE orders (
  id      TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  total   BIGINT NOT NULL
);
`,
        'internal/store/store.go': `package store

import (
	"context"
	"time"
)

const qAlias = \`SELECT id, name AS user_name FROM users WHERE id = $1\`
const qJoin = \`SELECT u.id, u.name, o.total FROM users u JOIN orders o ON o.user_id = u.id WHERE o.total > $1 AND u.id = $2\`
const qSub = \`SELECT id FROM users WHERE id IN (SELECT user_id FROM orders WHERE total > $1) AND created_at > now() - interval '1 day'\`
const qStar = \`SELECT u.*, o.total FROM users u JOIN orders o ON o.user_id = u.id WHERE u.id = $1\`

type Row interface{ Scan(dest ...any) error }

type DB interface {
	QueryRow(ctx context.Context, q string, args ...any) Row
}

var db DB

type User struct {
	ID        string    \`json:"id"\`
	Name      string    \`json:"name"\`
	CreatedAt time.Time \`json:"createdAt"\`
	Total     int64     \`json:"total"\`
}

func Alias(ctx context.Context, id string) (User, error) {
	var u User
	err := db.QueryRow(ctx, qAlias, id).Scan(&u.ID, &u.Name)
	return u, err
}

func Join(ctx context.Context, min int64, id string) (User, error) {
	var u User
	err := db.QueryRow(ctx, qJoin, min, id).Scan(&u.ID, &u.Name, &u.Total)
	return u, err
}

func Sub(ctx context.Context, min int64) (string, error) {
	var id string
	err := db.QueryRow(ctx, qSub, min).Scan(&id)
	return id, err
}

func Star(ctx context.Context, id string) (User, error) {
	var u User
	err := db.QueryRow(ctx, qStar, id).Scan(&u.ID, &u.Name, &u.CreatedAt, &u.Total)
	return u, err
}
`,
      });
      const ctx = createRepoContext(root, {}, createMemoryLogger(), {
        repoName: 'm',
        repos: { m: root },
        configDir: root,
      });
      const part = await extractor.extract(ctx, { nodes: [], edges: [] });
      byId = new Map(part.v2!.nodes.map((n) => [n.id, n]));
    }, 120_000);

    it('C1: 別名の項目は id が別名、元のカラムを meta.sql.column に残し、型はそのカラムから', () => {
      const a = byId.get('fn:internal/store.Alias')!;
      expect(item(a, 'in/row')!.children!.map((c) => c.id)).toEqual(['id', 'user_name']);
      // もとは meta が無く、合流の照合で「送る側（users）に無い」の error になった
      expect(item(a, 'in/row.user_name')).toEqual({
        id: 'user_name',
        name: 'user_name',
        type: 'TEXT',
        wireType: 'string',
        typeRef: 'table:users',
        meta: { sql: { column: 'name' } },
      });
    });

    it('C2: JOIN の行はカラムごとのテーブル（別名で解く）を typeRef に。行の meta.sql.tables、WHERE のカラムも', () => {
      const j = byId.get('fn:internal/store.Join')!;
      const row = item(j, 'in/row')!;
      expect(row.meta?.['sql']).toMatchObject({ table: 'users', tables: ['users', 'orders'] });
      // もとは全部 table:users で、orders の total は型が引けず unknown だった
      expect(row.children!.map((c) => `${c.id} ${c.typeRef} ${c.wireType}`)).toEqual([
        'id table:users string',
        'name table:users string',
        'total table:orders integer',
      ]);
      const q = item(j, 'out/query_1')!;
      expect(q.children!.map((c) => `${c.id} ${c.typeRef}`)).toEqual([
        'total table:orders',
        'id table:users',
      ]);
    });

    it('C4: 副問い合わせの中・`interval` の型付きのリテラル・テーブルに無い識別子を WHERE のカラムにしない', () => {
      const s = byId.get('fn:internal/store.Sub')!;
      // もとは user_id・orders・total（副問い合わせの中）も WHERE のカラムになっていた
      expect(item(s, 'out/query_1')!.children!.map((c) => c.id)).toEqual(['id', 'created_at']);
      expect(s.meta?.['sql']).toMatchObject({ where: ['id', 'created_at'] });
      // 副問い合わせの中のプレースホルダ（$1）は外の id の値にしない
      expect(s.links ?? []).not.toContainEqual(expect.objectContaining({ to: 'out/query_1.id' }));
    });

    it('C5: `u.*` はスキーマで広げてから Scan の引数の順に写す（もとは `*` を飛ばして total が out/return.id に写っていた）', () => {
      const st = byId.get('fn:internal/store.Star')!;
      expect(item(st, 'in/row')!.children!.map((c) => c.id)).toEqual([
        'id',
        'name',
        'created_at',
        'total',
      ]);
      const links = (st.links ?? []).filter((l) => l.from.startsWith('in/row'));
      expect(links).toEqual([
        { from: 'in/row.id', to: 'out/return.id', confidence: 'exact' },
        { from: 'in/row.name', to: 'out/return.name', confidence: 'exact' },
        { from: 'in/row.created_at', to: 'out/return.createdAt', confidence: 'exact' },
        { from: 'in/row.total', to: 'out/return.total', confidence: 'exact' },
      ]);
    });
  },
);

describe.skipIf(!hasGo)('C8: chi の Mount と http.StripPrefix の接頭辞', () => {
  it('Mount（ルーターを返す関数の呼び出し）と StripPrefix の中の mux のルートに接頭辞を付ける。定数でない接頭辞は警告', async () => {
    const dir = mod({
      'cmd/api/main.go': `package main

import (
	"net/http"

	"github.com/go-chi/chi/v5"
)

func getItem(w http.ResponseWriter, r *http.Request)   {}
func listUsers(w http.ResponseWriter, r *http.Request) {}
func health(w http.ResponseWriter, r *http.Request)    {}

func api() http.Handler {
	r := chi.NewRouter()
	r.Get("/items/{id}", getItem)
	return r
}

func prefix() string { return "/v" }

func main() {
	r := chi.NewRouter()
	r.Mount("/api", api())
	other := chi.NewRouter()
	other.Get("/health", health)
	r.Mount(prefix(), other)
	sub := http.NewServeMux()
	sub.HandleFunc("GET /users", listUsers)
	mux := http.NewServeMux()
	mux.Handle("/admin/", http.StripPrefix("/admin", sub))
	mux.Handle("/", r)
	http.ListenAndServe(":1", mux)
}
`,
    });
    const out = JSON.parse(await runHelper(['-root', dir])) as HelperOutput;
    // もとは /items/{id}・/users（接頭辞が無かった）
    expect(
      out.routes.map((r) => `${r.method} ${r.path} ${r.handler} ${r.framework}`).sort(),
    ).toEqual([
      'GET /admin/users fn:cmd/api.listUsers net/http',
      'GET /api/items/{id} fn:cmd/api.getItem chi',
      'GET /health fn:cmd/api.health chi',
    ]);
    expect(
      out.warnings.some(
        (w) => w.level === 'warn' && w.message.includes('Mount の接頭辞が定数でない'),
      ),
    ).toBe(true);
  }, 60_000);
});

describe('S3・C5（TS の側）: fillSqlColumns', () => {
  const table = (name: string, cols: string[]) => ({
    table: name,
    columns: cols,
    file: 'm.sql',
    line: 1,
    code: '',
    defs: cols.map((c) => ({
      name: c,
      type: 'text',
      notNull: true,
      primaryKey: false,
      hasDefault: false,
    })),
  });
  const rowBox = (children: ItemV2[], sql: Record<string, unknown>): HelperBox => ({
    id: 'fn:x.f',
    name: 'f',
    file: 'x.go',
    line: 1,
    pkg: 'x',
    pkgName: 'x',
    func: 'f',
    ports: [
      {
        id: 'in',
        dir: 'in',
        items: [
          { id: 'row', name: 'row', type: 'record', wireType: 'object', meta: { sql }, children },
        ],
      },
    ],
  });

  it('S3: カラムの定義は名前の表で引く（4 万カラムの行で、もとは項目ごとに defs.find で O(n²)）', () => {
    const C = 40_000;
    const cols = Array.from({ length: C }, (_, i) => `c${i}`);
    const kids = cols.map((c) => ({
      id: c,
      name: c,
      type: 'column',
      meta: { _sql: { table: 't', column: c } },
    }));
    const b = rowBox(kids, { table: 't', query: 'query_1' });
    const t0 = performance.now();
    const r = fillSqlColumns([b], new Map([['t', table('t', cols)]]));
    expect(performance.now() - t0).toBeLessThan(5000);
    expect(r.filled).toBe(C);
    expect(b.ports[0]!.items[0]!.children![C - 1]).toMatchObject({
      type: 'text',
      wireType: 'string',
    });
  }, 30_000);

  it('C5: helper が広げられなかった `*` は、他の子があってもその位置（starAt）に広げる。maxItems で切る', () => {
    const b = rowBox(
      [{ id: 'one', name: 'one', type: '1', meta: { _sql: { table: 't', expr: '1' } } }],
      {
        table: 't',
        query: 'query_1',
        star: true,
        starAt: 0,
      },
    );
    const r = fillSqlColumns([b], new Map([['t', table('t', ['id', 'one', 'name'])]]), 2);
    const row = b.ports[0]!.items[0]!;
    // もとは子があると広げなかった
    expect(row.children!.map((c) => c.id)).toEqual(['id', 'one_2', 'one']);
    expect(row.meta).toEqual({ sql: { table: 't', query: 'query_1' } });
    expect(r.truncatedStars).toBe(1);
  });
});

describe('C7: 複数の入口から使う関数は、入口のインフラが分からなくても meta.hosts（空の配列）', () => {
  it('group の host を受け継がない', () => {
    const out: HelperOutput = {
      module: 'example.com/m',
      boxes: [
        {
          id: 'fn:internal/store.Save',
          name: 'store.Save',
          file: 'internal/store/store.go',
          line: 1,
          pkg: 'internal/store',
          pkgName: 'store',
          func: 'Save',
          ports: [{ id: 'in', dir: 'in', items: [{ id: 'call', name: '()', type: 'void' }] }],
          reach: ['cmd/a', 'cmd/b'],
        },
      ],
      wires: [],
      types: [],
      routes: [],
      warnings: [],
      stats: { packages: 1, files: 1, stdPackages: 0, typeErrors: 0, totalMs: 0 },
    };
    const { v2, multiHost } = toPartialV2(out, new Map());
    expect(multiHost).toBe(1);
    // もとは infra が空なら meta.hosts を書かず、mergeV2 で group（v1 のパッケージの箱）の host を受け継いでいた
    expect(v2.nodes[0]!.meta?.['hosts']).toEqual([]);
    expect(v2.nodes[0]!.host).toBeUndefined();
    const merged = mergeV2(
      {
        version: 2,
        nodes: [
          {
            id: 'lib:internal/store',
            kind: 'helper',
            name: 'store',
            runtime: 'server',
            host: 'infra:lambda/a',
            meta: { go: { pkg: 'internal/store' } },
            ports: [],
          },
        ],
        wires: [],
      },
      v2,
    );
    const m = merged.graph.nodes.find((n) => n.id === 'fn:internal/store.Save')!;
    expect(m.group).toBe('lib:internal/store');
    expect(m.host).toBeUndefined();
  });
});

describe('C10: helper の正規表現はパッケージで 1 回だけ作る', () => {
  it('関数の本体の中で regexp.MustCompile しない（呼び出しごとに正規表現を作っていた）', () => {
    const bad: string[] = [];
    for (const f of readdirSync(HELPER_DIR).filter((n) => n.endsWith('.go'))) {
      let inFunc = false;
      readFileSync(join(HELPER_DIR, f), 'utf8')
        .split('\n')
        .forEach((line, i) => {
          if (line.startsWith('func ')) inFunc = !line.trimEnd().endsWith('}');
          else if (line === '}') inFunc = false;
          if (inFunc && line.includes('regexp.MustCompile(')) bad.push(`${f}:${i + 1}`);
        });
    }
    expect(bad).toEqual([]);
  });
});
