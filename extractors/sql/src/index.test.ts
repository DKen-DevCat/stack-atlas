import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { PartialGraph, RepoContext, StackAtlasConfig } from '@stack-atlas/core';
import {
  DEFAULT_MIGRATIONS,
  extractor,
  migrationFiles,
  parseSql,
  readTables,
  stripSqlComments,
  tablesReferenced,
} from './index.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../test/fixtures/shop');
const warnings: string[] = [];
const log = { debug() {}, info() {}, warn: (m: string) => warnings.push(m), error() {} };
function ctxOf(config: StackAtlasConfig = {}): RepoContext {
  return {
    root,
    config,
    repoName: 'shop',
    repos: { shop: root },
    configDir: root,
    log,
    resolve: (...s) => resolve(root, ...s),
  };
}

describe('helpers', () => {
  it('migrationFiles skips down files next to up files', () => {
    expect(migrationFiles(root, DEFAULT_MIGRATIONS)).toEqual([
      'migrations/000001_init.up.sql',
      'migrations/000002_add_note.up.sql',
    ]);
  });
  it('stripSqlComments keeps strings', () => {
    expect(stripSqlComments("a -- x\n'--y' /* z */")).toBe("a     \n'--y'        ");
  });
  it('parseSql reads CREATE TABLE and ALTER TABLE ADD COLUMN', () => {
    const { tables, added } = parseSql(
      'CREATE TABLE IF NOT EXISTS s.t (\n  a INT,\n  "b" TEXT,\n  PRIMARY KEY (a)\n);\nALTER TABLE t ADD COLUMN c INT, ADD d INT;\nDROP TABLE x;',
    );
    expect(tables).toEqual([
      {
        table: 't',
        schema: 's',
        columns: ['a', 'b'],
        line: 1,
        code: 'CREATE TABLE IF NOT EXISTS s.t (\n  a INT,\n  "b" TEXT,\n  PRIMARY KEY (a)\n);',
      },
    ]);
    expect(added).toEqual([
      { table: 't', column: 'c' },
      { table: 't', column: 'd' },
    ]);
  });
  it('tablesReferenced matches whole names after SQL keywords', () => {
    expect(
      tablesReferenced('SELECT * FROM orders o JOIN "order_items" i', ['orders', 'order_items']),
    ).toEqual(['orders', 'order_items']);
    expect(tablesReferenced('FROM orders_archive', ['orders'])).toEqual([]);
    expect(tablesReferenced('update public.orders set', ['orders'])).toEqual(['orders']);
  });
});

describe('sql extractor', async () => {
  const upstream: PartialGraph = {
    nodes: [
      { id: 'infra:aurora/this', kind: 'infra', meta: { infra: { type: 'aws_rds_cluster' } } },
      {
        id: 'schema:internal/store',
        kind: 'schema',
        file: 'internal/store/items.go',
        meta: { go: { pkg: 'internal/store', name: 'store', imports: [] } },
      },
      {
        id: 'lib:report',
        kind: 'lib',
        file: 'web/report.ts',
        code: "export const sql = 'select * from audit_log';",
      },
      {
        id: 'lib:unrelated',
        kind: 'lib',
        file: 'web/report.ts',
        code: 'export function unrelated() {}',
      },
    ],
    edges: [],
  };
  warnings.length = 0;
  const g = await extractor.extract(ctxOf(), upstream);
  const byId = new Map(g.nodes.map((n) => [n.id, n]));
  const has = (from: string, to: string, kind: string) =>
    g.edges.some((e) => e.from === from && e.to === to && e.kind === kind);

  it('detects migrations', async () => {
    expect(await extractor.detect(ctxOf())).toBe(true);
    expect(await extractor.detect(ctxOf({ sql: { repo: 'other' } }))).toBe(false);
    expect(await extractor.detect(ctxOf({ sql: { migrations: ['db/*.sql'] } }))).toBe(false);
  });

  it('schema nodes per table', () => {
    expect([...byId.keys()]).toEqual(['schema:orders', 'schema:order_items', 'schema:audit_log']);
    const o = byId.get('schema:orders')!;
    expect(o).toMatchObject({
      kind: 'schema',
      name: 'orders',
      file: 'migrations/000001_init.up.sql',
      line: 2,
    });
    expect(o.meta?.['sql']).toEqual({
      table: 'orders',
      schema: 'public',
      columns: ['id', 'total', 'created_at', 'note'],
    });
    expect(o.code?.startsWith('CREATE TABLE IF NOT EXISTS public.orders (')).toBe(true);
    expect(o.code?.endsWith(');')).toBe(true);
    expect(byId.get('schema:audit_log')?.meta?.['sql']).toMatchObject({ columns: ['id', 'msg'] });
  });

  it('guesses the DB (single RDS cluster) and warns', () => {
    expect(has('infra:aurora/this', 'schema:orders', 'schema')).toBe(true);
    expect(has('infra:aurora/this', 'schema:audit_log', 'schema')).toBe(true);
    expect(warnings.some((w) => w.startsWith('推定: infra:aurora/this'))).toBe(true);
  });

  it('uses edges from code that queries the tables (Go: whole package)', () => {
    expect(has('schema:internal/store', 'schema:orders', 'uses')).toBe(true);
    expect(has('schema:internal/store', 'schema:order_items', 'uses')).toBe(true);
    expect(has('lib:report', 'schema:audit_log', 'uses')).toBe(true);
    expect(has('lib:unrelated', 'schema:audit_log', 'uses')).toBe(false);
    expect(g.edges.filter((e) => e.kind === 'uses')).toHaveLength(3);
  });

  it('sql.db is explicit', async () => {
    warnings.length = 0;
    const g2 = await extractor.extract(ctxOf({ sql: { db: 'infra:other' } }), upstream);
    expect(g2.edges.filter((e) => e.kind === 'schema').every((e) => e.from === 'infra:other')).toBe(
      true,
    );
    expect(warnings.some((w) => w.startsWith('推定'))).toBe(false);
  });
});

describe('read の申告（docs/23 §3.1。2026-11-11 Phase 9-L0 のレビュー）', () => {
  it('readTables が実際に読んだファイルを返し、抽出器はそれを申告する（glob に合わない down は入らない）', async () => {
    const read: string[] = [];
    readTables(root, ['migrations/*.up.sql'], undefined, read);
    expect(read).toEqual(['migrations/000001_init.up.sql', 'migrations/000002_add_note.up.sql']);
    const g = await extractor.extract(ctxOf({ sql: { migrations: ['migrations/*.up.sql'] } }), {
      nodes: [],
      edges: [],
    });
    expect(g.read).toEqual(read);
  });
});
