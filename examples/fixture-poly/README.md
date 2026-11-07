# fixture-poly（Stack Atlas 用フィクスチャ: 2 リポジトリ構成）

実際の構成（`docs/12-design-generalization.md` §2.1）と同じ**形**を、架空の「支出トラッカー」で再現した**合成**の 2 リポジトリです。
一般化した抽出器（terraform / go / openapi / sql / nextjs-app の static export / api-link）の end-to-end テストの入力に使います（§3.9）。
内容はすべて創作で、実在のリポジトリのコードは含みません。

## 注意

- **動きません**。`node_modules` も Go の依存も無く、`next` / `react` / AWS provider などは未解決のままです。`go vet` / `next build` / `terraform apply` の対象ではありません。
- Stack Atlas のワークスペースには含まれません（lint / typecheck の対象外）。`.tf` は `@cdktf/hcl2json` で、`.go` は正規表現で読まれます。
- `web/openapi/today.yaml` は `platform/openapi/today.yaml` の写しです（実構成と同じく両リポジトリに置く）。設定は platform 側を指します。

## ディレクトリ

```
fixture-poly/
├─ stack-atlas.config.yaml      # repos: web / platform。terraform / go / openapi / sql / next / ts / api / deploy / classify / kinds
├─ stack-atlas.overrides.yaml   # actor:user と、静的解析で取れない結線
├─ flows.yaml                   # 「今日の合計を見る」「メール取り込み」
├─ .stack-atlas/memos.json
├─ web/                         # Next.js App Router（output: "export"、trailingSlash: true）
│   ├─ src/app/                 #   layout / page / calendar / push
│   ├─ src/components/*.tsx     #   kebab-case ファイル、PascalCase export、data-component 付き
│   ├─ src/feature/{spend,days}/{request,types,transformer}.ts
│   ├─ src/lib/fetcher/{index,consts}.ts   # fetch(`${API_DOMAIN}${url}`) をするラッパー
│   └─ openapi/today.yaml
└─ platform/                    # Go module example.com/expense-platform
    ├─ cmd/{api,gmail-webhook,notify}/main.go
    ├─ internal/{api,domain,store,parser,inbound,auth,push}/
    ├─ migrations/000001_init.{up,down}.sql, 000002_push.{up,down}.sql
    ├─ openapi/today.yaml
    └─ infra/{envs/dev, modules/{network,aurora,lambda-api,static-site,cognito,scheduler-notify}}
```

## 期待する ID

### infra（Terraform HCL。`infra:<module>/<logicalId>`、root 直下は `infra:<logicalId>`）

| 期待する ID | 元 | 備考 |
|---|---|---|
| `infra:app` | root `aws_ecr_repository.app` | ECR。`image_uri` の参照元 |
| `infra:lambda_api/api` | `aws_lambda_function.api` | Function URL（`aws_lambda_function_url.api`）はホップとして畳む |
| `infra:lambda_api/gmail_webhook` | `aws_lambda_function.gmail_webhook` | 同上（Function URL あり） |
| `infra:lambda_api/notify` | `aws_lambda_function.notify` | URL なし。Scheduler から起動 |
| `infra:aurora/this` | `aws_rds_cluster.this` | `aws_rds_cluster_instance.this` は `cluster_identifier` 参照でクラスタに寄せる（instance を別ノードにする場合の ID は抽出器の決定に従う） |
| `infra:aurora/db` | `aws_secretsmanager_secret.db` | Secrets Manager |
| `infra:static_site/site` | `aws_s3_bucket.site` | |
| `infra:static_site/this` | `aws_cloudfront_distribution.this` | CloudFront。`aws_cloudfront_function.index`（viewer-request）は default behavior に関連づく（`infra:static_site/index` としてノード化してもよい） |
| `infra:cognito/this` | `aws_cognito_user_pool.this` | client / domain は配管扱い |
| `infra:scheduler_notify/daily` | `aws_scheduler_schedule.daily` | |
| 出さない（配管） | VPC / subnet / route table / SG / IAM / log group / OAC / cache policy / DB subnet group | `infra:network/*` は出ない |

### コード・契約

