# @stack-atlas/extractor-cloudformation

AWS CDK（`cdk.out/*.template.json`）・SAM（`template.yaml`）・素の CloudFormation から **インフラ層** を作る抽出器（docs/12 §3.3）。
テンプレートを Terraform JSON の形に変換して `@stack-atlas/tf-graph`（cdktf / terraform と共通）に渡す。

## 入力・設定

| キー | 既定 | 意味 |
|---|---|---|
| `cloudformation.templates` | 自動 | テンプレートの glob（repo 相対）。例 `["cdk.out/*.template.json", "template.yaml"]` |
| `cloudformation.repo` | | 複数リポジトリのとき、対象の repo |
| `infra.include` / `exclude` / `all` | | ノードにする型の調整（tf-graph の README） |

`templates` が無いとき: `cdk.out/*.template.json`、無ければ repo 直下の `template.yaml|yml|json`（`AWSTemplateFormatVersion` か `Resources` を含むもの）。
YAML は CFn の短縮形（`!Ref` `!GetAtt` `!Sub` `!Join` `!If` `!Select` …）を解釈する。

## 変換

- 型: `AWS::Lambda::Function` → `aws_lambda_function` などの対応表（`TYPE_MAP`）。無い型は `aws_<service>_<resource>`（例 `AWS::IAM::Role` → `aws_iam_role`）なので、配管の判定もそのまま効く。
  SAM: `Serverless::Function` → Lambda、`Serverless::Api` → REST API、`Serverless::HttpApi` → HTTP API、`Serverless::SimpleTable` → DynamoDB。
  `RDS::DBInstance` が `DBClusterIdentifier` を持てば cluster instance（cluster へのホップ）。
- 属性: Properties のキーを snake_case にし、tf-graph が読む名前に寄せる（`BucketName` → `bucket`、`TableName` → `name`、CloudFront の `DistributionConfig` を展開して `origin` / `default_cache_behavior` / `ordered_cache_behavior` / `function_association` など）。`Environment.Variables` と `Tags` のキーはそのまま。
- 参照: `Ref X` → `${<型>.X.id}`、`Fn::GetAtt [X, Attr]` → `${<型>.X.attr}`、`Fn::Sub` の `${X}` / `${X.Attr}` も同様、`Fn::Join` は連結。パラメータと疑似パラメータは `${var.*}`（解決しない）。
- `ApiGateway::Method` の中の `Integration` は別の integration に分ける（REST API のルートと API → Lambda のエッジになる）。
- SAM の `Events`: `Api` / `HttpApi` → ルート ＋ API → Lambda（`RestApiId` / `ApiId` が無ければ暗黙の `ServerlessRestApi` / `ServerlessHttpApi` ノード）、`SQS` / `Kinesis` / `DynamoDB` → event source mapping（キュー → Lambda）、`SNS` → subscription。`FunctionUrlConfig` → Function URL（`meta.infra.functionUrl`）。
- CDK の内部リソース（カスタムリソースのプロバイダ Lambda、`Custom::*`、`CDKMetadata`、LogRetention など）はノードにしない。

## ノード

- ID: `infra:<logicalId>`。テンプレートが複数あれば `infra:<stack>/<logicalId>`（stack はファイル名から `.template.json` を除いたもの）。
- 表示名は tf-graph の規則。CDK では `Metadata['aws:cdk:path']` の末尾（`Resource` を除く）を論理 ID の代わりに使う（`Lambda: Handler`）。
- `meta.infra.path` は CDK の construct path（無ければ `<stack>/<logicalId>`）。`file` はテンプレートのパス、`line` / `code` は論理 ID のキーの位置から最大 25 行。
