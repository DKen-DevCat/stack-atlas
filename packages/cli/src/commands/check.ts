/**
 * `stack-atlas check [<dir>]`: <dir>/.stack-atlas/ の図（利用者の手元のエージェントが書いたもの）を検査する（docs/25 §3.4）。
 * 対象のコードは読まない。エラーがあれば終了コード 1
 */
import { checkAtlas, formatAtlasReport } from '@stack-atlas/core';

export interface CheckOptions {
  /** 結果を JSON で出す（エージェントが読む） */
  json?: boolean;
}

export function runCheck(
  dir: string | undefined,
  log: (line: string) => void,
  options: CheckOptions = {},
): number {
  const report = checkAtlas(dir ?? '.');
  log(options.json ? JSON.stringify(report, null, 2) : formatAtlasReport(report));
  return report.counts.errors > 0 ? 1 : 0;
}
