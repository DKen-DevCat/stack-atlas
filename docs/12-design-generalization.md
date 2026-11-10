# 12. 設計: どんな構成にもはめる（Phase 6・7）

作成: 2026-11-07。実リポジトリ（`damage-web` ＋ `damage-platform`）を確認した結果、Phase 0〜5 の前提
（CDKtf ＋ Next.js on Lambda ＋ TS の API、単一リポジトリ）が**外れている**ことが分かった。
この文書は、その実リポジトリに当てつつ、**他の構成でも使える**ようにするための設計。

## 1. 結論

- 「前提に合わないと何も出ない」状態をやめ、**段階的に効く仕組み**にする。
  1. パーサがあるものは自動（Terraform HCL / CDKtf / CloudFormation、Next、TS、Go、OpenAPI、SQL）
  2. パーサが無い言語・独自構成は **設定だけでノードにできる**（`files` / `classify`）
  3. 静的解析で取れない結線は **overrides**（従来どおり）
- **複数リポジトリ**を 1 つの graph.json にまとめられるようにする（`repos`）。
- 「何が載っているか（deploy）」と「クライアントがどこを叩くか（api.targets）」は、規約の推定に頼らず**設定で明示できる**ようにし、推定は補助にする。
- ビューアは graph.json の `kinds` で未知の kind の見た目を受け取る。ビューアにスタックの知識は足さない。

## 2. 全体像

### 2.1 実リポジトリの構成（Q2 の答え）

```
damage-web（Next.js 16 App Router, output: "export"）─ S3 + CloudFront（CloudFront Function で index.html 補完）
  └ src/lib/fetcher → fetch(`${NEXT_PUBLIC_API_DOMAIN}${url}`) ─── ブラウザから直接 ───┐
damage-platform（Go + Terraform HCL、infra/envs/{dev,prod} が root、infra/modules/* を呼ぶ）    │
  ├ Lambda × 5（api, gmail-webhook, gmail-auth, notify, migrate。コンテナイメージ、ECR）◀─ Function URL ┘
  ├ internal/api/server.go: http.NewServeMux に "GET /today" 形式でルート登録
  ├ Aurora（RDS cluster）、Cognito、Secrets Manager、EventBridge Scheduler、VPC/NAT
  ├ migrations/*.up.sql（テーブル定義）
  └ openapi/today.yaml（front↔platform の契約。両リポジトリに写しがある）
```

前提との差分: Terraform は HCL（cdktf 出力ではない）／バックエンドは Go（ts-imports が効かない）／Next は静的エクスポートで S3 に載る（Lambda ではない）／API は API Gateway ではなく Function URL／2 リポジトリ／契約は OpenAPI。

### 2.2 一般化後の流れ

```
stack-atlas.config.yaml（repos: web, platform）
   │
   ├ repo ごとに抽出器を走らせる（section.repo で対象を絞れる）
   │   infra:  terraform(HCL) / cdktf / cloudformation ──▶ packages/tf-graph（共通: リソース→ノード、参照→エッジ、cache）
   │   画面:   nextjs-app（App Router / Pages Router / static export）
   │   コード: ts-imports / go / files（glob だけ）
   │   契約:   openapi（endpoint: ノードと type:）、sql（schema: ノード）
   │   結線:   api-link（clients glob ＋ ラッパー検出 ＋ OpenAPI/Go ルート/API Gateway 照合 ＋ targets）
   │   補正:   classify（glob → kind/layer）、deploy（何に何が載るか）、overrides
   ▼
graph.json（file は `<repo>/<path>`、kinds で表示定義を同梱）
```

## 3. 構造（設計）

### 3.1 設定ファイルの追加キー（契約。`packages/core/src/types.ts` が正）

