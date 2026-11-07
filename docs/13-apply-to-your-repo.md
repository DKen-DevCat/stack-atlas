# 13. 自分のリポジトリに適用する

実リポジトリに Stack Atlas を当てるための実践ガイド。設計の背景は `docs/12-design-generalization.md`、設定の契約は `packages/core/src/types.ts`、各抽出器の細部は `extractors/*/README.md`。
ここに書いたコマンドはすべて、このリポジトリのフィクスチャで実行して確かめたもの。

## 1. 結論

**3 つのコマンドで最初の地図ができる。** 設定が 1 枚もなくても、`detect()` が構成を見つけて動く範囲は自動で載る。

```sh
pnpm install && pnpm build                                     # 1. このツールをビルド（初回だけ）
pnpm atlas build <repo> -o out --with-viewer --no-screenshots -v   # 2. 解析。-v で抽出器ごとの件数と「推定」を見る
pnpm atlas serve out                                           # 3. http://127.0.0.1:4173/ を開く
```

そのあとの作業は、必ずこの順番になる。

1. `-v` の出力と `推定` の警告を読み、当たっていれば `stack-atlas.config.yaml` の `deploy` / `sql.db` / `api.targets` に**書いて固定**する（推定は補助。D18）
2. 線が足りないところを `stack-atlas.overrides.yaml` で補う
3. `init-flows` で `flows.yaml` の雛形を作り、主要なフローを直す
4. 必要なら `data-component` とスクショ、メモ、CI

複数リポジトリ（フロントとバックが別 repo）なら、**どの repo にも属さない場所**に設定を置き、`repos:` で両方を指す（§3.2）。

## 2. 全体像

### 2.1 何が自動で、何に設定が要り、何を overrides で補うか

| スタック | 自動（設定なし） | 設定が要る | overrides で補うもの |
|---|---|---|---|
| CDKtf | `cdktf.out/stacks/*/cdk.tf.json` があれば `cdktf` 抽出器が動く | `cdktf.out`（既定 `infra/cdktf.out`）、`sourceDir`、`stack` | 外部（利用者・外部サービス）からの入口 |
| Terraform（HCL） | `infra/` → `terraform/` → `iac/` → 直下の順に root を自動検出。module・`var` / `local` / `output` の参照まで解決 | root が複数あって選びたいとき `terraform.root` | 同上。レジストリ / git の module の中身（読まない） |
| AWS CDK / SAM / CloudFormation | `cdk.out/*.template.json`、無ければ直下の `template.yaml\|yml\|json` | `cloudformation.templates` | 同上 |
| Next.js App Router | `apps/*/app` → `src/app` → `app` を探して route / layout / `route.ts` | `next.appDir` | — |
| Next.js Pages Router | `src/pages` → `pages` | `next.pagesDir` | — |
| Next 静的エクスポート（`output: 'export'`） | cache バッジ `static export`。CloudFront の origin の S3 が 1 つなら deploy を推定 | `deploy."<S3 ノード>": { app: next }` で固定 | — |
| TypeScript の import | tsconfig（既定 `tsconfig.json`）から comp / hook / lib / type と `uses` | `ts.tsconfig`、分類を変えたいとき `classify` | 動的 import・`require` |
| Go | `go.mod` があれば全パッケージ。`cmd/*` は入口、import は `uses`、`HandleFunc("GET /x"` や chi / echo / gin / fiber のルートは `meta.apiRoutes` | `go.entries`、`classify`、Lambda ↔ `cmd/*` が推定とずれるとき `deploy.*.go` | `r.Route("/p", …)` の入れ子ルート |
| OpenAPI | `openapi.{yaml,yml,json}`、`openapi/*.yaml` などを探す | 場所が違うとき `openapi.files` | 外部ファイルへの `$ref` |
| SQL | `migrations/**/*.sql`、`db/migrations/**/*.sql` の `CREATE TABLE`。DB ノードが 1 つなら自動 | DB が複数のとき `sql.db`、場所が違うとき `sql.migrations` | `ORM` 経由で SQL 文字列が見えないテーブル参照 |
| フロント → API の結線 | `fetch` と、`fetch(\`${X}${arg}\`)` をするラッパーを自動検出。OpenAPI の `endpoint:` / Go のルートと照合 | `api.clients`（client の glob）。呼び先が決まらないとき `api.targets` | 照合できなかった呼び出し |
| キャッシュ | CloudFront / API Gateway / ISR / SWR / React Query / `fetch` の cache | — | — |
| 上のどれでもない言語・構成 | なし | `files`（glob → ノード）、`classify`、`kinds` | 結線はすべて overrides |

