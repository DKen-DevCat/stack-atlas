import { validateGraph } from '@stack-atlas/schema';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createRepoContext } from '../config.js';
import { createMemoryLogger } from '../logger.js';
import { buildGraph } from '../pipeline.js';
import { fileInRepo, repoFile, resolveRepos, splitRepoFile } from '../repo.js';
import { sectionFor, type Extractor, type RepoScoped } from '../types.js';
import { tmpRepo } from './helpers.js';

const NOW = new Date('2026-11-07T00:00:00Z');

/** config の隣に web/ と platform/ を持つワークスペース */
function workspace(extraConfig = '', withFlows = false): string {
  return tmpRepo({
    'atlas/stack-atlas.config.yaml': `project: { name: poly }
repos:
  web: ../web
  platform: ../platform
go: { repo: platform, module: example.com/p }
${extraConfig}`,
    ...(withFlows ? { 'atlas/flows.yaml': FLOWS } : {}),
    'web/src/a.ts': 'export const a = 1;\n',
    'platform/cmd/api/main.go': 'package main\n',
    'platform/platform/x.go': 'package platform\n',
  });
}

const FLOWS = `- id: f
  name: フロー
  steps:
    - [lib:web/src/a, 呼ぶ]
    - [handler:cmd/api, 返す]
`;

/** ctx.config.go が自分の repo に向いているときだけ Go のノードを出すスタブ */
const goStub: Extractor = {
  name: 'go',
  detect: async (ctx) => !!sectionFor(ctx, ctx.config.go),
  extract: async () => ({
    nodes: [
      {
        id: 'handler:cmd/api',
        kind: 'handler',
        file: 'cmd/api/main.go',
        meta: { go: { pkg: 'cmd/api' } },
      },
      // repo 名と同じディレクトリ: 実在する repo 相対パスなので修飾する
      { id: 'lib:platform', kind: 'lib', file: 'platform/x.go' },
    ],
    edges: [{ from: 'handler:cmd/api', to: 'lib:platform', kind: 'uses' }],
  }),
};

describe('buildGraph（複数 repo）', () => {
  it('repo ごとに抽出器を回し、file を <repo>/ で修飾し、sources に repo 名を並べる', async () => {
    const root = workspace('', true);
    const seen: string[] = [];
    const tsStub: Extractor = {
      name: 'ts',
      detect: async () => true,
      extract: async (ctx, up) => {
        seen.push(`${ctx.repoName}:${up.nodes.map((n) => n.file).join(',')}`);
        expect(ctx.configDir).toBe(join(root, 'atlas'));
        expect(Object.keys(ctx.repos)).toEqual(['web', 'platform']);
        if (ctx.repoName !== 'web') return { nodes: [], edges: [] };
        // 自分で修飾済みのもの（repoFile）は二重にしない
        return {
          nodes: [
            { id: 'lib:web/src/a', kind: 'lib', file: repoFile(ctx, 'src/a.ts') },
            { id: 'infra:x', kind: 'infra' },
          ],
          edges: [{ from: 'lib:web/src/a', to: 'handler:cmd/api', kind: 'http' }],
        };
      },
    };
    const log = createMemoryLogger();
    const res = await buildGraph({
      root: join(root, 'atlas'),
      extractors: [goStub, tsStub],
      log,
      now: NOW,
      commit: false,
    });
    expect(res.issues.filter((i) => i.level === 'error')).toEqual([]);
    // go は platform だけ、ts は両方（go の結果を upstream で修飾済みで受け取る）
    expect(res.reports[0]!.repos).toEqual({
      web: { status: 'not-detected', nodes: 0, edges: 0, flows: 0 },
      platform: { status: 'ok', nodes: 2, edges: 1, flows: 0 },
    });
    expect(res.reports[0]).toMatchObject({ name: 'go', status: 'ok', nodes: 2, edges: 1 });
    expect(seen[0]).toBe('web:platform/cmd/api/main.go,platform/platform/x.go');
    expect(res.repos).toEqual({ web: join(root, 'web'), platform: join(root, 'platform') });
    const files = Object.fromEntries(res.graph.nodes.map((n) => [n.id, n.file]));
    expect(files).toEqual({
      'handler:cmd/api': 'platform/cmd/api/main.go',
      'lib:platform': 'platform/platform/x.go',
      'lib:web/src/a': 'web/src/a.ts',
      'infra:x': undefined,
    });
    expect(res.graph.project).toEqual({
      name: 'poly',
      repo: 'atlas',
      generatedAt: '2026-11-07T00:00:00.000Z',
      sources: ['web', 'platform'],
    });
    // flows.yaml は config のディレクトリから読む
    expect(res.graph.flows?.map((f) => f.id)).toEqual(['f']);
    expect(log.of('info').some((m) => m.startsWith('- [platform] go: ノード 2'))).toBe(true);
    expect(validateGraph(res.graph).ok).toBe(true);
  });

  it('classify は repo 相対の glob と rule.repo で照合する。deploy.go はパッケージへ張る', async () => {
    const root = workspace(`
classify:
  - { glob: "cmd/**", repo: web, kind: component }
  - { glob: "platform/*.go", kind: schema }
  - { glob: "cmd/**", layer: infra }
deploy:
  "infra:fn": { go: cmd/api }
`);
    const infra: Extractor = {
      name: 'infra',
      detect: async (ctx) => ctx.repoName === 'platform',
      extract: async () => ({ nodes: [{ id: 'infra:fn', kind: 'infra' }], edges: [] }),
    };
    const res = await buildGraph({
      root: join(root, 'atlas'),
      extractors: [infra, goStub],
      commit: false,
    });
    expect(res.issues.filter((i) => i.level === 'error')).toEqual([]);
    const node = (id: string) => res.graph.nodes.find((n) => n.id === id)!;
    expect(node('handler:cmd/api')).toMatchObject({ kind: 'handler', layer: 'infra' });
    expect(node('lib:platform')).toMatchObject({ kind: 'schema', layer: 'types' });
    expect(res.graph.edges).toContainEqual({
      from: 'infra:fn',
      to: 'handler:cmd/api',
      kind: 'deploy',
    });
  });

  it('無い repo のディレクトリはエラーにして、残りの repo で続ける', async () => {
    const root = tmpRepo({
      'stack-atlas.config.yaml': 'repos: { here: ".", gone: ../nope-xyz }\n',
    });
    const res = await buildGraph({
      root,
      commit: false,
      extractors: [
        {
          name: 'a',
          detect: async () => true,
          extract: async (ctx) => ({
            nodes: [{ id: `lib:${ctx.repoName}`, file: 'x.ts' }],
            edges: [],
          }),
        },
      ],
    });
    expect(res.issues).toContainEqual(
      expect.objectContaining({ level: 'error', path: 'config#/repos/gone' }),
    );
    // 残りが 1 つなので単一 repo 扱い（file はそのまま）
    expect(res.graph.nodes).toMatchObject([{ id: 'lib:here', file: 'x.ts' }]);
  });
});

