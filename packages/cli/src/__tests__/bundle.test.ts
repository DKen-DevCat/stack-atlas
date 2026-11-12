// `stack-atlas bundle`（Phase 10-1c の後半。docs/26 §9）: 終了コード、書くファイル、出力先の守り
import { validateGraphV2 } from '@stack-atlas/schema';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { runBundle } from '../commands/bundle.js';
import { USAGE } from '../main.js';

const AGENT = fileURLToPath(
  new URL('../../../core/src/__tests__/fixtures/atlas-live-agent/', import.meta.url),
);
const copy = () => {
  const root = mkdtempSync(join(tmpdir(), 'stack-atlas-cli-bundle-'));
  cpSync(AGENT, root, { recursive: true });
  return root;
};

describe('stack-atlas bundle', () => {
  it('既定の出力先（<dir>/.stack-atlas/out）に、契約どおりの graph.json を書く。終了コード 0', () => {
    const root = copy();
    const lines: string[] = [];
    expect(runBundle([root], (l) => lines.push(l))).toBe(0);
    const file = join(root, '.stack-atlas/out/graph.json');
    expect(lines.join('\n')).toContain(`出力: ${file}`);
    const graph = JSON.parse(readFileSync(file, 'utf8')) as {
      behaviors: unknown[];
      parts: unknown[];
    };
    expect(validateGraphV2(graph).ok).toBe(true);
    expect(graph.behaviors).toHaveLength(3);
    expect(graph.parts).toHaveLength(4);
    expect(USAGE).toContain('bundle [<dir>] [-o <outDir>] [--json]');
  });

  it('-o で出力先を選べる。--json は、検査の結果と、書いたファイルを JSON で出す', () => {
    const root = copy();
    const out = mkdtempSync(join(tmpdir(), 'stack-atlas-cli-bundle-out-'));
    const lines: string[] = [];
    expect(runBundle([root], (l) => lines.push(l), { out, json: true })).toBe(0);
    const res = JSON.parse(lines.join('\n')) as { written: string; counts: { errors: number } };
    expect(res.written).toBe(join(out, 'graph.json'));
    expect(res.counts.errors).toBe(0);
    expect(existsSync(join(out, 'graph.json'))).toBe(true);
  });

  it('図に誤りがあれば、書かずに終了コード 1', () => {
    const root = copy();
    const file = join(root, '.stack-atlas/parts.yaml');
    writeFileSync(
      file,
      readFileSync(file, 'utf8').replace('box: "part:status"', 'box: "part:nothing"'),
    );
    const lines: string[] = [];
    expect(runBundle([root], (l) => lines.push(l))).toBe(1);
    expect(lines.join('\n')).toContain('図に誤りがあるので、まとめませんでした。');
    expect(existsSync(join(root, '.stack-atlas/out'))).toBe(false);
  });

  it('出力先がシンボリックリンクなら書かない（リンクの先を書き換えない）。終了コード 2', () => {
    const root = copy();
    const elsewhere = mkdtempSync(join(tmpdir(), 'stack-atlas-cli-bundle-else-'));
    symlinkSync(elsewhere, join(root, '.stack-atlas/out'));
    const lines: string[] = [];
    expect(runBundle([root], (l) => lines.push(l))).toBe(2);
    expect(lines.join('\n')).toContain('シンボリックリンクがあるので書きません');
    expect(existsSync(join(elsewhere, 'graph.json'))).toBe(false);

    // 出力先の graph.json そのものがリンクでも書かない
    const root2 = copy();
    mkdirSync(join(root2, '.stack-atlas/out'));
    writeFileSync(join(elsewhere, 'target.json'), 'keep');
    symlinkSync(join(elsewhere, 'target.json'), join(root2, '.stack-atlas/out/graph.json'));
    expect(runBundle([root2], () => {})).toBe(2);
    expect(readFileSync(join(elsewhere, 'target.json'), 'utf8')).toBe('keep');
  });

  it('引数が多ければ終了コード 2', () => {
    expect(runBundle(['a', 'b'], () => {})).toBe(2);
  });
});
