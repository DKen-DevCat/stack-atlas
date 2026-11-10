import { createConsoleLogger } from '@stack-atlas/core';
import { parseArgs, type ParseArgsConfig } from 'node:util';
import { runBuild } from './commands/build.js';
import { runDiff } from './commands/diff.js';
import { runInitFlows } from './commands/init-flows.js';
import { runServe } from './commands/serve.js';
import { runValidate } from './commands/validate.js';

export const USAGE = `使い方: stack-atlas <コマンド> [オプション]

コマンド:
  build <repo> [-o <outDir>] [--with-viewer] [--no-screenshots] [--v1] [--verbose]
      リポジトリを解析して <outDir>（既定 <repo>/.stack-atlas/out）に graph.json（v2。配線図）・
      graph.v1.json（v1。3D の地図）・issues.json・memos.json を書く。
      --with-viewer でビューアも同梱する。--v1 は graph.json に v1 だけを書く（従来の出力）。検証エラーがあれば終了コード 1
  validate <graph.json...>
      graph.json をスキーマと参照整合性で検証する（version 1 / 2 を見て検証器を選ぶ）
  serve <outDir> [--port 4173] [--host 127.0.0.1] [--repo <repo>] [--allowed-host <name>]...
      outDir を配信する（index.html が無ければワークスペースのビューアを使う）。
      --repo を付けると、ビューアからのメモ保存（POST /api/memos）を <repo>/.stack-atlas/memos.json に書き戻す。
      Host ヘッダが localhost / 127.0.0.1 / --host / --allowed-host 以外なら 403 にする
  diff <prev.json> <next.json>
      2 つの graph.json の差分（追加・削除・変更）を表示する。どちらかが v2 なら箱・線・型・項目で比べる
      （v1 の側は v2 に変換して比べる）
  init-flows <repo> [--out <file>] [--force]
      いまのグラフから flows.yaml（既定 <repo>/flows.yaml）の雛形（MISS / HIT / 無効化）を書き出す。
      既存のファイルは --force が無ければ上書きしない。graph.json（v2）では各フローの最初の箱が views の始点になる
`;

function parse(
  args: string[],
  options: ParseArgsConfig['options'],
): { values: Record<string, string | boolean | undefined>; positionals: string[] } {
  const { values, positionals } = parseArgs({
    args,
    options,
    allowPositionals: true,
    allowNegative: true,
    strict: true,
  });
  return { values: values as Record<string, string | boolean | undefined>, positionals };
}

export async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest0] = argv.filter((a, i) => !(i === 0 && a === '--'));
  const rest = rest0.filter((a) => a !== '--');
  try {
    switch (cmd) {
      case 'build': {
        const { values, positionals } = parse(rest, {
          out: { type: 'string', short: 'o' },
          'with-viewer': { type: 'boolean' },
          screenshots: { type: 'boolean', default: true },
          v1: { type: 'boolean' },
          verbose: { type: 'boolean', short: 'v' },
        });
        if (positionals.length !== 1) {
          console.error(
            '使い方: stack-atlas build <repo> [-o <outDir>] [--with-viewer] [--no-screenshots] [--v1]',
          );
          return 2;
        }
        return await runBuild({
          repo: positionals[0]!,
          outDir: values.out as string | undefined,
          withViewer: Boolean(values['with-viewer']),
          screenshots: values.screenshots !== false,
          v1Only: Boolean(values.v1),
          log: createConsoleLogger({ level: values.verbose ? 'debug' : 'info' }),
        });
      }
      case 'validate':
        return runValidate(parse(rest, {}).positionals);
      case 'serve': {
        const { values, positionals } = parse(rest, {
          port: { type: 'string', short: 'p' },
          host: { type: 'string' },
          repo: { type: 'string' },
          'allowed-host': { type: 'string', multiple: true },
        });
        const port = values.port === undefined ? 4173 : Number(values.port);
        if (positionals.length !== 1 || !Number.isInteger(port) || port < 0 || port > 65535) {
          console.error(
            '使い方: stack-atlas serve <outDir> [--port 4173] [--host 127.0.0.1] [--repo <repo>] [--allowed-host <name>]...',
          );
          return 2;
        }
        return await runServe({
          outDir: positionals[0]!,
          port,
          host: values.host as string | undefined,
          repo: values.repo as string | undefined,
          allowedHosts: values['allowed-host'] as string[] | undefined,
          log: createConsoleLogger(),
        });
      }
      case 'diff':
        return runDiff(parse(rest, {}).positionals);
      case 'init-flows': {
        const { values, positionals } = parse(rest, {
          out: { type: 'string', short: 'o' },
          force: { type: 'boolean', short: 'f' },
          verbose: { type: 'boolean', short: 'v' },
        });
        if (positionals.length !== 1) {
          console.error('使い方: stack-atlas init-flows <repo> [--out <file>] [--force]');
          return 2;
        }
        return await runInitFlows({
          repo: positionals[0]!,
          out: values.out as string | undefined,
          force: Boolean(values.force),
          log: createConsoleLogger({ level: values.verbose ? 'debug' : 'warn' }),
        });
      }
      case undefined:
      case 'help':
      case '-h':
      case '--help':
        console.log(USAGE);
        return cmd === undefined ? 2 : 0;
      default:
        console.error(`未知のコマンド "${cmd}"\n\n${USAGE}`);
        return 2;
    }
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (typeof code === 'string' && code.startsWith('ERR_PARSE_ARGS')) {
      console.error(`${(e as Error).message}\n\n${USAGE}`);
      return 2;
    }
    throw e;
  }
}
