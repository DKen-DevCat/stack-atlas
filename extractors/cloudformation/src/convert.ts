/**
 * CloudFormation テンプレート（AWS CDK / SAM / 素の CFn）→ Terraform JSON の形（tf-graph の入力）。
 * - `Resources.<Id>.Type` → Terraform のリソース型（対応表。無い型は `aws_<service>_<resource>`）
 * - Properties → snake_case の属性（tf-graph が読む名前に寄せる: bucket / name / function_name …）
 * - `Ref` / `Fn::GetAtt` / `Fn::Sub` / `Fn::Join` → `${<tf型>.<Id>.<attr>}` の文字列（tf-graph の参照検出に乗る）
 */
import { isObject, type Json, type JsonObject, type TfJson } from '@stack-atlas/tf-graph';

/** CFn 型 → Terraform 型 */
export const TYPE_MAP: Record<string, string> = {
  'AWS::Lambda::Function': 'aws_lambda_function',
  'AWS::Lambda::Url': 'aws_lambda_function_url',
  'AWS::Lambda::Alias': 'aws_lambda_alias',
  'AWS::Lambda::Permission': 'aws_lambda_permission',
  'AWS::Lambda::EventSourceMapping': 'aws_lambda_event_source_mapping',
  'AWS::Lambda::LayerVersion': 'aws_lambda_layer_version',
  'AWS::Lambda::Version': 'aws_lambda_alias',
  'AWS::CloudFront::Distribution': 'aws_cloudfront_distribution',
  'AWS::CloudFront::Function': 'aws_cloudfront_function',
  'AWS::CloudFront::OriginAccessControl': 'aws_cloudfront_origin_access_control',
  'AWS::CloudFront::CloudFrontOriginAccessIdentity': 'aws_cloudfront_origin_access_identity',
  'AWS::CloudFront::CachePolicy': 'aws_cloudfront_cache_policy',
  'AWS::CloudFront::OriginRequestPolicy': 'aws_cloudfront_origin_request_policy',
  'AWS::CloudFront::ResponseHeadersPolicy': 'aws_cloudfront_response_headers_policy',
  'AWS::ApiGateway::RestApi': 'aws_api_gateway_rest_api',
  'AWS::ApiGateway::Resource': 'aws_api_gateway_resource',
  'AWS::ApiGateway::Method': 'aws_api_gateway_method',
  'AWS::ApiGateway::Stage': 'aws_api_gateway_stage',
  'AWS::ApiGateway::Deployment': 'aws_api_gateway_deployment',
  'AWS::ApiGatewayV2::Api': 'aws_apigatewayv2_api',
  'AWS::ApiGatewayV2::Route': 'aws_apigatewayv2_route',
  'AWS::ApiGatewayV2::Integration': 'aws_apigatewayv2_integration',
  'AWS::ApiGatewayV2::Stage': 'aws_apigatewayv2_stage',
  'AWS::DynamoDB::Table': 'aws_dynamodb_table',
  'AWS::DynamoDB::GlobalTable': 'aws_dynamodb_table',
  'AWS::S3::Bucket': 'aws_s3_bucket',
  'AWS::S3::BucketPolicy': 'aws_s3_bucket_policy',
  'AWS::Cognito::UserPool': 'aws_cognito_user_pool',
  'AWS::Cognito::UserPoolClient': 'aws_cognito_user_pool_client',
  'AWS::SQS::Queue': 'aws_sqs_queue',
  'AWS::SQS::QueuePolicy': 'aws_sqs_queue_policy',
  'AWS::SNS::Topic': 'aws_sns_topic',
  'AWS::SNS::Subscription': 'aws_sns_topic_subscription',
  'AWS::SNS::TopicPolicy': 'aws_sns_topic_policy',
  'AWS::RDS::DBCluster': 'aws_rds_cluster',
  'AWS::RDS::DBInstance': 'aws_db_instance',
  'AWS::RDS::DBSubnetGroup': 'aws_db_subnet_group',
  'AWS::ElastiCache::CacheCluster': 'aws_elasticache_cluster',
  'AWS::ElastiCache::ReplicationGroup': 'aws_elasticache_replication_group',
  'AWS::ElastiCache::SubnetGroup': 'aws_elasticache_subnet_group',
  'AWS::ECR::Repository': 'aws_ecr_repository',
  'AWS::Events::Rule': 'aws_cloudwatch_event_rule',
  'AWS::Scheduler::Schedule': 'aws_scheduler_schedule',
  'AWS::StepFunctions::StateMachine': 'aws_sfn_state_machine',
  'AWS::ECS::Service': 'aws_ecs_service',
  'AWS::ECS::Cluster': 'aws_ecs_cluster',
  'AWS::ECS::TaskDefinition': 'aws_ecs_task_definition',
  'AWS::ElasticLoadBalancingV2::LoadBalancer': 'aws_lb',
  'AWS::ElasticLoadBalancingV2::Listener': 'aws_lb_listener',
  'AWS::ElasticLoadBalancingV2::TargetGroup': 'aws_lb_target_group',
  'AWS::AppSync::GraphQLApi': 'aws_appsync_graphql_api',
  'AWS::SES::ReceiptRule': 'aws_ses_receipt_rule',
  'AWS::SecretsManager::Secret': 'aws_secretsmanager_secret',
  'AWS::Logs::LogGroup': 'aws_cloudwatch_log_group',
  'AWS::EC2::VPC': 'aws_vpc',
  'AWS::EC2::Subnet': 'aws_subnet',
  'AWS::EC2::SecurityGroup': 'aws_security_group',
  'AWS::EC2::SecurityGroupIngress': 'aws_security_group_rule',
  'AWS::EC2::SecurityGroupEgress': 'aws_security_group_rule',
  'AWS::EC2::RouteTable': 'aws_route_table',
  'AWS::EC2::Route': 'aws_route',
  'AWS::EC2::SubnetRouteTableAssociation': 'aws_route_table_association',
  'AWS::EC2::InternetGateway': 'aws_internet_gateway',
  'AWS::EC2::VPCGatewayAttachment': 'aws_internet_gateway_attachment',
  'AWS::EC2::NatGateway': 'aws_nat_gateway',
  'AWS::EC2::EIP': 'aws_eip',
  'AWS::EC2::Instance': 'aws_instance',
  'AWS::CDK::Metadata': 'aws_cdk_metadata',
  // SAM
  'AWS::Serverless::Function': 'aws_lambda_function',
  'AWS::Serverless::Api': 'aws_api_gateway_rest_api',
  'AWS::Serverless::HttpApi': 'aws_apigatewayv2_api',
  'AWS::Serverless::SimpleTable': 'aws_dynamodb_table',
  'AWS::Serverless::StateMachine': 'aws_sfn_state_machine',
  'AWS::Serverless::LayerVersion': 'aws_lambda_layer_version',
};

