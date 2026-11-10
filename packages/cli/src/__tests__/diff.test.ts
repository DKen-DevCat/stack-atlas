import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { formatDiff, runDiff } from '../commands/diff.js';
import { diffGraphs } from '@stack-atlas/core';

const SAMPLE = fileURLToPath(new URL('../../../../examples/race-site.graph.json', import.meta.url));

describe('stack-atlas diff', () => {
  it('同じファイルなら「差分なし」で終了コード 0', () => {
    const lines: string[] = [];
    expect(runDiff([SAMPLE, SAMPLE], (s) => lines.push(s))).toBe(0);
    expect(lines.join('\n')).toContain('差分なし');
  });

  it('追加・削除・変更を日本語で出す', () => {
    const g = JSON.parse(readFileSync(SAMPLE, 'utf8'));
    g.nodes = g.nodes.filter((n: { id: string }) => n.id !== 'comp:Pagination');
    g.edges = g.edges.filter(
      (e: { from: string; to: string }) =>
        e.from !== 'comp:Pagination' && e.to !== 'comp:Pagination',
    );
    g.nodes.push({ id: 'comp:New', layer: 'components', kind: 'component', name: 'New' });
    g.edges.push({ from: 'route:/', to: 'comp:New', kind: 'uses' });
    g.nodes.find((n: { id: string }) => n.id === 'route:/').name = 'Home';
    const next = join(mkdtempSync(join(tmpdir(), 'stack-atlas-diff-')), 'next.json');
    writeFileSync(next, JSON.stringify(g));

    const lines: string[] = [];
    expect(runDiff([SAMPLE, next], (s) => lines.push(s))).toBe(0);
    const text = lines.join('\n');
    expect(text).toContain('+ 追加ノード（1）\n  comp:New');
    expect(text).toContain('- 削除ノード（1）\n  comp:Pagination');
    expect(text).toContain('~ 変更ノード（1）\n  route:/: name');
    expect(text).toContain('+ 追加エッジ（1）\n  route:/ → comp:New（uses）');
    expect(text).toMatch(/- 削除エッジ（\d+）/);
    expect(text).toMatch(/合計: ノード \+1 \/ -1 \/ ~1、エッジ \+1 \/ -\d+/);
  });

  it('引数不足・読めないファイルは終了コード 2', () => {
    expect(runDiff([SAMPLE])).toBe(2);
    expect(runDiff([SAMPLE, '/nonexistent.json'])).toBe(2);
  });

  it('formatDiff のラベル', () => {
    const g = JSON.parse(readFileSync(SAMPLE, 'utf8'));
    expect(formatDiff(diffGraphs(g, g), 'a.json', 'b.json').split('\n')[0]).toBe(
      '差分: a.json → b.json',
    );
  });
});