### 2.2 自動で出るものと、地図の読み方

```
repos（web / platform …） ─ 抽出器を repo ごとに回す（順番は §4.4）
   ├ infra:     terraform / cdktf / cloudformation → tf-graph（共通。リソース → ノード、参照 → エッジ）
   ├ routes:    nextjs-app
   ├ code:      ts-imports / go / files
   ├ 契約:      openapi（endpoint:）、sql（schema:）
   ├ 結線:      api-link（client ⇔ endpoint ⇔ Go ルート ⇔ API Gateway）
   └ 補正:      classify → deploy → overrides → 層 → flows.yaml
        ▼
graph.json（4 層。file は複数 repo なら `<repo>/<path>`）
```

実リポジトリ 2 つ（Go ＋ Terraform HCL ＋ Next 静的エクスポート）で、設定ファイル 1 枚で 149 ノード / 330 エッジ / エラー 0 / 警告 0 になった（詳細は `HANDOFF.md` §0）。
このとき、ホバーで「route → コンポーネント → fetcher → endpoint → Go ハンドラ → テーブル」が 1 本につながる。

## 3. 手順

### 3.1 設定ファイルを置く場所

- 1 リポジトリ: そのリポジトリ直下の `stack-atlas.config.yaml`（`stack-atlas build <repo>` の `<repo>`）
- 複数リポジトリ: どの repo にも属さない作業ディレクトリ（または片方の repo）に置き、`repos:` で相対パス指定する。**overrides / flows / memos は設定のあるディレクトリから読む**（`.stack-atlas/memos.json` も同じ）
- パスはすべて「設定ファイルのあるディレクトリ」基準。`repos` の値もそこからの相対
- 業務リポジトリの設定・overrides・flows は、そのリポジトリ側か、非公開の別ディレクトリに置く。**このツールの公開リポジトリには入れない**

### 3.2 設定の完全な例 A: 2 リポジトリ（Go ＋ Terraform ＋ Next 静的エクスポート）

`examples/fixture-poly/stack-atlas.config.yaml` と同じ形（実行確認済み）。コメントは `stack-atlas.config.yaml` に書ける。

```yaml
project:
  name: expense-tracker
  description: Go + Terraform HCL + Next static export

repos:                          # 名前 → 設定ファイルからの相対パス。2 つ以上なら file は <名前>/<path> になる
  web: ./web
  platform: ./platform

terraform:                      # 素の Terraform（HCL）。terraform CLI は不要
  repo: platform                #   この repo でだけ動く（sectionFor）
  root: infra/envs/dev          #   module 呼び出しを持つ root。省略すると自動検出（dev* を優先）
  sourceDir: infra

next:
  repo: web
  appDir: src/app               #   省略時は apps/*/app → src/app → app
  tsconfig: tsconfig.json

ts:
  repo: web
  tsconfig: [tsconfig.json]

go:
  repo: platform
  entries: ["cmd/*"]            #   入口パッケージ（kind handler）。既定も cmd/*

openapi:
  files:
    - { repo: platform, path: openapi/today.yaml }   # 同じ契約の写しが複数 repo にあれば最初の 1 つだけ残る

sql:
  repo: platform
  migrations: ["migrations/*.up.sql"]   # *.down.sql は読まない
  db: "infra:aurora/this"               # 省略すると「DB ノードが 1 つなら推定」＋ 推定の警告

api:
  repo: web
  clients:                      # client ファイルの glob。ここに入れたファイルの fetch / ラッパー呼び出しがパスになる
    - "src/lib/fetcher/**/*.ts"
    - "src/feature/**/request.ts"
    - "src/components/*.tsx"
  callers: ["fetcher"]          #   ラッパー名（自動検出に足す）
  targets: ["infra:lambda_api/api"]   # client の呼び先。省略すると API Gateway → Function URL を持つ Lambda（endpoint の実装に着くもの）から推定

deploy:                         # 「何に何が載るか」。キーは infra ノード ID（実在しないとエラー）
  "infra:static_site/site": { app: next }          # S3 でも Lambda でも ECS でもよい
  "infra:lambda_api/api": { go: cmd/api }
  "infra:lambda_api/gmail_webhook": { go: cmd/gmail-webhook }
  "infra:lambda_api/notify": { go: cmd/notify }

classify:                       # glob → kind / layer。上から順、最初に合ったものだけ（ID は変えない）
  - { repo: platform, glob: "internal/domain/**", kind: type }
  - { repo: platform, glob: "internal/store/**", kind: schema }

kinds:                          # 追加 kind の見た目。graph.json の kinds にそのまま出る
  endpoint: { name: "API エンドポイント", color: "#38bdf8", layer: types }

screenshots:
  repo: web
  baseUrl: "http://localhost:4174"
  routes: {}
```