```yaml
repos:                       # 省略時は config のディレクトリ 1 つ（名前はディレクトリ名）
  web: ../damage-web
  platform: ../damage-platform

terraform:                   # 素の Terraform（HCL）。@cdktf/hcl2json で JSON 化して tf-graph に渡す
  repo: platform
  root: infra/envs/dev       # module 呼び出しを持つ root モジュール。resources は infra:<module>/<logicalId>
  sourceDir: infra           # file/line の探索範囲（既定 root の親）
cdktf: { repo: ..., out: ..., sourceDir: ..., stack: ... }      # 従来どおり
cloudformation:
  repo: ...
  templates: ["cdk.out/*.template.json", "template.yaml"]        # AWS CDK / SAM / 素の CFn

infra:                       # tf-graph 共通（どの IaC でも）
  include: ["aws_scheduler_schedule", "google_*"]   # 既定の許可リストに足す（glob）
  exclude: ["aws_cloudwatch_log_group"]
  all: false                 # true で配管（IAM/SG/subnet/log）以外の全リソース

next: { repo: web, appDir: src/app, tsconfig: tsconfig.json }
ts:   { repo: web, tsconfig: [tsconfig.json] }
go:
  repo: platform
  module: github.com/DKen-DevCat/damage-platform   # 省略時 go.mod
  entries: ["cmd/*"]         # Lambda / バイナリの入口パッケージ（kind handler）
openapi:
  files: [{ repo: platform, path: openapi/today.yaml }]   # 文字列ならどの repo でも探す
sql:
  migrations: ["migrations/*.up.sql"]
  db: "infra:aurora/this"    # テーブルを持つ DB ノード。省略時: RDS/DynamoDB が 1 つなら自動

api:
  client: src/lib/api.ts     # 従来（1 ファイル）
  clients: ["src/lib/fetcher/**/*.ts", "src/feature/**/request.ts", "src/components/*-island.tsx"]
  callers: ["fetcher", "request"]   # 第 1 引数がパスのラッパー関数名。省略時は fetch(`${X}${arg}`) をする関数を自動検出
  targets: ["infra:lambda_api/api"] # クライアントの呼び先。省略時: API Gateway があればそれ、無ければ Function URL を持つ Lambda が 1 つなら自動

deploy:                      # 「何に何が載るか」。キーは infra ノード ID
  "infra:static_site/site":      { app: next }          # S3 でも Lambda でも ECS でもよい
  "infra:lambda_api/api":        { go: cmd/api }        # Go の入口パッケージ
  "infra:lambda_api/gmail_webhook": { go: cmd/gmail-webhook }
  "infra:api":                   { handlers: "apps/api/src/handlers/**/*.ts" }   # 従来

classify:                    # ts-imports / go の分類を glob で上書き（上から順、最初に合ったもの）
  - { glob: "src/components/**", kind: component }
  - { glob: "src/feature/**/types.ts", kind: type }
  - { glob: "internal/domain/**", kind: type }
  - { glob: "internal/store/**", kind: schema }

files:                       # パーサの無いものを glob でノードにする
  - { glob: "reference/*.py", kind: lib, name: "{basename}", layer: types }

kinds:                       # 追加 kind の表示定義（graph.json にそのまま出る）
  endpoint: { name: "API エンドポイント", color: "#38bdf8", layer: types }
```

`screenshots` にも `repo` を足す。既存キーはすべて互換。

### 3.2 複数リポジトリ

- `RepoContext` に `repoName` と `repos` を足す。パイプラインは **repo ごとに** 抽出器の `detect` / `extract` を回す。
- 設定の各セクションの `repo` は「そのセクションが指す repo」。core の `sectionFor(ctx, 'go')` が、ctx の repo に合うときだけセクションを返す（抽出器はこれを使う）。
- repo が 2 つ以上なら `file` を `<repoName>/<path>` にする（1 つなら従来どおり）。`project.sources` に repo 名を並べる。
- ノード ID は repo をまたいで共有（`infra:` と `route:` と `handler:` は衝突しない。`lib:` が衝突したら `lib:<repo>/<path>`）。

### 3.3 インフラ: `packages/tf-graph` と 3 つの抽出器

