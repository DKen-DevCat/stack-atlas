# @stack-atlas/extractor-nextjs-app

Next.js の App Router（`app/`）と Pages Router（`pages/`）から **画面層**（`route:*` / `layout:*`）と API ルート（`handler:*`）を作る抽出器。
route segment config と `output: 'export'` を `meta.next` と `cache` にし、Next を載せたインフラノード（Lambda でも S3 でも）から `deploy` エッジを張る。

## 入力・設定

| キー | 既定 | 意味 |
|---|---|---|
| `next.repo` | — | この repo でだけ動かす（`sectionFor`） |
| `next.appDir` | `apps/*/app` → `src/app` → `app` の順に探す | `page.*` / `layout.*` があるディレクトリ |
| `next.pagesDir` | `src/pages` → `pages` | Pages Router のディレクトリ |
| `deploy.<id>.app: next` | | その infra ノード（型は問わない）から全ルートへ `deploy` |

`next.config.{ts,mjs,js,cjs,mts}`（app / pages の親から root へ探す）の `output: "export"` を正規表現で読む。

## ノード

- `page.(tsx|ts|jsx|js)` → `route:<URL>`（kind `page`）、`layout.*` → `layout:<URL>`（kind `layout`）。`name` は URL、`line: 1`、`code` は先頭 25 行。
- URL 化: `(group)` は除く、`[id]` / `[...slug]` / `[[...slug]]` はそのまま。`@slot`（パラレル）・`(.)x`（インターセプト）・`_private` は対象外（info ログ）。
  この変換は core の `segmentToUrl`（ts-imports と共用）。
- `meta.next: { segment, revalidate?, dynamic?, generateStaticParams?, output?, router? }`。値は `export const revalidate = 60` のようなリテラルだけを正規表現で読む。
- `route.(ts|js)` → `handler:<URL>`（kind `handler`）。`meta.apiRoutes` は export している `GET` / `POST` …（無ければ `ANY`）、パスは `[id]` → `{id}`、`[...x]` → `{x+}`。
- Pages Router: `pages/x/[id].tsx` → `route:/x/[id]`、`index` はディレクトリの URL、`_app`（無ければ `_document`）→ `layout:/`、
  `pages/api/**` → `handler:<URL>`（`ANY`）。ほかの `_` ファイル（`_error` など）は対象外。App Router と同じ ID なら App Router を残す。
- ID の一覧は `listNextFiles()`（export）。ts-imports も同じ関数でファイル → ID を引く。

## cache

- `revalidate: n` → `ISR ns`（Next を載せているのが Lambda なら `warn`、それ以外は `ok`）
- `dynamic: 'force-dynamic'` / `revalidate: 0` → `off`（dynamic）
- `revalidate: false` / `force-static` → `ok`（static）
- `generateStaticParams` があれば rule を追加（それだけなら `SSG`）
- 上のどれも無く `output: 'export'` なら `ok`（`static export`、rule `output: export（ビルド時に静的生成）`）

## エッジ

- 上流の `meta.deployApp === 'next'` のノード、または `config.deploy` で `app: next` のノード（型は問わない）→ 全 route / layout に `deploy`。
- どれも無く `output: 'export'` なら、CloudFront（`aws_cloudfront_distribution`）からエッジが出ている S3 バケットが 1 つだけのときそこから deploy（warn `推定`）。
- layout と route の間のエッジは張らない（サンプルにも無い）。route → コンポーネントの `uses` は ts-imports が張る。

## 制限

- `revalidate` が式（定数参照など）だと読めない。Pages Router の `getStaticProps` の `revalidate` は読まない。
