import { describe, expect, it } from 'vitest';
import { createRepoContext } from '../config.js';
import { loadFlowDefinitions, loadFlows, normalizeFlows } from '../flows.js';
import { FIXTURE, tmpRepo } from './helpers.js';

describe('flows', () => {
  it('フィクスチャの flows.yaml を正規化できる（[id] を含む ID も）', () => {
    const ctx = createRepoContext(FIXTURE, {});
    const { defs } = loadFlowDefinitions(ctx);
    const { flows: all } = normalizeFlows(defs);
    const ids = new Set(all.flatMap((f) => f.steps.map((s) => s.node)));
    expect(ids.has('route:/races/[id]')).toBe(true);

    const { flows, issues } = loadFlows(ctx, ids);
    expect(issues).toEqual([]);
    expect(flows.map((f) => [f.id, f.tone, f.steps.length])).toEqual([
      ['miss', 'default', 14],
      ['hit', 'cache-hit', 3],
      ['entry', 'default', 15],
    ]);
    expect(flows[1]!.steps[1]).toEqual({
      node: 'infra:cdn',
      text: 'HIT（age 23s < s-maxage 60）→ エッジで即返却',
    });
  });

  it('{node, text} 形式も受け付ける', () => {
    const { flows } = normalizeFlows([
      { id: 'f', name: 'F', steps: [{ node: 'a', text: 't' }, ['b', 'u']] },
    ]);
    expect(flows[0]!.steps).toEqual([
      { node: 'a', text: 't' },
      { node: 'b', text: 'u' },
    ]);
  });

  it('存在しないノードはフロー ID とステップ番号付きのエラー', () => {
    const { flows, issues } = normalizeFlows(
      [
        {
          id: 'miss',
          name: 'M',
          steps: [
            ['a', 'ok'],
            ['ghost', 'x'],
          ],
        },
      ],
      new Set(['a']),
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ level: 'error', path: 'flows.yaml#/0/steps/1' });
    expect(issues[0]!.message).toContain('"miss"');
    expect(issues[0]!.message).toContain('1 番目');
    expect(issues[0]!.message).toContain('"ghost"');
    expect(flows[0]!.steps).toEqual([{ node: 'a', text: 'ok' }]);
  });

  it('id 重複・steps なし・未知の tone', () => {
    const { flows, issues } = normalizeFlows([
      { id: 'a', name: 'A', tone: 'weird', steps: [['n', '']] },
      { id: 'a', name: 'dup', steps: [] },
      { id: 'b', name: 'B' },
    ]);
    expect(flows).toEqual([{ id: 'a', name: 'A', steps: [{ node: 'n', text: '' }] }]);
    expect(issues.map((i) => i.level)).toEqual(['warning', 'error', 'error']);
  });

  it('flows.yaml が無ければ []', () => {
    expect(loadFlows(createRepoContext(tmpRepo(), {}))).toEqual({ flows: [], issues: [] });
  });
});
