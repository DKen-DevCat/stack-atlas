/**
 * sql 抽出器（docs/12 §3.5）: SQL マイグレーションの `CREATE TABLE` → `schema:<table>` ノード。
 *
 * - 対象: `sql.migrations` の glob（既定 `migrations/**\/*.sql`・`db/migrations/**\/*.sql`）。
 *   `x.up.sql` と並んでいる `x.down.sql`（と `up.sql` と並ぶ `down.sql`）は読まない
 * - `CREATE [TEMP|UNLOGGED] TABLE [IF NOT EXISTS] [schema.]name (...)`（Postgres / MySQL / SQLite）。
 *   列は本体のトップレベルの項目から（制約は除く）。`ALTER TABLE x ADD [COLUMN] y` の列も足す。DROP は無視
 * - `schema` エッジ: `sql.db` のノード（無ければ上流の RDS / Cloud SQL が 1 つなら推定して warn）→ 各テーブル
 * - `uses` エッジ: 上流のコードノード（file を持つ go / ts / py など）のファイルに
 *   `FROM|JOIN|INTO|UPDATE|TABLE <table>` があれば、そのノード → `schema:<table>`
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import type { Edge } from '@stack-atlas/schema';
import type { Extractor, PartialGraph, PartialNode, RepoContext } from '@stack-atlas/core';
import { globBase, globToRegExp, sectionFor } from '@stack-atlas/core';

export const NAME = 'sql';

export const DEFAULT_MIGRATIONS = ['migrations/**/*.sql', 'db/migrations/**/*.sql'];
const MAX_SCAN_BYTES = 200 * 1024;
const MAX_CODE_LINES = 30;
const CODE_EXT = /\.(go|[cm]?[jt]sx?|py|rb|java|kt|scala|rs|php|cs|ex|exs)$/;

const toPosix = (p: string) => p.split(sep).join('/');

function walk(dir: string, out: string[] = []): string[] {
  let names: string[];
  try {
    names = readdirSync(dir).sort();
  } catch {
    return out;
  }
  for (const name of names) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const p = join(dir, name);
    try {
      if (statSync(p).isDirectory()) walk(p, out);
      else out.push(p);
    } catch {
      /* 読めないものは飛ばす */
    }
  }
  return out;
}

/** マイグレーションファイル（repo 相対、ソート済み）。down は up と並んでいれば除く */
export function migrationFiles(root: string, globs: string[]): string[] {
  const found = new Set<string>();
  for (const g of globs) {
    const re = globToRegExp(g);
    for (const abs of walk(join(root, globBase(g) || '.'))) {
      const rel = toPosix(relative(root, abs));
      if (re.test(rel)) found.add(rel);
    }
  }
  const all = [...found].sort();
  return all.filter((rel) => {
    if (/\.down\.sql$/i.test(rel)) return !found.has(rel.replace(/\.down\.sql$/i, '.up.sql'));
    if (/(^|\/)down\.sql$/i.test(rel)) return !found.has(rel.replace(/down\.sql$/i, 'up.sql'));
    return true;
  });
}