- cdktf 抽出器の中身（リソース → ノード、`${...}` 参照 → エッジ、Function URL のホップ、CloudFront の cache）を `packages/tf-graph` に出し、**Terraform JSON を入力にする純関数**にする。
- `extractors/terraform`: `root` の `*.tf` を `@cdktf/hcl2json` で JSON 化。`module "x" { source = "../../modules/y" }` を再帰的に読み、モジュール内のリソースを `infra:<x>/<logicalId>` にする。参照の解決:
  - `aws_x.y.attr`（同じモジュール内）→ そのまま
  - `var.foo` → root の module 呼び出しの引数の式へ置換 → そこに `module.z.out` があれば z の `outputs.tf` の式へ → リソース参照に到達すればエッジ
  - `local.*` は `locals` の式へ置換（1 段）。解決できないものは無視（debug ログ）
- `extractors/cloudformation`: `Resources.<LogicalId>.Type` を型に、`Ref` / `Fn::GetAtt` / `Fn::Sub` の `${X}` / `Fn::Join` を参照に変換して tf-graph に渡す（`AWS::Lambda::Function` → `aws_lambda_function` の対応表）。
- 許可リストは tf-graph に 1 つ。既定を広げる: Lambda、Function URL（ホップ）、CloudFront distribution / function、API Gateway v1・v2、DynamoDB、S3、Cognito、SQS、SNS、RDS cluster / instance、ElastiCache、ECR、EventBridge rule / Scheduler、Step Functions、ECS service、ALB/NLB、AppSync、SES receipt rule、Secrets Manager secret、`google_cloudfunctions*` / `google_pubsub_*` / `google_cloud_run_*`。配管（IAM、SG、subnet、route table、log group、policy、permission、stage、integration、route、OAC）は `all: true` でも出さない。
- 参照の正規表現を `aws_` 限定から `<provider>_<type>.<name>.<attr>` に広げる。

### 3.4 Go 抽出器（`extractors/go`）

- toolchain 不要。`go.mod` の module path を読み、`*.go`（`_test.go` 除く）の `package` と `import` ブロックを正規表現で読む。
- 1 パッケージ = 1 ノード。ID は `<kind>:<module 相対パス>`（例 `handler:cmd/api`、`lib:internal/store`）、`name` は相対パス。
- kind: `entries` glob に合う（既定 `cmd/*` と `package main`）→ `handler`。`HandleFunc("GET /x"` / `Handle("POST /"` / chi・gin・echo の `r.Get("/x"`・`r.GET(` を含むパッケージ → `handler` ＋ `meta.apiRoutes`。`classify` → 指定どおり。名前が `domain|model|types|entity` → `type`、`store|db|repo|repository` → `schema`。それ以外 → `lib`。
- `uses`: module 内 import。`file` はパッケージの先頭ファイル、`code` はそのファイルの先頭 25 行。
- `deploy`: `config.deploy[<lambda>].go` が正。無ければ Lambda の `function_name` の末尾（`-api`）か `image_uri` の名前が `cmd/<name>` と一致したら推定（warn で「推定」と出す）。

### 3.5 契約: OpenAPI と SQL

- `extractors/openapi`: `paths.<path>.<method>` → `endpoint:<METHOD> <path>`（kind `endpoint`、`name` は `GET /today`、`meta.api`、`file`/`line`）。`components.schemas.X` → `type:X`（`symbolKind: 'openapi'`）。endpoint → `uses` → request/response で参照する schema。`kinds.endpoint` を graph に同梱。
- `extractors/sql`: `CREATE TABLE [IF NOT EXISTS] <name>` → `schema:<table>`（`code` は CREATE 文）。`sql.db`（または自動）の DB ノード → `schema` エッジ。Go / TS のファイルに `FROM <table>` / `INSERT INTO <table>` / `UPDATE <table>` があればそのノード → `uses` → `schema:<table>`。

### 3.6 api-link の一般化

