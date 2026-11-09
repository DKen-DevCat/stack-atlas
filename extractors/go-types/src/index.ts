/**
 * go-types 抽出器（Go の言語アダプタ。docs/17 §3.3・§7、8-2b）: 標準ライブラリだけの helper（`helper/`）を `go run` し、
 * go/parser と go/types で読んだ関数の単位の箱・口・項目・links と、同じ言語の中の線（呼び出し・戻り）を
 * `PartialGraph.v2` に出す。v1 の nodes / edges は出さない（go 抽出器が出す）。
 *
 * - 箱: 関数とメソッド（`fn:<パッケージ相対パス>.<名前>`。衝突したメソッドだけ `.<型>.<名前>`）。kind fn、runtime server。
 *   `meta.go.pkg` は go 抽出器のパッケージの箱と同じ（mergeV2 が v1 のパッケージの箱を group にする。D53）
 * - 入口（go 抽出器と同じ判定: `go.entries` の glob と package main、config の `deploy.*.go`）から閉包を辿り、
 *   届く入口がインフラの箱 1 つなら `host`、2 つ以上なら host を空にして `meta.hosts`（§7 #11）
 * - HTTP のレシピ: handler の `meta.route = { method, path }`、`meta.auth = "login"`（認証の middleware で包んだもの）、
 *   in の `path` / `query` / `body`（無ければ `r`）、out の Encode（`out/<変数名>` か `out/response`）と `out/status`。
 *   endpoint への線は合流の段（core の join）が引く（D49）
 * - SQL のレシピ: `meta.sql`（テーブル・読む / 書く / WHERE のカラム）、`out/query_n` / `out/insert_n` / `out/update_n`、
 *   `in/row`。カラムの型はマイグレーション（sql 抽出器の readTables）で埋める（`table:<名前>`）
 * - go が無いときは警告して何も出さない（D51）。`STACK_ATLAS_REQUIRE_GO=1` なら失敗にする（CI）
 */
import { existsSync } from 'node:fs';
import type { ItemV2, LinkV2, NamedType, PortV2, WireV2 } from '@stack-atlas/schema';
import type {
  Extractor,
  PartialGraph,
  PartialGraphV2,
  PartialNodeV2,
  RepoContext,
} from '@stack-atlas/core';
import { sectionFor } from '@stack-atlas/core';
import { analyzeGo, infraType, lambdaHints, lambdaMatchesEntry } from '@stack-atlas/extractor-go';
import {
  DEFAULT_MIGRATIONS,
  readTables,
  sqlWireType,
  type SqlTableWithDefs,
} from '@stack-atlas/extractor-sql';
import { GoMissingError, runHelper, type RunHelperOptions } from './run.js';

export { GoMissingError, HELPER_DIR, helperEnv, runHelper } from './run.js';

export const NAME = 'go-types';

/** 展開の深さと 1 箱の項目の上限の既定（ts-types と同じ。config の adapters） */
export const DEFAULT_DEPTH = 2;
export const DEFAULT_MAX_ITEMS = 200;

/** helper の出力（helper/analyze.go の Output） */
export interface HelperBox {
  id: string;
  name: string;
  file: string;
  line: number;
  code?: string;
  pkg: string;
  pkgName: string;
  func: string;
  recv?: string;
  entry?: string;
  ports: PortV2[];
  links?: LinkV2[];
  meta?: Record<string, unknown>;
  reach?: string[];
  truncated?: boolean;
}

export interface HelperOutput {
  module: string;
  goVersion?: string;
  boxes: HelperBox[];
  wires: WireV2[];
  types: Array<{ id: string; name: string; file?: string; line?: number }>;
  routes: Array<{
    method: string;
    path: string;
    handler: string;
    framework: string;
    auth?: string;
  }>;
  warnings: Array<{ level: 'warn' | 'info'; message: string }>;
  stats: {
    packages: number;
    files: number;
    stdPackages: number;
    typeErrors: number;
    totalMs: number;
  };
}

export interface GoTypesOptions extends RunHelperOptions {
  /** go が無いときに失敗にする（既定は env の STACK_ATLAS_REQUIRE_GO=1） */
  requireGo?: boolean;
}

