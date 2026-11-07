import type { Extractor } from '@stack-atlas/core';
import { createMemoryLogger } from '@stack-atlas/core';
import { validateGraph } from '@stack-atlas/schema';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { runBuild } from '../commands/build.js';
import { EXTRACTOR_PACKAGES, loadExtractors } from '../extractors.js';

function repo(): string {
  const root = mkdtempSync(join(tmpdir(), 'stack-atlas-build-'));
  writeFileSync(join(root, 'stack-atlas.config.yaml'), 'project: { name: demo }\n');
  mkdirSync(join(root, '.stack-atlas'));
  writeFileSync(join(root, '.stack-atlas', 'memos.json'), '{"lib:x":"memo","gone:y":"orphan"}');
  return root;
}

const quiet = <T>(fn: () => Promise<T>) => {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  return fn().finally(() => log.mockRestore());
};

const stub: Extractor = {
  name: 'stub',
  detect: async () => true,
  extract: async () => ({ nodes: [{ id: 'lib:x', file: 'src/x.ts' }], edges: [] }),
};

describe('runBuild', () => {
  it('graph.json・issues.json・memos.json を書き、要約を出す', async () => {
    const root = repo();
    const out = join(root, 'out');
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const code = await runBuild({
      repo: root,
      outDir: out,
      extractors: [stub],
      log: createMemoryLogger(),
    });
    const summary = log.mock.calls.map((c) => String(c[0])).join('\n');
    log.mockRestore();
    expect(code).toBe(0);
    const graph = JSON.parse(readFileSync(join(out, 'graph.json'), 'utf8'));
    expect(validateGraph(graph).ok).toBe(true);
    expect(graph.nodes[0]).toMatchObject({
      id: 'lib:x',
      layer: 'components',
      kind: 'lib',
      name: 'x',
    });
    expect(JSON.parse(readFileSync(join(out, 'issues.json'), 'utf8'))).toEqual([]);
    expect(JSON.parse(readFileSync(join(out, 'memos.json'), 'utf8'))).toEqual({
      'gone:y': 'orphan',
      'lib:x': 'memo',
    });
    expect(summary).toContain('stub: ノード 1、エッジ 0、フロー 0');
    expect(summary).toContain('結果: ノード 1、エッジ 0、フロー 0、層 4');
    expect(summary).toContain('孤立メモ（graph に無いノード ID）: gone:y');
  });

  it('リポジトリの memos.json が無くなったら、前回の build の out/memos.json も消す', async () => {
    // 以前は残っていたので、serve --repo で開くと消したメモが共有メモとして見え、次の保存で書き戻されていた
    const root = repo();
    const out = join(root, 'out');
    const run = () =>
      runBuild({ repo: root, outDir: out, extractors: [stub], log: createMemoryLogger() });
    await quiet(run);
    expect(existsSync(join(out, 'memos.json'))).toBe(true);
    rmSync(join(root, '.stack-atlas', 'memos.json'));
    await quiet(run);
    expect(existsSync(join(out, 'memos.json'))).toBe(false);
  });

  it('既定の出力先は <repo>/.stack-atlas/out、検証エラーなら終了コード 1', async () => {
    const root = repo();
    const bad: Extractor = {
      ...stub,
      extract: async () => ({ nodes: [], edges: [{ from: 'a:1', to: 'b:2', kind: 'uses' }] }),
    };
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const code = await runBuild({ repo: root, extractors: [bad], log: createMemoryLogger() });
    log.mockRestore();
    expect(code).toBe(1);
    expect(existsSync(join(root, '.stack-atlas', 'out', 'graph.json'))).toBe(true);
  });

  it('--with-viewer はビューアを同梱する。無ければ pnpm build を促して終了コード 2', async () => {
    const root = repo();
    const viewer = mkdtempSync(join(tmpdir(), 'stack-atlas-viewer-'));
    const mlog = createMemoryLogger();
    expect(
      await runBuild({
        repo: root,
        withViewer: true,
        viewerDist: viewer,
        extractors: [stub],
        log: mlog,
      }),
    ).toBe(2);
    expect(mlog.of('error')[0]).toContain('pnpm build');

    writeFileSync(join(viewer, 'index.html'), '<p>v</p>');
    mkdirSync(join(viewer, 'assets'));
    writeFileSync(join(viewer, 'assets', 'app.js'), '');
    const out = join(root, 'o');
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(
      await runBuild({
        repo: root,
        outDir: out,
        withViewer: true,
        viewerDist: viewer,
        extractors: [stub],
        log: mlog,
      }),
    ).toBe(0);
    log.mockRestore();
    expect(existsSync(join(out, 'index.html'))).toBe(true);
    expect(existsSync(join(out, 'assets', 'app.js'))).toBe(true);
    expect(existsSync(join(out, 'graph.json'))).toBe(true);
  });
});

