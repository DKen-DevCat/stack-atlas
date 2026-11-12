// `stack-atlas bundle`（Phase 10-1c の後半。docs/26 §9）: 終了コード、書くファイル、出力先の守り
import { validateGraphV2 } from '@stack-atlas/schema';
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
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

  // ここから下は、PR を作る前のレビュー（docs/26 §9）で見つかったこと
  it('図に誤りがあるとき、前にまとめた graph.json を残さない（古い図を、今の図としてビューアに出さない）', () => {
    const root = copy();
    const out = join(root, '.stack-atlas/out/graph.json');
    expect(runBundle([root], () => {})).toBe(0);
    expect(existsSync(out)).toBe(true);

    const parts = join(root, '.stack-atlas/parts.yaml');
    writeFileSync(
      parts,
      readFileSync(parts, 'utf8').replace('box: "part:status"', 'box: "part:nothing"'),
    );
    const lines: string[] = [];
    expect(runBundle([root], (l) => lines.push(l))).toBe(1);
    expect(existsSync(out)).toBe(false);
    expect(lines.join('\n')).toContain(
      `前にまとめた graph.json は、今の図と合わないので消しました: ${out}`,
    );
    // --json でも、消したファイルが出る。もう残っていなければ null
    const json: string[] = [];
    expect(runBundle([root], (l) => json.push(l), { json: true })).toBe(1);
    expect(JSON.parse(json.join('\n'))).toMatchObject({ written: null, removed: null, kept: null });
  });

  it('消すのは、bundle が書いた graph.json だけ（ほかの手段で作ったもの・読めないものには触らず、残っていると知らせる）', () => {
    const root = copy();
    const parts = join(root, '.stack-atlas/parts.yaml');
    writeFileSync(
      parts,
      readFileSync(parts, 'utf8').replace('box: "part:status"', 'box: "part:nothing"'),
    );
    const outDir = mkdtempSync(join(tmpdir(), 'stack-atlas-cli-bundle-out-'));
    const out = join(outDir, 'graph.json');
    for (const other of ['{"version":2,"nodes":[],"wires":[]}', 'not json', 'null']) {
      writeFileSync(out, other);
      const lines: string[] = [];
      expect(runBundle([root], (l) => lines.push(l), { out: outDir, json: true })).toBe(1);
      expect(readFileSync(out, 'utf8')).toBe(other);
      expect(JSON.parse(lines.join('\n'))).toMatchObject({ removed: null, kept: out });
    }
    // 出力先の graph.json がリンクなら、読みも消しもしない（リンクも、リンクの先も、そのまま）
    const target = join(mkdtempSync(join(tmpdir(), 'stack-atlas-cli-bundle-else-')), 'target.json');
    writeFileSync(target, '{"project":{"generator":{"v2":"atlas"}}}');
    rmSync(out);
    symlinkSync(target, out);
    expect(runBundle([root], () => {}, { out: outDir })).toBe(1);
    expect(lstatSync(out).isSymbolicLink()).toBe(true);
    expect(existsSync(target)).toBe(true);
  });

  it('出力先に index.html があれば、serve がそれを配信することを知らせる', () => {
    const root = copy();
    mkdirSync(join(root, '.stack-atlas/out'));
    const index = join(root, '.stack-atlas/out/index.html');
    writeFileSync(index, '<p>?</p>');
    const lines: string[] = [];
    expect(runBundle([root], (l) => lines.push(l))).toBe(0);
    expect(lines.join('\n')).toContain(`この index.html を配信します`);
    expect(lines.join('\n')).toContain(index);
    const json: string[] = [];
    expect(runBundle([root], (l) => json.push(l), { json: true })).toBe(0);
    expect((JSON.parse(json.join('\n')) as { notes: string[] }).notes).toHaveLength(1);
    // 無ければ、何も足さない
    const clean = copy();
    const quiet: string[] = [];
    expect(runBundle([clean], (l) => quiet.push(l), { json: true })).toBe(0);
    expect((JSON.parse(quiet.join('\n')) as { notes: string[] }).notes).toEqual([]);
  });
});
