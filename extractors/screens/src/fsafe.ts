/**
 * ファイルの読み書きの安全な入口。8-4 で core へ移した（init --skill と .stack-atlas/ の補いのファイルでも使う。
 * docs/19 §3.6）。screens の各ファイルはここから読む
 */
export {
  confineDir,
  within,
  findSiteFile,
  readNoFollow,
  readNoFollowResult,
  SafeOutput,
  type FindResult,
  type ReadResult,
} from '@stack-atlas/core';