/** `--` / `#`（MySQL）/ `/* *\/` コメントを空白にする（位置を保つ）。文字列リテラルは残す */
export function stripSqlComments(src: string): string {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    const n = src[i + 1];
    if (c === "'" || c === '"' || c === '`') {
      let j = i + 1;
      while (j < src.length && !(src[j] === c && src[j + 1] !== c)) j += src[j] === c ? 2 : 1;
      out += src.slice(i, j + 1);
      i = j + 1;
    } else if ((c === '-' && n === '-') || c === '#') {
      while (i < src.length && src[i] !== '\n') {
        out += ' ';
        i++;
      }
    } else if (c === '/' && n === '*') {
      const end = src.indexOf('*/', i + 2);
      const stop = end < 0 ? src.length : end + 2;
      out += src.slice(i, stop).replace(/[^\n]/g, ' ');
      i = stop;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

export interface SqlTable {
  table: string;
  /** スキーマ修飾（`public.users` の public） */
  schema?: string;
  columns: string[];
  line: number;
  code: string;
}

const IDENT = '[`"\\[]?([A-Za-z_][\\w$]*)[`"\\]]?';
const CONSTRAINT =
  /^(constraint|primary|foreign|unique|check|key|index|exclude|like|fulltext|spatial|period)\b/i;
const unquote = (s: string) => s.replace(/^[`"[]|[`"\]]$/g, '');

/** 括弧の対応を見て、open の位置から閉じ括弧の位置を返す */
function closeParen(src: string, open: number): number {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === "'" || c === '"' || c === '`') {
      const end = src.indexOf(c, i + 1);
      if (end < 0) return src.length;
      i = end;
    } else if (c === '(') depth++;
    else if (c === ')' && --depth === 0) return i;
  }
  return src.length;
}

/** トップレベルのカンマで分ける */
function splitTopLevel(body: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const c of body) {
    if (c === '(') depth++;
    else if (c === ')') depth--;
    if (c === ',' && depth === 0) {
      out.push(cur);
      cur = '';
    } else cur += c;
  }
  if (cur.trim()) out.push(cur);
  return out;
}

const lineAt = (src: string, index: number) => src.slice(0, index).split('\n').length;

/** SQL 文字列から CREATE TABLE（と ALTER TABLE ADD COLUMN）を読む */
export function parseSql(raw: string): {
  tables: SqlTable[];
  added: Array<{ table: string; column: string }>;
} {
  const src = stripSqlComments(raw);
  const tables: SqlTable[] = [];
  const create = new RegExp(
    `\\bCREATE\\s+(?:OR\\s+REPLACE\\s+)?(?:(?:GLOBAL|LOCAL)\\s+)?(?:TEMP(?:ORARY)?\\s+|UNLOGGED\\s+)?TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?(?:${IDENT}\\.)?${IDENT}\\s*\\(`,
    'gi',
  );
  for (const m of src.matchAll(create)) {
    const open = m.index + m[0].length - 1;
    const close = closeParen(src, open);
    const semi = src.indexOf(';', close);
    const end = semi < 0 ? Math.min(src.length, close + 1) : semi + 1;
    const columns = splitTopLevel(src.slice(open + 1, close))
      .map((item) => item.trim())
      .filter((item) => item && !CONSTRAINT.test(item))
      .map((item) => unquote(/^([`"[]?[^\s`"\]]+[`"\]]?)/.exec(item)?.[1] ?? item));
    const lines = raw.slice(m.index, end).split('\n');
    const t: SqlTable = {
      table: m[2]!,
      columns,
      line: lineAt(raw, m.index),
      code:
        lines.length > MAX_CODE_LINES
          ? [...lines.slice(0, MAX_CODE_LINES), '-- …'].join('\n')
          : lines.join('\n'),
    };
    if (m[1]) t.schema = m[1];
    tables.push(t);
  }
  const added: Array<{ table: string; column: string }> = [];
  const alter = new RegExp(
    `\\bALTER\\s+TABLE\\s+(?:IF\\s+EXISTS\\s+)?(?:ONLY\\s+)?(?:${IDENT}\\.)?${IDENT}\\s+([^;]*)`,
    'gi',
  );
  for (const m of src.matchAll(alter)) {
    for (const part of splitTopLevel(m[3]!)) {
      const a = new RegExp(
        `^\\s*ADD\\s+(?:COLUMN\\s+)?(?:IF\\s+NOT\\s+EXISTS\\s+)?${IDENT}`,
        'i',
      ).exec(part);
      if (a && !CONSTRAINT.test(a[1]!)) added.push({ table: m[2]!, column: a[1]! });
    }
  }
  return { tables, added };
}

/** infra ノードの Terraform 型（cdktf / terraform / cloudformation のどれでも） */
function infraType(n: PartialNode): string | undefined {
  for (const key of ['infra', 'cdktf']) {
    const v = n.meta?.[key] as { type?: unknown } | undefined;
    if (v && typeof v.type === 'string') return v.type;
  }
  return undefined;
}

const DB_TYPES = [
  /^aws_rds_cluster$/,
  /^aws_db_instance$/,
  /^google_sql_database_instance$/,
  /^azurerm_(postgresql|mysql|mssql)_(flexible_)?server$/,
];

