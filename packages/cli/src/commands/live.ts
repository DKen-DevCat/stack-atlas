/**
 * `stack-atlas live [<dir>] --url <手元の URL> [--hold-writes] [--window] [--local-name <名前>]...`（docs/27）。
 * <dir>/.stack-atlas/ の図を検査し、ブラウザの窓を開く。人が、その窓の中でアプリを操作する。道具は見るだけ。
 * 手元の外へは、つながせない。窓を閉じると終わる。
 * 終了コード: 0 = 窓を閉じて終わった、1 = 図に誤りがあるので開かなかった、2 = 開けなかった（手元ではない URL・引数の誤り など）
 */
export interface LiveCommandOptions {
  url?: string;
  holdWrites?: boolean;
  window?: boolean;
  localNames?: string[];
  /** 窓を出さない（確かめ用。CLI の引数には出さない） */
  headless?: boolean;
}

export const LIVE_USAGE =
  '使い方: stack-atlas live [<dir>] --url <手元で起動したアプリの URL> [--hold-writes] [--window] [--local-name <名前>]...';

export async function runLive(
  dirs: readonly string[],
  log: (line: string) => void,
  options: LiveCommandOptions,
): Promise<number> {
  if (dirs.length > 1 || !options.url) {
    log(LIVE_USAGE);
    return 2;
  }
  // ブラウザを動かす部品は、このコマンドのときだけ読みこむ（D238）
  const { startLive, LiveError } = await import('@stack-atlas/live');
  try {
    const session = await startLive({
      root: dirs[0] ?? '.',
      url: options.url,
      holdWrites: options.holdWrites === true,
      window: options.window === true,
      localNames: options.localNames ?? [],
      headless: options.headless === true,
      log,
    });
    log(
      [
        'ブラウザの窓を 1 つ開きました（道具が開いた、別のブラウザです。ふだんのブラウザで URL を開いても、つながりません）。',
        'その窓の中で、アプリを操作してください。道具は、見るだけです（何も押しません）。',
        '手元の外（共有の環境・外のサービス）へは、読むことも書くことも、つながりません。',
        options.holdWrites
          ? '「止めて見る」が入っています。手元への書きこみも、出る直前で止めます（止めきれない通信もあります。docs/27 §5.2）。'
          : '手元への書きこみを止めたいときは、画面の「止めて見る」を入れてください。',
        '窓を閉じると終わります。',
      ].join('\n'),
    );
    await session.closed;
    return 0;
  } catch (e) {
    if (e instanceof LiveError) {
      log(e.message);
      return e.exitCode;
    }
    log(`ライブを開けませんでした: ${(e as Error).message}`);
    return 2;
  }
}
