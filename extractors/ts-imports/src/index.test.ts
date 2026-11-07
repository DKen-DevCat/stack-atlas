import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import type { RepoContext, StackAtlasConfig } from '@stack-atlas/core';
import { extractor, libName } from './index.js';
import { globBase, globToRegExp } from '@stack-atlas/core';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../examples/fixture-repo');
const silent = { debug() {}, info() {}, warn() {}, error() {} };
function fixtureCtx(config?: StackAtlasConfig): RepoContext {
  return {
    root,
    config:
      config ??
      (parse(readFileSync(resolve(root, 'stack-atlas.config.yaml'), 'utf8')) as StackAtlasConfig),
    log: silent,
    resolve: (...s) => resolve(root, ...s),
  };
}

describe('helpers', () => {
  it('libName', () => {
    expect(libName('apps/web/lib/apiClient.ts')).toBe('apiClient');
    expect(libName('src/api-client.ts')).toBe('apiClient');
    expect(libName('apps/api/src/index.ts')).toBe('api');
  });
  it('glob', () => {
    const re = globToRegExp('apps/api/src/handlers/**/*.ts');
    expect(re.test('apps/api/src/handlers/getRaces.ts')).toBe(true);
    expect(re.test('apps/api/src/handlers/a/b.ts')).toBe(true);
    expect(re.test('apps/api/src/index.ts')).toBe(false);
    expect(globToRegExp('src/*.{ts,tsx}').test('src/a.tsx')).toBe(true);
    expect(globBase('apps/api/src/handlers/**/*.ts')).toBe('apps/api/src/handlers');
  });
});

describe('ts-imports extractor', async () => {
  const ctx = fixtureCtx();
  const g = await extractor.extract(ctx, { nodes: [], edges: [] });
  const byId = new Map(g.nodes.map((n) => [n.id, n]));
  const uses = (from: string, to: string) =>
    g.edges.some((e) => e.from === from && e.to === to && e.kind === 'uses');

  it('detects the fixture', async () => {
    expect(await extractor.detect(ctx)).toBe(true);
  });

  it('classifies exports into the README ids', () => {
    const expected = [
      'comp:Header',
      'comp:RaceCard',
      'comp:Pagination',
      'comp:ResultTable',
      'comp:EntryForm',
      'comp:AuthGuard',
      'hook:useSession',
      'hook:useRaces',
      'lib:apiClient',
      'type:Race',
      'type:RaceResult',
      'type:EntryInput',
      'type:Session',
      'type:ApiResponse',
      'handler:getRaces',
      'handler:postResult',
      'schema:RaceItem',
    ];
    for (const id of expected) expect(byId.has(id), id).toBe(true);
    // Lambda のエントリ（apps/api/src/index.ts の handler）だけが余分に出る
    expect([...byId.keys()].filter((id) => !expected.includes(id))).toEqual(['lib:api']);
    // 非 export の Row、ページ・レイアウト、再エクスポートだけの index はノードにならない
    expect(byId.has('comp:Row')).toBe(false);
    expect([...byId.keys()].some((id) => id.startsWith('route:') || id.startsWith('layout:'))).toBe(
      false,
    );
  });

  it('node fields', () => {
    expect(byId.get('comp:ResultTable')).toMatchObject({
      kind: 'component',
      name: 'ResultTable',
      file: 'apps/web/components/ResultTable.tsx',
      line: 13,
      meta: {
        extractors: ['ts-imports'],
        ts: { exportName: 'ResultTable', symbolKind: 'function' },
      },
    });
    expect(byId.get('type:EntryInput')?.meta?.['ts']).toEqual({
      exportName: 'EntryInput',
      symbolKind: 'zod',
    });
    expect(byId.get('type:EntryInput')?.code).toContain('z.object');
    expect(byId.get('lib:apiClient')?.meta?.['ts']).toMatchObject({ exportName: 'api' });
    expect(byId.get('schema:RaceItem')?.kind).toBe('schema');
    expect(byId.get('handler:getRaces')?.kind).toBe('handler');
    expect(byId.get('hook:useRaces')?.kind).toBe('hook');
    for (const n of g.nodes) expect(n.layer).toBeUndefined();
  });

  it('resolves imports to declaring exports, through re-exports', () => {
    expect(uses('comp:ResultTable', 'type:RaceResult')).toBe(true);
    expect(uses('route:/races/[id]', 'comp:ResultTable')).toBe(true);
    expect(uses('route:/races/[id]', 'lib:apiClient')).toBe(true);
    expect(uses('layout:/', 'comp:Header')).toBe(true);
    expect(uses('hook:useRaces', 'lib:apiClient')).toBe(true);
    expect(uses('handler:getRaces', 'schema:RaceItem')).toBe(true);
    expect(uses('handler:getRaces', 'type:ApiResponse')).toBe(true); // ローカルの ok() 経由
    expect(uses('handler:postResult', 'type:EntryInput')).toBe(true);
    expect(uses('type:RaceResult', 'type:Race')).toBe(true);
    expect(uses('route:/login', 'hook:useSession')).toBe(true);
  });

  it('does not invent edges', () => {
    // /admin/entry は EntryInput を import していない
    expect(uses('route:/admin/entry', 'type:EntryInput')).toBe(false);
    // react / next / swr / zod / aws-sdk は外部
    const ids = new Set(g.nodes.map((n) => n.id));
    for (const e of g.edges) {
      expect(e.kind).toBe('uses');
      expect(ids.has(e.to), e.to).toBe(true);
    }
  });
});