| 種類 | 期待する ID | 元 |
|---|---|---|
| Go 入口 | `handler:cmd/api`, `handler:cmd/gmail-webhook`, `handler:cmd/notify` | `cmd/*/main.go` |
| Go ルート | `handler:internal/api`（`meta.apiRoutes` に 7 本） | `internal/api/server.go` の `HandleFunc("GET /today"` など |
| Go（classify） | `type:internal/domain`, `schema:internal/store` | config の `classify`（既定の名前規則とも一致） |
| Go lib | `lib:internal/parser`, `lib:internal/inbound`, `lib:internal/auth`, `lib:internal/push` | 名前規則に当たらないもの |
| OpenAPI endpoint | `endpoint:GET /today`, `endpoint:GET /days`, `endpoint:GET /entries`, `endpoint:GET /transactions`, `endpoint:POST /transactions`, `endpoint:DELETE /transactions/{id}`, `endpoint:POST /push/subscriptions`, `endpoint:DELETE /push/subscriptions` | `openapi/today.yaml` |
| OpenAPI type | `type:Today`, `type:Entry`, `type:Transaction`, `type:PushSubscription` | `components.schemas` |
| SQL | `schema:transactions`, `schema:inboxes`, `schema:push_subscriptions` | `migrations/*.up.sql`（`.down.sql` は読まない） |
| route / layout | `route:/`, `route:/calendar`, `route:/push`, `layout:/` | `web/src/app`（static export なので cache バッジは `static export`） |
| comp | `comp:TotalCard`, `comp:EntryList`, `comp:CalendarGrid`, `comp:TodayIsland`, `comp:CalendarIsland`, `comp:PushToggle` | `web/src/components/*.tsx` |
| lib | `lib:fetcher`（`src/lib/fetcher/index.ts`）, `lib:consts`（`src/lib/fetcher/consts.ts`） | ID はファイル名 |
| feature lib | `lib:request`, `lib:transformer` が spend / days で衝突する。衝突時は `lib:web/src/feature/spend/request` のように `<repo>/<path>` 修飾（docs/12 §3.2） | `src/feature/*/request.ts`, `transformer.ts` |
| feature type | `type:Entry`（OpenAPI の `type:Entry` と衝突しうる）, `type:Today`, `type:TodayView`, `type:DailyTotals`, `type:CalendarCell` | `src/feature/*/types.ts`。同名は抽出器で統合 or 修飾を決める |
| actor | `actor:user` | overrides |

`type:Today` / `type:Entry` は OpenAPI（platform）と web の `types.ts` の両方に現れる。ID 衝突の扱いは 7-1（core）の merge 規則に従うこと（このフィクスチャが衝突ケースのテストを兼ねる）。

## 期待するエッジ

### 自動（静的解析で見つかるべき）

