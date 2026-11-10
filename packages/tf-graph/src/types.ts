/**
 * tf-graph の入出力の型。Terraform JSON（cdk.tf.json と同じ形）を入力にする。
 */
import type { Edge } from '@stack-atlas/schema';
import type { DeployTarget, Logger, PartialNode } from '@stack-atlas/core';

export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
export type JsonObject = { [k: string]: Json };

/** Terraform JSON（`resource.<type>.<name> = body`）。hcl2json の「ブロックは配列」形は呼び出し側で正規化する */
export interface TfJson {
  resource?: Record<string, Record<string, JsonObject>>;
  data?: Record<string, Record<string, JsonObject>>;
  module?: Record<string, JsonObject>;
  '//'?: Json;
  [k: string]: unknown;
}

/** 1 つの Terraform JSON と、その出どころ */
export interface TfDocument {
  tf: TfJson;
  /** スタック名（cdktf のスタック、terraform の root ディレクトリ名、CFn のテンプレート名） */
  stack: string;
  /** モジュールのパス（`a/b`）。root は '' */
  module?: string;
  /** construct path / アドレスの既定（`<stack>/<logicalId>` の代わり）を作る */
  pathOf?: (type: string, logicalId: string, body: JsonObject) => string;
}

export interface TfResource {
  type: string;
  logicalId: string;
  body: JsonObject;
  stack: string;
  /** モジュールのパス（root は ''） */
  module: string;
  /** construct path（cdktf の `//`.metadata.path）や Terraform アドレス */
  path: string;
}

/** 参照 1 つ（`<provider>_<type>.<name>.<attr>`） */
export interface Reference {
  type: string;
  logicalId: string;
  attr: string;
  /** 参照が書かれていた属性のパス（配列の添字は省く）。例 origin.domain_name */
  at: string;
  /** `mod:<path>:` で修飾されていたモジュールのパス（無ければ参照元と同じモジュール） */
  module?: string;
}

/** `var.x` / `local.x` / `module.m.out` の未解決トークン */
export interface Token {
  kind: 'var' | 'local' | 'module';
  /** var / local の名前、module の呼び出し名 */
  name: string;
  /** module の output 名 */
  output?: string;
  module?: string;
  at: string;
  /** 元の文字列（`var.x` など） */
  text: string;
}

export interface InfraFilter {
  include?: string[];
  exclude?: string[];
  all?: boolean;
}

export interface Located {
  file?: string;
  line?: number;
  code?: string;
}

export interface BuildInfraOptions extends InfraFilter {
  /** ノード ID。既定 `infra:<module>/<logicalId>`（module が '' なら `infra:<logicalId>`） */
  idOf?: (res: TfResource) => string;
  /** 表示名に使う短い名前（既定は論理 ID。CDK の construct id など） */
  labelOf?: (res: TfResource) => string | undefined;
  /** ソース上の位置（fs を触るのは呼び出し側） */
  locate?: (res: TfResource) => Located | undefined;
  /** config.deploy（`app: next` を Lambda の meta.deployApp に写す） */
  deploy?: Record<string, DeployTarget>;
  /** meta.extractors に入れる名前 */
  extractor: string;
  log?: Logger;
}

/** API Gateway の 1 ルート（v1 / v2）。api-link 用 */
export interface ApiGatewayRoute {
  /** API Gateway ノードの ID */
  apiId: string;
  /** `GET /races/{id}`（v2 の `$default` などもそのまま） */
  routeKey: string;
  /** 統合先 Lambda のノード ID */
  lambdaId?: string;
  version: 'v1' | 'v2';
}

export interface FunctionUrl {
  lambdaId: string;
  /** aws_lambda_function_url の論理 ID */
  urlResource: string;
}

export interface InfraGraph {
  nodes: PartialNode[];
  edges: Edge[];
  routes: ApiGatewayRoute[];
  functionUrls: FunctionUrl[];
  /** ノードの属性に残った var / local / module トークン（terraform の未解決） */
  unresolved: Token[];
  resources: TfResource[];
}

/** `meta.infra`（docs/12 §3.3。`meta.cdktf` と同じ値 ＋ module など） */
export interface InfraMeta {
  type: string;
  logicalId: string;
  path: string;
  stack: string;
  module?: string;
  /** Function URL を持つ Lambda */
  functionUrl?: true;
  /** API Gateway のルート */
  apiRoutes?: Array<{ routeKey: string; lambdaId?: string }>;
}
