# @stack-atlas/extractor-nextjs-app

Next.js App Router の `app/` から **画面層**（`route:*` / `layout:*`）を作る抽出器。route segment config を `meta.next` と `cache` にし、Next を載せた Lambda から `deploy` エッジを張る。

## 入力・設定

| キー | 既定 | 意味 |
|---|---|---|
| `next.appDir` | `apps/*/app` → `src/app` → `app` の順に探す | `page.*` / `layout.*` があるディレクトリ |
| `deploy.<id>.app: next` | | その infra ノードから全ルートへ `deploy` |

## ノード

- `page.(tsx|ts|jsx|js)` → `route:<URL>`（kind `page`）、`layout.*` → `layout:<URL>`（kind `layout`）。`name` は URL、`line: 1`、`code` は先頭 25 行。
- URL 化: `(group)` は除く、`[id]` / `[...slug]` / `[[...slug]]` はそのまま。`@slot`（パラレル）・`(.)x`（インターセプト）・`_private` は対象外（info ログ）。
  この変換は `extractors/ts-imports/src/routes.ts` と同じ実装（ID を一致させるため。変えるときは両方）。
- `meta.next: { segment, revalidate?, dynamic?, generateStaticParams? }`。値は `export const revalidate = 60` のようなリテラルだけを正規表現で読む。

## cache

- `revalidate: n` → `ISR ns`（Next を載せているのが Lambda なら `warn`、それ以外は `ok`）
- `dynamic: 'force-dynamic'` / `revalidate: 0` → `off`（dynamic）
- `revalidate: false` / `force-static` → `ok`（static）
- `generateStaticParams` があれば rule を追加（それだけなら `SSG`）

## エッジ

- 上流（cdktf）の `meta.deployApp === 'next'` のノード、または `config.deploy` で `app: next` のノード → 全 route / layout に `deploy`。
- layout と route の間のエッジは張らない（サンプルにも無い）。route → コンポーネントの `uses` は ts-imports が張る。

## 制限

- Pages Router（`pages/`）は未対応。`revalidate` が式（定数参照など）だと読めない。
