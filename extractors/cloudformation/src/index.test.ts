import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { PartialGraph, RepoContext, StackAtlasConfig } from '@stack-atlas/core';
import { convertTemplate, extractor, listTemplates, parseTemplate, tfTypeOf } from './index.js';

const fixtures = resolve(dirname(fileURLToPath(import.meta.url)), '../test/fixtures');

function ctxFor(dir: string, config: StackAtlasConfig = {}): RepoContext {
  const root = resolve(fixtures, dir);
  return {
    root,
    config,
    repoName: dir,
    repos: { [dir]: root },
    configDir: root,
    log: { debug() {}, info() {}, warn() {}, error() {} },
    resolve: (...s) => resolve(root, ...s),
  };
}
const edge = (g: PartialGraph, from: string, to: string) =>
  g.edges.find((e) => e.from === from && e.to === to && e.kind === 'flow');

describe('type mapping and intrinsics', () => {
  it('maps CFn types to Terraform types', () => {
    expect(tfTypeOf('AWS::Lambda::Function')).toBe('aws_lambda_function');
    expect(tfTypeOf('AWS::ApiGatewayV2::Api')).toBe('aws_apigatewayv2_api');
    expect(tfTypeOf('AWS::Serverless::Function')).toBe('aws_lambda_function');
    expect(tfTypeOf('AWS::IAM::Role')).toBe('aws_iam_role');
    expect(tfTypeOf('AWS::IAM::ManagedPolicy')).toBe('aws_iam_managed_policy');
    expect(tfTypeOf('Custom::Foo')).toBe('cfn_custom_resource');
  });

  it('turns Ref / GetAtt / Sub / Join into ${...} references', () => {
    const tpl = parseTemplate(
      't.yaml',
      [
        'Resources:',
        '  Q: { Type: AWS::SQS::Queue }',
        '  F:',
        '    Type: AWS::Lambda::Function',
        '    Properties:',
        '      Environment:',
        '        Variables:',
        '          A: !Ref Q',
        '          B: !GetAtt Q.Arn',
        "          C: !Sub '${Q.QueueName}-${AWS::Region}-${!Literal}'",
        "          D: !Join [':', [!Ref Q, x]]",
        '          E: !Ref Param',
      ].join('\n'),
    );
    const { tf } = convertTemplate(tpl);
    const env = (
      tf.resource!['aws_lambda_function']!['F']!['environment'] as Record<string, unknown>
    )['variables'];
    expect(env).toEqual({
      A: '${aws_sqs_queue.Q.id}',
      B: '${aws_sqs_queue.Q.arn}',
      C: '${aws_sqs_queue.Q.queue_name}-${var.AWS_Region}-Literal',
      D: '${aws_sqs_queue.Q.id}:x',
      E: '${var.Param}',
    });
  });
});