実行（フィクスチャ。ノード 56、エッジ 95、フロー 2、エラー 0、警告 0）:

```sh
pnpm atlas build examples/fixture-poly -o out --with-viewer --no-screenshots -v
```

設定ファイルを repo の外に置く場合は、`repos` を相対パスで外へ向ける（`atlas/` に設定、隣に `web/` と `platform/`）。

```yaml
# atlas/stack-atlas.config.yaml（repos だけ変える。ほかは同じ）
repos:
  web: ../web
  platform: ../platform
```

```sh
pnpm atlas build atlas -o atlas/out --with-viewer --no-screenshots   # 実行確認済み（同じ 56 / 95）
```

### 3.3 設定の完全な例 B: 1 リポジトリ（CDKtf ＋ Next on Lambda ＋ TS の API）

`examples/fixture-repo/stack-atlas.config.yaml` がそのまま動く例。`repos` を書かない 1 リポジトリでは、`file` は従来どおり repo 相対パスになる。

```yaml
project: { name: race-results }

cdktf: { out: infra/cdktf.out, sourceDir: infra }          # synth 済みの cdk.tf.json
next: { appDir: apps/web/app, tsconfig: apps/web/tsconfig.json }
ts:
  tsconfig: [apps/web/tsconfig.json, apps/api/tsconfig.json, packages/types/tsconfig.json]

deploy:                                                     # Lambda とアプリの対応（推定できないときの明示）
  infra:next: { app: next }                                 # この Lambda に Next の全ルート・レイアウトが載る
  infra:api: { handlers: "apps/api/src/handlers/**/*.ts" }  # この Lambda に載る TS ハンドラ

api: { client: apps/web/lib/apiClient.ts }                  # 従来の 1 ファイル指定

screenshots:
  baseUrl: http://localhost:4173
  routes: { "/races/[id]": ["42"] }
  storageState: .stack-atlas/auth.json                      # 認証が必要なとき
```

```sh
pnpm atlas build examples/fixture-repo -o out --with-viewer --no-screenshots   # ノード 33、エッジ 55、フロー 3
```

### 3.4 `-v` を読む

```sh
pnpm atlas build <repo> -o out --no-screenshots -v
```

見る順番:

1. **repo と root の検出**: `repo（2）:` の一覧、`terraform: root = infra/envs/dev` のような自動検出の結果。違えば `terraform.root` などで直す
2. **抽出器ごとの件数**: 末尾の表に `terraform (platform): ノード 11、エッジ 10` のように出る。`対象なし` は `detect()` が見つけられなかった（設定が要る）
3. **`推定` の警告**: 抽出器が規約から線を引いたとき、必ず 1 行出る（D18）。当たっていれば config に書いて固定する

fixture-poly から `deploy` / `sql.db` / `api.targets` を消すと、実際に次の 6 本が出る（結果のグラフは同じ 56 / 95）。

```
⚠ 推定: infra:static_site/site → Next（output: export。deploy で明示できます）
⚠ 推定: infra:lambda_api/api → cmd/api（deploy で明示できます）
⚠ 推定: infra:lambda_api/gmail_webhook → cmd/gmail-webhook（deploy で明示できます）
⚠ 推定: infra:lambda_api/notify → cmd/notify（deploy で明示できます）
⚠ 推定: infra:aurora/this → テーブル 3 件（sql.db で明示できます）
⚠ 推定: client の呼び先 → infra:lambda_api/api（Function URL。api.targets で明示できます）
```

| 警告 | 固定するキー |
|---|---|
| `推定: <S3 など> → Next` | `deploy."<id>": { app: next }` |
| `推定: <Lambda> → cmd/<name>` | `deploy."<id>": { go: cmd/<name> }` |
| `推定: <DB> → テーブル n 件` | `sql.db: "<DB ノード ID>"` |
| `推定: client の呼び先 → <id>` | `api.targets: ["<id>"]` |

推定の警告は**コンソールのログ**に出る。`issues.json` と終了コードの対象（`問題: 警告 n 件`）はスキーマ・参照の検証結果で、推定とは別。

