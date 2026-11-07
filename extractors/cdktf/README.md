# @stack-atlas/extractor-cdktf

`cdktf synth` の出力（`cdktf.out/stacks/<stack>/cdk.tf.json`）から **インフラ層**（`infra:*` ノードと `flow` エッジ）を作る抽出器。CloudFront / API Gateway / Lambda@Edge の `cache` もここで作る。

## 入力・設定

| キー | 既定 | 意味 |
|---|---|---|
| `cdktf.out` | `infra/cdktf.out` | synth の出力ディレクトリ。`stacks/*/cdk.tf.json` があれば `detect` が true |
| `cdktf.sourceDir` | `infra` | `file` / `line` を探す .ts ソースの場所 |
| `cdktf.stack` | （全部） | 指定するとそのスタックだけ読む |
| `deploy.<id>.app: next` | | その Lambda に `meta.deployApp: 'next'` を付ける |

## ノード

- 対象の型（`NODE_RESOURCE_TYPES`）: CloudFront distribution / function、Lambda、API Gateway v2、DynamoDB、S3、Cognito User Pool、SQS、SNS、RDS cluster、ElastiCache。IAM・route・integration・stage・permission・pool client などはノードにしない（参照だけ読む）。
- ID は `infra:<logicalId>`（cdktf の論理 ID。単一スタックでは construct id と同じ）。スタックが複数あり `cdktf.stack` が未指定なら `infra:<stack>/<logicalId>`。
- `file` / `line` / `code`: `sourceDir` の .ts から construct id の文字列リテラル（`new X(scope, "id"` を優先）を grep し、最初の一致の前後 12 行。見つからなければリソースの主要属性の JSON。
- `meta.cdktf: { type, logicalId, path, stack }`、Next を載せた Lambda は `meta.deployApp: 'next'`（`config.deploy` か、`filename` に `.next/standalone` / `handler: run.sh`）、Lambda@Edge は `meta.edge: true`。

## エッジ（すべて `flow`、参照元 → 参照先）

- 属性値の `${aws_xxx.<id>.<attr>}` を再帰的に拾い、ノード同士の参照をエッジにする。`label` は属性パス（`origin.domain_name`、`environment.TABLE`、`tags.UserPoolId` など）。
- `aws_lambda_function_url` は 1 段またぐ（CloudFront origin → Function URL → Lambda）。
- `aws_apigatewayv2_integration` は `api_id` の API → `integration_uri` の Lambda のエッジにする。

## cache

- CloudFront: behavior ごとに `rules`（キーは `path_pattern`、既定 behavior は `既定（*）`）。管理ポリシー（CachingDisabled など）は名前、`aws_cloudfront_cache_policy` は TTL を要約。キャッシュキーに Cookie を入れていれば `warn` と注記。
- HTTP API: `off`（キャッシュなし）。Lambda@Edge: `lambda_function_association` のイベントと path pattern から `info`。

## 制限

- 参照の正規表現は `aws_` で始まるリソースだけ（`data.*` やモジュールは見ない）。
- Terraform の式（`element(split(...))` など）は中の参照だけを見る。
