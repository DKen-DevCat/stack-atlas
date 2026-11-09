// regions.yaml（docs/19 §3.7。Phase 8-4b）: HTML で測れない部品の領域を手で補う。計測で取れる ref は使わない、
// source: yaml、カバー率は計測と別に数える、壊れた行・リンク・上限
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { PartialGraph, PartialNode, RepoContext, StackAtlasConfig } from '@stack-atlas/core';
import { extractor, readRegionsYaml } from '../index.js';

const here = dirname(fileURLToPath(import.meta.url));
const web = resolve(here, '../../../../examples/fixture-poly/web');
const tmp = (p: string) => realpathSync(mkdtempSync(join(tmpdir(), p)));
const N = (id: string, extra: Partial<PartialNode> = {}): PartialNode => ({ id, ...extra });

function run(configDir: string) {
  const out = tmp('stack-atlas-regions-out-');
  const config: StackAtlasConfig = { screens: { from: 'dir', dir: 'export', outDir: out } };
  const logs: string[] = [];
  const ctx: RepoContext = {
    root: web,
    repoName: 'web',
    repos: { web },
    configDir,
    config,
    log: {
      debug() {},
      info: (m) => logs.push(m),
      warn: (m) => logs.push(m),
      error: (m) => logs.push(m),
    },
    resolve: (...s) => resolve(web, ...s),
  };
  const upstream: PartialGraph = {
    nodes: [
      N('route:/', { kind: 'page' }),
      ...['TodayIsland', 'TotalCard', 'EntryList'].map((c) =>
        N(`comp:${c}`, { kind: 'component' }),
      ),
    ],
    edges: [
      { from: 'route:/', to: 'comp:TodayIsland', kind: 'uses' },
      { from: 'comp:TodayIsland', to: 'comp:TotalCard', kind: 'uses' },
      { from: 'comp:TodayIsland', to: 'comp:EntryList', kind: 'uses' },
    ],
  };
  return extractor.extract(ctx, upstream);
}

function configWith(yaml: string): string {
  const dir = tmp('stack-atlas-regions-cfg-');
  mkdirSync(join(dir, '.stack-atlas', 'screens'), { recursive: true });
  writeFileSync(join(dir, '.stack-atlas', 'screens', 'index.regions.yaml'), yaml);
  return dir;
}

describe('regions.yaml（.stack-atlas/screens/<slug>.regions.yaml）', () => {
  it('計測で取れない ref だけを source: yaml で足し、カバー率は別に数える', async () => {
    const dir = configWith(`
- { ref: comp:TodayIsland, x: 0, y: 0, w: 100, h: 100 }   # HTML の data-component で測れる（使わない）
- { ref: TotalCard, x: 10, y: 20, w: 300, h: 900 }        # 名前でも解ける。ビューポートで切り詰める
- { ref: comp:Nope, x: 0, y: 0, w: 1, h: 1 }
- { ref: comp:EntryList, x: "a", y: 0, w: 1, h: 1 }
- { ref: comp:EntryList, x: 2000, y: 0, w: 10, h: 10 }
`);
    const g = await run(dir);
    const root = g.nodes.find((n) => n.id === 'route:/')!;
    expect(root.screen!.regions).toEqual([
      { ref: 'comp:TotalCard', x: 10, y: 20, w: 300, h: 780, source: 'yaml' },
    ]);
    const mine = g.issues!.filter((i) => i.message.includes('index.regions.yaml'));
    expect(mine.map((i) => `${i.level}:${i.message.replace(/^.*?regions\.yaml: /, '')}`)).toEqual([
      'warning:[2] の ref comp:Nope が箱に解けません',
      'warning:[3]（comp:EntryList）の x・y・w・h は数で書いてください',
      'warning:[4]（comp:EntryList）は画面（1280×800）の外です',
      'info:comp:TodayIsland は HTML の data-component で測れるので使いません（計測が勝つ）',
    ]);
    const cov = g.issues!.find((i) => i.path === 'screens:/' && /カバー率/.test(i.message))!;
    expect(cov.data).toEqual({ reachable: 3, dom: 1, yaml: 1 });
    expect(cov.message).toBe(
      'regions のカバー率 1/3（33%）。HTML に無い部品: comp:EntryList。regions.yaml で補った部品: comp:TotalCard',
    );
    // 他の画面には付けない
    expect(g.nodes.filter((n) => n.screen?.regions)).toHaveLength(1);
  });

  it('無ければ何もしない。シンボリックリンク・壊れた YAML・形の違うものは警告して読まない', async () => {
    const none = await run(tmp('stack-atlas-regions-none-'));
    expect(none.nodes.find((n) => n.id === 'route:/')!.screen!.regions).toBeUndefined();
    const opts = {
      pattern: '/',
      viewport: { width: 1280, height: 800 },
      ids: new Set(['comp:A']),
      measured: new Set<string>(),
    };
    const link = tmp('stack-atlas-regions-link-');
    mkdirSync(join(link, '.stack-atlas'));
    writeFileSync(join(link, 'r.yaml'), '- { ref: comp:A, x: 0, y: 0, w: 1, h: 1 }\n');
    mkdirSync(join(link, 'real'));
    symlinkSync(join(link, 'real'), join(link, '.stack-atlas', 'screens'));
    writeFileSync(
      join(link, 'real', 'index.regions.yaml'),
      '- { ref: comp:A, x: 0, y: 0, w: 1, h: 1 }\n',
    );
    const l = readRegionsYaml(link, 'index', opts);
    expect(l.regions).toEqual([]);
    expect(l.issues[0]!.message).toContain('シンボリックリンク');
    expect(readRegionsYaml(configWith('[\n'), 'index', opts).issues[0]!.message).toContain(
      'YAML として読めません',
    );
    expect(readRegionsYaml(configWith('a: 1\n'), 'index', opts).issues[0]!.message).toContain(
      '配列',
    );
    expect(
      readRegionsYaml(
        configWith('regions: [{ ref: comp:A, x: 1, y: 2, w: 3, h: 4 }]\n'),
        'index',
        opts,
      ).regions,
    ).toEqual([{ ref: 'comp:A', x: 1, y: 2, w: 3, h: 4, source: 'yaml' }]);
  });
});
