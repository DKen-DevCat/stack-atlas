/**
 * `stack-atlas check [<dir>]`: <dir>/.stack-atlas/ の図（利用者の手元のエージェントが書いたもの）を検査する（docs/25 §3.4、docs/26）。
 * 対象のコードは読まない。終了コード: 0 = 誤りなし、1 = 図に誤りがある、2 = 検査そのものができなかった（引数の誤り・読む権限が無い、など）
 */
import { checkAtlas, formatAtlasReport } from '@stack-atlas/core';

export interface CheckOptions {
  /** 結果を JSON で出す（エージェントが読む）。検査できなかったときも `{ error: { message, exitCode } }` の JSON を出す */
  json?: boolean;
}

export function runCheck(
  dirs: readonly string[],
  log: (line: string) => void,
  options: CheckOptions = {},
): number {
  const fail = (message: string): number => {
    log(options.json ? JSON.stringify({ error: { message, exitCode: 2 } }, null, 2) : message);
    return 2;
  };
  if (dirs.length > 1) return fail('check に渡せるディレクトリは 1 つです');
  try {
    const report = checkAtlas(dirs[0] ?? '.');
    log(options.json ? JSON.stringify(report, null, 2) : formatAtlasReport(report));
    return report.counts.errors > 0 ? 1 : 0;
  } catch (e) {
    return fail(`検査できませんでした: ${(e as Error).message}`);
  }
}