describe('cloudformation extractor: CDK (cdk.out)', async () => {
  const ctx = ctxFor('cdk');
  const g = await extractor.extract(ctx, { nodes: [], edges: [] });
  const byId = new Map(g.nodes.map((n) => [n.id, n]));

  it('detects cdk.out templates', async () => {
    expect(listTemplates(ctx)).toEqual(['cdk.out/AppStack.template.json']);
    expect(
      await extractor.detect(ctxFor('cdk', { cloudformation: { templates: ['none/*.json'] } })),
    ).toBe(false);
    expect(await extractor.detect(ctxFor('cdk', { cloudformation: { repo: 'other' } }))).toBe(
      false,
    );
  });

  it('nodes: allowlisted types only, CDK internals and plumbing skipped', () => {
    expect([...byId.keys()].sort()).toEqual(
      [
        'infra:ApiHandler5E7490E8',
        'infra:HttpApi',
        'infra:IndexRewrite',
        'infra:ItemsTable',
        'infra:SiteBucket',
        'infra:SiteDistribution',
      ].sort(),
    );
  });

  it('names, cdk path and meta', () => {
    const fn = byId.get('infra:ApiHandler5E7490E8')!;
    expect(fn.name).toBe('Lambda: Handler');
    expect(fn.meta?.['infra']).toEqual({
      type: 'aws_lambda_function',
      logicalId: 'ApiHandler5E7490E8',
      path: 'AppStack/Api/Handler/Resource',
      stack: 'AppStack',
      functionUrl: true,
    });
    expect((fn.meta?.['cdktf'] as { path: string }).path).toBe('AppStack/Api/Handler/Resource');
    expect(fn.meta?.['extractors']).toEqual(['cloudformation']);
    expect(byId.get('infra:ItemsTable')?.name).toBe('DynamoDB items');
    expect(byId.get('infra:SiteBucket')?.name).toBe('S3 demo-site');
    expect(byId.get('infra:IndexRewrite')?.name).toBe('CloudFront Function index-rewrite');
    expect(byId.get('infra:HttpApi')?.meta?.['infra']).toMatchObject({
      apiRoutes: [{ routeKey: 'GET /items', lambdaId: 'infra:ApiHandler5E7490E8' }],
    });
  });

  it('edges: env ref, origins (incl. Function URL hop), integration, function association', () => {
    expect(edge(g, 'infra:ApiHandler5E7490E8', 'infra:ItemsTable')?.label).toBe(
      'environment.TABLE',
    );
    expect(edge(g, 'infra:SiteDistribution', 'infra:SiteBucket')?.label).toBe('origin.domain_name');
    expect(edge(g, 'infra:SiteDistribution', 'infra:ApiHandler5E7490E8')).toBeDefined();
    expect(edge(g, 'infra:HttpApi', 'infra:ApiHandler5E7490E8')).toBeDefined();
    expect(edge(g, 'infra:SiteDistribution', 'infra:IndexRewrite')).toBeDefined();
    expect(g.edges).toHaveLength(5);
  });

  it('file / line / cache', () => {
    const cdn = byId.get('infra:SiteDistribution')!;
    expect(cdn.file).toBe('cdk.out/AppStack.template.json');
    expect(cdn.line).toBeGreaterThan(1);
    expect(cdn.code).toContain('"SiteDistribution"');
    expect(cdn.cache?.badge).toBe('CDN 2 behaviors');
    expect(cdn.cache?.rules?.find((r) => r.key === '/api/*')?.value).toContain('CachingDisabled');
    expect(cdn.cache?.note).toContain('index-rewrite');
  });
});

describe('cloudformation extractor: SAM (template.yaml)', async () => {
  const ctx = ctxFor('sam');
  const g = await extractor.extract(ctx, { nodes: [], edges: [] });
  const byId = new Map(g.nodes.map((n) => [n.id, n]));

  it('detects template.yaml and makes nodes incl. the implicit REST API', async () => {
    expect(await extractor.detect(ctx)).toBe(true);
    expect([...byId.keys()].sort()).toEqual(
      [
        'infra:GetItemFunction',
        'infra:ItemsTable',
        'infra:JobsQueue',
        'infra:Nightly',
        'infra:ServerlessRestApi',
        'infra:WorkerFunction',
      ].sort(),
    );
    expect(byId.get('infra:ServerlessRestApi')?.name).toBe('API Gateway (REST)');
    expect(byId.get('infra:JobsQueue')?.name).toBe('SQS JobsQueue'); // 名前が式なら論理 ID
    expect(byId.get('infra:Nightly')?.name).toBe('Scheduler nightly');
  });

  it('events become routes, event source mappings and edges', () => {
    expect(byId.get('infra:ServerlessRestApi')?.meta?.['infra']).toMatchObject({
      apiRoutes: [{ routeKey: 'GET /items/{id}', lambdaId: 'infra:GetItemFunction' }],
    });
    expect(edge(g, 'infra:ServerlessRestApi', 'infra:GetItemFunction')).toBeDefined();
    expect(edge(g, 'infra:JobsQueue', 'infra:WorkerFunction')?.label).toBe('event source');
    expect(edge(g, 'infra:WorkerFunction', 'infra:JobsQueue')).toBeUndefined();
    expect(edge(g, 'infra:Nightly', 'infra:WorkerFunction')?.label).toBe('target.arn');
    expect(edge(g, 'infra:GetItemFunction', 'infra:ItemsTable')?.label).toContain(
      'environment.TABLE',
    );
    expect(byId.get('infra:WorkerFunction')?.meta?.['infra']).toMatchObject({ functionUrl: true });
  });

  it('file / line from the YAML', () => {
    const fn = byId.get('infra:GetItemFunction')!;
    expect(fn.file).toBe('template.yaml');
    expect(fn.line).toBe(13);
    expect(fn.code?.split('\n')[0]).toBe('  GetItemFunction:');
  });
});
