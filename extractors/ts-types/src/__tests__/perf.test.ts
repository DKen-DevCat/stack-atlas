// 性能の上限（docs/17 §5 8-2a の受け入れ条件）: ts-types は fixture-poly で 5 秒未満、合成の 150 ファイルで 30 秒未満（CPU 時間）。
// 上限はゆるく取る（CI の遅い runner でも落ちないように）。並列に走る他のテストに待たされた分を含めないよう CPU 時間で測る
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { createMemoryLogger, createRepoContext, loadConfig } from '@stack-atlas/core';
import { extractor as tsImports } from '@stack-atlas/extractor-ts-imports';
import { extractor } from '../index.js';

const cpuMs = async (f: () => Promise<unknown>) => {
  const t0 = process.cpuUsage();
  await f();
  const d = process.cpuUsage(t0);
  return (d.user + d.system) / 1000;
};

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

/** 合成の 150 ファイル: 型 30・関数 60（HTTP のラッパーを呼ぶ）・部品 60（関数を呼び、別の部品を描く） */
function synthetic(): string {
  const root = mkdtempSync(join(tmpdir(), 'stack-atlas-ts-perf-'));
  roots.push(root);
  const files: Record<string, string> = {
    'tsconfig.json': JSON.stringify({
      compilerOptions: {
        target: 'ES2022',
        lib: ['dom', 'esnext'],
        module: 'esnext',
        moduleResolution: 'bundler',
        jsx: 'preserve',
        strict: true,
        noEmit: true,
        skipLibCheck: true,
      },
      include: ['src/**/*.ts', 'src/**/*.tsx'],
    }),
    'src/http.ts': [
      "const BASE: string = (globalThis as { API?: string }).API ?? '';",
      'export async function http<T>(path: string, init?: RequestInit): Promise<T> {',
      '  const res = await fetch(`${BASE}${path}`, init);',
      '  return (await res.json()) as T;',
      '}',
    ].join('\n'),
  };
  for (let i = 0; i < 30; i++) {
    files[`src/types/t${i}.ts`] = [
      `export type Item${i} = { id: string; n: number; at: Date; tags: string[]; child: { a: string; b: number } };`,
      `export type Page${i} = { items: Item${i}[]; total: number; next?: string | null };`,
    ].join('\n');
  }
  for (let i = 0; i < 59; i++) {
    const t = i % 30;
    files[`src/fns/f${i}.ts`] = [
      `import { http } from '../http';`,
      `import type { Item${t}, Page${t} } from '../types/t${t}';`,
      i > 0 ? `import { load${i - 1} } from './f${i - 1}';` : '',
      `export function load${i}(page: number): Promise<Page${t}> { return http<Page${t}>(\`/p${i}?page=\${page}\`); }`,
      `export function save${i}(item: Item${t}) { return http<void>('/p${i}', { method: 'POST', body: JSON.stringify(item) }); }`,
      `export function shape${i}(p: Page${t}) { return { total: p.total, first: p.items[0]?.id ?? '' ${i > 0 ? `, prev: load${i - 1}` : ''} }; }`,
    ].join('\n');
  }
  for (let i = 0; i < 60; i++) {
    const f = i % 59;
    const t = f % 30;
    files[`src/components/C${i}.tsx`] = [
      `import { useEffect, useState } from 'react';`,
      `import { load${f}, shape${f} } from '../fns/f${f}';`,
      `import type { Page${t} } from '../types/t${t}';`,
      i > 0 ? `import { C${i - 1} } from './C${i - 1}';` : '',
      `export function C${i}({ start }: { start: number }) {`,
      `  const [page, setPage] = useState<Page${t} | null>(null);`,
      `  useEffect(() => { load${f}(start).then((p) => setPage(p)); }, [start]);`,
      `  if (!page) return null;`,
      `  const view = shape${f}(page);`,
      `  return <section>{view.total}${i > 0 ? `<C${i - 1} start={view.total} />` : ''}</section>;`,
      `}`,
    ].join('\n');
  }
  for (const [p, src] of Object.entries(files)) {
    mkdirSync(dirname(join(root, p)), { recursive: true });
    writeFileSync(join(root, p), src);
  }
  return root;
}

describe('性能', () => {
  it('fixture-poly の web: ts-types は 5 秒未満（CPU 時間）', async () => {
    const fixture = fileURLToPath(new URL('../../../../examples/fixture-poly', import.meta.url));
    const log = createMemoryLogger();
    const repos = { web: `${fixture}/web`, platform: `${fixture}/platform` };
    const ctx = createRepoContext(repos.web, loadConfig(fixture, log), log, {
      repoName: 'web',
      repos,
      configDir: fixture,
    });
    const up = await tsImports.extract(ctx, { nodes: [], edges: [] });
    const ms = await cpuMs(() => extractor.extract(ctx, up));
    expect(ms).toBeLessThan(5_000);
  }, 30_000);

  it('合成の 150 ファイル: ts-imports ＋ ts-types で 30 秒未満（CPU 時間）。箱・線・項目が出る', async () => {
    const root = synthetic();
    const log = createMemoryLogger();
    const ctx = createRepoContext(root, {}, log, { repoName: 'app' });
    let part: Awaited<ReturnType<typeof extractor.extract>> | undefined;
    const ms = await cpuMs(async () => {
      const up = await tsImports.extract(ctx, { nodes: [], edges: [] });
      part = await extractor.extract(ctx, up);
    });
    expect(ms).toBeLessThan(30_000);
    const v2 = part!.v2!;
    // 関数 59 × 3 ＋ 部品 60 ＋ http
    expect(v2.nodes.length).toBe(59 * 3 + 60 + 1);
    expect(v2.wires.length).toBeGreaterThan(400);
    expect(
      v2.nodes.filter((n) => n.ports.some((p) => p.items.some((i) => i.meta?.http))).length,
    ).toBe(59 * 2);
  }, 120_000);
});