### 3.5 取りこぼしを overrides で補う

`stack-atlas.overrides.yaml`（設定のあるディレクトリ）。静的解析では取れない線（利用者 → CloudFront、ブラウザ → Function URL、外部サービスの Webhook など）を書く。

```yaml
nodes:
  - { id: "actor:user", layer: infra, kind: actor, name: Browser }
edges:
  - { from: "actor:user", to: "infra:static_site/this", kind: flow }
  - { from: "actor:user", to: "infra:lambda_api/api", kind: http }
remove: ["lib:xxx"]                 # ノード ID、または { from, to, kind }
deploy:
  "infra:lambda_api/api": ["handler:cmd/api"]
```

動く例は `examples/fixture-poly/stack-atlas.overrides.yaml`。`api-link` が結べなかった呼び出しは `build` の警告に出る（該当 client の endpoint を overrides の `edges` に書く）。

### 3.6 フロー（`flows.yaml`）

```sh
pnpm atlas init-flows <repo> --out <repo>/flows.yaml      # いまのグラフから MISS / HIT / 無効化の雛形
```

fixture-poly では `miss`（13 ステップ）、`hit`（3）、`invalidate`（13）が出る。経路は `actor` → CloudFront → S3（静的エクスポートのホスティング）→ route → client（`lib:…/request.ts`）→ Lambda → `endpoint:` → Go ハンドラ → テーブル → DB の順にたどる。
OpenAPI の `endpoint:` を経由するホップと、S3 に載った静的エクスポートも扱う。ステップが 2 つに満たないフローは出さない。
文はプレースホルダ（「MISS → オリジン（S3）へ」など）なので、実際の挙動に合わせて書き換える。形式は `docs/09-design-phase2-5.md` §3.2。

### 3.7 スクショ・メモ・CI

- スクショ: 対象サイトを起動して `screenshots.baseUrl` を指す。動的ルートは `routes`、認証は `storageState`。部品の領域は対象アプリのルート要素に `data-component="Name"` を付ける（`docs/10-screenshots-guide.md`）。`--no-screenshots` を外すと撮る
- メモ: `<設定のあるディレクトリ>/.stack-atlas/memos.json`（Git 管理）。`serve --repo <dir>` で書き戻す。共有・差分は `docs/11-sharing.md`
- CI と配信: `docs/ci-example.yml`（`build --with-viewer` → 静的ホスティング。差分は `?prev=` と `stack-atlas diff`）

## 4. 詳細

### 4.1 設定キー一覧（`packages/core/src/types.ts` の `StackAtlasConfig`）

読み込みはゆるく、知らないキーや型の違いは警告にとどめる。パスは設定ファイルのあるディレクトリ基準。`repo` を持つセクションは、その repo のときだけ有効（`sectionFor`。省略すると全 repo）。

| キー | 意味 | 既定 |
|---|---|---|
| `project.{name,description,repo}` | graph.json の `project` | ディレクトリ名 |
| `layers` | 層の定義（`id` / `name` / `color` / `source`） | 4 層（`infra` / `routes` / `components` / `types`） |
| `layerOf` | kind → layer.id の割り当て | 下の「kind と層」 |
| `repos` | 名前 → 相対パス。2 つ以上で `file` が `<名前>/<path>` | 設定ファイルのディレクトリ 1 つ |
| `cdktf.{out,sourceDir,stack,repo}` | synth 出力、ソース探索先、対象スタック | `infra/cdktf.out`、`infra`、全部 |
| `terraform.{root,sourceDir,repo}` | root モジュール、file / line の探索範囲 | 自動検出（`infra/` → `terraform/` → `iac/` → 直下。`dev*` 優先） |
| `cloudformation.{templates,repo}` | テンプレートの glob | `cdk.out/*.template.json`、無ければ直下の `template.*` |
| `infra.include` | ノードにする型を足す（glob）。型名そのもの（`*` なし）なら配管も出す | 既定の許可リスト |
| `infra.exclude` | ノードから外す（glob） | なし |
| `infra.all` | `true` で配管以外のすべてのリソース | `false` |
| `next.{appDir,pagesDir,tsconfig,repo}` | App Router / Pages Router の場所、tsconfig | `apps/*/app` → `src/app` → `app`、`src/pages` → `pages` |
| `ts.{tsconfig,repo}` | 読む tsconfig の配列 | `tsconfig.json`（`next.tsconfig` も足す） |
| `go.{module,entries,repo}` | module path、入口パッケージの glob | `go.mod` の `module`、`["cmd/*"]` |
| `openapi.files` | 文字列（どの repo でも探す）または `{ repo, path }` | `openapi.*` / `swagger.*` / `openapi/*` ほか |
| `sql.{migrations,db,repo}` | マイグレーションの glob、テーブルを持つ DB ノード ID | `migrations/**/*.sql`・`db/migrations/**/*.sql`、DB が 1 つなら推定 |
| `deploy.<infra ID>` | 何が載るか（下表） | なし |
| `api.{client,clients,callers,targets,repo}` | client ファイル、client の glob、ラッパー名、呼び先の infra ID | 呼び先は API Gateway → Function URL の Lambda（複数なら endpoint の実装に着くもの）が 1 つに決まれば推定 |
| `classify` | `[{ glob, kind?, layer?, repo? }]`。上から順に最初に合ったもの | なし |
| `files` | `[{ glob, kind, name?, id?, layer?, repo? }]` | なし |
| `kinds` | `kind → { name, color, size, layer }`（graph.json の `kinds` に出る） | なし |
| `screenshots.{baseUrl,viewport,routes,storageState,outDir,timeout,repo}` | スクショ設定（`docs/10`） | — |
| `extractors` | `{ <name>: false }` で抽出器を無効化 | `detect()` に従う |

