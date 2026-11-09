/**
 * 出力先の screens/（screens 抽出器の書き出し先。docs/18 §3.3）が誰のものか。
 * 2026-11-09（8-3b のレビュー）: 印（SCREENS_MARKER）の無い screens/ に抽出器が書いて印を足すと、次の build が
 * 利用者のディレクトリを消していた。消してよい・書いてよいのは、印のあるもの（前回の build が書いた）か、無いもの（この build が作る）だけ
 */
import { lstatSync } from 'node:fs';
import { join } from 'node:path';
import { SCREENS_DIR, SCREENS_MARKER } from './types.js';

/**
 * - `absent`: 無い（作ってよい）
 * - `ours`: ディレクトリで、印のファイルがある（前回の build が書いた。消して書き直してよい）
 * - `foreign`: 印の無いディレクトリか、ディレクトリでないもの（触らない）
 * - `link`: シンボリックリンク（触らない。build は書く前に止める）
 */
export type ScreensDirState = 'absent' | 'ours' | 'foreign' | 'link';

export function screensDirState(outDir: string): ScreensDirState {
  const dir = join(outDir, SCREENS_DIR);
  try {
    const st = lstatSync(dir, { throwIfNoEntry: false });
    if (!st) return 'absent';
    if (st.isSymbolicLink()) return 'link';
    if (!st.isDirectory()) return 'foreign';
    return lstatSync(join(dir, SCREENS_MARKER), { throwIfNoEntry: false })?.isFile()
      ? 'ours'
      : 'foreign';
  } catch {
    return 'foreign'; // 読めない（出力先がファイルなど）。触らない
  }
}

/** 印の無い screens/ に書かない理由（issues.json と log に出す文） */
export function screensSkipMessage(state: Exclude<ScreensDirState, 'absent' | 'ours'>): string {
  return state === 'link'
    ? `出力先の ${SCREENS_DIR}/ がシンボリックリンクなので、画面を書きません`
    : `出力先の ${SCREENS_DIR}/ は stack-atlas build が書いたものではない（印 ${SCREENS_MARKER} が無い）ので、画面を書きません（消しも上書きもしない）。` +
        `別の出力先（-o）を選ぶか、そのディレクトリを移してください`;
}
