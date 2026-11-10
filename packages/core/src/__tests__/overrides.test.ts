import { describe, expect, it } from 'vitest';
import { createRepoContext } from '../config.js';
import { createMemoryLogger } from '../logger.js';
import { applyOverrides, loadOverrides } from '../overrides.js';
import type { PartialGraph } from '../types.js';
import { FIXTURE, tmpRepo } from './helpers.js';

const base = (): PartialGraph => ({
  nodes: [
    { id: 'infra:cdn', kind: 'infra', name: 'cdn', meta: { extractors: ['cdktf'] } },
    { id: 'infra:next', kind: 'infra', name: 'next' },
    { id: 'infra:api', kind: 'infra', name: 'api' },
    { id: 'route:/login', kind: 'page', name: '/login' },
    { id: 'route:/admin/entry', kind: 'page', name: '/admin/entry' },
    { id: 'handler:getRaces', kind: 'handler', name: 'getRaces' },
    { id: 'handler:postResult', kind: 'handler', name: 'postResult' },
  ],
  edges: [{ from: 'infra:cdn', to: 'infra:next', kind: 'flow' }],
});

describe('loadOverrides / applyOverrides', () => {
  it('フィクスチャの overrides.yaml を読んで当てられる', () => {
    const log = createMemoryLogger();
    const ov = loadOverrides(createRepoContext(FIXTURE, {}, log));
    expect(log.of('warn')).toEqual([]);
    expect(ov.nodes?.[0]?.id).toBe('actor:user');
    expect(ov.deploy?.['infra:api']).toEqual(['handler:getRaces', 'handler:postResult']);

    const { graph, issues } = applyOverrides(base(), ov);
    expect(issues).toEqual([]);
    const user = graph.nodes.find((n) => n.id === 'actor:user');
    expect(user).toMatchObject({
      kind: 'actor',
      layer: 'infra',
      name: 'Browser',
      meta: { extractors: ['overrides'] },
    });
    expect(graph.edges).toEqual(
      expect.arrayContaining([
        { from: 'actor:user', to: 'infra:cdn', kind: 'flow' },
        { from: 'route:/admin/entry', to: 'infra:cdn', kind: 'http' },
        { from: 'infra:api', to: 'handler:getRaces', kind: 'deploy' },
        { from: 'infra:api', to: 'handler:postResult', kind: 'deploy' },
        { from: 'infra:next', to: 'route:/login', kind: 'deploy' },
      ]),
    );
  });

  it('ファイルが無ければ {}', () => {
    expect(loadOverrides(createRepoContext(tmpRepo(), {}))).toEqual({});
  });

  it('既存ノードは上書きでマージする（meta.extractors は和集合）', () => {
    const { graph } = applyOverrides(base(), {
      nodes: [{ id: 'infra:cdn', name: 'CloudFront', cache: { tone: 'ok', badge: 'CDN' } }],
    });
    expect(graph.nodes[0]).toEqual({
      id: 'infra:cdn',
      kind: 'infra',
      name: 'CloudFront',
      cache: { tone: 'ok', badge: 'CDN' },
      meta: { extractors: ['cdktf', 'overrides'] },
    });
  });

  it('edges / deploy の未知ノードはエラー（ID を名指し）', () => {
    const { graph, issues } = applyOverrides(base(), {
      edges: [{ from: 'infra:cdn', to: 'infra:ghost', kind: 'flow' }],
      deploy: { 'infra:nope': ['route:/login'] },
    });
    expect(issues.map((i) => i.level)).toEqual(['error', 'error']);
    expect(issues[0]!.message).toContain('"infra:ghost"');
    expect(issues[1]!.message).toContain('"infra:nope"');
    expect(graph.edges).toHaveLength(1);
  });

  it('remove はノード（と繋がるエッジ）とエッジを消す', () => {
    const { graph, issues } = applyOverrides(
      {
        ...base(),
        edges: [...base().edges, { from: 'infra:next', to: 'route:/login', kind: 'deploy' }],
      },
      {
        remove: [
          'infra:cdn',
          { from: 'infra:next', to: 'route:/login', kind: 'deploy' },
          'missing:x',
        ],
      },
    );
    expect(graph.nodes.some((n) => n.id === 'infra:cdn')).toBe(false);
    expect(graph.edges).toEqual([]);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.level).toBe('warning');
  });

  it('形の違う要素は警告して捨てる', () => {
    const root = tmpRepo({
      'stack-atlas.overrides.yaml': 'nodes: [{ name: noid }]\nedges: [{ from: a }]\nbogus: 1\n',
    });
    const log = createMemoryLogger();
    const ov = loadOverrides(createRepoContext(root, {}, log));
    expect(ov).toEqual({ nodes: [], edges: [] });
    expect(log.of('warn')).toHaveLength(3);
  });
});
