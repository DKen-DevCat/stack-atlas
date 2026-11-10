import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { PartialGraph, RepoContext, StackAtlasConfig } from '@stack-atlas/core';
import { extractor, findRoot } from './index.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../test/fixtures/hcl');

function ctxFor(config: StackAtlasConfig = {}, warns: string[] = []): RepoContext {
  return {
    root,
    config,
    repoName: 'platform',
    repos: { platform: root },
    configDir: root,
    log: { debug() {}, info() {}, warn: (m) => warns.push(m), error() {} },
    resolve: (...s) => resolve(root, ...s),
  };
}

const CF = 'infra:site/aws_cloudfront_distribution.site';
const S3 = 'infra:site/aws_s3_bucket.site';

describe('terraform extractor', async () => {
  const warns: string[] = [];
  const g = await extractor.extract(ctxFor({}, warns), { nodes: [], edges: [] });
  const byId = new Map(g.nodes.map((n) => [n.id, n]));
  const hasEdge = (gr: PartialGraph, from: string, to: string) =>
    gr.edges.some((e) => e.from === from && e.to === to && e.kind === 'flow');

  it('detects and picks envs/dev as the root (not modules/*, not envs/prod)', async () => {
    expect(await extractor.detect(ctxFor())).toBe(true);
    expect(findRoot(ctxFor())).toBe(resolve(root, 'infra/envs/dev'));
    expect(findRoot(ctxFor({ terraform: { root: 'infra/envs/prod' } }))).toBe(
      resolve(root, 'infra/envs/prod'),
    );
    expect(await extractor.detect(ctxFor({ terraform: { root: 'nope' } }))).toBe(false);
    expect(await extractor.detect(ctxFor({ terraform: { repo: 'web' } }))).toBe(false);
  });

  it('emits module-qualified ids for allowlisted resources only', () => {
    expect([...byId.keys()].sort()).toEqual(
      [
        'infra:app',
        'infra:db/this',
        'infra:db/db',
        'infra:lambda/api',
        CF,
        S3,
        'infra:site/index',
      ].sort(),
    );
  });

  it('excludes plumbing, the function URL and the cluster instance (hops)', () => {
    for (const id of byId.keys()) expect(id).not.toMatch(/^infra:network\//);
    for (const id of [
      'infra:lambda/aws_lambda_function_url.api',
      'infra:db/aws_rds_cluster_instance.this',
    ]) {
      expect(byId.has(id)).toBe(false);
    }
    const types = g.nodes.map((n) => (n.meta?.['infra'] as { type: string }).type);
    for (const t of [
      'aws_iam_role',
      'aws_cloudwatch_log_group',
      'aws_lambda_function_url',
      'aws_rds_cluster_instance',
      'aws_secretsmanager_secret_version',
      'random_password',
      'aws_cloudfront_origin_access_control',
      'aws_s3_bucket_versioning',
      'aws_ssm_parameter',
    ]) {
      expect(types).not.toContain(t);
    }
  });

  it('resolves var / local / module outputs across modules into edges', () => {
    // var.db_secret_arn → module.db.secret_arn → aws_secretsmanager_secret.db.arn
    expect(hasEdge(g, 'infra:lambda/api', 'infra:db/db')).toBe(true);
    expect(
      g.edges.find((e) => e.from === 'infra:lambda/api' && e.to === 'infra:db/db')?.label,
    ).toBe('environment.DB_SECRET_ARN');
    // var.image_uri → root の "${aws_ecr_repository.app.repository_url}:api"
    expect(hasEdge(g, 'infra:lambda/api', 'infra:app')).toBe(true);
    // CloudFront origin → var.api_url → module.lambda.function_url → Function URL（ホップ）→ Lambda
    expect(hasEdge(g, CF, 'infra:lambda/api')).toBe(true);
    expect(hasEdge(g, CF, S3)).toBe(true);
    expect(hasEdge(g, CF, 'infra:site/index')).toBe(true);
    expect(g.edges).toHaveLength(5);
  });

  it('names and meta', () => {
    expect(byId.get('infra:db/this')?.name).toBe('Aurora demo-dev-db');
    expect(byId.get('infra:db/db')?.name).toBe('Secret demo-dev/db');
    expect(byId.get('infra:app')?.name).toBe('ECR demo-dev-app');
    expect(byId.get(S3)?.name).toBe('S3 demo-dev-web');
    expect(byId.get('infra:site/index')?.name).toBe('CloudFront Function demo-dev-index');
    expect(byId.get('infra:lambda/api')?.name).toBe('Lambda: api');
    const api = byId.get('infra:lambda/api')!;
    expect(api.meta?.['infra']).toEqual({
      type: 'aws_lambda_function',
      logicalId: 'api',
      path: 'module.lambda.aws_lambda_function.api',
      stack: 'dev',
      module: 'lambda',
      functionUrl: true,
    });
    expect(api.meta?.['cdktf']).toEqual({
      type: 'aws_lambda_function',
      logicalId: 'api',
      path: 'module.lambda.aws_lambda_function.api',
      stack: 'dev',
    });
    expect(api.meta?.['extractors']).toEqual(['terraform']);
    expect((byId.get('infra:app')?.meta?.['infra'] as { module?: string }).module).toBeUndefined();
  });

  it('resolves file / line / code from the .tf source', () => {
    const api = byId.get('infra:lambda/api')!;
    expect(api.file).toBe('infra/modules/lambda/main.tf');
    expect(api.line).toBe(10);
    expect(api.code?.split('\n')[0]).toBe('resource "aws_lambda_function" "api" {');
    expect(api.code?.split('\n').length).toBeLessThanOrEqual(25);
    expect(byId.get('infra:app')?.file).toBe('infra/envs/dev/main.tf');
    expect(byId.get(CF)?.code?.trim().endsWith('}')).toBe(false); // 25 行で切る
  });

  it('CloudFront cache with the CloudFront Function association', () => {
    const c = byId.get(CF)!.cache!;
    expect(c.badge).toBe('CDN 2 behaviors');
    expect(c.rules?.find((r) => r.key === '/api/*')?.value).toContain('CachingDisabled');
    expect(c.rules?.find((r) => r.key === 'viewer-request (*)')?.value).toBe(
      'CloudFront Function demo-dev-index',
    );
    expect(c.note).toContain('CloudFront Function');
    expect(byId.get('infra:site/index')?.cache).toMatchObject({
      tone: 'info',
      badge: 'キャッシュ判定の前',
    });
  });

  it('warns about non-local module sources', () => {
    expect(warns.some((w) => w.includes('remote_vpc'))).toBe(true);
  });

  it('honours infra include / exclude / all', async () => {
    const inc = await extractor.extract(
      ctxFor({
        infra: {
          include: ['aws_cloudwatch_log_group', 'aws_ssm_*'],
          exclude: ['aws_secretsmanager_*'],
        },
      }),
      { nodes: [], edges: [] },
    );
    const ids = inc.nodes.map((n) => n.id);
    expect(ids).toContain('infra:db/endpoint');
    expect(ids).not.toContain('infra:db/db');
    expect(ids.some((id) => id.includes('aws_cloudwatch_log_group.api'))).toBe(true);
    // log group と Lambda が同名なので衝突 → 末尾が <type>.<name>
    expect(ids).toContain('infra:lambda/aws_lambda_function.api');
    expect(hasEdge(inc, 'infra:db/endpoint', 'infra:db/this')).toBe(true);

    const all = await extractor.extract(ctxFor({ infra: { all: true } }), { nodes: [], edges: [] });
    const allTypes = all.nodes.map((n) => (n.meta?.['infra'] as { type: string }).type);
    expect(allTypes).toContain('aws_ssm_parameter');
    for (const t of [
      'aws_iam_role',
      'aws_subnet',
      'aws_vpc',
      'random_password',
      'aws_lambda_function_url',
    ]) {
      expect(allTypes).not.toContain(t);
    }
  });
});

describe('read の申告（docs/23 §3.1。2026-11-11 Phase 9-L0 のレビュー）', () => {
  it('解析できた .tf と .tfvars だけを申告する（解析できない .tfvars・.tf は読んだことにしない）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'stack-atlas-tfread-'));
    mkdirSync(join(dir, 'infra'), { recursive: true });
    writeFileSync(
      join(dir, 'infra', 'main.tf'),
      'resource "aws_s3_bucket" "b" {\n  bucket = var.name\n}\nvariable "name" {}\n',
    );
    writeFileSync(join(dir, 'infra', 'broken.tf'), 'resource "x" {{{\n');
    writeFileSync(join(dir, 'infra', 'terraform.tfvars'), 'name = "a"\n');
    writeFileSync(join(dir, 'infra', 'bad.auto.tfvars'), 'name = = =\n');
    const ctx: RepoContext = {
      root: dir,
      config: { terraform: { root: 'infra' } },
      repoName: 'r',
      repos: { r: dir },
      configDir: dir,
      log: { debug() {}, info() {}, warn() {}, error() {} },
      resolve: (...s) => resolve(dir, ...s),
    };
    const g = await extractor.extract(ctx, { nodes: [], edges: [] });
    expect(g.read).toEqual(['infra/main.tf', 'infra/terraform.tfvars']);
  });
});