describe('runBuild（複数 repo）', () => {
  it('repo を表示し、要約は抽出器 (repo) ごとに出す', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'stack-atlas-poly-'));
    for (const d of ['atlas', 'web', 'platform']) mkdirSync(join(ws, d));
    writeFileSync(
      join(ws, 'atlas', 'stack-atlas.config.yaml'),
      'repos: { web: ../web, platform: ../platform }\n',
    );
    const ex: Extractor = {
      name: 'cdktf',
      detect: async (ctx) => ctx.repoName === 'platform',
      extract: async () => ({
        nodes: [{ id: 'infra:a', file: 'infra/a.tf' }, { id: 'infra:b' }],
        edges: [{ from: 'infra:a', to: 'infra:b', kind: 'flow' }],
      }),
    };
    const mlog = createMemoryLogger();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const out = join(ws, 'out');
    const code = await runBuild({
      repo: join(ws, 'atlas'),
      outDir: out,
      extractors: [ex, stub],
      log: mlog,
    });
    const summary = log.mock.calls.map((c) => String(c[0])).join('\n');
    log.mockRestore();
    expect(code).toBe(0);
    expect(mlog.of('info')).toContain(`  - platform: ${join(ws, 'platform')}`);
    expect(summary).toContain('  cdktf (platform): ノード 2、エッジ 1\n');
    expect(summary).toContain('  stub (web): ノード 1、エッジ 0');
    expect(summary).toContain('  stub (platform): ノード 1、エッジ 0');
    const graph = JSON.parse(readFileSync(join(out, 'graph.json'), 'utf8'));
    expect(graph.project.sources).toEqual(['web', 'platform']);
    expect(graph.nodes.find((n: { id: string }) => n.id === 'infra:a').file).toBe(
      'platform/infra/a.tf',
    );
  });
});

describe('loadExtractors', () => {
  it('見つからないパッケージはスキップし、named / default export を受け付ける', async () => {
    const log = createMemoryLogger();
    const notFound = (spec: string) =>
      Object.assign(new Error(`Cannot find package '${spec}'`), { code: 'ERR_MODULE_NOT_FOUND' });
    const list = await loadExtractors(log, {
      skip: ['screenshots'],
      importer: async (spec) => {
        if (spec.endsWith('cdktf')) return { extractor: { ...stub, name: 'cdktf' } };
        if (spec.endsWith('nextjs-app')) return { default: { ...stub, name: 'nextjs-app' } };
        if (spec.endsWith('ts-imports')) return { nothing: true };
        throw notFound(spec);
      },
    });
    expect(list.map((e) => e.name)).toEqual(['cdktf', 'nextjs-app']);
    expect(log.of('info')).toEqual(
      expect.arrayContaining([
        '- 抽出器 api-link は見つかりません（スキップ）',
        '- 抽出器 cache は見つかりません（スキップ）',
        '- screenshots: オプションで無効（スキップ）',
      ]),
    );
    expect(log.of('warn')).toHaveLength(1);
    expect(EXTRACTOR_PACKAGES).toHaveLength(12);
    expect(EXTRACTOR_PACKAGES[0]).toBe('@stack-atlas/extractor-files');
  });
});