/** PascalCase → snake_case（`FunctionARN` → `function_arn`、`DBClusterIdentifier` → `db_cluster_identifier`） */
export const snake = (s: string): string =>
  s
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[.:-]/g, '_')
    .toLowerCase();

export function tfTypeOf(cfnType: string): string {
  const mapped = TYPE_MAP[cfnType];
  if (mapped) return mapped;
  if (cfnType.startsWith('Custom::') || cfnType === 'AWS::CloudFormation::CustomResource')
    return 'cfn_custom_resource';
  const m = /^(\w+)::(\w+)::(\w+)$/.exec(cfnType);
  if (!m) return `cfn_${snake(cfnType)}`;
  const [, vendor, service, res] = m;
  return `${vendor === 'AWS' ? 'aws' : snake(vendor!)}_${service!.toLowerCase()}_${snake(res!)}`;
}

/** CDK が自動で作る内部リソース（カスタムリソースのプロバイダなど）はノードにしない */
const CDK_INTERNAL =
  /^(Custom[A-Za-z0-9]*CustomResourceProvider|CustomCDKBucketDeployment|LogRetention[0-9a-f]{32}|AWSCDK|BucketNotificationsHandler|CustomS3AutoDeleteObjects)/;

interface Template {
  Resources?: Record<string, { Type?: string; Properties?: JsonObject; Metadata?: JsonObject }>;
}

