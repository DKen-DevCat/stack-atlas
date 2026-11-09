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
 * - v2（docs/17 §7 #5、8-2b）: `PartialGraph.v2` に table の 3 つの口（key / write / read）とカラムの項目を出す（v2.ts）。
 *   カラムの型は CREATE TABLE の型（SQL の型 → wireType は v2.ts の sqlWireType）。go-types も readTables で同じ表を読む
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import type { Edge } from '@stack-atlas/schema';
import type { Extractor, PartialGraph, PartialNode, RepoContext } from '@stack-atlas/core';
import { globBase, globToRegExp, sectionFor } from '@stack-atlas/core';
import { tableNodeV2, tableTypeV2 } from './v2.js';

export { sqlWireType, tableNodeV2, tableTypeV2, columnItem } from './v2.js';

export const NAME = 'sql';

export const DEFAULT_MIGRATIONS = ['migrations/**/*.sql', 'db/migrations/**/*.sql'];
const MAX_SCAN_BYTES = 200 * 1024;
/** 読むマイグレーションの 1 ファイルの上限（超えるものは警告して読まない。8-2b レビュー S3） */
export const MAX_MIGRATION_BYTES = 5 * 1024 * 1024;
/** カラムの型の文字列の上限（それより長いものは切って `…`） */
const MAX_TYPE_TEXT = 256;
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

/** 位置 → 行番号（前から順に数える。表ごとに先頭から数え直すと O(n × 表の数) だった） */
function lineCounter(src: string) {
  let pos = 0;
  let line = 1;
  return (index: number) => {
    if (index < pos) {
      pos = 0;
      line = 1;
    }
    for (let i = src.indexOf('\n', pos); i >= 0 && i < index; i = src.indexOf('\n', i + 1)) line++;
    pos = index;
    return line;
  };
}

/**
 * CREATE TABLE の正規表現の当たりを順に回す。表の本体の閉じ括弧の後から次を探す（閉じない `(` の中の CREATE TABLE を
 * 何度も末尾まで読まない。2026-11-09 8-2b レビュー S3）
 */
function* createTables(
  src: string,
  re: RegExp,
): Generator<{ m: RegExpExecArray; open: number; close: number }> {
  re.lastIndex = 0;
  for (let m = re.exec(src); m; m = re.exec(src)) {
    const open = m.index + m[0].length - 1;
    const close = closeParen(src, open);
    yield { m, open, close };
    re.lastIndex = Math.max(re.lastIndex, close + 1);
  }
}

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
  const lineAt = lineCounter(raw);
  for (const { m, open, close } of createTables(src, create)) {
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
      line: lineAt(m.index),
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

/** カラムの定義（v2 の項目に使う） */
export interface SqlColumn {
  name: string;
  /** 書いたままの型（`TIMESTAMPTZ`・`VARCHAR(255)`）。無ければ "" */
  type: string;
  notNull: boolean;
  primaryKey: boolean;
  /** DEFAULT・serial・identity・AUTO_INCREMENT・GENERATED（INSERT で省ける） */
  hasDefault: boolean;
}

const COLUMN_STOP =
  /\b(NOT|NULL|PRIMARY|REFERENCES|DEFAULT|CHECK|UNIQUE|CONSTRAINT|COLLATE|GENERATED|AUTO_INCREMENT|AUTOINCREMENT|IDENTITY|COMMENT|ON)\b/i;

/** `name TYPE [制約]` → カラムの定義 */
export function parseColumnDef(item: string): SqlColumn | undefined {
  const m = /^\s*([`"[]?[^\s`"\]]+[`"\]]?)\s*([\s\S]*)$/.exec(item);
  if (!m) return undefined;
  const name = unquote(m[1]!);
  const rest = m[2]!;
  const stop = COLUMN_STOP.exec(rest);
  let type = (stop ? rest.slice(0, stop.index) : rest).trim().replace(/\s+/g, ' ');
  if (type.length > MAX_TYPE_TEXT) type = `${type.slice(0, MAX_TYPE_TEXT)}…`;
  const primaryKey = /\bPRIMARY\s+KEY\b/i.test(rest);
  return {
    name,
    type,
    notNull: primaryKey || /\bNOT\s+NULL\b/i.test(rest),
    primaryKey,
    hasDefault:
      /\b(DEFAULT|GENERATED|AUTO_INCREMENT|AUTOINCREMENT|IDENTITY)\b/i.test(rest) ||
      /^(small|big)?serial\d?$/i.test(type),
  };
}

