import type { Extractor } from '@stack-atlas/core';
import { createMemoryLogger } from '@stack-atlas/core';
import { validateGraph, validateGraphV2 } from '@stack-atlas/schema';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { confineShotsOutDir, runBuild, unsafeOutputs } from '../commands/build.js';
import { EXTRACTOR_PACKAGES, loadExtractors } from '../extractors.js';
import { hasGo, POLY_GO_FNS, POLY_GO_GROUPS } from './go-env.js';

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
  it('graph.json（v2）・graph.v1.json・issues.json・memos.json を書き、要約を出す', async () => {
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
    // Phase 8-1 で変更: graph.json は v2（配線図）になり、これまでの v1 は graph.v1.json に移った（docs/16 §10）
    const graph = JSON.parse(readFileSync(join(out, 'graph.v1.json'), 'utf8'));
    expect(validateGraph(graph).ok).toBe(true);
    expect(graph.nodes[0]).toMatchObject({
      id: 'lib:x',
      layer: 'components',
      kind: 'lib',
      name: 'x',
    });
    const v2 = JSON.parse(readFileSync(join(out, 'graph.json'), 'utf8'));
    expect(v2.version).toBe(2);
    expect(validateGraphV2(v2).errors).toEqual([]);
    expect(v2.nodes[0]).toMatchObject({ id: 'lib:x', kind: 'helper', runtime: 'browser' });
    expect(JSON.parse(readFileSync(join(out, 'issues.json'), 'utf8'))).toEqual([]);
    expect(JSON.parse(readFileSync(join(out, 'memos.json'), 'utf8'))).toEqual({
      'gone:y': 'orphan',
      'lib:x': 'memo',
    });
    expect(summary).toContain('stub: ノード 1、エッジ 0、フロー 0');
    expect(summary).toContain('結果: ノード 1、エッジ 0、フロー 0、層 4');
    expect(summary).toContain('v2: 箱 1（うち枠 0）、線 0、型 0、view 0');
    expect(summary).toContain('孤立メモ（graph に無いノード ID）: gone:y');
    expect(summary).toContain(`${join(out, 'graph.v1.json')}（v1。3D の地図）`);
  });

  it('--v1 は graph.json に v1 だけを書き、前回の graph.v1.json を消す（従来の出力）', async () => {
    const root = repo();
    const out = join(root, 'out');
    const run = (v1Only: boolean) =>
      runBuild({ repo: root, outDir: out, extractors: [stub], log: createMemoryLogger(), v1Only });
    await quiet(() => run(false));
    expect(existsSync(join(out, 'graph.v1.json'))).toBe(true);
    await quiet(() => run(true));
    expect(JSON.parse(readFileSync(join(out, 'graph.json'), 'utf8')).version).toBe(1);
    expect(existsSync(join(out, 'graph.v1.json'))).toBe(false);
  });

  /** v1 では正しいが、v2 では型 ID の形が違う（kind type で接頭辞が type: でない）ので v2 の検証エラーになる */
  const v2Bad: Extractor = {
    name: 'bad',
    detect: async () => true,
    extract: async () => ({ nodes: [{ id: 'comp:T', kind: 'type', name: 'T' }], edges: [] }),
  };

  it('--v1 は v2 を作らないので、v2 だけのエラーでは失敗しない（既定の build は終了コード 1）', async () => {
    // 以前は --v1 でも v2 に変換して検証し、書かない graph のエラーで終了コード 1 になっていた
    const root = repo();
    const out = join(root, 'out');
    const run = (v1Only: boolean) =>
      quiet(() =>
        runBuild({
          repo: root,
          outDir: out,
          extractors: [v2Bad],
          log: createMemoryLogger(),
          v1Only,
        }),
      );
    expect(await run(false)).toBe(1);
    expect(await run(true)).toBe(0);
    expect(JSON.parse(readFileSync(join(out, 'graph.json'), 'utf8')).version).toBe(1);
    expect(JSON.parse(readFileSync(join(out, 'issues.json'), 'utf8'))).toEqual([]);
  });

  it('v2 の検証エラーは要約に 1 回だけ出る（log には出さない）', async () => {
    // 以前は buildGraph が log.error にも出していたので、要約と合わせて 2 回出ていた
    const root = repo();
    const mlog = createMemoryLogger();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const code = await runBuild({
      repo: root,
      outDir: join(root, 'out'),
      extractors: [v2Bad],
      log: mlog,
    });
    const printed = [
      ...log.mock.calls.map((c) => String(c[0])),
      ...mlog.records.map((r) => r.msg),
    ].join('\n');
    log.mockRestore();
    expect(code).toBe(1);
    // 要約は `v2:/types/0/id`、以前の log は `graph.json（v2）: /types/0/id` と書いていた
    expect(printed.split('/types/0/id').length - 1).toBe(1);
  });

  describe('出力先のシンボリックリンク（解析対象の repo が置いたリンクで repo の外を書き換えない）', () => {
    /** repo の外の「書き換えられてはいけない」ファイル */
    const victim = () => {
      const dir = mkdtempSync(join(tmpdir(), 'stack-atlas-victim-'));
      const file = join(dir, 'victim.txt');
      writeFileSync(file, 'keep');
      return { dir, file };
    };
    const run = (root: string, extra: Partial<Parameters<typeof runBuild>[0]> = {}) => {
      const mlog = createMemoryLogger();
      return quiet(() => runBuild({ repo: root, extractors: [stub], log: mlog, ...extra })).then(
        (code) => ({ code, errors: mlog.of('error') }),
      );
    };

    it.each(['graph.json', 'graph.v1.json', 'issues.json', 'memos.json'])(
      '既定の出力先の %s がリンクなら書かずに終了コード 2',
      async (name) => {
        const root = repo();
        const v = victim();
        const out = join(root, '.stack-atlas', 'out');
        mkdirSync(out, { recursive: true });
        symlinkSync(v.file, join(out, name));
        const { code, errors } = await run(root);
        expect(code).toBe(2);
        expect(errors[0]).toContain('シンボリックリンク');
        expect(errors[0]).toContain(join(out, name));
        expect(readFileSync(v.file, 'utf8')).toBe('keep');
      },
    );

    it('--v1 で消す graph.v1.json がリンクでも止める', async () => {
      const root = repo();
      const v = victim();
      const out = join(root, 'out');
      mkdirSync(out);
      symlinkSync(v.file, join(out, 'graph.v1.json'));
      const { code } = await run(root, { outDir: out, v1Only: true });
      expect(code).toBe(2);
      expect(existsSync(join(out, 'graph.json'))).toBe(false);
      expect(readFileSync(v.file, 'utf8')).toBe('keep');
    });

    it('repo の中の出力先のディレクトリ（.stack-atlas/out）や shots/ の中身がリンクでも止める', async () => {
      const root = repo();
      const v = victim();
      symlinkSync(v.dir, join(root, '.stack-atlas', 'out'));
      expect((await run(root)).code).toBe(2);
      expect(existsSync(join(v.dir, 'graph.json'))).toBe(false);

      const root2 = repo();
      const shots = join(root2, 'o', 'shots');
      mkdirSync(shots, { recursive: true });
      symlinkSync(v.file, join(shots, 'home.png'));
      expect((await run(root2, { outDir: join(root2, 'o') })).code).toBe(2);
      expect(readFileSync(v.file, 'utf8')).toBe('keep');
    });

    it('--with-viewer で写すビューアのファイルの写し先がリンクでも止める（cpSync はリンクの先に書く）', async () => {
      const root = repo();
      const v = victim();
      const viewer = mkdtempSync(join(tmpdir(), 'stack-atlas-viewer-'));
      mkdirSync(join(viewer, 'assets'));
      writeFileSync(join(viewer, 'index.html'), '<p>v</p>');
      writeFileSync(join(viewer, 'assets', 'app.js'), '');
      const out = join(root, 'o');
      mkdirSync(join(out, 'assets'), { recursive: true });
      symlinkSync(v.file, join(out, 'assets', 'app.js'));
      const { code, errors } = await run(root, {
        outDir: out,
        withViewer: true,
        viewerDist: viewer,
      });
      expect(code).toBe(2);
      expect(errors[0]).toContain(join(out, 'assets', 'app.js'));
      expect(readFileSync(v.file, 'utf8')).toBe('keep');
    });

    it('リンクの無い出力先は今までどおり書く', async () => {
      const root = repo();
      expect((await run(root)).code).toBe(0);
      expect(existsSync(join(root, '.stack-atlas', 'out', 'graph.json'))).toBe(true);
    });
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
    // Phase 8-2a で変更: 言語アダプタ ts-types を ts-imports の直後に足したので 12 → 13
    // 2026-11-09 変更（8-2b）: 言語アダプタ go-types を go の直後に足したので 13 → 14
    // 2026-11-09 変更（8-3b）: ビルド成果物の画面の screens を screenshots の後に足したので 14 → 15
    expect(EXTRACTOR_PACKAGES).toHaveLength(15);
    expect(EXTRACTOR_PACKAGES.at(-1)).toBe('@stack-atlas/extractor-screens');
    expect(EXTRACTOR_PACKAGES.indexOf('@stack-atlas/extractor-screens')).toBe(
      EXTRACTOR_PACKAGES.indexOf('@stack-atlas/extractor-screenshots') + 1,
    );
    expect(EXTRACTOR_PACKAGES[0]).toBe('@stack-atlas/extractor-files');
    expect(EXTRACTOR_PACKAGES.indexOf('@stack-atlas/extractor-ts-types')).toBe(
      EXTRACTOR_PACKAGES.indexOf('@stack-atlas/extractor-ts-imports') + 1,
    );
    expect(EXTRACTOR_PACKAGES.indexOf('@stack-atlas/extractor-go-types')).toBe(
      EXTRACTOR_PACKAGES.indexOf('@stack-atlas/extractor-go') + 1,
    );
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
    // Phase 8-1 で変更: v1 は graph.v1.json に移った（graph.json は v2。下で別に確かめる）
    const graph = JSON.parse(readFileSync(join(out, 'graph.v1.json'), 'utf8')) as {
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

    // graph.json は v2（docs/16 §10）: 検証エラー 0、箱 id は v1 のまま、type: は types[] へ
    const v2 = JSON.parse(readFileSync(join(out, 'graph.json'), 'utf8'));
    expect(v2.version).toBe(2);
    expect(validateGraphV2(v2).errors).toEqual([]);
    // Phase 8-2a で変更: 言語アダプタ（ts-types）の関数の箱が v1 のファイルの箱（lib:<file>）を置き換える（D47・D53）。
    // 置き換わった v1 の箱は group（関数の箱の group が v1 の箱 id）になり、箱としては消える。それ以外の箱 id は v1 のまま
    const grouped = [
      'lib:web/src/feature/days/request.ts',
      'lib:web/src/feature/days/transformer.ts',
      'lib:web/src/feature/spend/request.ts',
      'lib:web/src/feature/spend/transformer.ts',
    ];
    const fnBoxes = [
      'fn:getDays',
      'fn:toCells',
      'fn:getToday',
      'fn:getEntries',
      'fn:createTransaction',
      'fn:toTodayView',
    ];
    // 2026-11-09 変更（8-2b）: go-types の関数の箱が v1 の Go のパッケージの箱を置き換える（meta.go.pkg の被覆。D53）。
    // go が無ければ Go の側はパッケージの箱のまま（D51）
    if (hasGo) {
      grouped.push(...POLY_GO_GROUPS);
      fnBoxes.push(...POLY_GO_FNS);
    }
    expect([...v2.nodes.map((n: N) => n.id)].sort()).toEqual(
      [
        ...graph.nodes
          .filter((n) => !n.id.startsWith('type:') && !grouped.includes(n.id))
          .map((n) => n.id),
        ...fnBoxes,
      ].sort(),
    );
    // internal/domain の関数は v1 の箱が type（types[]）なので group が無い
    for (const id of fnBoxes.filter((x) => !x.startsWith('fn:internal/domain.')))
      expect(
        grouped.includes(v2.nodes.find((n: N & { group?: string }) => n.id === id).group),
        id,
      ).toBe(true);
    expect(v2.types.map((t: N) => t.id)).toEqual(
      expect.arrayContaining(['type:Today', 'type:Entry', 'table:transactions']),
    );
    expect(v2.views.map((v: N) => v.id)).toEqual(['today', 'inbound']);

    // 2026-11-09 追加（8-3b）: screens 抽出器が web/export の HTML を写して消毒し、route の箱に screen.html を付ける（v1 と v2）
    type S = {
      id: string;
      screen?: { html?: string; source?: string; width: number; height: number };
    };
    for (const g of [graph as unknown as { nodes: S[] }, v2 as { nodes: S[] }]) {
      expect(
        Object.fromEntries(g.nodes.filter((n) => n.screen).map((n) => [n.id, n.screen])),
      ).toEqual({
        'route:/': { html: 'screens/index/index.html', width: 1280, height: 800, source: 'dir' },
        'route:/calendar': {
          html: 'screens/calendar/index.html',
          width: 1280,
          height: 800,
          source: 'dir',
        },
        'route:/push': { html: 'screens/push/index.html', width: 1280, height: 800, source: 'dir' },
      });
    }
    for (const n of v2.nodes as S[])
      if (n.screen?.html) expect(existsSync(join(out, n.screen.html)), n.id).toBe(true);
    const issues = JSON.parse(readFileSync(join(out, 'issues.json'), 'utf8')) as Array<{
      level: string;
      path: string;
      message: string;
    }>;
    expect(issues.filter((i) => /カバー率/.test(i.message)).map((i) => [i.level, i.path])).toEqual([
      ['info', 'screens:/calendar'],
      ['info', 'screens:/'],
      ['info', 'screens:/push'],
    ]);
    expect(issues.filter((i) => i.level === 'warning').map((i) => i.path)).toEqual([
      'screens:/',
      'screens:_next/static/css/7f3a9c1d2e4b5a60.css',
    ]);
  }, 60_000);
});

