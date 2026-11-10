import { describe, expect, it, vi } from 'vitest';
import { fileURLToPath } from 'node:url';
import { main } from '../main.js';

const SAMPLE = fileURLToPath(new URL('../../../../examples/race-site.graph.json', import.meta.url));

describe('main', () => {
  it('validate はスキーマ CLI と同じ出力', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await main(['validate', SAMPLE])).toBe(0);
    expect(log.mock.calls[0]![0]).toBe(`✓ ${SAMPLE}: エラー 0 件、警告 0 件`);
    log.mockRestore();
  });

  it('未知のコマンド・未知のオプションは終了コード 2', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await main(['nope'])).toBe(2);
    expect(await main(['build', '.', '--bogus'])).toBe(2);
    expect(await main(['serve', 'out', '--port', 'abc'])).toBe(2);
    err.mockRestore();
  });
});
