// 図を 1 つの graph.json にまとめる（Phase 10-1c の後半。docs/26 §9）
import { validateGraphV2 } from '@stack-atlas/schema';
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ATLAS_GENERATOR, bundleAtlas } from '../atlas/index.js';

const AGENT = fileURLToPath(new URL('./fixtures/atlas-live-agent/', import.meta.url));
const WIRING_FIXTURE = fileURLToPath(
  new URL('../../../wiring/src/__tests__/fixtures/atlas-live-agent.graph.json', import.meta.url),
);

describe('bundleAtlas', () => {
  it('検査を通った図を、契約どおりの graph.json（部品と挙動つき）にまとめる', () => {
    const { report, graph } = bundleAtlas(AGENT, { name: 'atlas-live-agent' });
    expect(report.counts.errors).toBe(0);
    expect(validateGraphV2(graph)).toMatchObject({ ok: true, errors: [], warnings: [] });
    expect(graph!.project).toEqual({
      name: 'atlas-live-agent',
      generator: { v2: ATLAS_GENERATOR },
    });
    expect(graph!.nodes).toHaveLength(11);
    expect(graph!.wires).toHaveLength(17);
    expect(graph!.parts).toHaveLength(4);
    expect(graph!.behaviors!.map((b) => b.id)).toEqual(['open', 'post-comment', 'delete-comment']);
  });

  it('wiring のテストが読む graph.json は、この図をまとめたものと同じ（ずれたら、作り直す）', () => {
    // 作り直し: pnpm atlas bundle packages/core/src/__tests__/fixtures/atlas-live-agent -o <dir> して、graph.json を写す
    const fixture = JSON.parse(readFileSync(WIRING_FIXTURE, 'utf8')) as unknown;
    expect(bundleAtlas(AGENT, { name: 'atlas-live-agent' }).graph).toEqual(fixture);
  });

  it('図に誤りがあれば、まとめない', () => {
    const root = mkdtempSync(join(tmpdir(), 'stack-atlas-bundle-'));
    cpSync(AGENT, root, { recursive: true });
    const file = join(root, '.stack-atlas/parts.yaml');
    writeFileSync(
      file,
      readFileSync(file, 'utf8').replace('box: "part:status"', 'box: "part:nothing"'),
    );
    const { report, graph } = bundleAtlas(root);
    expect(report.counts.errors).toBe(1);
    expect(graph).toBeUndefined();
  });
});