`deploy.<infra ID>` の値（複数指定可。キーの infra ノードが無いと**エラー**、`nodes` の ID が無いのも**エラー**）:

| 値 | 意味 |
|---|---|
| `app: next` | そのノード（S3 でも Lambda でも）に Next の全 route / layout が載る。`meta.deployApp: next` も付く |
| `handlers: <glob>` | `file` が glob に合う TS ハンドラが載る（repo 相対） |
| `go: cmd/api` | Go の入口パッケージ（module 相対）が載る |
| `nodes: [id…]` | 任意のノードを直接載せる |

kind と層の既定（`DEFAULT_LAYER_OF`）: `actor` `infra` `queue` `db` `cron` `service` → infra / `page` `layout` → routes / `component` `hook` `lib` → components / `type` `handler` `schema` `endpoint` → types。
`kinds.<k>.layer`、`layerOf` の順に上書きできる。どれにも無い kind は最後の層に置いて警告する。

### 4.2 抽出器と ID の規約

| 抽出器 | ノード ID | 主な meta |
|---|---|---|
| terraform | `infra:<logicalId>`（root）、`infra:<module>/<logicalId>`（module。入れ子は `infra:a/b/<id>`）。同じモジュールで型違いの同名が両方ノードになると末尾が `<type>.<name>` | `meta.infra`（`type` `logicalId` `path` `stack` `module?` `functionUrl?` `apiRoutes?`）。`meta.cdktf` は同じ値の別名 |
| cdktf | `infra:<logicalId>`（複数スタックで `cdktf.stack` 未指定なら `infra:<stack>/<logicalId>`） | 同上 |
| cloudformation | `infra:<logicalId>`（テンプレートが複数なら `infra:<stack>/<logicalId>`） | 同上。CDK は construct path |
| nextjs-app | `route:<URL>`、`layout:<URL>`、`handler:<URL>`（`route.ts` / `pages/api`） | `meta.next`、`meta.apiRoutes` |
| ts-imports | `comp:<Name>` `hook:<name>` `lib:<ファイル名>` `type:<Name>` `handler:<name>` `schema:<Name>`。衝突すると `comp:<path>#<Name>`、`lib:<path>`。複数 repo の lib 衝突は `lib:<repo>/<path>` | `meta.ts: { exportName, symbolKind }` |
| go | `<kind>:<module 相対ディレクトリ>`（`handler:cmd/api`、`lib:internal/store`） | `meta.go`、`meta.apiRoutes` |
| openapi | `endpoint:<METHOD> <path>`、`type:<SchemaName>` | `meta.api`、`meta.apiRoutes`、`meta.openapi` |
| sql | `schema:<table>` | `meta.sql: { table, columns }` |
| files | `<kind>:<id テンプレート>`（既定 `{path}`） | — |
| api-link | 上流のノードを引く。無ければ `handler:<basename>` / `lib:<camelCase>` を作る | `meta.apiCalls` |

ID は overrides・flows・メモの結合キー。`classify` は kind と層を変えても **ID は変えない**。

### 4.3 未知の構成を `classify` / `files` / `kinds` で形にする

