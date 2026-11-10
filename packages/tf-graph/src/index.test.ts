import { describe, expect, it } from 'vitest';
import {
  buildInfraGraph,
  collectRefs,
  collectTokens,
  makeNodeTypeFilter,
  normalizeHclJson,
  type TfJson,
} from './index.js';

const build = (tf: TfJson | TfJson[], opts: Partial<Parameters<typeof buildInfraGraph>[1]> = {}) =>
  buildInfraGraph(Array.isArray(tf) ? tf : [tf], { extractor: 'test', ...opts });

describe('references', () => {
  it('matches any provider prefix, module qualifiers and indexes; skips data/var', () => {
    const refs = collectRefs({
      a: '${aws_lambda_function.api.arn}',
      b: { c: '${google_pubsub_topic.t.id}-${data.aws_caller_identity.me.account_id}' },
      d: ['${mod:db:aws_secretsmanager_secret.db.arn}', '${aws_s3_bucket.b[0].arn}'],
      e: '${var.x} ${local.y} ${module.m.out} ${each.value.name}',
      f: 'aws_s3_bucket.not_interpolated.arn',
    });
    expect(refs.map((r) => [r.type, r.logicalId, r.attr, r.at, r.module])).toEqual([
      ['aws_lambda_function', 'api', 'arn', 'a', undefined],
      ['google_pubsub_topic', 't', 'id', 'b.c', undefined],
      ['aws_secretsmanager_secret', 'db', 'arn', 'd', 'db'],
      ['aws_s3_bucket', 'b', 'arn', 'd', undefined],
    ]);
  });

  it('surfaces var / local / module tokens', () => {
    const t = collectTokens({
      x: '${merge(var.a, local.b)} ${module.net[0].ids} ${mod:a/b:var.c}',
    });
    expect(t.map((x) => [x.kind, x.name, x.output, x.module])).toEqual([
      ['var', 'a', undefined, undefined],
      ['local', 'b', undefined, undefined],
      ['module', 'net', 'ids', undefined],
      ['var', 'c', undefined, 'a/b'],
    ]);
  });

  it('handles nested braces inside interpolations', () => {
    expect(collectRefs('${jsonencode({ a = aws_sqs_queue.q.arn })}')[0]?.logicalId).toBe('q');
  });
});

describe('allowlist', () => {
  it('default, include, exclude, all, plumbing', () => {
    const def = makeNodeTypeFilter();
    expect(def('aws_lambda_function')).toBe(true);
    expect(def('aws_scheduler_schedule')).toBe(true);
    expect(def('google_cloud_run_v2_service')).toBe(true);
    expect(def('aws_ssm_parameter')).toBe(false);
    expect(def('aws_iam_role')).toBe(false);
    const all = makeNodeTypeFilter({ all: true, exclude: ['aws_ecr_*'] });
    expect(all('aws_ssm_parameter')).toBe(true);
    expect(all('aws_ecr_repository')).toBe(false);
    for (const t of [
      'aws_iam_role',
      'google_project_iam_member',
      'aws_security_group_rule',
      'aws_subnet',
      'aws_route_table_association',
      'aws_cloudwatch_log_group',
      'aws_lambda_permission',
      'aws_apigatewayv2_stage',
      'aws_apigatewayv2_route',
      'aws_cloudfront_origin_access_control',
      'random_password',
      'null_resource',
      'aws_s3_bucket_versioning',
      'aws_lambda_function_url',
    ]) {
      expect(all(t)).toBe(false);
    }
    const inc = makeNodeTypeFilter({ include: ['google_*', 'aws_cloudwatch_log_group'] });
    expect(inc('google_anything')).toBe(true);
    expect(inc('google_project_iam_member')).toBe(false); // glob では配管を出さない
    expect(inc('aws_cloudwatch_log_group')).toBe(true); // 型名そのものなら出す
  });
});