describe('build (fixture-poly)', () => {
  it('2 リポジトリ構成のフィクスチャを検証エラー 0 でビルドし、主要なノード・エッジが出る', async () => {
    const fixture = fileURLToPath(new URL('../../../../examples/fixture-poly', import.meta.url));
    const out = mkdtempSync(join(tmpdir(), 'stack-atlas-poly-ci-'));
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    let code: number;
    try {
      const extractors = await loadExtractors(createMemoryLogger(), { skip: ['screenshots'] });
      code = await runBuild({
        repo: fixture,
        outDir: out,
        extractors,
        log: createMemoryLogger(),
      });
    } finally {
      log.mockRestore();
    }
    expect(code).toBe(0);

    type N = { id: string; file?: string };
    type E = { from: string; to: string; kind: string };
    const graph = JSON.parse(readFileSync(join(out, 'graph.json'), 'utf8')) as {
      nodes: N[];
      edges: E[];
      flows: unknown[];
      kinds: Record<string, unknown>;
      project: { sources: string[] };
    };
    expect(validateGraph(graph).ok).toBe(true);
    expect(
      JSON.parse(readFileSync(join(out, 'issues.json'), 'utf8')).filter(
        (i: { severity?: string; level?: string }) => (i.severity ?? i.level) === 'error',
      ),
    ).toEqual([]);

    // ゆるい下限（ヒューリスティクスの小変更で壊れないように）
    expect(graph.nodes.length).toBeGreaterThanOrEqual(50);
    expect(graph.edges.length).toBeGreaterThanOrEqual(90);

    const ids = new Set(graph.nodes.map((n) => n.id));
    for (const id of [
      'infra:lambda_api/api',
      'infra:static_site/site',
      'infra:aurora/this',
      'infra:scheduler_notify/daily',
      'handler:cmd/api',
      'handler:internal/api',
      'type:internal/domain',
      'schema:internal/store',
      'endpoint:GET /today',
      'type:Today',
      'schema:transactions',
      'route:/',
      'layout:/',
      'comp:TotalCard',
      'lib:fetcher',
      'actor:user',
    ]) {
      expect(ids.has(id), `ノード ${id}`).toBe(true);
    }

    const has = (from: string, to: string, kind: string) =>
      graph.edges.some((e) => e.from === from && e.to === to && e.kind === kind);
    const edges: [string, string, string][] = [
      ['infra:static_site/site', 'route:/', 'deploy'],
      ['infra:lambda_api/api', 'handler:cmd/api', 'deploy'],
      ['infra:lambda_api/api', 'endpoint:GET /today', 'deploy'],
      ['endpoint:GET /today', 'handler:internal/api', 'http'],
      ['infra:aurora/this', 'schema:transactions', 'schema'],
      ['infra:scheduler_notify/daily', 'infra:lambda_api/notify', 'flow'],
      ['infra:static_site/this', 'infra:static_site/site', 'flow'],
      // 別モジュールの出力変数を辿った結線
      ['infra:lambda_api/api', 'infra:aurora/db', 'flow'],
    ];
    for (const [f, t, k] of edges) expect(has(f, t, k), `${f} -> ${t} (${k})`).toBe(true);

    // api-link: web の呼び出し側 (lib: / comp:) から endpoint への http
    expect(
      graph.edges.some(
        (e) =>
          e.kind === 'http' &&
          e.to === 'endpoint:GET /today' &&
          (e.from.startsWith('lib:') || e.from.startsWith('comp:')),
      ),
    ).toBe(true);

    expect(graph.kinds.endpoint).toBeDefined();
    expect(graph.project.sources).toEqual(['web', 'platform']);
    expect(graph.flows).toHaveLength(2);
    for (const n of graph.nodes) {
      if (n.file) expect(n.file, n.id).toMatch(/^(web|platform)\//);
    }
  }, 60_000);
});
