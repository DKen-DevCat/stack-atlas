import { describe, expect, it } from 'vitest';
import { AtlasConfigError, createRepoContext, loadConfig } from '../config.js';
import { createMemoryLogger } from '../logger.js';
import { FIXTURE, tmpRepo } from './helpers.js';

describe('loadConfig', () => {
  it('フィクスチャの設定を読める', () => {
    const log = createMemoryLogger();
    const cfg = loadConfig(FIXTURE, log);
    expect(cfg.project?.name).toBe('race-results');
    expect(cfg.layers?.map((l) => l.id)).toEqual(['infra', 'routes', 'components', 'types']);
    expect(cfg.deploy?.['infra:next']).toEqual({ app: 'next' });
    expect(cfg.ts?.tsconfig).toHaveLength(3);
    expect(log.of('warn')).toEqual([]);
  });

  it('ファイルが無ければ {} と警告', () => {
    const log = createMemoryLogger();
    expect(loadConfig(tmpRepo(), log)).toEqual({});
    expect(log.of('warn')).toHaveLength(1);
  });

  it('.yml も読む。未知のキーと型違いは警告して捨てる', () => {
    const root = tmpRepo({
      'stack-atlas.config.yml':
        'project: { name: x }\nfoo: 1\nlayers: nope\nextractors: { cdktf: false, ts: maybe }\n',
    });
    const log = createMemoryLogger();
    const cfg = loadConfig(root, log);
    expect(cfg).toEqual({ project: { name: 'x' }, extractors: { cdktf: false } });
    expect(log.of('warn').join('\n')).toMatch(/foo/);
    expect(log.of('warn').join('\n')).toMatch(/layers/);
    expect(log.of('warn').join('\n')).toMatch(/extractors\.ts/);
  });

  it('screens（8-3b）: 正しい値は残し、outDir・未知のキー・型違いは警告して捨てる', () => {
    const root = tmpRepo({
      'stack-atlas.config.yaml': [
        'screens:',
        '  repo: web',
        '  from: dir',
        '  dir: export',
        '  routes: { "/items/[id]": ["a"], "/bad/[x]": 3 }',
        '  viewport: { width: 1280, height: 800 }',
        '  outDir: /etc',
        '  build: pnpm build',
        '',
      ].join('\n'),
    });
    const log = createMemoryLogger();
    expect(loadConfig(root, log).screens).toEqual({
      repo: 'web',
      from: 'dir',
      dir: 'export',
      routes: { '/items/[id]': ['a'] },
      viewport: { width: 1280, height: 800 },
    });
    const warns = log.of('warn').join('\n');
    expect(warns).toContain('screens.outDir は設定できません');
    expect(warns).toContain('screens.build は未知のキー');
    expect(warns).toContain('screens.routes["/bad/[x]"]');

    const bad = tmpRepo({
      'stack-atlas.config.yaml':
        'screens: { from: next-build, viewport: { width: 0, height: 800 }, dir: 3 }\n',
    });
    const log2 = createMemoryLogger();
    expect(loadConfig(bad, log2).screens).toEqual({});
    expect(log2.of('warn').join('\n')).toMatch(
      /screens\.from[\s\S]*screens\.dir[\s\S]*screens\.viewport/,
    );
  });

  it('YAML の構文エラーは AtlasConfigError', () => {
    const root = tmpRepo({ 'stack-atlas.config.yaml': 'a: [1, 2\n' });
    expect(() => loadConfig(root)).toThrow(AtlasConfigError);
  });

  it('createRepoContext は root 基準で resolve する', () => {
    const ctx = createRepoContext('/repo', {});
    expect(ctx.resolve('infra', 'main.ts')).toBe('/repo/infra/main.ts');
  });
});