- クライアント: `api.clients` の glob（`client` も可）。各ファイルで、`fetch(` の第 1 引数、`api.callers` の関数呼び出しの第 1 引数、そして**自動検出したラッパー**（本体に `fetch(\`${X}${引数}\`)` か `${X}` + 引数 の連結を持つ関数）の呼び出しの第 1 引数をパスにする。パスの前の `${API_DOMAIN}` などは落とす。
- 呼び出し元のノード: そのファイルが属するノード（上流の `file` 一致。comp / hook / lib / route）。
- 照合先（上から順）: API Gateway の route_key（従来）→ `endpoint:` ノード（OpenAPI）→ `meta.apiRoutes` を持つノード（Go / Next route handlers）→ `handler:` の `@route` コメント。
- エッジ: 呼び出し元 → endpoint（`http`、label `GET /today`）、endpoint → ルートを持つ handler（`http`）。`api.targets`（または自動の Function URL Lambda）→ endpoint に `deploy`（「この Lambda がこのエンドポイントを提供」）。
- 合わない呼び出しは従来どおり warn（overrides で補う）。

### 3.7 Next の一般化

- `output: 'export'` → 全 route の cache を `{ tone: ok, badge: 'static export' }`、`deploy.*.app: next` の先が S3 でも Lambda でもよい。自動推定: Lambda に `deployApp` が無く、CloudFront の origin になっている S3 が 1 つなら、そこから deploy（warn で「推定」）。
- Pages Router（`pages/**`）を同じ `route:` 規約で読む。`app/**/route.ts` は `handler:` ＋ `meta.apiRoutes`（Next の API ルート）。

### 3.8 ビューア

- graph.json の `kinds`（schema に追加、任意）を kind レジストリにマージ（名前・色・サイズ・既定の層）。未知 kind のままでも描ける。
- ほかは変更なし。

### 3.9 フィクスチャ

- `examples/fixture-poly/`: 実リポジトリと同じ形の**合成** 2 リポジトリ（`web/`: Next 静的エクスポート、`platform/`: Go ＋ HCL モジュール ＋ OpenAPI ＋ SQL）。CI の end-to-end はこれで回す。
- 実リポジトリ（非公開）の graph.json やスクショは**この公開リポジトリにコミットしない**。設定は実リポジトリ側（`damage-web/stack-atlas.config.yaml` に `repos.platform: ../damage-platform`）に置く案。

## 4. 決定事項

| # | 決定 | 理由 |
|---|---|---|
| D14 | 複数リポジトリは `repos` で宣言し、`file` を `<repo>/` で修飾する | 実リポジトリが 2 つ。ビューアは変更不要 |
| D15 | HCL は `@cdktf/hcl2json` で JSON 化し、cdktf と同じ解析器（tf-graph）に通す | terraform CLI 不要、オフラインで動く |
| D16 | Go は toolchain なしで正規表現解析。パッケージ単位のノード | 入口 → パッケージ → DB の流れが見えれば十分。シンボル単位は後回し |
| D17 | OpenAPI の操作を `endpoint:` ノードにし、クライアントとサーバーの結線の「合流点」にする | 契約が正本。Go と TS を直接突き合わせるより堅い |
| D18 | 推定（deploy / targets）は設定で上書きでき、推定したときは必ず warn を出す | 間違った線を黙って引かない |
| D19 | `files` / `classify` / `kinds` で、パーサの無い構成でも設定だけで地図が作れる | 「どんな構成でも」の最低保証 |

## 5. タスク

| # | 担当 | 内容 |
|---|---|---|
| 7-1 | core | `repos` / `sectionFor` / `file` 修飾、`classify` / `files` / `kinds` の適用、`deploy.*.go`・`app` の一般化、schema に `kinds`、viewer の kind レジストリ |
| 7-2 | infra | `packages/tf-graph`、`extractors/terraform`（HCL、モジュール、参照解決）、`extractors/cloudformation`、許可リストの拡大と設定 |
| 7-3 | backend / 結線 | `extractors/go`、`extractors/openapi`、`extractors/sql`、api-link の一般化（clients / callers / targets / endpoint 照合）、nextjs-app の static export と Pages Router |
| 7-4 | fixture | `examples/fixture-poly/`（web ＋ platform）、README、期待する ID 表 |
| 7-5 | 統合 | 実リポジトリで `build` → overrides を書く → ビューアで確認（結果は非公開）。fixture-poly の e2e を CI に。docs 更新 |

