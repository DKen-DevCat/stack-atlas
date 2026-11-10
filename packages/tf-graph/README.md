# @stack-atlas/tf-graph

IaC 共通の解析ライブラリ（docs/12 §3.3）。**Terraform JSON（`cdk.tf.json` と同じ形）→ infra ノード・`flow` エッジ・`cache`** を作る純関数で、fs は触らない。
cdktf / terraform（HCL）/ cloudformation の 3 抽出器が、それぞれの入力をこの形に変換して渡す。

```
cdk.tf.json ──────────────┐
*.tf ─(hcl2json + 参照解決)─┼─▶ buildInfraGraph(docs, opts) ─▶ { nodes, edges, routes, functionUrls, unresolved }
template.json/yaml ─(変換)─┘
```

## API

```ts
import { buildInfraGraph } from '@stack-atlas/tf-graph';

const g = buildInfraGraph(
  [{ tf: cdkTfJson, stack: 'web', module: '' /* terraform のモジュールパス（a/b） */ }],
  {
    extractor: 'cdktf',                 // meta.extractors に入る名前
    idOf: (r) => `infra:${r.logicalId}`, // 既定 infra:<module>/<logicalId>（root は infra:<logicalId>）
    locate: (r) => ({ file, line, code }), // ソース位置（呼び出し側が grep する）
    labelOf: (r) => '短い名前',          // 表示名の既定（論理 ID の代わり）
    deploy: config.deploy,              // app: next → Lambda に meta.deployApp
    ...config.infra,                    // include / exclude / all
    log,
  },
);
```

- `g.routes`: API Gateway のルート `{ apiId, routeKey, lambdaId?, version: 'v1' | 'v2' }`（v2 の route → integration、v1 の resource / method / integration）。
- `g.functionUrls`: `{ lambdaId, urlResource }`。
- `g.unresolved`: ノードの属性に残った `var.*` / `local.*` / `module.*.*` トークン。
- そのほか `collectRefs` / `collectTokens` / `makeNodeTypeFilter` / `normalizeHclJson`（hcl2json の「ブロックは配列」形を cdk.tf.json の形に寄せる）など。

## ノード

- 既定の許可リスト `DEFAULT_NODE_TYPES`: Lambda、CloudFront distribution / function、API Gateway v1（`aws_api_gateway_rest_api`）・v2、AppSync、DynamoDB、S3、Cognito User Pool、SQS、SNS、RDS cluster / instance、ElastiCache、ECR、EventBridge rule、Scheduler、Step Functions、ECS service、ALB/NLB、SES receipt rule、Secrets Manager secret、`google_cloudfunctions(2)_function` / `google_pubsub_topic|subscription` / `google_cloud_run(_v2)_service` / `google_storage_bucket`。
- 配管 `PLUMBING_TYPES`（glob）は `all: true` でもノードにしない: IAM、SG、subnet、route / route table、VPC・IGW・EIP、log group、`*_policy`、`*_permission`、API Gateway の stage / integration / route / method / resource、OAC、cache policy、S3 の付属リソース（`aws_s3_bucket_*`）、secret version、`random_*`、`null_resource` など。
- `infra.include`（glob）で足す・`infra.exclude`（glob）で外す・`infra.all: true` で配管以外すべて。`include` に**型名そのもの**（`*` なし）を書いたときだけ配管も出す。
- 中継（ノードにせず参照を 1 段またぐ）: `aws_lambda_function_url` / `aws_lambda_alias` → Lambda、`aws_rds_cluster_instance` → cluster（`cluster_identifier` がクラスタを指すとき。指さなければ RDS ノード）。
- ID が衝突したとき（Terraform は型が違えば同名を使える）は、衝突した全部の末尾を `<type>.<name>` にする（例 `infra:static_site/aws_s3_bucket.site`）。
- 表示名: `Lambda: <name>`、`CloudFront`、`API Gateway (HTTP|REST|WebSocket)`、`DynamoDB <table>`、`S3 <bucket>`、`Cognito <pool>`、`Aurora <cluster>`（engine が aurora*）/ `RDS <id>`、`ECR <repo>`、`Scheduler <name>`、`EventBridge rule <name>`、`Secret <name>`、`CloudFront Function <name>` など。名前の属性が式のまま（`${...}` を含む）なら論理 ID（または `labelOf`）。
- `meta.infra: { type, logicalId, path, stack, module?, functionUrl?, apiRoutes? }` が正。互換のため `meta.cdktf: { type, logicalId, path, stack }` も同じ値で付ける。
  - `functionUrl: true`: Function URL を持つ Lambda
  - `apiRoutes: [{ routeKey, lambdaId? }]`: API Gateway ノードのルート（api-link が使う）
- `meta.deployApp: 'next'`（Lambda）: `config.deploy[id].app === 'next'`、`filename` に `.next/standalone`、`handler: run.sh`、`image_uri` / `function_name` に `open-next` / `opennext`。Lambda@Edge は `meta.edge: true`。

## エッジ（すべて `flow`、参照元 → 参照先）

- ノードの属性値の `${<provider>_<type>.<name>[i].<attr>}` を再帰的に拾う（`data.*` / `var.*` / `local.*` は除く）。`label` は属性パス（`origin.domain_name`、`environment.TABLE` など）。
- 呼び出し側がモジュールをまたいで置換した参照は `${mod:<module>:aws_x.y.attr}` と修飾され、そのモジュールのリソースに解決される。
- 配管の「つなぎ」: API Gateway の integration（API → Lambda）、`aws_lambda_event_source_mapping`（キュー等 → Lambda）、`aws_cloudwatch_event_target`（rule → 先）、`aws_sns_topic_subscription`（topic → 先）、`aws_s3_bucket_notification`（bucket → 先）。

## cache

- CloudFront: behavior ごとの `rules`（管理ポリシーは名前、`aws_cloudfront_cache_policy` は TTL を要約、Cookie をキーに含めると `warn`）。`function_association`（CloudFront Function）は `rules` に足し、viewer-* なら `note`。
- CloudFront Function / Lambda@Edge 自身: `info`（トリガーと関連付けの範囲）。
- HTTP API: `off`。REST API: ステージの `cache_cluster_enabled` があれば `ok`、無ければ `off`。