describe('buildInfraGraph', () => {
  it('API Gateway v2 routes, function URLs and meta.infra', () => {
    const g = build({
      resource: {
        aws_apigatewayv2_api: { http: { protocol_type: 'HTTP' } },
        aws_lambda_function: { fn: { function_name: 'fn' } },
        aws_lambda_function_url: {
          url: { function_name: '${aws_lambda_function.fn.function_name}' },
        },
        aws_apigatewayv2_integration: {
          i: {
            api_id: '${aws_apigatewayv2_api.http.id}',
            integration_uri: '${aws_lambda_function.fn.invoke_arn}',
          },
        },
        aws_apigatewayv2_route: {
          r1: {
            api_id: '${aws_apigatewayv2_api.http.id}',
            route_key: 'GET /items/{id}',
            target: 'integrations/${aws_apigatewayv2_integration.i.id}',
          },
        },
      },
    });
    expect(g.routes).toEqual([
      { apiId: 'infra:http', routeKey: 'GET /items/{id}', lambdaId: 'infra:fn', version: 'v2' },
    ]);
    expect(g.functionUrls).toEqual([{ lambdaId: 'infra:fn', urlResource: 'url' }]);
    const api = g.nodes.find((n) => n.id === 'infra:http')!;
    expect(api.meta?.['infra']).toMatchObject({
      apiRoutes: [{ routeKey: 'GET /items/{id}', lambdaId: 'infra:fn' }],
    });
    expect(api.name).toBe('API Gateway (HTTP)');
    expect(api.cache?.badge).toBe('キャッシュなし');
    expect(g.nodes.find((n) => n.id === 'infra:fn')?.meta?.['infra']).toMatchObject({
      functionUrl: true,
    });
    expect(g.edges).toEqual([
      { from: 'infra:http', to: 'infra:fn', kind: 'flow', label: 'integration i' },
    ]);
  });

  it('API Gateway v1 (REST) routes from resource / method / integration', () => {
    const g = build({
      resource: {
        aws_api_gateway_rest_api: { rest: { name: 'r' } },
        aws_lambda_function: { fn: {} },
        aws_api_gateway_resource: {
          items: {
            rest_api_id: '${aws_api_gateway_rest_api.rest.id}',
            parent_id: '${aws_api_gateway_rest_api.rest.root_resource_id}',
            path_part: 'items',
          },
          item: {
            rest_api_id: '${aws_api_gateway_rest_api.rest.id}',
            parent_id: '${aws_api_gateway_resource.items.id}',
            path_part: '{id}',
          },
        },
        aws_api_gateway_method: {
          get: {
            rest_api_id: '${aws_api_gateway_rest_api.rest.id}',
            resource_id: '${aws_api_gateway_resource.item.id}',
            http_method: 'GET',
          },
        },
        aws_api_gateway_integration: {
          getI: {
            rest_api_id: '${aws_api_gateway_rest_api.rest.id}',
            resource_id: '${aws_api_gateway_resource.item.id}',
            http_method: '${aws_api_gateway_method.get.http_method}',
            uri: '${aws_lambda_function.fn.invoke_arn}',
          },
        },
      },
    });
    expect(g.routes).toEqual([
      { apiId: 'infra:rest', routeKey: 'GET /items/{id}', lambdaId: 'infra:fn', version: 'v1' },
    ]);
    const rest = g.nodes.find((n) => n.id === 'infra:rest')!;
    expect(rest.name).toBe('API Gateway (REST)');
    expect(rest.cache?.tone).toBe('off');
    expect(g.edges.some((e) => e.from === 'infra:rest' && e.to === 'infra:fn')).toBe(true);
  });

  it('connectors: event source mapping, event target, SNS subscription', () => {
    const g = build({
      resource: {
        aws_sqs_queue: { q: { name: 'jobs' } },
        aws_sns_topic: { t: { name: 'events' } },
        aws_cloudwatch_event_rule: { rule: { name: 'nightly' } },
        aws_lambda_function: { worker: {} },
        aws_lambda_event_source_mapping: {
          m: {
            event_source_arn: '${aws_sqs_queue.q.arn}',
            function_name: '${aws_lambda_function.worker.arn}',
          },
        },
        aws_cloudwatch_event_target: {
          tg: {
            rule: '${aws_cloudwatch_event_rule.rule.name}',
            arn: '${aws_lambda_function.worker.arn}',
          },
        },
        aws_sns_topic_subscription: {
          s: { topic_arn: '${aws_sns_topic.t.arn}', endpoint: '${aws_sqs_queue.q.arn}' },
        },
      },
    });
    const pairs = g.edges.map((e) => `${e.from}>${e.to}:${e.label}`).sort();
    expect(pairs).toEqual([
      'infra:q>infra:worker:event source',
      'infra:rule>infra:worker:target',
      'infra:t>infra:q:subscription',
    ]);
    expect(g.nodes.find((n) => n.id === 'infra:rule')?.name).toBe('EventBridge rule nightly');
  });

  it('RDS instance: hop to the cluster, or a node when standalone', () => {
    const g = build({
      resource: {
        aws_rds_cluster: { c: { engine: 'aurora-postgresql', cluster_identifier: 'main' } },
        aws_rds_cluster_instance: {
          ci: { cluster_identifier: '${aws_rds_cluster.c.id}' },
          lone: { identifier: 'lone', cluster_identifier: 'external' },
        },
        aws_lambda_function: {
          fn: { environment: { variables: { DB: '${aws_rds_cluster_instance.ci.endpoint}' } } },
        },
      },
    });
    expect(g.nodes.map((n) => n.id).sort()).toEqual(['infra:c', 'infra:fn', 'infra:lone']);
    expect(g.nodes.find((n) => n.id === 'infra:c')?.name).toBe('Aurora main');
    expect(g.edges).toEqual([
      { from: 'infra:fn', to: 'infra:c', kind: 'flow', label: 'environment.DB' },
    ]);
  });

  it('names fall back to the logical id when the name is an expression', () => {
    const g = build({
      resource: {
        aws_s3_bucket: { assets: { bucket: '${var.prefix}-assets' } },
        aws_scheduler_schedule: { daily: { name: 'daily-job' } },
        google_cloud_run_v2_service: { svc: { name: 'svc' } },
      },
    });
    const name = (id: string) => g.nodes.find((n) => n.id === id)?.name;
    expect(name('infra:assets')).toBe('S3 assets');
    expect(name('infra:daily')).toBe('Scheduler daily-job');
    expect(name('infra:svc')).toBe('Cloud Run svc');
    expect(g.unresolved.map((t) => t.text)).toEqual(['var.prefix']);
  });

  it('deployApp heuristics (open-next, config.deploy) and Lambda@Edge', () => {
    const g = build(
      {
        resource: {
          aws_lambda_function: {
            server: { image_uri: '123.dkr.ecr/open-next-server:latest' },
            plain: {},
            edge: { publish: true },
          },
          aws_cloudfront_distribution: {
            cdn: {
              default_cache_behavior: [
                {
                  lambda_function_association: [
                    {
                      event_type: 'origin-request',
                      lambda_arn: '${aws_lambda_function.edge.qualified_arn}',
                    },
                  ],
                },
              ],
            },
          },
        },
      },
      { deploy: { 'infra:plain': { app: 'next' } } },
    );
    const meta = (id: string) => g.nodes.find((n) => n.id === id)?.meta ?? {};
    expect(meta('infra:server')['deployApp']).toBe('next');
    expect(meta('infra:plain')['deployApp']).toBe('next');
    expect(meta('infra:edge')['edge']).toBe(true);
    expect(g.nodes.find((n) => n.id === 'infra:edge')?.cache?.badge).toBe('MISS 時のみ');
    expect(g.nodes.find((n) => n.id === 'infra:edge')?.name).toBe('Lambda@Edge: edge');
  });

  it('documents: stacks, modules and qualified cross-module references', () => {
    const g = build([
      {
        tf: {
          resource: { aws_lambda_function: { fn: { env: '${mod:db:aws_dynamodb_table.t.arn}' } } },
        },
        stack: 'dev',
      },
      {
        tf: { resource: { aws_dynamodb_table: { t: { name: 'items' } } } },
        stack: 'dev',
        module: 'db',
      },
    ] as never);
    expect(g.nodes.map((n) => n.id)).toEqual(['infra:fn', 'infra:db/t']);
    expect(g.edges[0]).toMatchObject({ from: 'infra:fn', to: 'infra:db/t', label: 'env' });
    expect(g.nodes[1]?.meta?.['infra']).toMatchObject({
      module: 'db',
      stack: 'dev',
      path: 'dev/t',
    });
  });
});

describe('normalizeHclJson', () => {
  it('unwraps block arrays and merges locals', () => {
    const n = normalizeHclJson({
      resource: { aws_s3_bucket: { b: [{ bucket: 'x' }] } },
      module: { m: [{ source: './m' }] },
      locals: [{ a: 1 }, { b: 2 }],
      output: { o: [{ value: '${aws_s3_bucket.b.id}' }] },
    });
    expect(n.resource).toEqual({ aws_s3_bucket: { b: { bucket: 'x' } } });
    expect(n.module).toEqual({ m: { source: './m' } });
    expect(n.locals).toEqual({ a: 1, b: 2 });
    expect(n.output).toEqual({ o: { value: '${aws_s3_bucket.b.id}' } });
  });
});
