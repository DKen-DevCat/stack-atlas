import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { formatDiff, runDiff } from '../commands/diff.js';
import { diffGraphs, upgradeGraph } from '@stack-atlas/core';

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

  it('スキーマを満たさない v2（口の無い箱）は読めないものとして終了コード 2（落ちない）', () => {
    // 以前は検証せずに比べたので、itemRefs が n.ports を回して TypeError で落ちた
    const v2 = upgradeGraph(JSON.parse(readFileSync(SAMPLE, 'utf8')));
    const broken = structuredClone(v2) as unknown as { nodes: Record<string, unknown>[] };
    delete broken.nodes[0]!.ports;
    const dir = mkdtempSync(join(tmpdir(), 'stack-atlas-diff-bad-'));
    const prev = join(dir, 'prev.json');
    const next = join(dir, 'next.json');
    writeFileSync(prev, JSON.stringify(v2));
    writeFileSync(next, JSON.stringify(broken));
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const out: string[] = [];
    const code = runDiff([prev, next], (s) => out.push(s));
    const msg = err.mock.calls.map((c) => String(c[0])).join('\n');
    err.mockRestore();
    expect(code).toBe(2);
    expect(out).toEqual([]);
    expect(msg).toContain(`${next} は graph.json v2 のスキーマを満たしません`);
    expect(msg).toContain('/nodes/0');
  });

  it('v2 どうしは箱・線・型・項目で比べる', () => {
    const v2 = upgradeGraph(JSON.parse(readFileSync(SAMPLE, 'utf8')));
    const dir = mkdtempSync(join(tmpdir(), 'stack-atlas-diff-v2-'));
    const prev = join(dir, 'prev.json');
    writeFileSync(prev, JSON.stringify(v2));
    const same: string[] = [];
    expect(runDiff([prev, prev], (s) => same.push(s))).toBe(0);
    expect(same.join('\n')).toBe(`差分: ${prev} → ${prev}（graph.json v2）\n差分なし`);

    const g = structuredClone(v2);
    g.nodes
      .find((n) => n.id === 'route:/')!
      .ports[0]!.items.push({
        id: 'date',
        name: 'date',
        type: 'string',
      });
    g.wires = g.wires.filter((w) => w.to !== 'comp:Pagination#in/_');
    g.types = g.types!.filter((t) => t.id !== 'type:Session');
    const next = join(dir, 'next.json');
    writeFileSync(next, JSON.stringify(g));
    const lines: string[] = [];
    expect(runDiff([prev, next], (s) => lines.push(s))).toBe(0);
    const text = lines.join('\n');
    expect(text).toContain('+ 追加の項目（1）\n  route:/#in/date');
    expect(text).toContain(
      '- 削除の線（1）\n  route:/races#out/_ → comp:Pagination#in/_（render）',
    );
    expect(text).toContain('- 削除の型（1）\n  type:Session');
    expect(text).toContain('合計: 箱 +0 / -0 / ~0、項目 +1 / -0、線 +0 / -1 / ~0、型 +0 / -1');
  });

  it('v1 と v2 を比べるときは v1 の側を v2 に変換する（Phase 8-1 より前の graph.json と比べられる）', () => {
    const v2 = upgradeGraph(JSON.parse(readFileSync(SAMPLE, 'utf8')));
    const next = join(mkdtempSync(join(tmpdir(), 'stack-atlas-diff-mix-')), 'next.json');
    writeFileSync(next, JSON.stringify(v2));
    const lines: string[] = [];
    expect(runDiff([SAMPLE, next], (s) => lines.push(s))).toBe(0);
    expect(lines.join('\n')).toContain('v1 の側は v2 に変換して比べました');
    expect(lines.join('\n')).toContain('差分なし');
  });

  it('formatDiff のラベル', () => {
    const g = JSON.parse(readFileSync(SAMPLE, 'utf8'));
    expect(formatDiff(diffGraphs(g, g), 'a.json', 'b.json').split('\n')[0]).toBe(
      '差分: a.json → b.json',
    );
  });
});
