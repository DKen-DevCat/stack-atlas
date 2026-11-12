// `stack-atlas live`（docs/27）: 開けないときの終了コード（ブラウザを開く前に止まる）。開いたあとの動きは、
// packages/live の live.e2e.test.ts が、実際のブラウザで確かめる
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { LIVE_USAGE, runLive } from '../commands/live.js';
import { USAGE } from '../main.js';

const ATLAS = fileURLToPath(
  new URL('../../../core/src/__tests__/fixtures/atlas-live-agent/', import.meta.url),
);

describe('stack-atlas live', () => {
  it('--url が無い・ディレクトリが 2 つ: 使い方を出して、終了コード 2', async () => {
    const lines: string[] = [];
    expect(await runLive([ATLAS], (l) => lines.push(l), {})).toBe(2);
    expect(await runLive([ATLAS, ATLAS], (l) => lines.push(l), { url: 'http://localhost/' })).toBe(
      2,
    );
    expect(lines).toEqual([LIVE_USAGE, LIVE_USAGE]);
    expect(USAGE).toContain('live [<dir>] --url <手元の URL>');
  });

  it('手元ではない URL・アドレスの名指しは、開かずに終了コード 2（名指しで外につなぐ道は無い）', async () => {
    for (const [url, localNames] of [
      ['http://staging.example.com/', []],
      ['http://192.168.1.5:3000/', []],
      ['http://localhost:3000/', ['10.0.0.1']],
    ] as const) {
      const lines: string[] = [];
      expect(
        await runLive([ATLAS], (l) => lines.push(l), { url, localNames: [...localNames] }),
      ).toBe(2);
      expect(lines.join('\n')).toMatch(/手元ではありません|アドレスは書けません/);
    }
  });

  it('図に誤りがあれば、開かずに終了コード 1（検査の結果を出す）', async () => {
    const lines: string[] = [];
    const empty = mkdtempSync(join(tmpdir(), 'stack-atlas-cli-live-'));
    expect(await runLive([empty], (l) => lines.push(l), { url: 'http://localhost:9/' })).toBe(1);
    expect(lines.join('\n')).toContain('図に誤りがあるので、ライブを開きませんでした');
  });
});