export interface ConvertedTemplate {
  tf: TfJson;
  /** 論理 ID → `aws:cdk:path` */
  cdkPaths: Record<string, string>;
}

const PSEUDO = /^AWS::/;

export function convertTemplate(template: unknown): ConvertedTemplate {
  const t = (isObject(template) ? template : {}) as Template;
  const resources = isObject(t.Resources) ? t.Resources : {};
  const typeOfId = new Map<string, string>();
  for (const [id, r] of Object.entries(resources)) {
    if (!isObject(r) || typeof r.Type !== 'string') continue;
    let type = tfTypeOf(r.Type);
    const path = isObject(r.Metadata) ? r.Metadata['aws:cdk:path'] : undefined;
    if (CDK_INTERNAL.test(id) || (typeof path === 'string' && path.includes('/Custom::')))
      type = 'cfn_cdk_internal';
    // DBInstance が cluster に属するなら cluster instance（ホップ）にする
    if (
      r.Type === 'AWS::RDS::DBInstance' &&
      isObject(r.Properties) &&
      r.Properties['DBClusterIdentifier']
    )
      type = 'aws_rds_cluster_instance';
    typeOfId.set(id, type);
  }

  const ref = (id: string, attr: string): string => {
    if (PSEUDO.test(id)) return `\${var.${id.replace(/::/g, '_')}}`;
    const type = typeOfId.get(id);
    return type ? `\${${type}.${id}.${attr}}` : `\${var.${id}}`; // パラメータ
  };
  const flat = (v: Json): string => {
    const c = intrinsic(v);
    if (typeof c === 'string') return c;
    const parts: string[] = [];
    const walk = (x: Json) => {
      if (typeof x === 'string') parts.push(x);
      else if (Array.isArray(x)) x.forEach(walk);
      else if (isObject(x)) Object.values(x).forEach(walk);
    };
    walk(c);
    return parts.join(' ');
  };
  const sub = (s: string, vars: JsonObject = {}): string =>
    s.replace(/\$\{(!?)([^}]*)\}/g, (_m, bang: string, expr: string) => {
      if (bang) return expr; // ${!Literal}
      if (expr in vars) return flat(vars[expr]!);
      const [id, ...attr] = expr.split('.');
      return attr.length ? ref(id!, snake(attr.join('.'))) : ref(id!, 'id');
    });

  /** 組み込み関数を `${...}` 文字列にする。それ以外は再帰的に変換 */
  const intrinsic = (v: Json): Json => {
    if (Array.isArray(v)) return v.map(intrinsic);
    if (!isObject(v)) return v;
    const keys = Object.keys(v);
    if (keys.length === 1) {
      const k = keys[0]!;
      const a = v[k]!;
      if (k === 'Ref' && typeof a === 'string') return ref(a, 'id');
      if (k === 'Fn::GetAtt') {
        const parts = typeof a === 'string' ? a.split('.') : Array.isArray(a) ? a.map(String) : [];
        const [id, ...attr] = parts;
        if (id) return ref(id, snake(attr.join('.') || 'arn'));
      }
      if (k === 'Fn::Sub') {
        if (typeof a === 'string') return sub(a);
        if (Array.isArray(a) && typeof a[0] === 'string')
          return sub(a[0], isObject(a[1]) ? a[1] : {});
      }
      if (k === 'Fn::Join' && Array.isArray(a) && Array.isArray(a[1])) {
        const delim = typeof a[0] === 'string' ? a[0] : '';
        return a[1].map(flat).join(delim);
      }
      if (k === 'Fn::ImportValue') return `\${var.import_${snake(flat(a)).replace(/[^\w]/g, '_')}}`;
      if (k.startsWith('Fn::') || k === 'Condition') return flat(a);
    }
    const o: JsonObject = {};
    for (const [kk, x] of Object.entries(v)) o[kk] = intrinsic(x);
    return o;
  };

  /** キーを snake_case にする（値はそのまま） */
  const snakeKeys = (v: Json): Json => {
    if (Array.isArray(v)) return v.map(snakeKeys);
    if (!isObject(v)) return v;
    const o: JsonObject = {};
    for (const [k, x] of Object.entries(v)) {
      // 環境変数などのユーザー定義キーはそのまま
      o[snake(k)] = k === 'Variables' || k === 'Tags' ? x : snakeKeys(x);
    }
    return o;
  };

  const out: Record<string, Record<string, JsonObject>> = {};
  const put = (type: string, id: string, body: JsonObject) => {
    (out[type] ??= {})[id] = body;
  };
  const cdkPaths: Record<string, string> = {};
  /** SAM の暗黙の API */
  const implicitApi = (kind: 'Api' | 'HttpApi'): string => {
    const id = kind === 'Api' ? 'ServerlessRestApi' : 'ServerlessHttpApi';
    if (!typeOfId.has(id)) {
      const type = kind === 'Api' ? 'aws_api_gateway_rest_api' : 'aws_apigatewayv2_api';
      typeOfId.set(id, type);
      put(type, id, kind === 'Api' ? { name: id } : { name: id, protocol_type: 'HTTP' });
    }
    return id;
  };

  for (const [id, r] of Object.entries(resources)) {
    const type = typeOfId.get(id);
    if (!type || !isObject(r)) continue;
    const props = snakeKeys(intrinsic(isObject(r.Properties) ? r.Properties : {})) as JsonObject;
    const path = isObject(r.Metadata) ? r.Metadata['aws:cdk:path'] : undefined;
    if (typeof path === 'string') cdkPaths[id] = path;
    const body = fixup(r.Type!, type, props);
    put(type, id, body);

    if (r.Type === 'AWS::ApiGateway::Method' && isObject(props['integration'])) {
      // CFn の Method は統合を中に持つ → tf-graph の aws_api_gateway_integration に分ける
      const integ = props['integration'];
      put('aws_api_gateway_integration', `${id}Integration`, {
        rest_api_id: props['rest_api_id'] ?? null,
        resource_id: props['resource_id'] ?? null,
        http_method: props['http_method'] ?? null,
        uri: integ['uri'] ?? null,
      });
    }

    if (r.Type === 'AWS::Serverless::Function') {
      const fnRef = `\${aws_lambda_function.${id}.arn}`;
      if (isObject(props['function_url_config'])) {
        put('aws_lambda_function_url', `${id}Url`, { function_name: fnRef });
      }
      const events =
        isObject(r.Properties) && isObject(r.Properties['Events']) ? r.Properties['Events'] : {};
      for (const [ev, raw] of Object.entries(events)) {
        if (!isObject(raw)) continue;
        const p = isObject(raw['Properties']) ? (intrinsic(raw['Properties']) as JsonObject) : {};
        const evType = raw['Type'];
        if (evType === 'Api' || evType === 'HttpApi') {
          const explicit = p['RestApiId'] ?? p['ApiId'];
          const apiExpr =
            typeof explicit === 'string'
              ? explicit
              : `\${${evType === 'Api' ? 'aws_api_gateway_rest_api' : 'aws_apigatewayv2_api'}.${implicitApi(evType)}.id}`;
          const method = typeof p['Method'] === 'string' ? p['Method'].toUpperCase() : 'ANY';
          const routeKey = typeof p['Path'] === 'string' ? `${method} ${p['Path']}` : '$default';
          const integId = `${id}${ev}Integration`;
          put('aws_apigatewayv2_integration', integId, {
            api_id: apiExpr,
            integration_uri: fnRef,
          });
          put('aws_apigatewayv2_route', `${id}${ev}Route`, {
            api_id: apiExpr,
            route_key: routeKey,
            target: `integrations/\${aws_apigatewayv2_integration.${integId}.id}`,
          });
        } else if (evType === 'SQS' || evType === 'Kinesis' || evType === 'DynamoDB') {
          const src = p['Queue'] ?? p['Stream'];
          if (typeof src === 'string')
            put('aws_lambda_event_source_mapping', `${id}${ev}`, {
              event_source_arn: src,
              function_name: fnRef,
            });
        } else if (evType === 'SNS' && typeof p['Topic'] === 'string') {
          put('aws_sns_topic_subscription', `${id}${ev}`, {
            topic_arn: p['Topic'],
            endpoint: fnRef,
          });
        }
      }
    }
  }
  return { tf: { resource: out }, cdkPaths };
}