describe('runBuild（screens の出力先。8-3b）', () => {
  /** 画面を 1 つ書くだけの screens の代わり（本物と同じく config.screens.outDir に書く） */
  /** slug の画面を 1 つ書く screens の代わり */
  const screensStubAt = (slug: string): Extractor => ({
    name: 'screens',
    detect: async (ctx) => Boolean(ctx.config.screens),
    extract: async (ctx) => {
      // 本物と同じく、書き出し先が無ければ何もしない（印の無い screens/ があると build は渡さない）
      if (!ctx.config.screens?.outDir) return { nodes: [], edges: [] };
      const dir = join(ctx.config.screens!.outDir!, 'screens', slug);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'index.html'), '<!DOCTYPE html>');
      writeFileSync(join(ctx.config.screens!.outDir!, 'screens', '.stack-atlas-screens'), '');
      return {
        nodes: [{ id: 'lib:x', file: 'src/x.ts' }],
        edges: [],
        issues: [
          { level: 'info', path: 'screens:/', message: 'regions のカバー率 1/2（50%）' },
          { level: 'error' as 'warning', path: 'screens:/x', message: 'error は warning にする' },
        ],
      };
    },
  });
  const screensStub = screensStubAt('index');
  const withScreens = () => {
    const root = repo();
    writeFileSync(
      join(root, 'stack-atlas.config.yaml'),
      'project: { name: demo }\nscreens: { from: dir, dir: site, outDir: /tmp/evil }\n',
    );
    return root;
  };

  it('config.screens.outDir は出力先（設定ファイルの outDir は使わない）。info は要約に出し、問題の件数に数えない', async () => {
    const root = withScreens();
    const out = join(root, 'o');
    const mlog = createMemoryLogger();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const code = await runBuild({ repo: root, outDir: out, extractors: [screensStub], log: mlog });
    const summary = log.mock.calls.map((c) => String(c[0])).join('\n');
    log.mockRestore();
    expect(code).toBe(0);
    expect(existsSync(join(out, 'screens', 'index', 'index.html'))).toBe(true);
    // 2026-11-09 変更（8-3b のレビュー）: 抽出器は出力先の中の一時ディレクトリに書き、成功したら screens/ に移す（一時ディレクトリは残さない）
    expect(readdirSync(out).filter((f) => f.startsWith('.screens-staging-'))).toEqual([]);
    expect(mlog.of('warn').join('\n')).toContain('screens.outDir は設定できません');
    expect(summary).toContain(
      '報告（issues.json の info）: 1 件\n  screens:/: regions のカバー率 1/2（50%）',
    );
    expect(summary).toContain('問題: エラー 0 件、警告 1 件');
    expect(JSON.parse(readFileSync(join(out, 'issues.json'), 'utf8'))).toEqual([
      { level: 'info', path: 'screens:/', message: 'regions のカバー率 1/2（50%）' },
      { level: 'warning', path: 'screens:/x', message: 'error は warning にする' },
    ]);
  });

  it('前回の screens/ は印があるときだけ消す（自分が書いていない screens/ は残す）', async () => {
    const root = repo();
    const out = join(root, 'o');
    mkdirSync(join(out, 'screens', 'old'), { recursive: true });
    writeFileSync(join(out, 'screens', 'old', 'index.html'), 'old');
    const run = () =>
      quiet(() =>
        runBuild({ repo: root, outDir: out, extractors: [stub], log: createMemoryLogger() }),
      );
    expect(await run()).toBe(0);
    expect(existsSync(join(out, 'screens', 'old', 'index.html'))).toBe(true);
    writeFileSync(join(out, 'screens', '.stack-atlas-screens'), '');
    expect(await run()).toBe(0);
    expect(existsSync(join(out, 'screens'))).toBe(false);
  });

  it('screens/ とその中（入れ子も）がリンクなら書かずに終了コード 2。消すときもリンクの先は消さない', async () => {
    const victim = mkdtempSync(join(tmpdir(), 'stack-atlas-victim-'));
    writeFileSync(join(victim, 'keep.txt'), 'keep');
    const run = (root: string, out: string) =>
      quiet(() =>
        runBuild({ repo: root, outDir: out, extractors: [screensStub], log: createMemoryLogger() }),
      );

    const r1 = withScreens();
    const o1 = join(r1, 'o');
    mkdirSync(o1);
    symlinkSync(victim, join(o1, 'screens'));
    expect(await run(r1, o1)).toBe(2);

    const r2 = withScreens();
    const o2 = join(r2, 'o');
    mkdirSync(join(o2, 'screens', '_assets'), { recursive: true });
    writeFileSync(join(o2, 'screens', '.stack-atlas-screens'), '');
    symlinkSync(victim, join(o2, 'screens', '_assets', 'deep'));
    expect(await run(r2, o2)).toBe(2);
    expect(existsSync(join(o2, 'screens', '_assets', 'deep'))).toBe(true);
    expect(readFileSync(join(victim, 'keep.txt'), 'utf8')).toBe('keep');
  });

  // 2026-11-09 追加（8-3b のレビュー）: 以下は直す前に失敗したもの
  it('印の無い screens/（利用者のディレクトリ）には書かず、次の build でも消さない。警告を log と issues.json に出す', async () => {
    const root = withScreens();
    const out = join(root, 'o');
    mkdirSync(join(out, 'screens', 'mine'), { recursive: true });
    writeFileSync(join(out, 'screens', 'mine', 'notes.txt'), 'mine');
    for (let k = 0; k < 2; k++) {
      const mlog = createMemoryLogger();
      expect(
        await quiet(() =>
          runBuild({ repo: root, outDir: out, extractors: [screensStub], log: mlog }),
        ),
      ).toBe(0);
      expect(mlog.of('warn').join('\n')).toContain('印 .stack-atlas-screens が無い');
      expect(readFileSync(join(out, 'screens', 'mine', 'notes.txt'), 'utf8')).toBe('mine');
      expect(readdirSync(join(out, 'screens'))).toEqual(['mine']); // 印も画面も書かない
      expect(JSON.parse(readFileSync(join(out, 'issues.json'), 'utf8'))).toContainEqual({
        level: 'warning',
        path: 'screens',
        message: expect.stringContaining('画面を書きません（消しも上書きもしない）'),
      });
    }
  });

  // 2026-11-10 追加（8-3c を 8-4 に合流）: dry-run も本番の build と同じ screens/ の規則で判定し、出力先には書かない
  it('dry-run: 印の無い screens/ なら画面を写さずに警告を JSON に出す。印のある screens/ は消さない（書くのは一時ディレクトリだけ）', async () => {
    const run = async (out: string, extractors: Extractor[], root: string) => {
      const writes: string[] = [];
      const stdout = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
        writes.push(String(chunk));
        return true;
      });
      const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      try {
        const code = await runBuild({
          repo: root,
          outDir: out,
          extractors,
          dryRun: true,
          json: true,
          log: createMemoryLogger(),
        });
        return { code, json: JSON.parse(writes.join('')) };
      } finally {
        stdout.mockRestore();
        stderr.mockRestore();
      }
    };
    let seen: string | undefined = 'unset';
    const spy: Extractor = {
      ...screensStub,
      extract: async (ctx, up) => {
        seen = ctx.config.screens?.outDir;
        return screensStub.extract(ctx, up);
      },
    };
    // 印の無い screens/: 抽出器に書き出し先を渡さない（本番と同じ）、警告を出す、出力先はそのまま
    const r1 = withScreens();
    const o1 = join(r1, 'o');
    mkdirSync(join(o1, 'screens', 'mine'), { recursive: true });
    const a = await run(o1, [spy], r1);
    expect(a.code).toBe(0);
    expect(seen).toBeUndefined();
    expect(a.json.issues).toContainEqual({
      level: 'warning',
      path: 'screens',
      message: expect.stringContaining('画面を書きません（消しも上書きもしない）'),
    });
    expect(readdirSync(o1)).toEqual(['screens']);
    expect(readdirSync(join(o1, 'screens'))).toEqual(['mine']);
    // 印のある screens/: 抽出器は出力先の外（一時ディレクトリの staging）に書く。出力先の screens/ は消さない
    const r2 = withScreens();
    const o2 = join(r2, 'o');
    mkdirSync(join(o2, 'screens', 'old'), { recursive: true });
    writeFileSync(join(o2, 'screens', '.stack-atlas-screens'), '');
    const b = await run(o2, [spy], r2);
    expect(b.code).toBe(0);
    expect(seen).toMatch(/stack-atlas-dry-run-.*\.screens-staging-/);
    expect(seen!.startsWith(o2)).toBe(false);
    expect(readdirSync(o2)).toEqual(['screens']);
    expect(readdirSync(join(o2, 'screens')).sort()).toEqual(['.stack-atlas-screens', 'old']);
    // screens/ がリンク: dry-run は書かないので止まらないが、本番は止まることと画面を写さないことを警告する
    const r3 = withScreens();
    const o3 = join(r3, 'o');
    mkdirSync(o3);
    const victim = mkdtempSync(join(tmpdir(), 'stack-atlas-victim-'));
    symlinkSync(victim, join(o3, 'screens'));
    const c = await run(o3, [spy], r3);
    expect(c.code).toBe(0);
    expect(seen).toBeUndefined();
    expect(c.json.issues.map((i: { path: string }) => i.path)).toEqual(
      expect.arrayContaining(['screens', 'build']),
    );
    expect(readdirSync(victim)).toEqual([]);
  });

  it('失敗した build（flows.yaml が壊れている）は前回の screens/ を残す（graph.json が指す画面を消さない）', async () => {
    const root = withScreens();
    const out = join(root, 'o');
    const run = (slug: string) =>
      quiet(() =>
        runBuild({
          repo: root,
          outDir: out,
          extractors: [screensStubAt(slug)],
          log: createMemoryLogger(),
        }),
      );
    expect(await run('index')).toBe(0);
    expect(existsSync(join(out, 'screens', 'index', 'index.html'))).toBe(true);
    const graph = readFileSync(join(out, 'graph.json'), 'utf8');
    writeFileSync(join(root, 'flows.yaml'), 'not: a list\n');
    // 2 回目の抽出は別の画面を書く（直す前は、前回の screens/ を抽出の前に消し、出力先の screens/ に書いていた）
    expect(await run('next')).toBe(2);
    expect(readFileSync(join(out, 'graph.json'), 'utf8')).toBe(graph);
    expect(readdirSync(join(out, 'screens')).sort()).toEqual(['.stack-atlas-screens', 'index']);
    expect(readdirSync(out).filter((f) => f.startsWith('.screens-staging-'))).toEqual([]);
  });

  it('印のある前回の screens/ は、成功した build の画面と入れ替える（消した route の画面を残さない）', async () => {
    const root = withScreens();
    const out = join(root, 'o');
    mkdirSync(join(out, 'screens', 'gone'), { recursive: true });
    writeFileSync(join(out, 'screens', 'gone', 'index.html'), 'old');
    writeFileSync(join(out, 'screens', '.stack-atlas-screens'), '');
    expect(
      await quiet(() =>
        runBuild({ repo: root, outDir: out, extractors: [screensStub], log: createMemoryLogger() }),
      ),
    ).toBe(0);
    expect(readdirSync(join(out, 'screens')).sort()).toEqual(['.stack-atlas-screens', 'index']);
  });

  it('触らない screens/（印が無い）の中のリンクでは build を止めない（unsafeOutputs は消す・書く screens/ だけ調べる）', async () => {
    const victim = mkdtempSync(join(tmpdir(), 'stack-atlas-victim-'));
    for (const root of [repo(), withScreens()]) {
      const out = join(root, 'o');
      mkdirSync(join(out, 'screens'), { recursive: true });
      symlinkSync(victim, join(out, 'screens', 'link'));
      expect(unsafeOutputs(root, out)).toEqual([]);
      expect(unsafeOutputs(root, out, undefined, true)).toEqual([join(out, 'screens', 'link')]);
      expect(
        await quiet(() =>
          runBuild({
            repo: root,
            outDir: out,
            extractors: [stub, screensStub],
            log: createMemoryLogger(),
          }),
        ),
      ).toBe(0);
      expect(existsSync(join(out, 'screens', 'link'))).toBe(true);
    }
  });
});

