# @stack-atlas/extractor-cdktf

`cdktf synth` の出力（`cdktf.out/stacks/<stack>/cdk.tf.json`）から **インフラ層**（`infra:*` ノードと `flow` エッジ）を作る抽出器。
解析（許可リスト・参照 → エッジ・Function URL のホップ・CloudFront / API Gateway / Lambda@Edge の `cache`）は **`@stack-atlas/tf-graph`** に移した（terraform / cloudformation 抽出器と共通。規則はその README）。
この抽出器は cdk.tf.json を読むことと、construct id で .ts ソースの `file` / `line` を探すことだけをする薄いアダプタ。

## 入力・設定

| キー | 既定 | 意味 |
|---|---|---|
| `cdktf.out` | `infra/cdktf.out` | synth の出力ディレクトリ。`stacks/*/cdk.tf.json` があれば `detect` が true |
| `cdktf.sourceDir` | `infra` | `file` / `line` を探す .ts ソースの場所 |
| `cdktf.stack` | （全部） | 指定するとそのスタックだけ読む |
| `cdktf.repo` | | 複数リポジトリのとき、対象の repo（`sectionFor`） |
| `infra.include` / `exclude` / `all` | | ノードにする型の調整（tf-graph） |
| `deploy.<id>.app: next` | | その Lambda に `meta.deployApp: 'next'` を付ける |

## ノード

- 対象の型は tf-graph の `DEFAULT_NODE_TYPES`（互換のため `NODE_RESOURCE_TYPES` としても export）。IAM・route・integration・stage・permission・pool client などはノードにしない（参照だけ読む）。
- ID は `infra:<logicalId>`（cdktf の論理 ID。単一スタックでは construct id と同じ）。スタックが複数あり `cdktf.stack` が未指定なら `infra:<stack>/<logicalId>`。
- `file` / `line` / `code`: `sourceDir` の .ts から construct id の文字列リテラル（`new X(scope, "id"` を優先）を grep し、最初の一致の前後 12 行。見つからなければリソースの主要属性の JSON。
- `meta.infra: { type, logicalId, path, stack, functionUrl?, apiRoutes? }` と、従来の `meta.cdktf: { type, logicalId, path, stack }`。Next を載せた Lambda は `meta.deployApp: 'next'`、Lambda@Edge は `meta.edge: true`。

## エッジ（すべて `flow`、参照元 → 参照先）

- 属性値の `${<provider>_<type>.<id>.<attr>}` を再帰的に拾い、ノード同士の参照をエッジにする。`label` は属性パス（`origin.domain_name`、`environment.TABLE` など）。
- `aws_lambda_function_url` は 1 段またぐ（CloudFront origin → Function URL → Lambda）。
- `aws_apigatewayv2_integration` は `api_id` の API → `integration_uri` の Lambda のエッジにする。

## 制限

- `data.*` やモジュール（cdktf の `TerraformModule`）の中は見ない。
- Terraform の式（`element(split(...))` など）は中の参照だけを見る。