describe('repo.ts', () => {
  it('resolveRepos: 省略時は config のディレクトリ 1 つ', () => {
    const root = tmpRepo();
    mkdirSync(join(root, 'w'));
    expect(resolveRepos(root, {}).repos).toEqual({ [root.split('/').pop()!]: root });
    expect(resolveRepos(root, { repos: { web: 'w' } }).repos).toEqual({ web: join(root, 'w') });
    expect(resolveRepos(root, { repos: { 'a b': 'w' } }).issues[0]!.level).toBe('error');
  });

  it('repoFile / splitRepoFile / fileInRepo', () => {
    const single = createRepoContext('/r/web', {});
    const multi = createRepoContext('/r/web', {}, undefined, {
      repoName: 'web',
      repos: { web: '/r/web', api: '/r/api' },
    });
    expect(repoFile(single, 'src/a.ts')).toBe('src/a.ts');
    expect(repoFile(multi, './src/a.ts')).toBe('web/src/a.ts');
    expect(repoFile(multi, '/r/web/src/a.ts')).toBe('web/src/a.ts');
    expect(splitRepoFile('api/x.go', ['web', 'api'])).toEqual({ repo: 'api', path: 'x.go' });
    expect(splitRepoFile('x.go', ['web'])).toEqual({ repo: 'web', path: 'x.go' });
    expect(fileInRepo(multi, 'web/src/a.ts')).toBe('src/a.ts');
    expect(fileInRepo(multi, 'api/x.go')).toBeUndefined();
    expect(fileInRepo(single, 'src/a.ts')).toBe('src/a.ts');
  });

  it('sectionFor: repo が無いセクションは全 repo、あれば一致する repo だけ', () => {
    const all: RepoScoped<{ appDir: string }> = { appDir: 'app' };
    const api: RepoScoped<{ appDir: string }> = { repo: 'api', appDir: 'app' };
    expect(sectionFor({ repoName: 'web' }, all)).toEqual({ appDir: 'app' });
    expect(sectionFor({ repoName: 'web' }, api)).toBeUndefined();
    expect(sectionFor({ repoName: 'api' }, api)).toBe(api);
    expect(sectionFor({ repoName: 'web' }, undefined)).toBeUndefined();
  });
});
