// 8-2b のレビューの指摘 S3（2026-11-09）を直したことを固定する: 型の正規化・readTables・CREATE TABLE の走査の計算量と、
// マイグレーションの大きさの上限。入力はセキュリティのレビューの実測（もとのコードは 100KB の型で 15.8 秒、4 万カラムで 20.9 秒）
// より大きくして、もとのコードなら時間の上限を超えるようにしてある
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { MAX_MIGRATION_BYTES, parseColumnDefs, parseSql, readTables } from './index.js';
import { MAX_SQL_TYPE, sqlWireType, tableNodeV2 } from './v2.js';

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
function repo(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'sql-review-'));
  dirs.push(root);
  for (const [p, body] of Object.entries(files)) {
    mkdirSync(join(root, p, '..'), { recursive: true });
    writeFileSync(join(root, p), body);
  }
  return root;
}

const timed = <T>(f: () => T): [T, number] => {
  const t0 = performance.now();
  const v = f();
  return [v, performance.now() - t0];
};

describe('S3: sql 抽出器の計算量', () => {
  it('sqlWireType: 閉じない `(` が続く型でも線形（`/\\(.*?\\)/` は O(n²) だった）。長すぎる型は unknown', () => {
    const [w, ms] = timed(() => sqlWireType('('.repeat(200_000)));
    expect(w).toBe('unknown');
    expect(ms).toBeLessThan(1000);
    // 上限より短ければ従来どおり（入れ子の括弧も内側から消す）
    expect(sqlWireType('numeric(10, 2)')).toBe('number');
    expect(sqlWireType('varchar((255))')).toBe('string');
    expect(sqlWireType(`text${' '.repeat(MAX_SQL_TYPE)}`)).toBe('unknown');
    const [w2, ms2] = timed(() => sqlWireType(`int${'('.repeat(MAX_SQL_TYPE - 3)}`));
    expect(w2).toBe('unknown');
    expect(ms2).toBeLessThan(100);
  });

  it('readTables: 8 万カラムのテーブルでも線形（defs.some / find を回して O(カラム²) だった）。型は 256 文字で切る', () => {
    const C = 80_000;
    const cols = Array.from({ length: C }, (_, i) => `c${i} text`).join(', ');
    const root = repo({
      'migrations/000001_init.up.sql': `CREATE TABLE t (${cols}, x ${'('.repeat(1000)});\n`,
      'migrations/000002_more.up.sql': Array.from(
        { length: 2000 },
        (_, i) => `ALTER TABLE t ADD COLUMN c${i} text;`,
      ).join('\n'),
    });
    const [tables, ms] = timed(() => readTables(root, ['migrations/**/*.sql']));
    expect(ms).toBeLessThan(10_000);
    const t = tables.get('t')!;
    expect(t.columns).toHaveLength(C + 1);
    expect(t.defs).toHaveLength(C + 1);
    expect(t.defs[C]!.type.length).toBeLessThanOrEqual(257);
    const [node, ms2] = timed(() => tableNodeV2(t));
    expect(ms2).toBeLessThan(5000);
    expect(node.ports[0]!.items).toHaveLength(C + 1);
  }, 60_000);

  it('CREATE TABLE の走査: 閉じない `(` の中の CREATE TABLE を末尾まで読み直さない。行番号は前から数える', () => {
    // 閉じない `CREATE TABLE tN (` が 6 万回（もとは当たりごとに末尾まで閉じ括弧を探して O(n²)）
    const open = Array.from({ length: 60_000 }, (_, i) => `CREATE TABLE u${i} (`).join('\n');
    const [r1, ms1] = timed(() => parseSql(open));
    expect(ms1).toBeLessThan(5000);
    expect(r1.tables.map((t) => t.table)).toEqual(['u0']);
    expect(timed(() => parseColumnDefs(open))[1]).toBeLessThan(5000);
    // 閉じた表が 6 万（もとは表ごとに先頭から行を数え直して O(n × 表の数)）
    const closed = Array.from({ length: 60_000 }, (_, i) => `CREATE TABLE t${i} (a int);`).join(
      '\n',
    );
    const [r2, ms2] = timed(() => parseSql(closed));
    expect(ms2).toBeLessThan(5000);
    expect(r2.tables).toHaveLength(60_000);
    expect(r2.tables[59_999]).toMatchObject({ table: 't59999', line: 60_000 });
  }, 60_000);

  it('マイグレーションの 1 ファイルが上限（5MB）を超えたら警告して読まない', () => {
    const big = `CREATE TABLE big (a int);\n-- ${'x'.repeat(MAX_MIGRATION_BYTES)}\n`;
    const root = repo({
      'migrations/000001_big.up.sql': big,
      'migrations/000002_ok.up.sql': 'CREATE TABLE ok (id int);',
    });
    const warns: string[] = [];
    const tables = readTables(root, ['migrations/**/*.sql'], (m) => warns.push(m));
    expect([...tables.keys()]).toEqual(['ok']);
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain('migrations/000001_big.up.sql は大きすぎるので読みません');
  });
});
