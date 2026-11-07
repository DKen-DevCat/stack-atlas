import { describe, expect, it, vi } from 'vitest';
import { fileURLToPath } from 'node:url';
import { main } from '../main.js';

const SAMPLE = fileURLToPath(new URL('../../../../examples/race-site.graph.json', import.meta.url));
const SAMPLE_V2 = fileURLToPath(
  new URL('../../../../examples/fixture-poly.today.v2.json', import.meta.url),
);

describe('main', () => {
  it('validate はスキーマ CLI と同じ出力', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await main(['validate', SAMPLE])).toBe(0);
    expect(log.mock.calls[0]![0]).toBe(`✓ ${SAMPLE}: エラー 0 件、警告 0 件`);
    log.mockRestore();
  });

  it('validate は version: 2 を見て v2 の検証器を使う（エラーと警告を 1 列に出す）', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await main(['validate', SAMPLE_V2])).toBe(0);
    expect(log.mock.calls[0]![0]).toBe(`✓ ${SAMPLE_V2}: エラー 0 件、警告 1 件`);
    expect(log.mock.calls[1]![0]).toContain('[警告]');
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
