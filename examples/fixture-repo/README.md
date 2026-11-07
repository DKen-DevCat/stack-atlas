# fixture-repo（Stack Atlas 用フィクスチャ）

`examples/race-site.graph.json`（手書きサンプル）と同じ構成を、実際の TypeScript / HTML / YAML ファイルで再現した**合成モノレポ**です。
Stack Atlas の抽出器（cdktf / nextjs-app / ts-imports / api-link / cache / screenshots）の入力として使い、
`stack-atlas build examples/fixture-repo -o out/` の結果をサンプルと見比べるために置いています（`docs/09-design-phase2-5.md` §3.4）。

## 注意

- **動きません**。`node_modules` は無く、`next` / `react` / `swr` / `zod` / `aws-lambda` / `@cdktf/provider-aws` などの import は意図的に未解決のままです（ts-morph は解決できない import を外部として無視します）。
- Stack Atlas のワークスペースには含まれません（ルートの `pnpm-workspace.yaml` は `packages/*` のみ）。lint / format / typecheck の対象外です。
- `infra/cdktf.out/stacks/web/cdk.tf.json` は `cdktf synth` の出力を**手書き**したものです。`infra/` のソースと整合させています。
- `site/` は各ルートの静的 HTML モックです（JS なし、1280px 幅、`data-component` 付き）。screenshots 抽出器の e2e テスト用で、`npx serve site -l 4173` のように配信します。

## ディレクトリ

```
fixture-repo/
├─ package.json / pnpm-workspace.yaml     # name: race-results
├─ stack-atlas.config.yaml                # 設定（docs/09 §3.3）
├─ stack-atlas.overrides.yaml             # 静的解析で取れない補正
├─ flows.yaml                             # データフロー 3 本（miss / hit / entry）
├─ .stack-atlas/memos.json                # チーム共有メモ
├─ infra/                                 # CDKtf（main.ts + stacks/*.ts）と cdktf.out
├─ apps/web/                              # Next.js App Router 風（app/ components/ hooks/ lib/）
├─ apps/api/                              # Lambda ハンドラ（src/index.ts が router、src/handlers/*）
├─ packages/types/                        # 型と zod スキーマ（src/*.ts、`@race/types`）
└─ site/                                  # スクショ用の静的 HTML
```

## ID の規約（抽出器が出すべき ID）

| 種類 | 規約 | 例 |
|---|---|---|
| infra | `infra:<construct id>`。construct path は `web/<id>` で、スタックは 1 つだけなのでスタック名は付けない | `infra:cdn`, `infra:next` |
| route / layout | `route:<URL パターン>` / `layout:<パス>` | `route:/races/[id]`, `layout:/` |
| comp / hook / lib / type | export 名（lib はファイル名）。`@race/types` の再エクスポートは宣言元までたどる | `comp:ResultTable`, `hook:useRaces`, `lib:apiClient`, `type:RaceResult` |
| handler / schema | export 名 | `handler:getRaces`, `schema:RaceItem` |
| actor | `overrides.yaml` で定義 | `actor:user` |

サンプルの `infra:lambdaNext` のような論理名ではなく construct id を使います（`docs/09` §3.3 の例にある `infra:web/next` 形式でもありません。スタックが 1 つなので `web/` は省いています）。
サンプルでは API Gateway と API Lambda がどちらも construct id `"api"` でしたが、同じスコープで重複できないため、API Gateway は `httpApi` にしました。

## ノード対応表（サンプル ID → フィクスチャ）