## 6. 実装結果

7-1〜7-5 を実装した（ビューアの大規模 graph 対応を除く。§6.4）。テストは全体で 379 件（schema 18 / core 86 / viewer 88 / cli 27 / tf-graph 12 / files 6 / cdktf 9 / terraform 9 / cloudformation 10 / nextjs-app 14 / ts-imports 10 / go 13 / openapi 8 / sql 9 / api-link 27 / cache 15 / screenshots 18）。viewer の e2e は 18 件。
フィクスチャ `examples/fixture-poly/` は 56 ノード / 95 エッジ / 2 フロー / エラー 0 / 警告 0。実リポジトリ 2 つ（非公開。中身はここに書かない）では 149 ノード / 330 エッジ / エラー 0 / 警告 0。使い方は `docs/13-apply-to-your-repo.md`。

### 6.1 設計どおりにできたこと

- `repos` と `sectionFor`、複数 repo のとき `file` を `<repo>/<path>` にする（D14）。抽出器は repo 相対パスを返せばよく、パイプラインが修飾する。`repoFile()` / `fileInRepo()` / `splitRepoFile()` が補助
- `classify`（`classifyKind()` を抽出器が、`applyClassify()` をパイプラインが使う）、`files` 抽出器、`kinds`（schema と viewer の kind レジストリ）（D19）
- `deploy.*.{app,handlers,go,nodes}`。`app: next` は S3 でも Lambda でもよい
- `packages/tf-graph` ＋ terraform（`@cdktf/hcl2json`、module・`var` / `local` / `output` の参照解決、root の自動検出、tfvars）・cloudformation（CDK / SAM / CFn）（D15）
- go（toolchain なし）、openapi（`endpoint:` と schema の `type:`）、sql（`CREATE TABLE` → `schema:`）（D16・D17）
- api-link の一般化（`api.clients` / `callers` / `targets`、ラッパー自動検出、照合順 API Gateway → endpoint → `meta.apiRoutes` → `@route`）。nextjs-app の `output: 'export'`・Pages Router・`route.ts`。ts-imports の `classify` と複数 repo の lib 衝突
- 推定は必ず warn（`推定: …（… で明示できます）`）を出し、設定で上書きできる（D18）

### 6.2 設計からのずれ

