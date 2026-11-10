import { validateGraph } from '@stack-atlas/schema';
import { describe, expect, it } from 'vitest';
import { checkConfig } from '../config.js';
import { createMemoryLogger } from '../logger.js';
import { buildGraph } from '../pipeline.js';
import { mergePartialGraphs } from '../merge.js';
import { tmpRepo } from './helpers.js';

describe('kinds', () => {
  it('config.kinds と抽出器の kinds を graph.kinds に出し、kinds[k].layer を既定の層に使う', async () => {
    const res = await buildGraph({
      root: tmpRepo(),
      commit: false,
      config: {
        kinds: {
          job: { name: 'ジョブ', color: '#123456', layer: 'infra' },
          endpoint: { color: '#000000' },
        },
      },
      extractors: [
        {
          name: 'x',
          detect: async () => true,
          extract: async () => ({
            nodes: [
              { id: 'job:nightly', kind: 'job' },
              { id: 'endpoint:GET /a', kind: 'endpoint' },
            ],
            edges: [],
            kinds: { endpoint: { name: 'API エンドポイント', color: '#38bdf8', layer: 'types' } },
          }),
        },
      ],
    });
    expect(res.graph.kinds).toEqual({
      endpoint: { name: 'API エンドポイント', color: '#000000', layer: 'types' },
      job: { name: 'ジョブ', color: '#123456', layer: 'infra' },
    });
    expect(res.graph.nodes.map((n) => [n.id, n.layer])).toEqual([
      ['job:nightly', 'infra'],
      ['endpoint:GET /a', 'types'],
    ]);
    expect(res.issues).toEqual([]);
    expect(validateGraph(res.graph)).toMatchObject({ ok: true, errors: [] });
  });

  it('kinds が無ければ graph.kinds を出さない', async () => {
    const res = await buildGraph({ root: tmpRepo(), commit: false, config: {}, extractors: [] });
    expect('kinds' in res.graph).toBe(false);
  });

  it('マージは kind ごとに先の値を残す', () => {
    const m = mergePartialGraphs([
      { nodes: [], edges: [], kinds: { a: { size: [1, 1, 1] } } },
      { nodes: [], edges: [], kinds: { a: { size: [2, 2, 2], name: 'A' } } },
    ]);
    expect(m.kinds).toEqual({ a: { size: [1, 1, 1], name: 'A' } });
  });

  it('checkConfig は kinds の色・大きさ、classify / files のルールをゆるく検査する', () => {
    const log = createMemoryLogger();
    const cfg = checkConfig(
      {
        kinds: { a: { color: 'red', size: [1, 2] }, b: 'x' },
        classify: [{ glob: 'a/**' }, { kind: 'x' }],
        files: [{ glob: 'a/*', kind: 'lib' }, { glob: 'b/*' }],
        repos: { web: '.', bad: 3 },
      },
      log,
    );
    expect(cfg.kinds).toEqual({ a: {} });
    expect(cfg.classify).toEqual([{ glob: 'a/**' }]);
    expect(cfg.files).toEqual([{ glob: 'a/*', kind: 'lib' }]);
    expect(cfg.repos).toEqual({ web: '.' });
    expect(log.of('warn')).toHaveLength(6);
  });
});
