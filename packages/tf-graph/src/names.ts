/**
 * ノードの表示名。名前の属性が式のまま（`${var.env}-api` など）なら論理 ID を使う。
 */
import type { TfResource } from './types.js';
import { literal, str } from './util.js';

export function humanName(r: TfResource, isEdge: boolean, label?: string): string {
  const b = r.body;
  const fallback = label ?? r.logicalId;
  const nameAttr = (_r: TfResource, ...keys: string[]): string => {
    for (const k of keys) {
      const v = literal(b[k]);
      if (v) return v;
    }
    return fallback;
  };
  switch (r.type) {
    case 'aws_cloudfront_distribution':
      return 'CloudFront';
    case 'aws_cloudfront_function':
      return `CloudFront Function ${nameAttr(r, 'name')}`;
    case 'aws_lambda_function':
      return isEdge ? `Lambda@Edge: ${fallback}` : `Lambda: ${fallback}`;
    case 'aws_apigatewayv2_api': {
      const p = str(b['protocol_type']) ?? 'HTTP';
      return `API Gateway (${p === 'WEBSOCKET' ? 'WebSocket' : p.includes('${') ? 'HTTP' : p})`;
    }
    case 'aws_api_gateway_rest_api':
      return 'API Gateway (REST)';
    case 'aws_appsync_graphql_api':
      return `AppSync ${nameAttr(r, 'name')}`;
    case 'aws_dynamodb_table':
      return `DynamoDB ${nameAttr(r, 'name')}`;
    case 'aws_s3_bucket':
      return `S3 ${nameAttr(r, 'bucket')}`;
    case 'aws_cognito_user_pool':
      return `Cognito ${nameAttr(r, 'name')}`;
    case 'aws_sqs_queue':
      return `SQS ${nameAttr(r, 'name')}`;
    case 'aws_sns_topic':
      return `SNS ${nameAttr(r, 'name')}`;
    case 'aws_rds_cluster': {
      const engine = str(b['engine']) ?? '';
      return `${engine.startsWith('aurora') ? 'Aurora' : 'RDS'} ${nameAttr(r, 'cluster_identifier')}`;
    }
    case 'aws_rds_cluster_instance':
    case 'aws_db_instance':
      return `RDS ${nameAttr(r, 'identifier')}`;
    case 'aws_elasticache_cluster':
      return `ElastiCache ${nameAttr(r, 'cluster_id')}`;
    case 'aws_elasticache_replication_group':
      return `ElastiCache ${nameAttr(r, 'replication_group_id')}`;
    case 'aws_ecr_repository':
      return `ECR ${nameAttr(r, 'name')}`;
    case 'aws_cloudwatch_event_rule':
      return `EventBridge rule ${nameAttr(r, 'name')}`;
    case 'aws_scheduler_schedule':
      return `Scheduler ${nameAttr(r, 'name')}`;
    case 'aws_sfn_state_machine':
      return `Step Functions ${nameAttr(r, 'name')}`;
    case 'aws_ecs_service':
      return `ECS ${nameAttr(r, 'name')}`;
    case 'aws_lb':
    case 'aws_alb': {
      const t = str(b['load_balancer_type']);
      return `${t === 'network' ? 'NLB' : 'ALB'} ${nameAttr(r, 'name')}`;
    }
    case 'aws_ses_receipt_rule':
      return `SES rule ${nameAttr(r, 'name')}`;
    case 'aws_secretsmanager_secret':
      return `Secret ${nameAttr(r, 'name')}`;
    case 'google_cloudfunctions_function':
    case 'google_cloudfunctions2_function':
      return `Cloud Functions: ${nameAttr(r, 'name')}`;
    case 'google_pubsub_topic':
      return `Pub/Sub ${nameAttr(r, 'name')}`;
    case 'google_pubsub_subscription':
      return `Pub/Sub sub ${nameAttr(r, 'name')}`;
    case 'google_cloud_run_v2_service':
    case 'google_cloud_run_service':
      return `Cloud Run ${nameAttr(r, 'name')}`;
    case 'google_storage_bucket':
      return `GCS ${nameAttr(r, 'name')}`;
    default:
      return `${r.type}.${fallback}`;
  }
}
