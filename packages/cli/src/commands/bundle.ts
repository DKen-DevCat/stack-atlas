/**
 * `stack-atlas bundle [<dir>] [-o <outDir>]`: <dir>/.stack-atlas/ の図を検査して、<outDir>/graph.json（契約 v2。部品と挙動つき）に
 * まとめる（docs/26 §9）。既定の出力先は <dir>/.stack-atlas/out。`stack-atlas serve <outDir>` で、今のビューアで開ける。
 * 終了コード: 0 = 書いた、1 = 図に誤りがあるので書かなかった、2 = まとめられなかった（引数の誤り・書けない出力先、など）
 */
import { bundleAtlas, formatAtlasReport, SafeOutput } from '@stack-atlas/core';
import { basename, join, resolve } from 'node:path';
import { unsafeOutputs } from './build.js';

export interface BundleOptions {
  /** 出力先のディレクトリ（既定は <dir>/.stack-atlas/out） */
  out?: string;
  /** 結果を JSON で出す */
  json?: boolean;
}

export function runBundle(
  dirs: readonly string[],
  log: (line: string) => void,
  options: BundleOptions = {},
): number {
  const fail = (message: string): number => {
    log(options.json ? JSON.stringify({ error: { message, exitCode: 2 } }, null, 2) : message);
    return 2;
  };
  if (dirs.length > 1) return fail('bundle に渡せるディレクトリは 1 つです');
  try {
    const root = resolve(dirs[0] ?? '.');
    const outDir = resolve(options.out ?? join(root, '.stack-atlas', 'out'));
    const { report, graph } = bundleAtlas(dirs[0] ?? '.', { name: basename(root) });
    if (!graph) {
      log(
        options.json
          ? JSON.stringify({ ...report, written: null }, null, 2)
          : `${formatAtlasReport(report)}\n図に誤りがあるので、まとめませんでした。`,
      );
      return 1;
    }
    // 出力先や、その途中がシンボリックリンクなら書かない（リンクの先を書き換えないため。build と同じ守り）
    const unsafe = unsafeOutputs(root, outDir);
    if (unsafe.length)
      return fail(`出力先にシンボリックリンクがあるので書きません: ${unsafe.join(', ')}`);
    const written = new SafeOutput(outDir).write(
      ['graph.json'],
      JSON.stringify(graph, null, 2) + '\n',
    );
    log(
      options.json
        ? JSON.stringify({ ...report, written }, null, 2)
        : `${formatAtlasReport(report)}\n出力: ${written}`,
    );
    return 0;
  } catch (e) {
    return fail(`まとめられませんでした: ${(e as Error).message}`);
  }
}
