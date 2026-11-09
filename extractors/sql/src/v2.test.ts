// sql 抽出器の v2（docs/17 §7 #2・#5、8-2b）: table の 3 つの口（key / write / read）とカラムの項目、SQL の型 → wireType。
// fixture-poly のマイグレーションは手で組んだ例（examples/fixture-poly.today.v2.json）の schema:transactions と比べる
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { GraphV2, ItemV2 } from '@stack-atlas/schema';
import type { RepoContext } from '@stack-atlas/core';
import { extractor, parseColumnDefs, readTables, sqlWireType } from './index.js';

const here = dirname(fileURLToPath(import.meta.url));
const shop = resolve(here, '../test/fixtures/shop');
const poly = resolve(here, '../../../examples/fixture-poly/platform');
const log = { debug() {}, info() {}, warn() {}, error() {} };
const ctxOf = (root: string): RepoContext => ({
  root,
  config: {},
  repoName: 'x',
  repos: { x: root },
  configDir: root,
  log,
  resolve: (...s) => resolve(root, ...s),
});

const brief = (items: ItemV2[]) =>
  items.map((i) => [i.id, i.type, i.wireType, i.nullable ?? false, i.optional ?? false]);

describe('sqlWireType（SQL の型 → wireType）', () => {
  it.each([
    ['smallint', 'integer'],
    ['INT', 'integer'],
    ['integer', 'integer'],
    ['BIGINT', 'integer'],
    ['bigint unsigned', 'integer'],
    ['serial', 'integer'],
    ['BIGSERIAL', 'integer'],
    ['numeric(10, 2)', 'number'],
    ['DECIMAL', 'number'],
    ['real', 'number'],
    ['double precision', 'number'],
    ['TEXT', 'string'],
    ['VARCHAR(255)', 'string'],
    ['character varying(20)', 'string'],
    ['char(2)', 'string'],
    ['UUID', 'string'],
    ['boolean', 'boolean'],
    ['TIMESTAMPTZ', 'datetime'],
    ['timestamp with time zone', 'datetime'],
    ['timestamp', 'datetime'],
    ['date', 'datetime'],
    ['time', 'datetime'],
    ['BYTEA', 'bytes'],
    ['jsonb', 'object'],
    ['JSON', 'object'],
    ['text[]', 'array'],
    ['integer ARRAY', 'array'],
    ['tsvector', 'unknown'],
    ['', 'unknown'],
  ])('%s → %s', (t, w) => expect(sqlWireType(t)).toBe(w));
});

describe('parseColumnDefs', () => {
  it('型・NOT NULL・PRIMARY KEY（列と表の制約）・DEFAULT・serial・AUTO_INCREMENT、ALTER TABLE ADD COLUMN', () => {
    const defs = parseColumnDefs(
      "CREATE TABLE t (\n  id BIGSERIAL PRIMARY KEY,\n  a VARCHAR(20) NOT NULL,\n  b NUMERIC(10, 2),\n  c TIMESTAMPTZ NOT NULL DEFAULT now(),\n  d INT,\n  e INT,\n  PRIMARY KEY (d, e)\n);\nALTER TABLE t ADD COLUMN f TEXT NOT NULL DEFAULT '';",
    );
    expect(defs.get('t')).toEqual([
      { name: 'id', type: 'BIGSERIAL', notNull: true, primaryKey: true, hasDefault: true },
      { name: 'a', type: 'VARCHAR(20)', notNull: true, primaryKey: false, hasDefault: false },
      { name: 'b', type: 'NUMERIC(10, 2)', notNull: false, primaryKey: false, hasDefault: false },
      { name: 'c', type: 'TIMESTAMPTZ', notNull: true, primaryKey: false, hasDefault: true },
      { name: 'd', type: 'INT', notNull: true, primaryKey: true, hasDefault: false },
      { name: 'e', type: 'INT', notNull: true, primaryKey: true, hasDefault: false },
      { name: 'f', type: 'TEXT', notNull: true, primaryKey: false, hasDefault: true },
    ]);
  });

  it('readTables は v1 と同じテーブル（最初の CREATE、後のファイルの ADD COLUMN）にカラムの定義を付ける', () => {
    const t = readTables(shop, ['migrations/**/*.sql']);
    expect([...t.keys()]).toEqual(['orders', 'order_items', 'audit_log']);
    expect(t.get('orders')!.defs.map((c) => [c.name, c.type])).toEqual([
      ['id', 'UUID'],
      ['total', 'INTEGER'],
      ['created_at', 'TIMESTAMPTZ'],
      ['note', 'TEXT'],
    ]);
    expect(t.get('audit_log')!.defs[0]).toMatchObject({
      name: 'id',
      type: 'BIGINT',
      hasDefault: true,
    });
  });
});