| from → to | kind | 見つける抽出器 |
|---|---|---|
| `infra:lambda_api/api` → `infra:aurora/db` | flow | terraform: `var.db_secret_arn` → `module.aurora.secret_arn` → `aws_secretsmanager_secret.db.arn` |
| `infra:lambda_api/api` → `infra:app` | flow | terraform: `var.image_uri` → `"${aws_ecr_repository.app.repository_url}:api"`（root の式まで解決） |
| `infra:lambda_api/{gmail_webhook,notify}` → `infra:app`, `infra:aurora/db` | flow | 同上 |
| `infra:lambda_api/api` → `infra:cognito/this` | flow | terraform: `var.cognito_issuer` → `module.cognito.issuer` → `aws_cognito_user_pool.this.endpoint` |
| `infra:aurora/this` ↔ instance | flow | `cluster_identifier = aws_rds_cluster.this.id`（同一ノードに畳むなら不要） |
| `infra:static_site/this` → `infra:static_site/site` | http | CloudFront origin → `bucket_regional_domain_name` |
| `infra:scheduler_notify/daily` → `infra:lambda_api/notify` | flow | terraform: `var.lambda_arn` → `module.lambda_api.notify_arn` |
| `handler:cmd/api` → `handler:internal/api`, `lib:internal/auth`, `schema:internal/store` | uses | go: module 内 import |
| `handler:cmd/gmail-webhook` → `lib:internal/inbound`, `lib:internal/parser`, `schema:internal/store` | uses | go |
| `handler:internal/api` → `schema:internal/store`, `type:internal/domain`, `lib:internal/push` | uses | go |
| `lib:internal/inbound` → `lib:internal/parser`, `schema:internal/store`; `lib:internal/parser` → `type:internal/domain`; `schema:internal/store` → `type:internal/domain`, `lib:internal/push` | uses | go |
| `schema:internal/store` → `schema:transactions`, `schema:push_subscriptions` | uses | sql: Go 内の `FROM` / `INSERT INTO` |
| `infra:aurora/this` → `schema:transactions`, `schema:inboxes`, `schema:push_subscriptions` | schema | sql（`sql.db`） |
| `endpoint:*` → `type:Today` など | uses | openapi の `$ref`（`GET /today` → `Today` → `Entry`、`POST /transactions` → `Transaction`、`POST/DELETE /push/subscriptions` → `PushSubscription`） |
| `route:/` → `comp:TodayIsland` → `comp:TotalCard`, `comp:EntryList` ほか | uses | nextjs-app / ts-imports |
| `lib:request`（spend）→ `lib:fetcher` → `lib:consts` | uses | ts-imports（`@/` エイリアス解決） |
| `lib:request`（spend / days）→ `endpoint:GET /today`, `GET /entries`, `POST /transactions`, `GET /days` | http | api-link: ラッパー `fetcher`（`callers` と自動検出）。`/days?month=${month}` はクエリを落として照合 |
| `comp:PushToggle` → `endpoint:POST /push/subscriptions` | http | api-link: `fetch(`${API_DOMAIN}/push/subscriptions`, { method: 'POST' })` の直接呼び出し |
| `endpoint:*` → `handler:internal/api` | http | api-link: Go の `meta.apiRoutes` と照合 |
| `infra:lambda_api/api` → `endpoint:*` | deploy | `api.targets` |
| `infra:static_site/site` → `route:/`, `route:/calendar`, `route:/push`, `layout:/` | deploy | `deploy.*.app: next` |
| `infra:lambda_api/api` → `handler:cmd/api`（gmail_webhook / notify も同様） | deploy | `deploy.*.go` |

### overrides で補うもの

| from → to | kind | 理由 |
|---|---|---|
| `actor:user` → `infra:static_site/this` | flow | 利用者はコードに現れない |
| `actor:user` → `infra:lambda_api/api` | http | ブラウザが Function URL を直接叩く（URL は環境変数。CloudFront を経由しない） |
| `actor:user` → `infra:lambda_api/gmail_webhook` | http | Gmail の push は外部から Function URL へ |
| `handler:cmd/notify` → `schema:push_subscriptions` | uses | notify は DB から購読を引く想定だが、`cmd/notify` 自体は store を import していない |

### 推定（`推定` と warn が出るべきもの。docs/12 D18）

この config は `deploy` と `api.targets` を**明示**しているので、推定は発生しない。
次のキーを消した config で推定が働き、warn に「推定」と出ることを確認するテストを想定する。

| 消すキー | 推定される結線 | 根拠 |
|---|---|---|
| `deploy."infra:static_site/site"` | `infra:static_site/site` → Next アプリ | CloudFront の origin の S3 が 1 つ（§3.7） |
| `deploy."infra:lambda_api/*".go` | 関数名の末尾（`-api` / `-gmail-webhook` / `-notify`）→ `cmd/<name>` | §3.4。`api` は `cmd/api` に一致 |
| `api.targets` | `infra:lambda_api/api` | Function URL を持つ Lambda は 2 つ（api / gmail_webhook）なので**自動では 1 つに決まらない** → warn のみで結線しない、が期待。`targets` が必要な理由を示すケース |
| `sql.db` | `infra:aurora/this` | RDS cluster が 1 つ |

## 取りこぼしを狙っているもの

- `comp:PushToggle` はラッパーを使わず `fetch` を直接呼ぶ（`api.clients` に `src/components/*.tsx` を入れてあるので拾える）。拾えないと endpoint への結線が欠ける。
- `GET /transactions`（`listTransactions`）は OpenAPI にあるが Go のルートには無く、web からも呼ばれない（契約だけが先行）。`endpoint:GET /transactions` はどこにも結線されない孤立ノードになる想定。
- `lib:internal/push` は `handler:internal/api` と `schema:internal/store` が import するが、`cmd/notify` は import しない（上記の overrides）。
