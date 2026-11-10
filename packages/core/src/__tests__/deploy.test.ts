import { describe, expect, it } from 'vitest';
import { applyDeployConfig } from '../deploy.js';
import type { PartialGraph } from '../types.js';

const graph: PartialGraph = {
  nodes: [
    { id: 'infra:static_site/site', kind: 'infra', meta: { tf: { type: 'aws_s3_bucket' } } },
    { id: 'infra:lambda_api/api', kind: 'infra' },
    { id: 'infra:lambda_api/notify', kind: 'infra' },
    { id: 'infra:lambda_api/migrate', kind: 'infra' },
    { id: 'route:/', kind: 'page', file: 'web/src/app/page.tsx' },
    { id: 'layout:/', kind: 'layout', file: 'web/src/app/layout.tsx' },
    { id: 'comp:X', kind: 'component', file: 'web/src/components/X.tsx' },
    { id: 'handler:cmd/api', kind: 'handler', file: 'platform/cmd/api/main.go' },
    { id: 'lib:cmd/notify', kind: 'lib', meta: { go: { pkg: 'cmd/notify' } } },
    { id: 'handler:migrate', kind: 'handler', file: 'platform/cmd/migrate/main.go' },
    { id: 'handler:getX', kind: 'handler', file: 'web/apps/api/src/handlers/getX.ts' },
  ],
  edges: [],
};
const repos = { web: '../web', platform: '../platform' };
const deploys = (g: PartialGraph) =>
  g.edges.filter((e) => e.kind === 'deploy').map((e) => `${e.from} → ${e.to}`);

describe('applyDeployConfig', () => {
  it('app: next は S3 でも route / layout に張り、deployApp を付ける', () => {
    const { graph: g, issues } = applyDeployConfig(graph, {
      repos,
      deploy: { 'infra:static_site/site': { app: 'next' } },
    });
    expect(issues).toEqual([]);
    expect(deploys(g)).toEqual([
      'infra:static_site/site → route:/',
      'infra:static_site/site → layout:/',
    ]);
    expect(g.nodes[0]!.meta).toEqual({ tf: { type: 'aws_s3_bucket' }, deployApp: 'next' });
  });

  it('go: ID・meta.go.pkg・file のディレクトリで Go のパッケージに張る', () => {
    const { graph: g, issues } = applyDeployConfig(graph, {
      repos,
      deploy: {
        'infra:lambda_api/api': { go: 'cmd/api' },
        'infra:lambda_api/notify': { go: 'cmd/notify/' },
        'infra:lambda_api/migrate': { go: 'cmd/migrate' },
      },
    });
    expect(issues).toEqual([]);
    expect(deploys(g)).toEqual([
      'infra:lambda_api/api → handler:cmd/api',
      'infra:lambda_api/notify → lib:cmd/notify',
      'infra:lambda_api/migrate → handler:migrate',
    ]);
  });

  it('nodes は指定 ID に張り、無い ID・無いキーはエラー、合わない go / handlers は警告', () => {
    const { graph: g, issues } = applyDeployConfig(graph, {
      repos,
      deploy: {
        'infra:lambda_api/api': {
          nodes: ['comp:X', 'comp:Ghost'],
          go: 'cmd/nope',
          handlers: 'x/**',
        },
        'infra:ghost': { app: 'next' },
      },
    });
    expect(deploys(g)).toEqual(['infra:lambda_api/api → comp:X']);
    expect(issues.map((i) => [i.level, i.path])).toEqual([
      ['warning', 'config#/deploy/infra:lambda_api/api/handlers'],
      ['warning', 'config#/deploy/infra:lambda_api/api/go'],
      ['error', 'config#/deploy/infra:lambda_api/api/nodes/1'],
      ['error', 'config#/deploy/infra:ghost'],
    ]);
  });

  it('handlers の glob は repo 相対でも <repo>/ 付きでも合う', () => {
    for (const glob of ['apps/api/src/handlers/**/*.ts', 'web/apps/api/src/handlers/*.ts']) {
      const { graph: g } = applyDeployConfig(graph, {
        repos,
        deploy: { 'infra:lambda_api/api': { handlers: glob } },
      });
      expect(deploys(g)).toEqual(['infra:lambda_api/api → handler:getX']);
    }
  });
});