| 論点 | 設計 | 実装 |
|---|---|---|
| Terraform の ID 衝突 | 規定なし | 同じモジュールで型違いの同名リソースが両方ノードになったら、衝突した全部の末尾を `<type>.<name>` にする（例 `infra:static_site/aws_s3_bucket.site`）。tf-graph の `idOf` 後の共通規則 |
| `meta.cdktf` | `meta.infra` に寄せる | `meta.infra` が正、`meta.cdktf` は同じ値の別名として残した（既存の rules / api-link / ビューアとの互換） |
| パイプラインのループ | repo ごとに抽出器を回す | **抽出器が外側、repo が内側**（抽出器 × repo の宣言順）。後続の抽出器が全 repo の先行の結果を `upstream` で読めるようにするため。api-link が他 repo の endpoint / Go ルートを引くのに必要 |
| `deploy` の検査 | 規定なし | キーの infra ノードが無い・`nodes` の ID が無いのは**エラー**（人が書いたものなので厳密に。overrides と同じ）、`go` / `handlers` が 1 つも合わなければ警告 |
| `classify` | ID を kind の接頭辞に合わせる | パイプラインの `applyClassify()` は kind / layer だけ書き換え **ID は変えない**（メモ・overrides・flows の結合キー）。ID の接頭辞まで変えたいときは抽出器が `classifyKind()` で作る時点に決める（ts-imports / go） |
| openapi の重複 | 規定なし | 同じ契約の写しが複数 repo にあれば、上流に openapi 由来の同じ ID があるものは出さない（最初の repo の写しが残る。info ログ） |
| ラッパー検出 | 本体に `fetch(\`${X}${引数}\`)` を持つ関数 | 推移的にたどる（fetcher → request → fetch）、client ファイルどうしで名前共有、`fetch(getFullUrl(endpoint))` や `BASE + path` も可。パスの前にリテラル（`${BASE}/api${path}`）があるものは検出しない |
| api-link の `targets` | 無ければ API Gateway、Function URL の Lambda が 1 つなら自動 | API Gateway → Function URL の Lambda。Function URL の Lambda が複数なら、`deploy` / `uses` を 4 段たどって endpoint を実装するハンドラに着くものだけに絞り、1 つに決まれば推定（warn）、決まらなければ info で `api.targets` を促す。fixture-poly は Function URL が 2 つ（api / gmail_webhook）だが gmail_webhook は Go のルートに着かないので `api` に決まる（`examples/fixture-poly/README.md` の「自動では 1 つに決まらない」は実装前の想定で、現在は決まる） |
| Go の Lambda ↔ `cmd/*` | `function_name` の末尾か `image_uri` | `image_config.command` を先に見て、次に `function_name` / `image_uri` / `handler` / ID / name を `-<name>` 末尾・`/<name>` 含有で照合（`_` と `-` は同一視） |
| Next の S3 deploy 推定 | CloudFront の origin の S3 が 1 つ | 同じ。CloudFront（`aws_cloudfront_distribution`）からエッジが出ている S3 が 1 つのときだけ。warn `推定` |
| terraform の `sourceDir` | file / line の探索範囲 | 互換のために残したが実質不要（読んだモジュールの .tf を直接 grep する） |
| terraform の module の外 | 規定なし | レジストリ / git の module は warn を出して読まない。深さは 5 まで |
| CloudFormation の対応表 | `TYPE_MAP` | 無い型は `aws_<service>_<resource>` に機械変換（配管の判定がそのまま効く）。SAM の `Events`（Api / HttpApi / SQS / SNS ほか）と `FunctionUrlConfig` も変換 |
| cache | 規定なし | openapi は `Cache-Control` を宣言する操作だけ cache（`info`）。CloudFront Function は `function_association` を behavior の `rules` に足す |

### 6.3 実リポジトリでの結果（公開してよい数だけ）

構成は `damage-web`（Next.js 16 App Router、静的エクスポート → S3 ＋ CloudFront）＋ `damage-platform`（Go の Lambda 5 つ、素の Terraform HCL、Aurora、Cognito、EventBridge Scheduler、OpenAPI、SQL マイグレーション）。設定は**この公開リポジトリの外**（兄弟ディレクトリで `repos` が両 repo を指す）に置いた。

| 抽出器 | ノード / エッジ | 備考 |
|---|---|---|
| terraform | 16 / 22 | module インスタンス 11、リソース 70、未解決の参照 0 |
| nextjs-app | 6 / 6 | |
| ts-imports | 78 / 188 | |
| go | 19 / 50 | |
| openapi | 27 / 21 | endpoint 10 |
| sql | 7 / 14 | |
| api-link | 7 / 30 | 10 endpoint すべてに client の呼び出しと Go ハンドラが結べた |
| 合計 | 149 / 330 | エラー 0、警告 0 |

Lambda 5 つ → Go 入口の推定、DB の推定、Function URL の呼び先の推定は、すべて当たっていた（各 1 行の `推定` が出る。`deploy` / `sql.db` / `api.targets` で黙らせられる）。
ビューアでは、endpoint を指すと「route → コンポーネント → fetcher → endpoint → Go ハンドラ → テーブル」が点灯した。

### 6.4 残っていること

- ビューアの大規模 graph 対応: 150 ノード前後で層内のレイアウトが密になり読みにくい。レイアウトの広がり・ラベルの LOD・検索ボックスを**進行中**（別タスク）
- 実アプリのスクショ（起動したサイトと `data-component` が要る）、`flows.yaml`、配信先の選定
- 設定を `damage-web` に置くか、非公開の別ディレクトリに置くか（ユーザーの判断）