/** CREATE TABLE（と ALTER TABLE ADD COLUMN）のカラムの定義（テーブル名 → カラム）。表の PRIMARY KEY (a, b) も必須にする */
export function parseColumnDefs(raw: string): Map<string, SqlColumn[]> {
  const src = stripSqlComments(raw);
  const out = new Map<string, SqlColumn[]>();
  const create = new RegExp(
    `\\bCREATE\\s+(?:OR\\s+REPLACE\\s+)?(?:(?:GLOBAL|LOCAL)\\s+)?(?:TEMP(?:ORARY)?\\s+|UNLOGGED\\s+)?TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?(?:${IDENT}\\.)?${IDENT}\\s*\\(`,
    'gi',
  );
  for (const { m, open, close } of createTables(src, create)) {
    if (out.has(m[2]!)) continue;
    const items = splitTopLevel(src.slice(open + 1, close)).map((i) => i.trim());
    const cols = items
      .filter((i) => i && !CONSTRAINT.test(i))
      .map(parseColumnDef)
      .filter((c): c is SqlColumn => !!c);
    const byName = new Map(cols.map((c) => [c.name, c]));
    for (const i of items) {
      const pk = /^(?:CONSTRAINT\s+\S+\s+)?PRIMARY\s+KEY\s*\(([^)]*)\)/i.exec(i);
      if (!pk) continue;
      for (const n of pk[1]!.split(',').map((x) => unquote(x.trim()))) {
        const c = byName.get(n);
        if (c) c.notNull = c.primaryKey = true;
      }
    }
    out.set(m[2]!, cols);
  }
  const alter = new RegExp(
    `\\bALTER\\s+TABLE\\s+(?:IF\\s+EXISTS\\s+)?(?:ONLY\\s+)?(?:${IDENT}\\.)?${IDENT}\\s+([^;]*)`,
    'gi',
  );
  const addedNames = new Map<SqlColumn[], Set<string>>();
  for (const m of src.matchAll(alter)) {
    for (const part of splitTopLevel(m[3]!)) {
      const a = /^\s*ADD\s+(?:COLUMN\s+)?(?:IF\s+NOT\s+EXISTS\s+)?([\s\S]*)$/i.exec(part);
      if (!a || CONSTRAINT.test(a[1]!.trim())) continue;
      const c = parseColumnDef(a[1]!);
      if (!c) continue;
      const list = out.get(m[2]!) ?? [];
      let names = addedNames.get(list);
      if (!names) addedNames.set(list, (names = new Set(list.map((x) => x.name))));
      if (!names.has(c.name)) {
        list.push(c);
        names.add(c.name);
      }
      out.set(m[2]!, list);
    }
  }
  return out;
}

/** マイグレーションのテーブル（最初に作ったもの。後のファイルの ADD COLUMN を足す）とカラムの定義 */
export type SqlTableWithDefs = SqlTable & { file: string; defs: SqlColumn[] };

/**
 * マイグレーションのテーブル。warn は読まなかったファイル（MAX_MIGRATION_BYTES を超える）の警告。カラムの照合は
 * 名前の表で（`defs.some` / `find` をカラムごとに回すと O(カラム²)。2026-11-09 8-2b レビュー S3: 4 万カラムで 20.9 秒）
 */
export function readTables(
  root: string,
  globs: string[],
  warn?: (message: string) => void,
): Map<string, SqlTableWithDefs> {
  const tables = new Map<string, SqlTableWithDefs>();
  /** テーブル → 列の名前・定義の名前の表 */
  const colSet = new Map<SqlTableWithDefs, Set<string>>();
  const defMap = new Map<SqlTableWithDefs, Map<string, SqlColumn>>();
  for (const rel of migrationFiles(root, globs)) {
    const abs = join(root, rel);
    let size: number;
    try {
      size = statSync(abs).size;
    } catch {
      continue;
    }
    if (size > MAX_MIGRATION_BYTES) {
      warn?.(
        `sql: ${rel} は大きすぎるので読みません（${size} バイト。上限 ${MAX_MIGRATION_BYTES} バイト）`,
      );
      continue;
    }
    const raw = readFileSync(abs, 'utf8');
    const { tables: ts, added } = parseSql(raw);
    const defs = parseColumnDefs(raw);
    for (const t of ts) {
      if (tables.has(t.table)) continue;
      const entry: SqlTableWithDefs = { ...t, file: rel, defs: [...(defs.get(t.table) ?? [])] };
      tables.set(t.table, entry);
      colSet.set(entry, new Set(entry.columns));
      const dm = new Map<string, SqlColumn>();
      for (const d of entry.defs) if (!dm.has(d.name)) dm.set(d.name, d);
      defMap.set(entry, dm);
    }
    for (const a of added) {
      const t = tables.get(a.table);
      if (t && !colSet.get(t)!.has(a.column)) {
        t.columns.push(a.column);
        colSet.get(t)!.add(a.column);
      }
    }
    // ADD COLUMN の型（CREATE と別のファイルにあるもの）
    for (const [name, cols] of defs) {
      const t = tables.get(name);
      if (!t) continue;
      const dm = defMap.get(t)!;
      for (const c of cols)
        if (!dm.has(c.name)) {
          t.defs.push(c);
          dm.set(c.name, c);
        }
    }
  }
  // CREATE の列に定義が無い（読めなかった）ものは型無しで足す。並びは列の順
  for (const t of tables.values()) {
    const dm = defMap.get(t)!;
    t.defs = t.columns.map(
      (c) =>
        dm.get(c) ?? { name: c, type: '', notNull: false, primaryKey: false, hasDefault: false },
    );
  }
  return tables;
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
  /** v2 の table は契約（合流点。言語アダプタではない。docs/17 §2） */
  v2Role: 'contract',
  async detect(ctx) {
    if (ctx.config.sql?.repo && !sectionFor(ctx, ctx.config.sql)) return false;
    const globs = sectionFor(ctx, ctx.config.sql)?.migrations ?? DEFAULT_MIGRATIONS;
    return migrationFiles(ctx.root, globs).length > 0;
  },
  async extract(ctx, upstream): Promise<PartialGraph> {
    const cfg = sectionFor(ctx, ctx.config.sql) ?? {};
    const files = migrationFiles(ctx.root, cfg.migrations ?? DEFAULT_MIGRATIONS);
    const tables = readTables(ctx.root, cfg.migrations ?? DEFAULT_MIGRATIONS, (m) =>
      ctx.log.warn(m),
    );
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
    const out: PartialGraph = { nodes, edges: [...edges.values()] };
    // v2: table の 3 つの口（key / write / read）とカラムの項目（docs/17 §7 #5）
    if (tables.size) {
      const list = [...tables.values()];
      out.v2 = { nodes: list.map(tableNodeV2), wires: [], types: list.map(tableTypeV2) };
    }
    return out;
  },
};

export default extractor;
