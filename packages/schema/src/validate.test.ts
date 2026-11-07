import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { validateGraph } from './validate.js';
import type { Graph } from './types.js';

const samplePath = fileURLToPath(
  new URL('../../../examples/race-site.graph.json', import.meta.url),
);
const sample = JSON.parse(readFileSync(samplePath, 'utf8')) as Graph;

/** サンプルを複製して壊す */
function broken(mutate: (g: Graph) => void): Graph {
  const g = structuredClone(sample);
  mutate(g);
  return g;
}

const errorsOf = (json: unknown) => validateGraph(json).errors.filter((e) => e.level === 'error');

describe('validateGraph', () => {
  it('サンプルはエラーも警告もなく通る', () => {
    const r = validateGraph(sample);
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.graph).toBeDefined();
  });

  it('未知の layer は参照エラー。graph は返す', () => {
    const r = validateGraph(
      broken((g) => {
        g.nodes[0]!.layer = 'no-such-layer';
      }),
    );
    expect(r.ok).toBe(false);
    expect(r.graph).toBeDefined();
    expect(r.errors).toContainEqual(
      expect.objectContaining({ level: 'error', path: '/nodes/0/layer' }),
    );
  });

  it('存在しないエッジの終点はエラー', () => {
    const r = validateGraph(
      broken((g) => {
        g.edges[0]!.to = 'comp:Missing';
      }),
    );
    expect(r.ok).toBe(false);
    expect(r.graph).toBeDefined();
    expect(r.errors).toContainEqual(expect.objectContaining({ path: '/edges/0/to' }));
  });

  it('ノード ID の重複はエラー', () => {
    const errs = errorsOf(
      broken((g) => {
        g.nodes.push(structuredClone(g.nodes[0]!));
      }),
    );
    expect(errs).toContainEqual(
      expect.objectContaining({ path: `/nodes/${sample.nodes.length}/id` }),
    );
    expect(errs[0]!.message).toContain('重複');
  });

  it('層 ID の重複はエラー', () => {
    const errs = errorsOf(
      broken((g) => {
        g.layers.push(structuredClone(g.layers[0]!));
      }),
    );
    expect(errs).toContainEqual(
      expect.objectContaining({ path: `/layers/${sample.layers.length}/id` }),
    );
  });

  it('存在しない region.ref はエラー', () => {
    const errs = errorsOf(
      broken((g) => {
        const screenNode = g.nodes.find((n) => n.screen?.regions?.length)!;
        screenNode.screen!.regions![0]!.ref = 'comp:Missing';
      }),
    );
    expect(errs.some((e) => /\/screen\/regions\/0\/ref$/.test(e.path))).toBe(true);
  });

  it('存在しない flow step のノードはエラー', () => {
    const errs = errorsOf(
      broken((g) => {
        g.flows![0]!.steps[0]!.node = 'actor:nobody';
      }),
    );
    expect(errs).toContainEqual(expect.objectContaining({ path: '/flows/0/steps/0/node' }));
  });

  it('version が 1 でなければスキーマエラー。graph は返さない', () => {
    const r = validateGraph(
      broken((g) => {
        (g as { version: number }).version = 2;
      }),
    );
    expect(r.ok).toBe(false);
    expect(r.graph).toBeUndefined();
    expect(r.errors).toContainEqual(expect.objectContaining({ level: 'error', path: '/version' }));
  });

  it('JSON でないもの・空オブジェクトはスキーマエラー', () => {
    expect(validateGraph(null).ok).toBe(false);
    expect(validateGraph({}).ok).toBe(false);
  });

  it('自己ループと未知の kind は警告のみ（ok のまま）', () => {
    const r = validateGraph(
      broken((g) => {
        const id = g.nodes[0]!.id;
        g.edges.push({ from: id, to: id, kind: 'telepathy' });
        g.nodes[1]!.kind = 'widget';
      }),
    );
    expect(r.ok).toBe(true);
    const warnings = r.errors.filter((e) => e.level === 'warning');
    expect(warnings).toHaveLength(3);
    expect(warnings.map((w) => w.path)).toContain('/nodes/1/kind');
  });
});