/** 上流ノードの file を絶対パスにする（`<repo>/<path>` 形式にも対応） */
export function resolveNodeFile(
  ctx: Pick<RepoContext, 'root' | 'repos'>,
  file: string,
): string | undefined {
  const first = file.split('/')[0]!;
  const repoRoot = ctx.repos[first];
  if (repoRoot && Object.keys(ctx.repos).length > 1) {
    const p = join(repoRoot, file.slice(first.length + 1));
    if (existsSync(p)) return p;
  }
  const p = join(ctx.root, file);
  if (existsSync(p)) return p;
  for (const r of Object.values(ctx.repos)) {
    const q = join(r, file);
    if (existsSync(q)) return q;
  }
  return undefined;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** テキスト中で参照しているテーブル名 */
export function tablesReferenced(text: string, tables: string[]): string[] {
  if (tables.length === 0) return [];
  const names = [...tables]
    .sort((a, b) => b.length - a.length)
    .map(escapeRe)
    .join('|');
  const re = new RegExp(
    `\\b(?:FROM|JOIN|INTO|UPDATE|TABLE|from|join|into|update|table)\\s+[\`"]?(?:\\w+\\.)?(${names})[\`"]?(?![\\w$])`,
    'g',
  );
  return [...new Set([...text.matchAll(re)].map((m) => m[1]!))];
}

function readSmall(abs: string): string | undefined {
  try {
    if (statSync(abs).size > MAX_SCAN_BYTES) return undefined;
    return readFileSync(abs, 'utf8');
  } catch {
    return undefined;
  }
}

export const extractor: Extractor = {
  name: NAME,
  async detect(ctx) {
    if (ctx.config.sql?.repo && !sectionFor(ctx, ctx.config.sql)) return false;
    const globs = sectionFor(ctx, ctx.config.sql)?.migrations ?? DEFAULT_MIGRATIONS;
    return migrationFiles(ctx.root, globs).length > 0;
  },
  async extract(ctx, upstream): Promise<PartialGraph> {
    const cfg = sectionFor(ctx, ctx.config.sql) ?? {};
    const files = migrationFiles(ctx.root, cfg.migrations ?? DEFAULT_MIGRATIONS);
    const tables = new Map<string, SqlTable & { file: string }>();
    for (const rel of files) {
      const { tables: ts, added } = parseSql(readFileSync(join(ctx.root, rel), 'utf8'));
      for (const t of ts) {
        if (!tables.has(t.table)) tables.set(t.table, { ...t, file: rel });
      }
      for (const a of added) {
        const t = tables.get(a.table);
        if (t && !t.columns.includes(a.column)) t.columns.push(a.column);
      }
    }
    const nodes: PartialNode[] = [...tables.values()].map((t) => {
      const sql: Record<string, unknown> = { table: t.table, columns: t.columns };
      if (t.schema) sql['schema'] = t.schema;
      return {
        id: `schema:${t.table}`,
        kind: 'schema',
        name: t.table,
        file: t.file,
        line: t.line,
        code: t.code,
        meta: { extractors: [NAME], sql },
      };
    });
    const edges = new Map<string, Edge>();
    const addEdge = (from: string, to: string, kind: string) => {
      if (from !== to) edges.set(`${from}\0${to}\0${kind}`, { from, to, kind });
    };

    // --- DB → テーブル
    let db = cfg.db;
    if (db && !upstream.nodes.some((n) => n.id === db))
      ctx.log.warn(`sql: sql.db の ${db} が上流にありません（エッジは張ります）`);
    if (!db && nodes.length > 0) {
      const dbs = upstream.nodes.filter((n) => {
        const t = infraType(n);
        return t !== undefined && DB_TYPES.some((re) => re.test(t));
      });
      const clusters = dbs.filter((n) => infraType(n) === 'aws_rds_cluster');
      const pick = dbs.length === 1 ? dbs : clusters.length === 1 ? clusters : [];
      if (pick.length === 1) {
        db = pick[0]!.id;
        ctx.log.warn(`推定: ${db} → テーブル ${nodes.length} 件（sql.db で明示できます）`);
      } else if (dbs.length > 1)
        ctx.log.info(`sql: DB ノードが ${dbs.length} 個あるので sql.db で指定してください`);
    }
    if (db) for (const n of nodes) addEdge(db, n.id, 'schema');

    // --- コード → テーブル
    const names = [...tables.keys()];
    const candidates = upstream.nodes.filter(
      (n) => n.file && n.kind !== 'infra' && n.kind !== 'endpoint' && n.meta?.['sql'] === undefined,
    );
    const byFile = new Map<string, PartialNode[]>();
    for (const n of candidates) {
      if (!n.file || !CODE_EXT.test(n.file)) continue;
      const goPkg = (n.meta?.['go'] as { pkg?: string } | undefined)?.pkg;
      const abs = resolveNodeFile(ctx, n.file);
      if (!abs) continue;
      // Go はパッケージ単位なので、同じディレクトリの .go をすべて見る
      const scan = goPkg
        ? readdirSync(dirname(abs))
            .filter((f) => f.endsWith('.go') && !f.endsWith('_test.go'))
            .map((f) => join(dirname(abs), f))
        : [abs];
      for (const f of scan) byFile.set(f, [...(byFile.get(f) ?? []), n]);
    }
    for (const [abs, owners] of byFile) {
      const text = readSmall(abs);
      if (text === undefined) continue;
      const refs = tablesReferenced(text, names);
      if (refs.length === 0) continue;
      for (const t of refs) {
        // 1 ファイルに複数ノード（TS の export ごと）があれば、コード片に参照があるもの、無ければファイル単位の lib / handler
        const own =
          owners.length === 1
            ? owners
            : owners.filter((o) => o.code && tablesReferenced(o.code, [t]).length > 0);
        const pick =
          own.length > 0
            ? own
            : owners.filter((o) => o.kind === 'lib' || o.kind === 'handler').slice(0, 1);
        for (const o of pick) addEdge(o.id, `schema:${t}`, 'uses');
      }
    }
    ctx.log.info(
      `sql: ${files.length} files, ${nodes.length} tables, ${[...edges.values()].filter((e) => e.kind === 'uses').length} uses`,
    );
    return { nodes, edges: [...edges.values()] };
  },
};

export default extractor;
