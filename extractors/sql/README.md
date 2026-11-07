# @stack-atlas/extractor-sql

SQL マイグレーションのテーブルを `schema:<table>` ノードにする抽出器（docs/12 §3.5）。

## 入力・設定

| キー | 既定 | 意味 |
|---|---|---|
| `sql.repo` | — | この repo でだけ動かす |
| `sql.migrations` | `["migrations/**/*.sql", "db/migrations/**/*.sql"]` | マイグレーションの glob |
| `sql.db` | 推定 | テーブルを持つ DB ノードの ID |

`x.up.sql` と並んでいる `x.down.sql`（`up.sql` と並ぶ `down.sql`）は読まない。

## ノード

- `CREATE [OR REPLACE] [TEMP|UNLOGGED] TABLE [IF NOT EXISTS] [schema.]name (...)`（Postgres / MySQL / SQLite、引用符 `"` `` ` `` `[]` 可）→ `schema:<name>`。
  `name` はテーブル名、`file` / `line`、`code` は CREATE 文（30 行まで）、`meta.sql: { table, schema?, columns }`。
- 列は本体のトップレベルの項目（`CONSTRAINT` / `PRIMARY KEY` / `FOREIGN KEY` / `UNIQUE` / `CHECK` / `KEY` / `INDEX` などは除く）＋ 後のファイルの `ALTER TABLE x ADD [COLUMN] y`。
- 同じテーブルが複数回作られたら最初のもの。DROP / RENAME は無視。コメント（`--` `#` `/* */`）は除く。

## エッジ

- `schema`: `sql.db` → 各テーブル。無ければ上流の DB（`aws_rds_cluster` / `aws_db_instance` / `google_sql_database_instance` / `azurerm_*_server`）が
  1 つ（または RDS cluster が 1 つ）なら推定して warn `推定: <db> → テーブル n 件（sql.db で明示できます）`。
- `uses`: 上流のコードノード（`file` が go / ts / js / py などで 200 KB 以下）のファイルに
  `FROM|JOIN|INTO|UPDATE|TABLE [schema.]<table>` があれば、そのノード → `schema:<table>`。
  Go のノード（`meta.go`）はパッケージのディレクトリの `.go` をすべて見る。1 ファイルに複数ノード（TS の export ごと）があれば、
  `code` に参照があるノード、無ければそのファイルの lib / handler。