| サンプルの node id | 期待する ID | フィクスチャのファイル（construct / export） |
|---|---|---|
| `actor:user` | `actor:user` | `stack-atlas.overrides.yaml`（nodes） |
| `infra:cloudfront` | `infra:cdn` | `infra/stacks/cdn.ts`（`cdn`）/ `aws_cloudfront_distribution.cdn` |
| `infra:edge` | `infra:authEdge` | `infra/stacks/edge.ts`（`authEdge`、us-east-1 の Lambda@Edge） |
| `infra:cognito` | `infra:admins` | `infra/stacks/auth.ts`（`admins`） |
| `infra:s3` | `infra:static` | `infra/stacks/cdn.ts`（`static`） |
| `infra:lambdaNext` | `infra:next` | `infra/stacks/web.ts`（`next`、`filename: ../apps/web/.next/standalone.zip`、`handler: run.sh`） |
| `infra:apigw` | `infra:httpApi` | `infra/stacks/api.ts`（`httpApi`。route は `getRaces` / `listRaces` / `postResult`） |
| `infra:lambdaApi` | `infra:api` | `infra/stacks/api.ts`（`api`、`handler: index.handler`、`filename: ../apps/api/dist/index.zip`） |
| `infra:dynamo` | `infra:racesTable` | `infra/stacks/db.ts`（`racesTable`） |
| `layout:/` | `layout:/` | `apps/web/app/layout.tsx` |
| `route:/` | `route:/` | `apps/web/app/page.tsx`（`revalidate = 30`） |
| `route:/races` | `route:/races` | `apps/web/app/races/page.tsx` |
| `route:/races/[id]` | `route:/races/[id]` | `apps/web/app/races/[id]/page.tsx`（`revalidate = 60`、`generateStaticParams`） |
| `route:/admin/entry` | `route:/admin/entry` | `apps/web/app/admin/entry/page.tsx`（`dynamic = 'force-dynamic'`） |
| `route:/login` | `route:/login` | `apps/web/app/login/page.tsx` |
| `comp:Header` | `comp:Header` | `apps/web/components/Header.tsx` |
| `comp:RaceCard` | `comp:RaceCard` | `apps/web/components/RaceCard.tsx` |
| `comp:Pagination` | `comp:Pagination` | `apps/web/components/Pagination.tsx` |
| `comp:ResultTable` | `comp:ResultTable` | `apps/web/components/ResultTable.tsx`（内部の `Row` は非 export なのでノードにならない） |
| `comp:EntryForm` | `comp:EntryForm` | `apps/web/components/EntryForm.tsx` |
| `comp:AuthGuard` | `comp:AuthGuard` | `apps/web/components/AuthGuard.tsx` |
| `hook:useSession` | `hook:useSession` | `apps/web/hooks/useSession.ts` |
| `hook:useRaces` | `hook:useRaces` | `apps/web/hooks/useRaces.ts`（SWR: `dedupingInterval: 2000`, `revalidateOnFocus: true`） |
| `lib:apiClient` | `lib:apiClient` | `apps/web/lib/apiClient.ts`（`export const api`） |
| `type:Session` | `type:Session` | `packages/types/src/session.ts` |
| `type:Race` | `type:Race` | `packages/types/src/race.ts` |
| `type:RaceResult` | `type:RaceResult` | `packages/types/src/result.ts` |
| `type:EntryInput` | `type:EntryInput` | `packages/types/src/entry.ts`（zod） |
| `type:ApiResponse` | `type:ApiResponse` | `packages/types/src/api.ts` |
| `handler:getRaces` | `handler:getRaces` | `apps/api/src/handlers/getRaces.ts` |
| `handler:postResult` | `handler:postResult` | `apps/api/src/handlers/postResult.ts` |
| `schema:RaceItem` | `schema:RaceItem` | `apps/api/src/db/schema.ts` |

`flows.yaml` / `stack-atlas.overrides.yaml` / `.stack-atlas/memos.json` は上の「期待する ID」で書いてあります（メモは `infra:next` と `type:RaceResult`。プロトタイプの `lambdaNext` / `RaceResult` に相当）。

## 結線の手がかり（抽出器向け）

- **cdktf**: CloudFront の origin `nextOrigin` は `aws_lambda_function_url.nextUrl.function_url` から作ったドメインで、`nextUrl` が `aws_lambda_function.next` を指します（Function URL を 1 段またぐ）。S3 origin は `aws_s3_bucket.static`。`/admin/*` の `lambda_function_association` は `aws_lambda_function.authEdge.qualified_arn`。
  `authEdge → admins`（Cognito）は、Lambda@Edge が環境変数を持てないため `tags.UserPoolId` の参照で表現。`next → httpApi` は `API_BASE_URL` 環境変数の参照、`api → racesTable` は `TABLE` 環境変数の参照。
- **api-link**: `apiClient.ts` の `get("/races")` / `` `/races/${id}` `` / `` `/results` `` → API Gateway の route_key `GET /races`, `GET /races/{id}`, `POST /results` → integration `apiIntegration` → `aws_lambda_function.api`（`index.handler`）→ `apps/api/src/index.ts` の `routes` テーブル → `getRaces` / `postResult`。
- **cache**: CloudFront の behavior は `/_next/static/*`（CachingOptimized）、`/races/*` と `/`（カスタム policy `honorOriginHeaders`: default 60s / max 300s、Cookie はキーに入れない）、`/admin/*`（CachingDisabled `4135ea2d-…`）。`next.config.mjs` は `cacheHandler` 無し（Lambda の /tmp に ISR → warn の想定）。
- **screenshots**: `site/` の各ページの `data-component` は、サンプルの `screen.regions` に出てくる名前だけを使っています。`/login` は `hook:useSession` の領域なので `data-component="useSession"`（comp ではなく hook にも解決できる必要があります）。

## サンプルとの差分

- ファイルパスは依頼仕様に合わせた: `lib/api.ts` → `apps/web/lib/apiClient.ts`、`packages/types/*.ts` → `packages/types/src/*.ts`、`apps/api/src/*.ts` → `apps/api/src/handlers/*.ts`。
- API Gateway に `GET /races`（`listRaces`）を追加（サンプルの `api.getRaces` が `/races` を呼ぶため）。
- ハンドラの `ddb` / `ok` / `toRace` / `toItem` は、`lib:` ノードが増えてサンプルの `uses` エッジとずれないよう、各ハンドラ内のローカル定義にしてある。
- `/admin/entry` の `save()` は `EntryInput` を直接 import せず `Parameters<typeof api.postResult>[0]` を使う（サンプルに `route:/admin/entry → type:EntryInput` が無いため）。
- `app/page.tsx` は `"use client"` かつ `export const revalidate = 30`。本物の Next では不可だが、サンプル（ISR 設定 + SWR）の再現を優先した。
- `useRaces` はサンプルの `Home` / `Races` の使い方に合わせて `page` / `setPage` も返す。
