// `stack-atlas check`（Phase 10-1a。docs/25 §3.4）: 終了コードと、人が読む形・JSON の出力。検査の中身は core の atlas-check.test.ts
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { runCheck } from '../commands/check.js';
import { main, USAGE } from '../main.js';

const ANSWER = fileURLToPath(
  new URL('../../../core/src/__tests__/fixtures/atlas-live/', import.meta.url),
);

describe('stack-atlas check', () => {
  it('正解の図は終了コード 0。人が読む形で数が出る', () => {
    const lines: string[] = [];
    expect(runCheck(ANSWER, (l) => lines.push(l))).toBe(0);
    expect(lines.join('\n')).toContain('図: 箱 9・線 15・部品 3・挙動 3');
  });

  it('誤りがあれば終了コード 1。--json は、エージェントが読む JSON だけを出す', () => {
    const root = mkdtempSync(join(tmpdir(), 'stack-atlas-cli-check-'));
    cpSync(ANSWER, root, { recursive: true });
    const file = join(root, '.stack-atlas/parts.yaml');
    writeFileSync(
      file,
      readFileSync(file, 'utf8').replace('box: "part:comment-list"', 'box: "part:nothing"'),
    );
    const lines: string[] = [];
    expect(runCheck(root, (l) => lines.push(l), { json: true })).toBe(1);
    const report = JSON.parse(lines.join('\n')) as {
      counts: { errors: number };
      issues: { check: string; file: string; message: string }[];
    };
    expect(report.counts.errors).toBe(1);
    expect(report.issues[0]).toMatchObject({ check: 'ref', file: '.stack-atlas/parts.yaml' });
  });

  it('main から呼べる。図の置き場が無ければ終了コード 1。USAGE に載っている', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      expect(await main(['check', ANSWER])).toBe(0);
      expect(await main(['check', mkdtempSync(join(tmpdir(), 'stack-atlas-cli-check-'))])).toBe(1);
    } finally {
      log.mockRestore();
    }
    expect(USAGE).toContain('check [<dir>] [--json]');
  });
});
