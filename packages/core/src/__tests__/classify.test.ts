import { describe, expect, it } from 'vitest';
import { applyClassify, classifyKind, matchGlob, repoOfNames } from '../classify.js';
import { createRepoContext } from '../config.js';
import type { PartialGraph, StackAtlasConfig } from '../types.js';

describe('matchGlob', () => {
  it.each([
    ['src/components/a/B.tsx', 'src/components/**', true],
    ['src/components/B.tsx', 'src/components/*.tsx', true],
    ['src/components/a/B.tsx', 'src/components/*.tsx', false],
    ['src/feature/x/types.ts', 'src/feature/**/types.ts', true],
    ['src/feature/types.ts', 'src/feature/**/types.ts', true],
    ['a.ts', '?.ts', true],
    ['ab.ts', '?.ts', false],
    ['x/a.tsx', 'x/*.{ts,tsx}', true],
    ['x/a.js', 'x/*.{ts,tsx}', false],
    ['./x/a.ts', 'x/*.ts', true],
  ])('%s ~ %s → %s', (path, glob, want) => {
    expect(matchGlob(path, glob)).toBe(want);
  });
});

const config: StackAtlasConfig = {
  repos: { web: '../web', platform: '../platform' },
  classify: [
    { glob: 'src/components/**', kind: 'component' },
    { glob: 'internal/domain/**', kind: 'type', repo: 'platform' },
    { glob: 'internal/**', layer: 'routes' },
    { glob: 'internal/store/**', kind: 'schema' }, // 上のルールが先に合うので効かない
  ],
};

describe('classifyKind（抽出器向け）', () => {
  const ctx = (repoName: string) =>
    createRepoContext(`/w/${repoName}`, config, undefined, { repoName });
  it('最初に合ったルールの kind。無ければ既定', () => {
    expect(classifyKind(ctx('web'), 'src/components/x/Y.tsx', 'lib')).toBe('component');
    expect(classifyKind(ctx('web'), '/w/web/src/components/Y.tsx', 'lib')).toBe('component');
    expect(classifyKind(ctx('web'), 'src/lib/y.ts', 'lib')).toBe('lib');
    expect(classifyKind(ctx('platform'), 'internal/domain/a.go', 'lib')).toBe('type');
    // rule.repo が違う
    expect(classifyKind(ctx('web'), 'internal/domain/a.go', 'lib')).toBe('lib');
    // 最初に合ったのが layer だけのルール → 既定
    expect(classifyKind(ctx('platform'), 'internal/store/a.go', 'lib')).toBe('lib');
  });
});

describe('applyClassify', () => {
  const graph: PartialGraph = {
    nodes: [
      { id: 'lib:Button', kind: 'lib', file: 'web/src/components/Button.tsx' },
      { id: 'lib:internal/domain', kind: 'lib', file: 'platform/internal/domain/a.go' },
      { id: 'lib:internal/store', kind: 'lib', file: 'platform/internal/store/s.go' },
      { id: 'lib:web-internal', kind: 'lib', file: 'web/internal/domain/x.ts' },
      { id: 'infra:x', kind: 'infra' },
    ],
    edges: [],
  };
  it('repo 名を外して照合し、ID は変えずに kind / layer を上書きする', () => {
    const out = applyClassify(graph, config, repoOfNames(['web', 'platform']));
    expect(out.nodes.map((n) => [n.id, n.kind, n.layer])).toEqual([
      ['lib:Button', 'component', undefined],
      ['lib:internal/domain', 'type', undefined],
      ['lib:internal/store', 'lib', 'routes'],
      ['lib:web-internal', 'lib', 'routes'],
      ['infra:x', 'infra', undefined],
    ]);
    expect(graph.nodes[0]!.kind).toBe('lib'); // 元は変えない
  });
  it('既定の repoOf は config.repos のキーを使う', () => {
    expect(applyClassify(graph, config).nodes[0]!.kind).toBe('component');
  });
  it('単一 repo では file をそのまま照合する', () => {
    const out = applyClassify(
      { nodes: [{ id: 'lib:a', kind: 'lib', file: 'src/components/A.tsx' }], edges: [] },
      { classify: [{ glob: 'src/components/**', kind: 'component' }] },
    );
    expect(out.nodes[0]!.kind).toBe('component');
  });
});