describe('sql 抽出器の v2', async () => {
  const g = await extractor.extract(ctxOf(shop), { nodes: [], edges: [] });

  it('テーブルごとに schema:<table>（v1 と同じ id）、kind table・runtime data、口は key / write / read', () => {
    const v2 = g.v2!;
    expect(v2.nodes.map((n) => n.id)).toEqual([
      'schema:orders',
      'schema:order_items',
      'schema:audit_log',
    ]);
    expect(v2.wires).toEqual([]);
    const o = v2.nodes[0]!;
    expect(o).toMatchObject({
      kind: 'table',
      runtime: 'data',
      name: 'orders',
      file: 'migrations/000001_init.up.sql',
      line: 2,
    });
    expect(o.ports.map((p) => [p.id, p.dir])).toEqual([
      ['key', 'in'],
      ['write', 'in'],
      ['read', 'out'],
    ]);
    // key: カラムそのまま（WHERE で引く。合流の段が query_n.<col> → key/<col>）
    expect(brief(o.ports[0]!.items)).toEqual([
      ['id', 'UUID', 'string', false, false],
      ['total', 'INTEGER', 'integer', false, false],
      ['created_at', 'TIMESTAMPTZ', 'datetime', false, false],
      ['note', 'TEXT', 'string', false, false],
    ]);
    // write: 親 row の子。INSERT で省ける（DEFAULT・nullable）ものは optional
    const write = o.ports[1]!.items[0]!;
    expect(write).toMatchObject({
      id: 'row',
      type: 'record',
      wireType: 'object',
      typeRef: 'table:orders',
    });
    expect(brief(write.children!)).toEqual([
      ['id', 'UUID', 'string', false, false],
      ['total', 'INTEGER', 'integer', false, false],
      ['created_at', 'TIMESTAMPTZ', 'datetime', false, true],
      ['note', 'TEXT', 'string', false, true],
    ]);
    // read: 親 row の子。NOT NULL / PRIMARY KEY でなければ nullable
    expect(brief(o.ports[2]!.items[0]!.children!)).toEqual([
      ['id', 'UUID', 'string', false, false],
      ['total', 'INTEGER', 'integer', false, false],
      ['created_at', 'TIMESTAMPTZ', 'datetime', false, false],
      ['note', 'TEXT', 'string', true, false],
    ]);
    expect(o.ports[0]!.items.every((i) => i.typeRef === 'table:orders')).toBe(true);
    expect(v2.types).toEqual([
      {
        id: 'table:orders',
        name: 'orders',
        file: 'migrations/000001_init.up.sql',
        line: 2,
        source: 'sql',
      },
      {
        id: 'table:order_items',
        name: 'order_items',
        file: 'migrations/000001_init.up.sql',
        line: 9,
        source: 'sql',
      },
      {
        id: 'table:audit_log',
        name: 'audit_log',
        file: 'migrations/000002_add_note.up.sql',
        line: 3,
        source: 'sql',
      },
    ]);
  });

  it('v1 の出力は変わらない（v2 は別に並べる）', () => {
    expect(g.nodes.map((n) => n.id)).toEqual([
      'schema:orders',
      'schema:order_items',
      'schema:audit_log',
    ]);
    expect(g.nodes[0]!.meta?.['sql']).toEqual({
      table: 'orders',
      schema: 'public',
      columns: ['id', 'total', 'created_at', 'note'],
    });
  });

  it('fixture-poly の transactions は手で組んだ例と同じ形（key の項目は全部のカラム、row の子は例と同じ）', async () => {
    const p = await extractor.extract(ctxOf(poly), { nodes: [], edges: [] });
    const t = p.v2!.nodes.find((n) => n.id === 'schema:transactions')!;
    const example = JSON.parse(
      readFileSync(resolve(here, '../../../examples/fixture-poly.today.v2.json'), 'utf8'),
    ) as GraphV2;
    const ex = example.nodes.find((n) => n.id === 'schema:transactions')!;
    const shape = (items: ItemV2[]): unknown =>
      items.map((i) => ({
        id: i.id,
        type: i.type,
        wireType: i.wireType,
        typeRef: i.typeRef,
        ...(i.children ? { children: shape(i.children) } : {}),
      }));
    expect([t.kind, t.runtime, t.file, t.line]).toEqual([
      ex.kind,
      ex.runtime,
      'migrations/000001_init.up.sql',
      ex.line,
    ]);
    expect(t.ports.map((x) => [x.id, x.dir])).toEqual(ex.ports.map((x) => [x.id, x.dir]));
    // 例の key は WHERE で使う occurred_at だけ。抽出器は全部のカラムを置く
    const keyIds = t.ports[0]!.items.map((i) => i.id);
    expect(keyIds).toEqual(['id', 'merchant', 'amount', 'occurred_at']);
    expect(shape(t.ports[0]!.items.filter((i) => i.id === 'occurred_at'))).toEqual(
      shape(ex.ports[0]!.items),
    );
    expect(shape(t.ports[1]!.items)).toEqual(shape(ex.ports[1]!.items));
    expect(shape(t.ports[2]!.items)).toEqual(shape(ex.ports[2]!.items));
    // occurred_at は DEFAULT now() なので INSERT で省ける（write で optional）
    expect(t.ports[1]!.items[0]!.children!.find((c) => c.id === 'occurred_at')!.optional).toBe(
      true,
    );
    // file は repo 相対（複数 repo の `platform/` はパイプラインが付ける）
    const exType = example.types!.find((x) => x.id === 'table:transactions')!;
    expect(p.v2!.types!.find((x) => x.id === 'table:transactions')).toEqual({
      ...exType,
      file: exType.file!.replace(/^platform\//, ''),
    });
  });
});
