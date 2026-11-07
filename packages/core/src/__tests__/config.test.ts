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

  it('YAML の構文エラーは AtlasConfigError', () => {
    const root = tmpRepo({ 'stack-atlas.config.yaml': 'a: [1, 2\n' });
    expect(() => loadConfig(root)).toThrow(AtlasConfigError);
  });

  it('createRepoContext は root 基準で resolve する', () => {
    const ctx = createRepoContext('/repo', {});
    expect(ctx.resolve('infra', 'main.ts')).toBe('/repo/infra/main.ts');
  });
});
