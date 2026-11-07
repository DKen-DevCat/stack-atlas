/**
 * どのリソース型をノードにするか（docs/12 §3.3）。許可リストは IaC 共通でここに 1 つ。
 */
import type { InfraFilter } from './types.js';

/** 既定でノードにするリソース型 */
export const DEFAULT_NODE_TYPES = [
  'aws_cloudfront_distribution',
  'aws_cloudfront_function',
  'aws_lambda_function',
  'aws_api_gateway_rest_api',
  'aws_apigatewayv2_api',
  'aws_appsync_graphql_api',
  'aws_dynamodb_table',
  'aws_s3_bucket',
  'aws_cognito_user_pool',
  'aws_sqs_queue',
  'aws_sns_topic',
  'aws_rds_cluster',
  'aws_rds_cluster_instance',
  'aws_db_instance',
  'aws_elasticache_cluster',
  'aws_elasticache_replication_group',
  'aws_ecr_repository',
  'aws_cloudwatch_event_rule',
  'aws_scheduler_schedule',
  'aws_sfn_state_machine',
  'aws_ecs_service',
  'aws_lb',
  'aws_alb',
  'aws_ses_receipt_rule',
  'aws_secretsmanager_secret',
  'google_cloudfunctions_function',
  'google_cloudfunctions2_function',
  'google_pubsub_topic',
  'google_pubsub_subscription',
  'google_cloud_run_v2_service',
  'google_cloud_run_service',
  'google_storage_bucket',
] as const;

/** `all: true` でもノードにしない配管（glob） */
export const PLUMBING_TYPES = [
  'aws_iam_*',
  '*_iam_*',
  'aws_security_group*',
  'aws_vpc_security_group_*',
  'aws_default_*',
  'aws_subnet*',
  '*_subnet_group',
  'aws_route',
  'aws_route_table*',
  'aws_main_route_table_association',
  'aws_network_acl*',
  'aws_vpc',
  'aws_vpc_endpoint*',
  'aws_internet_gateway*',
  'aws_egress_only_internet_gateway',
  'aws_eip*',
  'aws_cloudwatch_log_*',
  '*_policy',
  '*_policy_attachment',
  '*_permission',
  'aws_apigatewayv2_stage',
  'aws_apigatewayv2_integration*',
  'aws_apigatewayv2_route*',
  'aws_apigatewayv2_deployment',
  'aws_api_gateway_stage',
  'aws_api_gateway_deployment',
  'aws_api_gateway_integration*',
  'aws_api_gateway_method*',
  'aws_api_gateway_resource',
  'aws_cloudfront_origin_access_*',
  'aws_cloudfront_cache_policy',
  'aws_cloudfront_origin_request_policy',
  'aws_cloudfront_response_headers_policy',
  'aws_lambda_function_url',
  'aws_lambda_alias',
  'aws_lambda_event_source_mapping',
  'aws_cloudwatch_event_target',
  'aws_sns_topic_subscription',
  'aws_s3_bucket_*',
  'aws_s3_object',
  'aws_dynamodb_table_item',
  'aws_secretsmanager_secret_version',
  'aws_secretsmanager_secret_rotation',
  'aws_ecr_lifecycle_policy',
  'aws_acm_certificate_validation',
  'random_*',
  'null_resource',
  'terraform_data',
  'time_*',
  'tls_*',
  'local_file',
  'archive_file',
  // cloudformation 抽出器が付ける型（CDK の内部リソース・カスタムリソース）
  'cfn_*',
  'aws_cdk_metadata',
] as const;

/** ノードにせず参照の中継にする型（常に。rds cluster instance は cluster を指すときだけ graph 側で中継） */
export const HOP_TYPES: readonly string[] = ['aws_lambda_function_url', 'aws_lambda_alias'];

const globCache = new Map<string, RegExp>();
export function globToRegExp(glob: string): RegExp {
  let re = globCache.get(glob);
  if (!re) {
    const body = glob
      .split('*')
      .map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
      .join('.*');
    re = new RegExp(`^${body}$`);
    globCache.set(glob, re);
  }
  return re;
}

export const matchesAny = (type: string, globs: readonly string[] | undefined): boolean =>
  !!globs?.some((g) => globToRegExp(g).test(type));

export const isPlumbing = (type: string): boolean => matchesAny(type, PLUMBING_TYPES);

/** 型がノード対象か（rds cluster instance のホップ判定は graph 側） */
export function makeNodeTypeFilter(filter: InfraFilter = {}): (type: string) => boolean {
  return (type) => {
    if (matchesAny(type, filter.exclude)) return false;
    // include に型名そのもの（* なし）を書いたときだけ配管も出す
    if (filter.include?.includes(type) && !HOP_TYPES.includes(type)) return true;
    if (isPlumbing(type)) return false;
    if (filter.all) return true;
    return (
      (DEFAULT_NODE_TYPES as readonly string[]).includes(type) || matchesAny(type, filter.include)
    );
  };
}
