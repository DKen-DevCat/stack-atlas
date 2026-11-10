import { buildGraph, createMemoryLogger, createRepoContext } from '@stack-atlas/core';
import { validateGraph } from '@stack-atlas/schema';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { extractor, fillTemplate, globFiles, readHead } from './index.js';

function tmp(files: Record<string, string | Buffer>): string {
  const root = mkdtempSync(join(tmpdir(), 'stack-atlas-files-'));
  for (const [p, c] of Object.entries(files)) {
    mkdirSync(dirname(join(root, p)), { recursive: true });
    writeFileSync(join(root, p), c);
  }
  return root;
}

const long = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join('\n');

describe('files 抽出器', () => {
  it('glob に合うファイルをノードにする（ID・name テンプレート、code は先頭 20 行）', async () => {
    const root = tmp({
      'reference/calc.py': long,
      'reference/sub/skip.py': 'x',
      'reference/logo.png': Buffer.from([0x89, 0x50, 0x4e, 0x47]),
      'reference/data.txt': Buffer.from([0x61, 0x00, 0x62]),
      'node_modules/reference/calc.py': 'x',
      'jobs/a/run.sh': '#!/bin/sh\necho hi\n',
    });
    const ctx = createRepoContext(root, {
      files: [
        { glob: 'reference/*', kind: 'lib', name: '{basename}', layer: 'types' },
        { glob: 'jobs/**/*.sh', kind: 'cron', id: '{dir}', name: '{repo}:{stem}' },
        { glob: 'reference/calc.py', kind: 'lib' }, // 同じ ID は先のルールが勝つ
        { glob: 'none/**', kind: 'lib' },
        { glob: 'reference/*', kind: 'Bad' },
        { glob: 'reference/*', kind: 'lib', repo: 'other' },
      ],
    });
    expect(await extractor.detect(ctx)).toBe(true);
    const log = createMemoryLogger();
    const out = await extractor.extract({ ...ctx, log }, { nodes: [], edges: [] });
    expect(out.edges).toEqual([]);
    expect(out.nodes).toEqual([
      {
        id: 'lib:reference/calc.py',
        kind: 'lib',
        name: 'calc.py',
        file: 'reference/calc.py',
        line: 1,
        code: long.split('\n').slice(0, 20).join('\n'),
        layer: 'types',
      },
      {
        id: 'lib:reference/data.txt',
        kind: 'lib',
        name: 'data.txt',
        file: 'reference/data.txt',
        line: 1,
        layer: 'types',
      },
      {
        id: 'lib:reference/logo.png',
        kind: 'lib',
        name: 'logo.png',
        file: 'reference/logo.png',
        line: 1,
        layer: 'types',
      },
      {
        id: 'cron:jobs/a',
        kind: 'cron',
        name: `${ctx.repoName}:run`,
        file: 'jobs/a/run.sh',
        line: 1,
        code: '#!/bin/sh\necho hi',
      },
    ]);
    expect(log.of('warn')).toHaveLength(2);
  });

  it('files が無い・この repo 向けのルールが無いなら detect しない', async () => {
    const root = tmp({});
    expect(await extractor.detect(createRepoContext(root, {}))).toBe(false);
    expect(
      await extractor.detect(
        createRepoContext(root, { files: [{ glob: '*', kind: 'lib', repo: 'x' }] }, undefined, {
          repoName: 'y',
        }),
      ),
    ).toBe(false);
  });

  it('パイプラインでは file が <repo>/ で修飾され、kinds の layer に従う', async () => {
    const ws = tmp({
      'a/stack-atlas.config.yaml': `repos: { web: ., platform: ../p }
files:
  - { glob: "scripts/*.py", kind: job, repo: platform }
kinds:
  job: { name: ジョブ, layer: infra }
`,
      'p/scripts/x.py': 'print(1)\n',
      'a/scripts/x.py': 'print(2)\n',
    });
    const res = await buildGraph({ root: join(ws, 'a'), extractors: [extractor], commit: false });
    expect(res.issues).toEqual([]);
    // 2026-11-10（Phase 9-L0。docs/23 §3.1）: 段 0 の報告が、規則の外（repo: platform だけ）の web/scripts/x.py を
    // 読めていないソースにする（strict の警告。issues には出さない。platform の x.py は files が読んだ）
    expect(res.harness!.coverage.unread.map((u) => [u.language, u.examples])).toEqual([
      ['python', ['web/scripts/x.py']],
    ]);
    expect(res.graph.nodes).toEqual([
      {
        id: 'job:scripts/x.py',
        layer: 'infra',
        kind: 'job',
        name: 'x',
        file: 'platform/scripts/x.py',
        line: 1,
        code: 'print(1)',
        meta: { extractors: ['files'] },
      },
    ]);
    expect(validateGraph(res.graph).errors).toEqual([]);
  });
});

describe('ヘルパー', () => {
  it('fillTemplate', () => {
    expect(fillTemplate('{dir}|{basename}|{stem}|{path}|{repo}', 'a/b/c.d.ts', 'web')).toBe(
      'a/b|c.d.ts|c.d|a/b/c.d.ts|web',
    );
    expect(fillTemplate('{stem}', '.env', 'w')).toBe('.env');
  });
  it('globFiles は .git と node_modules を見ない', () => {
    const root = tmp({ '.git/x.ts': '', 'node_modules/y.ts': '', 'src/z.ts': '', 'z.ts': '' });
    expect(globFiles(root, '**/*.ts')).toEqual(['src/z.ts', 'z.ts']);
  });
  it('readHead は読めないファイルで undefined', () => {
    expect(readHead('/no/such/file.txt')).toBeUndefined();
  });
});