const rename = (o: JsonObject, from: string, to: string) => {
  if (from in o && !(to in o)) {
    o[to] = o[from]!;
    delete o[from];
  }
};

/** tf-graph が読む属性名に寄せる */
function fixup(cfnType: string, type: string, p: JsonObject): JsonObject {
  const b: JsonObject = { ...p };
  switch (type) {
    case 'aws_lambda_function': {
      const code = b['code'];
      if (isObject(code) && typeof code['image_uri'] === 'string')
        b['image_uri'] = code['image_uri'];
      if (cfnType === 'AWS::Serverless::Function') {
        rename(b, 'code_uri', 'filename');
        delete b['events']; // イベントは route / event source mapping などに分けて合成する
      }
      break;
    }
    case 'aws_lambda_function_url':
      rename(b, 'target_function_arn', 'function_name');
      break;
    case 'aws_cloudfront_distribution': {
      const cfg = isObject(b['distribution_config']) ? b['distribution_config'] : {};
      delete b['distribution_config'];
      Object.assign(b, cfg);
      rename(b, 'origins', 'origin');
      rename(b, 'cache_behaviors', 'ordered_cache_behavior');
      const behaviors = [
        b['default_cache_behavior'],
        ...(Array.isArray(b['ordered_cache_behavior']) ? b['ordered_cache_behavior'] : []),
      ];
      for (const beh of behaviors) {
        if (!isObject(beh)) continue;
        rename(beh, 'function_associations', 'function_association');
        rename(beh, 'lambda_function_associations', 'lambda_function_association');
        for (const a of Array.isArray(beh['lambda_function_association'])
          ? beh['lambda_function_association']
          : []) {
          if (isObject(a)) rename(a, 'lambda_function_arn', 'lambda_arn');
        }
      }
      break;
    }
    case 'aws_s3_bucket':
      rename(b, 'bucket_name', 'bucket');
      break;
    case 'aws_dynamodb_table':
      rename(b, 'table_name', 'name');
      break;
    case 'aws_sqs_queue':
      rename(b, 'queue_name', 'name');
      break;
    case 'aws_sns_topic':
      rename(b, 'topic_name', 'name');
      break;
    case 'aws_cognito_user_pool':
      rename(b, 'user_pool_name', 'name');
      break;
    case 'aws_rds_cluster':
      rename(b, 'db_cluster_identifier', 'cluster_identifier');
      break;
    case 'aws_rds_cluster_instance':
      rename(b, 'db_cluster_identifier', 'cluster_identifier');
      rename(b, 'db_instance_identifier', 'identifier');
      break;
    case 'aws_db_instance':
      rename(b, 'db_instance_identifier', 'identifier');
      break;
    case 'aws_elasticache_cluster':
      rename(b, 'cluster_name', 'cluster_id');
      break;
    case 'aws_ecr_repository':
      rename(b, 'repository_name', 'name');
      break;
    case 'aws_sfn_state_machine':
      rename(b, 'state_machine_name', 'name');
      break;
    case 'aws_ecs_service':
      rename(b, 'service_name', 'name');
      break;
    case 'aws_lb':
      rename(b, 'type', 'load_balancer_type');
      break;
    case 'aws_apigatewayv2_api':
      if (cfnType === 'AWS::Serverless::HttpApi') b['protocol_type'] = 'HTTP';
      break;
  }
  return b;
}
