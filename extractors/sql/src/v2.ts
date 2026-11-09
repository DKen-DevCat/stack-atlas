/**
 * SQL のテーブル → v2 の table の箱（docs/17 §7 #2・#5、docs/16 §5）。
 *
 * - 箱の id は v1 と同じ `schema:<table>`、kind table、runtime data（host は upgrade が DB の枠にする）
 * - 口: `key`（dir in。WHERE で引くカラム。全部のカラムを置き、合流の段が `query_n.<col> → key/<col>` を引く）、
 *   `write`（dir in。親の項目 `row`、子がカラム）、`read`（dir out。親の項目 `row`、子がカラム）
 * - カラムの項目: type は書いたままの SQL の型、wireType は sqlWireType、typeRef は `table:<table>`。
 *   NOT NULL / PRIMARY KEY でなければ nullable（read）。write の子は INSERT で省けるもの（DEFAULT・serial・identity・
 *   nullable）を optional にする（合流の照合で「送る側に無い必須のカラム」だけが error になるように）
 */
import type { ItemV2, NamedType, WireType } from '@stack-atlas/schema';
import type { PartialNodeV2 } from '@stack-atlas/core';
import type { SqlColumn, SqlTableWithDefs } from './index.js';

/** 項目 id の文字集合（docs/16 §3）。それ以外は _ に */
const itemId = (name: string) => name.replace(/[^A-Za-z0-9_$-]/g, '_') || '_';

/**
 * SQL の型 → wireType: smallint / int / integer / bigint / serial / bigserial → integer、numeric / decimal / real /
 * double precision / float → number、text / varchar / char / uuid → string、boolean → boolean、timestamp / timestamptz /
 * date / time → datetime、bytea / blob → bytes、json / jsonb → object、配列（`text[]`・`ARRAY`）→ array、ほか unknown
 */
export function sqlWireType(type: string): WireType {
  const t = type
    .toLowerCase()
    .replace(/\(.*?\)/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!t) return 'unknown';
  if (/\[\s*\]$/.test(t) || /\barray\b/.test(t)) return 'array';
  const base = t.replace(/\s+unsigned$/, '');
  if (
    /^(smallint|int|integer|bigint|int2|int4|int8|tinyint|mediumint|serial|bigserial|smallserial|serial2|serial4|serial8)$/.test(
      base,
    )
  )
    return 'integer';
  if (/^(numeric|decimal|real|double precision|double|float|float4|float8|money)$/.test(base))
    return 'number';
  if (
    /^(text|varchar|character varying|char|character|nchar|nvarchar|uuid|citext|string|tinytext|mediumtext|longtext|enum)$/.test(
      base,
    )
  )
    return 'string';
  if (/^(boolean|bool)$/.test(base)) return 'boolean';
  if (
    /^(timestamp|timestamptz|timestamp with time zone|timestamp without time zone|datetime|date|time|timetz|time with time zone|time without time zone)$/.test(
      base,
    )
  )
    return 'datetime';
  if (/^(bytea|blob|binary|varbinary|longblob|mediumblob|tinyblob)$/.test(base)) return 'bytes';
  if (/^(json|jsonb)$/.test(base)) return 'object';
  return 'unknown';
}

export interface ColumnItemOptions {
  /** nullable を書く（read） */
  nullable?: boolean;
  /** INSERT で省けるものを optional にする（write） */
  optional?: boolean;
}

/** カラムの項目 */
export function columnItem(table: string, c: SqlColumn, o: ColumnItemOptions = {}): ItemV2 {
  const it: ItemV2 = {
    id: itemId(c.name),
    name: c.name,
    type: c.type || 'unknown',
    wireType: sqlWireType(c.type),
    typeRef: `table:${table}`,
  };
  if (o.nullable && !c.notNull) it.nullable = true;
  if (o.optional && (!c.notNull || c.hasDefault)) it.optional = true;
  return it;
}

const rowItem = (table: string, children: ItemV2[]): ItemV2 => ({
  id: 'row',
  name: 'row',
  type: 'record',
  wireType: 'object',
  typeRef: `table:${table}`,
  children,
});

/** テーブル → v2 の箱 */
export function tableNodeV2(t: SqlTableWithDefs): PartialNodeV2 {
  const cols = t.defs;
  return {
    id: `schema:${t.table}`,
    kind: 'table',
    name: t.table,
    runtime: 'data',
    file: t.file,
    line: t.line,
    code: t.code,
    ports: [
      { id: 'key', dir: 'in', items: cols.map((c) => columnItem(t.table, c)) },
      {
        id: 'write',
        dir: 'in',
        items: [
          rowItem(
            t.table,
            cols.map((c) => columnItem(t.table, c, { optional: true })),
          ),
        ],
      },
      {
        id: 'read',
        dir: 'out',
        items: [
          rowItem(
            t.table,
            cols.map((c) => columnItem(t.table, c, { nullable: true })),
          ),
        ],
      },
    ],
    meta: {
      extractors: ['sql'],
      sql: { table: t.table, ...(t.schema ? { schema: t.schema } : {}) },
    },
  };
}

/** テーブル → types[]（`table:<name>`） */
export function tableTypeV2(t: SqlTableWithDefs): NamedType {
  return { id: `table:${t.table}`, name: t.table, file: t.file, line: t.line, source: 'sql' };
}
