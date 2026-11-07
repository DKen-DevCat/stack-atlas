import type { Extractor } from '@stack-atlas/core';
import { buildGraph, createMemoryLogger, normalizeFlows, readYamlFile } from '@stack-atlas/core';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { runInitFlows } from '../commands/init-flows.js';
import { loadExtractors } from '../extractors.js';
import { main } from '../main.js';

const FIXTURE = fileURLToPath(new URL('../../../../examples/fixture-repo/', import.meta.url));

const quiet = <T>(fn: () => Promise<T>) => {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  return fn().finally(() => log.mockRestore());
};

function tmpRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'stack-atlas-init-flows-'));
  writeFileSync(join(root, 'stack-atlas.config.yaml'), 'project: { name: demo }\n');
  return root;
}

describe('init-flows', () => {
  it('フィクスチャから MISS / HIT / 無効化の雛形を書き、ノード ID がすべてグラフにある', async () => {
    const out = join(mkdtempSync(join(tmpdir(), 'stack-atlas-flows-')), 'flows.yaml');
    const log = createMemoryLogger();
    const extractors = await loadExtractors(log, { skip: ['screenshots'] });
    expect(await quiet(() => runInitFlows({ repo: FIXTURE, out, log, extractors }))).toBe(0);

    const defs = readYamlFile(out) as unknown[];
    const { graph } = await buildGraph({ root: FIXTURE, extractors, commit: false });
    const res = normalizeFlows(defs, new Set(graph.nodes.map((n) => n.id)), out);
    expect(res.issues).toEqual([]);
    expect(res.flows.map((f) => [f.id, f.tone])).toEqual([
      ['miss', 'default'],
      ['hit', 'cache-hit'],
      ['invalidate', 'default'],
    ]);
    const nodes = (id: string) => res.flows.find((f) => f.id === id)!.steps.map((s) => s.node);
    expect(nodes('miss')).toEqual([
      'actor:user',
      'infra:cdn',
      'infra:next',
      'route:/races/[id]',
      'lib:apiClient',
      'infra:httpApi',
      'infra:api',
      'handler:getRaces',
      'schema:RaceItem',
      'infra:racesTable',
      'route:/races/[id]',
      'infra:cdn',
      'actor:user',
    ]);
    expect(nodes('hit')).toEqual(['actor:user', 'infra:cdn', 'actor:user']);
    expect(nodes('invalidate')).toEqual([
      'actor:user',
      'infra:cdn',
      'infra:authEdge',
      'infra:next',
      'route:/admin/entry',
      'lib:apiClient',
      'infra:httpApi',
      'infra:api',
      'handler:postResult',
      'schema:RaceItem',
      'infra:racesTable',
      'route:/admin/entry',
      'infra:next',
      'infra:cdn',
    ]);
    // サンプル値（screenshots.routes）でパスを具体化する
    expect(res.flows[0]!.steps[0]!.text).toBe('/races/42 をリクエスト');
    expect(readFileSync(out, 'utf8')).toMatch(/^# データフロー定義/);
  });

  it('既存のファイルは --force が無ければ上書きしない', async () => {
    const root = tmpRepo();
    const out = join(root, 'flows.yaml');
    writeFileSync(out, '# 手書き\n');
    const stub: Extractor = {
      name: 'stub',
      detect: async () => true,
      extract: async () => ({
        nodes: [{ id: 'lib:a' }, { id: 'lib:b' }],
        edges: [{ from: 'lib:a', to: 'lib:b', kind: 'uses' }],
      }),
    };
    const log = createMemoryLogger();
    expect(await runInitFlows({ repo: root, log, extractors: [stub] })).toBe(1);
    expect(readFileSync(out, 'utf8')).toBe('# 手書き\n');
    expect(log.of('error').some((m) => m.includes('--force'))).toBe(true);

    // --force なら書く。経路が無ければ 2 ステップの最小の雛形
    expect(
      await quiet(() => runInitFlows({ repo: root, log, extractors: [stub], force: true })),
    ).toBe(0);
    const defs = readYamlFile(out) as unknown[];
    const res = normalizeFlows(defs, new Set(['lib:a', 'lib:b']));
    expect(res.issues).toEqual([]);
    expect(res.flows).toEqual([
      {
        id: 'example',
        name: 'フローの例',
        tone: 'default',
        steps: [
          { node: 'lib:a', text: 'ここから始まる（文を書き換える）' },
          { node: 'lib:b', text: '次のノード（ステップを足していく）' },
        ],
      },
    ]);
    expect(readFileSync(out, 'utf8')).toContain('経路が見つからない');
  });

  it('flows.yml（build が読むほうの名前）があるときも --force 無しでは flows.yaml を書かない', async () => {
    // 以前は flows.yaml の有無しか見ず、手書きの flows.yml の隣に雛形を書いて、次の build から雛形が読まれていた
    const root = tmpRepo();
    writeFileSync(join(root, 'flows.yml'), '# 手書き\n');
    const stub: Extractor = {
      name: 'stub',
      detect: async () => true,
      extract: async () => ({ nodes: [{ id: 'lib:a' }], edges: [] }),
    };
    const log = createMemoryLogger();
    expect(await runInitFlows({ repo: root, log, extractors: [stub] })).toBe(1);
    expect(existsSync(join(root, 'flows.yaml'))).toBe(false);
    expect(log.of('error').some((m) => m.includes('flows.yml'))).toBe(true);
    // --out を明示したときは、その場所だけを見る
    const other = join(root, 'other.yaml');
    expect(
      await quiet(() => runInitFlows({ repo: root, log, extractors: [stub], out: other })),
    ).toBe(0);
    expect(existsSync(other)).toBe(true);
  });

  it('ノードが無ければ空の配列とコメントの例を書く', async () => {
    const root = tmpRepo();
    const empty: Extractor = {
      name: 'empty',
      detect: async () => true,
      extract: async () => ({ nodes: [], edges: [] }),
    };
    expect(
      await quiet(() =>
        runInitFlows({ repo: root, log: createMemoryLogger(), extractors: [empty] }),
      ),
    ).toBe(0);
    expect(readYamlFile(join(root, 'flows.yaml'))).toEqual([]);
  });

  it('main: 引数が足りなければ 2、無いリポジトリは 2', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await main(['init-flows'])).toBe(2);
    expect(await main(['init-flows', join(tmpdir(), 'no-such-repo-xyz')])).toBe(2);
    err.mockRestore();
    expect(existsSync(join(tmpdir(), 'no-such-repo-xyz'))).toBe(false);
  });
});
