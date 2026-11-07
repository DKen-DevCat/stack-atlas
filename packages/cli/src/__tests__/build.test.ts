import type { Extractor } from '@stack-atlas/core';
import { createMemoryLogger } from '@stack-atlas/core';
import { validateGraph } from '@stack-atlas/schema';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
    expect(EXTRACTOR_PACKAGES).toHaveLength(6);
  });
});