const norm = (d: string) => d.replace(/^\.\//, '').replace(/\/+$/, '') || '.';

/** 入口のパッケージ（go 抽出器と同じ判定）と config の deploy.*.go */
export function entryDirs(ctx: RepoContext): string[] {
  const cfg = sectionFor(ctx, ctx.config.go) ?? {};
  const opts: Parameters<typeof analyzeGo>[1] = { repoName: ctx.repoName };
  if (cfg.module) opts.module = cfg.module;
  if (cfg.entries) opts.entries = cfg.entries;
  const a = analyzeGo(ctx.root, opts);
  const dirs = new Set(a.packages.filter((p) => p.entry).map((p) => p.dir));
  for (const d of Object.values(ctx.config.deploy ?? {})) if (d.go) dirs.add(norm(d.go));
  return [...dirs].sort();
}

/** 入口 → インフラの箱（config の deploy.*.go、無ければ Lambda の名前で推定。go 抽出器と同じ規則） */
export function entryHosts(
  ctx: RepoContext,
  upstream: Readonly<PartialGraph>,
  entries: string[],
): Map<string, string> {
  const out = new Map<string, string>();
  const infra = new Set(upstream.nodes.filter((n) => n.kind === 'infra').map((n) => n.id));
  const named = new Set(Object.keys(ctx.config.deploy ?? {}));
  for (const [infraId, d] of Object.entries(ctx.config.deploy ?? {})) {
    if (!d.go) continue;
    const dir = norm(d.go);
    if (!infra.has(infraId)) {
      ctx.log.debug(
        `go-types: config.deploy の ${infraId} が上流のインフラにありません（host にしません）`,
      );
      continue;
    }
    if (!out.has(dir)) out.set(dir, infraId);
  }
  const lambdas = upstream.nodes.filter(
    (n) => infraType(n) === 'aws_lambda_function' && !named.has(n.id) && infra.has(n.id),
  );
  const entryName = (d: string) => d.split('/').pop() ?? d;
  for (const l of lambdas) {
    for (const hints of lambdaHints(l)) {
      const match = entries
        .filter((e) => !out.has(e) && lambdaMatchesEntry(hints, entryName(e)))
        .sort((x, y) => entryName(y).length - entryName(x).length)[0];
      if (match) {
        out.set(match, l.id);
        // 推定の警告は go 抽出器が出す（同じ規則。二重に出さない）
        ctx.log.debug(`go-types: 推定 ${l.id} → ${match}（deploy で明示できます）`);
        break;
      }
    }
  }
  return out;
}

const itemsWalk = (items: ItemV2[], visit: (it: ItemV2) => void) => {
  for (const it of items) {
    visit(it);
    if (it.children) itemsWalk(it.children, visit);
  }
};

/** SQL のカラムの項目（helper の `_sql` の印）に型を埋める */
export function fillSqlColumns(
  boxes: HelperBox[],
  tables: Map<string, SqlTableWithDefs>,
): { filled: number; unknownTables: string[] } {
  const byName = new Map([...tables.values()].map((t) => [t.table.toLowerCase(), t]));
  let filled = 0;
  const unknown = new Set<string>();
  for (const b of boxes) {
    for (const p of b.ports) {
      // SELECT * の 1 行: テーブルの全部のカラム
      for (const it of p.items) {
        const sql = it.meta?.['sql'] as { table?: string; star?: boolean } | undefined;
        if (!sql?.star || !sql.table || it.children?.length) continue;
        const t = byName.get(sql.table.toLowerCase());
        if (t)
          it.children = t.defs.map((c) => ({
            id: c.name.replace(/[^A-Za-z0-9_$-]/g, '_') || '_',
            name: c.name,
            type: 'column',
            meta: { _sql: { table: sql.table, column: c.name } },
          }));
      }
      itemsWalk(p.items, (it) => {
        const mark = it.meta?.['_sql'] as
          { table: string; column?: string; cast?: string; expr?: string } | undefined;
        if (!mark) return;
        const t = byName.get(mark.table.toLowerCase());
        const col = mark.column
          ? t?.defs.find((c) => c.name.toLowerCase() === mark.column!.toLowerCase())
          : undefined;
        if (!t) unknown.add(mark.table);
        if (mark.cast) {
          it.type = mark.cast;
          it.wireType = sqlWireType(mark.cast);
        } else if (col && !mark.expr) {
          it.type = col.type || 'unknown';
          it.wireType = sqlWireType(col.type);
          if (p.dir === 'in' && !col.notNull) it.nullable = true;
        } else if (!it.wireType) {
          it.wireType = 'unknown';
          if (it.type === 'column') it.type = mark.expr ?? 'unknown';
        }
        if (t) it.typeRef = `table:${t.table}`;
        filled++;
        const rest: Record<string, unknown> = { ...it.meta };
        delete rest['_sql'];
        if (mark.expr) rest['expr'] = mark.expr;
        if (Object.keys(rest).length) it.meta = rest;
        else delete it.meta;
      });
    }
  }
  return { filled, unknownTables: [...unknown].sort() };
}

/** helper の出力 → v2 の部分グラフ */
export function toPartialV2(
  out: HelperOutput,
  hosts: Map<string, string>,
): { v2: PartialGraphV2; multiHost: number } {
  let multiHost = 0;
  const nodes: PartialNodeV2[] = out.boxes.map((b) => {
    const reach = b.reach ?? [];
    const infra = [...new Set(reach.map((e) => hosts.get(e)).filter((x): x is string => !!x))];
    const meta: Record<string, unknown> = {
      extractors: [NAME],
      go: {
        pkg: b.pkg,
        name: b.pkgName,
        func: b.func,
        ...(b.recv ? { recv: b.recv } : {}),
        ...(reach.length ? { entries: reach } : {}),
      },
      ...(b.entry ? { entry: b.entry } : {}),
      ...(b.meta ?? {}),
    };
    let host: string | undefined;
    if (reach.length === 1 && infra.length === 1) host = infra[0];
    else if (reach.length > 1) {
      if (infra.length) meta['hosts'] = infra;
      multiHost++;
    }
    const node: PartialNodeV2 = {
      id: b.id,
      kind: 'fn',
      name: b.name,
      runtime: 'server',
      file: b.file,
      line: b.line,
      ...(b.code ? { code: b.code } : {}),
      ...(host ? { host } : {}),
      ports: b.ports,
      ...(b.links?.length ? { links: b.links } : {}),
      meta,
    };
    return node;
  });
  const types: NamedType[] = out.types.map((t) => ({ ...t, source: 'go' }));
  const v2: PartialGraphV2 = { nodes, wires: out.wires };
  if (types.length) v2.types = types;
  return { v2, multiHost };
}

const requireGoFromEnv = (env: NodeJS.ProcessEnv) => env['STACK_ATLAS_REQUIRE_GO'] === '1';

export function createGoTypesExtractor(opts: GoTypesOptions = {}): Extractor {
  return {
    name: NAME,
    async detect(ctx) {
      if (ctx.config.go?.repo) return sectionFor(ctx, ctx.config.go) !== undefined;
      return existsSync(ctx.resolve('go.mod'));
    },
    async extract(ctx, upstream): Promise<PartialGraph> {
      const env = opts.env ?? process.env;
      const requireGo = opts.requireGo ?? requireGoFromEnv(env);
      const depth = ctx.config.adapters?.depth ?? DEFAULT_DEPTH;
      const maxItems = ctx.config.adapters?.maxItems ?? DEFAULT_MAX_ITEMS;
      const entries = entryDirs(ctx);
      const args = ['-root', ctx.root, '-depth', String(depth), '-max-items', String(maxItems)];
      for (const e of entries) args.push('-entry', e);
      const timeoutEnv = Number(env['STACK_ATLAS_GO_TIMEOUT_MS']);
      let raw: string;
      try {
        raw = await runHelper(args, {
          ...opts,
          env,
          ...(opts.timeoutMs === undefined && timeoutEnv > 0 ? { timeoutMs: timeoutEnv } : {}),
        });
      } catch (e) {
        if (e instanceof GoMissingError) {
          if (requireGo)
            throw new Error(
              `go-types: ${e.message}。STACK_ATLAS_REQUIRE_GO=1 なので失敗にします（go 1.21 以上を入れてください）`,
              { cause: e },
            );
          ctx.log.warn(
            `go-types: ${e.message}。Go の関数の単位の解析を飛ばします（Go はパッケージの箱の単位のまま。go 1.21 以上を入れると関数の箱が出ます）`,
          );
          return { nodes: [], edges: [] };
        }
        throw e;
      }
      let out: HelperOutput;
      try {
        out = JSON.parse(raw) as HelperOutput;
      } catch (e) {
        throw new Error('go-types: helper の出力（JSON）が読めません', { cause: e });
      }
      for (const w of out.warnings ?? []) {
        if (w.level === 'warn') ctx.log.warn(w.message);
        else ctx.log.info(w.message);
      }
      for (const b of out.boxes)
        if (b.truncated)
          ctx.log.warn(
            `go-types: ${b.id} の項目が上限（${maxItems}）を超えたので、子の展開を打ち切りました（config の adapters.maxItems）`,
          );
      // SQL のカラムの型（sql 抽出器と同じマイグレーション）
      const sqlCfg = ctx.config.sql;
      const sqlRoot = sqlCfg?.repo ? ctx.repos[sqlCfg.repo] : ctx.root;
      const tables = sqlRoot
        ? readTables(sqlRoot, sqlCfg?.migrations ?? DEFAULT_MIGRATIONS)
        : new Map<string, SqlTableWithDefs>();
      const sql = fillSqlColumns(out.boxes, tables);
      if (sql.unknownTables.length)
        ctx.log.info(
          `go-types: SQL のテーブル ${sql.unknownTables.join(', ')} がマイグレーションにありません（カラムの型は unknown）`,
        );
      const hosts = entryHosts(ctx, upstream, entries);
      const { v2, multiHost } = toPartialV2(out, hosts);
      let items = 0;
      for (const n of v2.nodes) for (const p of n.ports) itemsWalk(p.items, () => items++);
      const links = v2.nodes.flatMap((n) => n.links ?? []);
      ctx.log.info(
        `go-types: 箱 ${v2.nodes.length}、項目 ${items}、線 ${v2.wires.length}、links ${links.length}` +
          `（exact ${links.filter((l) => l.confidence === 'exact').length} / crude ${links.filter((l) => l.confidence === 'crude').length}）` +
          `、ルート ${out.routes.length}、複数の入口から使う関数 ${multiHost}、${out.stats.totalMs}ms（module ${out.module}）`,
      );
      if (out.stats.typeErrors)
        ctx.log.debug(
          `go-types: 型の検査のエラー ${out.stats.typeErrors} 件（外部のモジュールの型など）`,
        );
      return { nodes: [], edges: [], v2 };
    },
  };
}

export const extractor: Extractor = createGoTypesExtractor();

export default extractor;