describe('スクショの書き出し先（config.screenshots.outDir は build の出力先の中だけ。8-3b）', () => {
  /** 受け取った screenshots.outDir を覚え、本物と同じく <outDir>/shots/ に書く screenshots の代わり */
  const shotsStub = (seen: string[]): Extractor => ({
    name: 'screenshots',
    detect: async () => true,
    extract: async (ctx) => {
      const dir = ctx.config.screenshots!.outDir!;
      seen.push(dir);
      mkdirSync(join(dir, 'shots'), { recursive: true });
      writeFileSync(join(dir, 'shots', 'index.png'), 'PNG');
      return { nodes: [{ id: 'lib:x', file: 'src/x.ts' }], edges: [] };
    },
  });
  const withShots = (outDir: string) => {
    const root = repo();
    writeFileSync(
      join(root, 'stack-atlas.config.yaml'),
      `project: { name: demo }\nscreenshots: { baseUrl: "http://localhost:1", outDir: ${JSON.stringify(outDir)} }\n`,
    );
    return root;
  };
  const build = async (root: string, out?: string) => {
    const seen: string[] = [];
    const mlog = createMemoryLogger();
    const code = await quiet(() =>
      runBuild({
        repo: root,
        ...(out ? { outDir: out } : {}),
        extractors: [shotsStub(seen)],
        log: mlog,
      }),
    );
    return { code, seen, warns: mlog.of('warn').join('\n'), errors: mlog.of('error') };
  };

  it('confineShotsOutDir: 無ければ出力先。repo 基準の相対で出力先そのものだけ受け付ける', () => {
    const repoDir = join(tmpdir(), 'r');
    const out = join(repoDir, '.stack-atlas', 'out');
    const mlog = createMemoryLogger();
    expect(confineShotsOutDir(repoDir, out, undefined, mlog)).toBe(out);
    expect(confineShotsOutDir(repoDir, out, '.stack-atlas/out', mlog)).toBe(out);
    expect(confineShotsOutDir(repoDir, out, './.stack-atlas/out/', mlog)).toBe(out);
    expect(confineShotsOutDir(repoDir, out, '.stack-atlas/out/a/..', mlog)).toBe(out);
    expect(mlog.of('warn')).toEqual([]);
  });

  // 2026-11-09 変更（8-3b のレビュー）: 出力先の下のディレクトリも受け付けていた（`o/sub` → <o>/sub/shots/）が、
  // スクショ抽出器は graph.json（<o>/）からの参照を shots/<slug>.png と書くので画像が開けなかった。出力先そのものだけにした
  it.each([['./.stack-atlas/out/sub/'], ['.stack-atlas/out/a/../b']])(
    'confineShotsOutDir: 出力先の下のディレクトリ %j は警告して出力先にする（graph.json の参照 shots/… と合わない）',
    (value) => {
      const repoDir = join(tmpdir(), 'r');
      const out = join(repoDir, '.stack-atlas', 'out');
      const mlog = createMemoryLogger();
      expect(confineShotsOutDir(repoDir, out, value, mlog)).toBe(out);
      expect(mlog.of('warn')).toEqual([
        `screenshots.outDir ${JSON.stringify(value)} は build の出力先の下のディレクトリ（graph.json は shots/… で参照する）なので使いません（スクショは出力先 ${out} の shots/ に書きます）`,
      ]);
    },
  );

  it.each([
    ['/tmp/evil', 'は絶対パスな'],
    [join(tmpdir(), 'r', '.stack-atlas', 'out'), 'は絶対パスな'], // 出力先と同じでも絶対パスは受け付けない
    ['../evil', 'は build の出力先の外を指す'],
    ['.stack-atlas/out/../../../evil', 'は build の出力先の外を指す'],
    ['.stack-atlas', 'は build の出力先の外を指す'],
    ['.stack-atlas/outx', 'は build の出力先の外を指す'],
    ['', 'は文字列でない'],
    [42, 'は文字列でない'],
  ])('confineShotsOutDir: %j は警告して出力先にする（%s）', (value, why) => {
    const repoDir = join(tmpdir(), 'r');
    const out = join(repoDir, '.stack-atlas', 'out');
    const mlog = createMemoryLogger();
    expect(confineShotsOutDir(repoDir, out, value, mlog)).toBe(out);
    expect(mlog.of('warn')).toEqual([
      `screenshots.outDir ${JSON.stringify(value)} ${why}ので使いません（スクショは出力先 ${out} の shots/ に書きます）`,
    ]);
  });

  it('runBuild: 絶対パス・出力先の外の outDir は使わず、PNG は出力先の shots/ に書く', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'stack-atlas-shots-evil-'));
    for (const value of [outside, '../evil-shots']) {
      const root = withShots(value);
      const r = await build(root);
      expect(r.code).toBe(0);
      expect(r.seen).toEqual([join(root, '.stack-atlas', 'out')]);
      expect(r.warns).toContain('screenshots.outDir');
      expect(existsSync(join(root, '.stack-atlas', 'out', 'shots', 'index.png'))).toBe(true);
      expect(existsSync(join(root, '..', 'evil-shots'))).toBe(false);
    }
    expect(existsSync(join(outside, 'shots'))).toBe(false);
  });

  it('runBuild: 出力先そのものの outDir はそのまま（docs/10 の例の .stack-atlas/out は既定の出力先と同じ）。下のディレクトリは出力先にする', async () => {
    const root = withShots('.stack-atlas/out');
    const r = await build(root);
    expect(r.code).toBe(0);
    expect(r.seen).toEqual([join(root, '.stack-atlas', 'out')]);
    expect(r.warns).not.toContain('screenshots.outDir');
    // 2026-11-09 変更（8-3b のレビュー）: 以前は <o>/sub に書いた（graph.json の shots/… から開けない）
    const root2 = withShots('o/sub');
    const r2 = await build(root2, join(root2, 'o'));
    expect(r2.seen).toEqual([join(root2, 'o')]);
    expect(r2.warns).toContain('は build の出力先の下のディレクトリ');
    expect(existsSync(join(root2, 'o', 'shots', 'index.png'))).toBe(true);
    expect(existsSync(join(root2, 'o', 'sub'))).toBe(false);
    // -o で出力先を変えると、repo 基準の .stack-atlas/out は出力先の外なので出力先にする
    const root3 = withShots('.stack-atlas/out');
    const r3 = await build(root3, join(root3, 'o'));
    expect(r3.seen).toEqual([join(root3, 'o')]);
    expect(r3.warns).toContain('は build の出力先の外を指す');
  });

  it('shots/・その中がリンクなら書かずに終了コード 2。出力先の下のリンクのディレクトリを指す outDir は使わない', async () => {
    const victim = mkdtempSync(join(tmpdir(), 'stack-atlas-victim-'));
    writeFileSync(join(victim, 'keep.png'), 'keep');
    // 書き出し先の shots/ がリンク
    const r1 = withShots('o');
    mkdirSync(join(r1, 'o'));
    symlinkSync(victim, join(r1, 'o', 'shots'));
    const b1 = await build(r1, join(r1, 'o'));
    expect(b1.code).toBe(2);
    expect(b1.errors[0]).toContain(join(r1, 'o', 'shots'));
    expect(b1.seen).toEqual([]);
    // shots/ の中のファイルがリンク
    const r2 = withShots('o');
    mkdirSync(join(r2, 'o', 'shots'), { recursive: true });
    symlinkSync(join(victim, 'keep.png'), join(r2, 'o', 'shots', 'index.png'));
    expect((await build(r2, join(r2, 'o'))).code).toBe(2);
    // 2026-11-09 変更（8-3b のレビュー）: 出力先の下（o/sub。リンク）は受け付けなくなったので、出力先の shots/ に書く
    // （以前は途中の段のリンクで終了コード 2）
    const r3 = withShots('o/sub/deeper');
    mkdirSync(join(r3, 'o'));
    symlinkSync(victim, join(r3, 'o', 'sub'));
    const b3 = await build(r3, join(r3, 'o'));
    expect(b3.code).toBe(0);
    expect(b3.seen).toEqual([join(r3, 'o')]);
    expect(readFileSync(join(victim, 'keep.png'), 'utf8')).toBe('keep');
    expect(existsSync(join(victim, 'shots'))).toBe(false);
    expect(existsSync(join(victim, 'deeper'))).toBe(false);
  });

  it('unsafeOutputs: 出力先の shots/ を調べる', () => {
    const root = repo();
    const out = join(root, 'o');
    mkdirSync(out);
    const victim = mkdtempSync(join(tmpdir(), 'stack-atlas-victim-'));
    symlinkSync(victim, join(out, 'shots'));
    expect(unsafeOutputs(root, out)).toEqual([join(out, 'shots')]);
  });
});