| やりたいこと | 書き方 |
|---|---|
| TS / Go の分類を変える | `classify: [{ glob: "src/feature/**/types.ts", kind: type }]`（repo 相対。`repo:` で絞る。`kind: lib` ならファイル単位の `lib:`） |
| 層を変える | `classify: [{ glob: "internal/**", layer: components }]` |
| パーサの無い言語のファイルを載せる | `files: [{ glob: "reference/*.py", kind: lib, name: "{basename}", layer: types }]` |
| 独自の kind を作る | `files` や overrides の `kind` に好きな名前を使い、`kinds: { job: { name: ジョブ, color: "#f472b6", layer: infra } }` で見た目と層を決める |

`files` のテンプレートは `{path}`（repo 相対）`{dir}` `{basename}`（拡張子あり）`{stem}`（なし）`{repo}`。`code` はテキストファイルの先頭 20 行、バイナリは中身を読まない。1 ルール最大 2000 ノード。`files` はノードを作るだけでエッジは出さないので、結線は overrides で書く。
未知の kind は `layerOf` か `kinds.<k>.layer` で層を決めれば、ビューアは `kinds` の色と名前で描く（ビューアはスタックの知識を持たない）。

### 4.4 抽出器の順序と複数 repo

CLI の順序（抽出器ごとに全 repo を宣言順に回す。後続は先行の結果を `upstream` で読める）:
`files` → `cdktf` → `terraform` → `cloudformation` → `nextjs-app` → `ts-imports` → `go` → `openapi` → `sql` → `api-link` → `cache` → `screenshots`。
そのあとに `classify` → `deploy` → overrides → 層の割り当て → flows.yaml が当たる。抽出器は repo 相対パスを返せばよく、パイプラインが複数 repo のときだけ `<repo>/` を付ける。
`api-link` は endpoint と Go のルートを上流から読むので、go / openapi は全 repo で api-link より先に走る必要がある（上の順序で満たされる）。

### 4.5 制限（各 README の「制限」をまとめたもの）

| 抽出器 | 制限 |
|---|---|
| terraform | `count` / `for_each` のインスタンスは区別しない（ブロック 1 つ = ノード 1 つ）。`terraform_remote_state` や別 root のリソースはたどらない。レジストリ / git の module は読まない（警告）。`merge` / `lookup` などの関数は中の参照だけを見る。module の深さは 5 まで |
| cdktf | `data.*` や `TerraformModule` の中は見ない。式は中の参照だけ |
| cloudformation | 解決できないパラメータ（`${var.*}`）はたどらない。CDK の内部リソース（カスタムリソースのプロバイダ Lambda、`CDKMetadata` など）はノードにしない |
| tf-graph（共通） | 配管（IAM / SG / subnet / log group / policy / permission / API Gateway の stage・integration など）は `all: true` でも出さない（`include` に型名そのものを書けば出る） |
| nextjs-app | `revalidate` が式（定数参照など）だと読めない。Pages Router の `getStaticProps` の `revalidate` は読まない。`@slot` / インターセプトは対象外 |
| ts-imports | 識別子は名前で照合（シャドーイング非対応）。動的 `import()` / `require` は見ない。Lambda のエントリファイルも `lib:` になる（`remove` で消す） |
| go | `r.Route("/prefix", …)` の入れ子ルートは未対応。シンボル単位ではなくパッケージ単位。toolchain を使わず正規表現で読む |
| openapi | `servers[].url` のパス部分は足さない。外部ファイルへの `$ref` はたどらない |
| sql | DROP / RENAME は無視。同じテーブルが複数回作られたら最初のもの |
| api-link | REST API（`aws_api_gateway_*`）の route・ALB のルールは読まない（endpoint / `apiRoutes` 経由なら結べる）。ラッパーのパスの前にリテラル（`${BASE}/api${path}`）があるものは検出しない |
| cache | 構文だけ。オプションを変数に入れて渡す・独自ラッパー経由の呼び出しは読まない |
| files | ノードを作るだけでエッジは出さない |
| init-flows | 雛形の文はプレースホルダ。経路はグラフのエッジを機械的にたどるだけで、実際の挙動（キャッシュの有無、認証）は人が直す |

### 4.6 ビューアの規模について

150 ノード前後（実リポジトリ 2 つ）で、層内のレイアウトが密になり読みにくい。レイアウトの広がり・ラベルの間引き（LOD）・検索ボックスは**進行中**（`docs/06-roadmap.md` Phase 7）。
