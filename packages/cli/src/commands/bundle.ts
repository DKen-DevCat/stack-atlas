/**
 * `stack-atlas bundle [<dir>] [-o <outDir>]`: <dir>/.stack-atlas/ の図を検査して、<outDir>/graph.json（契約 v2。部品と挙動つき）に
 * まとめる（docs/26 §9）。既定の出力先は <dir>/.stack-atlas/out。`stack-atlas serve <outDir>` で、今のビューアで開ける。
 * 終了コード: 0 = 書いた、1 = 図に誤りがあるので書かなかった、2 = まとめられなかった（引数の誤り・書けない出力先、など）
 *
 * 図に誤りがあって書かなかったとき、前にまとめた graph.json が出力先に残っていれば消す（古い図を、今の図としてビューアに出さないため）。
 * 消すのは、bundle が書いたとわかるもの（generator の印）だけ。ほかの手段で作った graph.json には触らない
 */
import {
  ATLAS_GENERATOR,
  bundleAtlas,
  formatAtlasReport,
  readLocalFile,
  SafeOutput,
} from '@stack-atlas/core';
import { existsSync, unlinkSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { unsafeOutputs } from './build.js';

export interface BundleOptions {
  /** 出力先のディレクトリ（既定は <dir>/.stack-atlas/out） */
  out?: string;
  /** 結果を JSON で出す */
  json?: boolean;
}

const GRAPH_FILE = 'graph.json';
/** 前の出力を確かめるために読む大きさの上限。超えるものは「bundle が書いたか、わからない」として触らない */
const PREVIOUS_MAX_BYTES = 64 * 1024 * 1024;

/** 出力先に残っている graph.json は、前に bundle が書いたものか（リンクは辿らない。無ければ undefined） */
function previousOutput(outDir: string): 'bundle' | 'other' | undefined {
  const read = readLocalFile(outDir, [GRAPH_FILE], PREVIOUS_MAX_BYTES);
  if ('why' in read) return read.why === 'missing' ? undefined : 'other';
  try {
    const g = JSON.parse(read.text) as { project?: { generator?: { v2?: unknown } } } | null;
    return g?.project?.generator?.v2 === ATLAS_GENERATOR ? 'bundle' : 'other';
  } catch {
    return 'other';
  }
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
    const file = join(outDir, GRAPH_FILE);
    const { report, graph } = bundleAtlas(dirs[0] ?? '.', { name: basename(root) });
    // 出力先や、その途中がシンボリックリンクなら、書きも消しもしない（リンクの先に触らないため。build と同じ守り）
    const unsafe = unsafeOutputs(root, outDir);
    if (!graph) {
      const notes = ['図に誤りがあるので、まとめませんでした。'];
      let removed: string | null = null;
      let kept: string | null = null;
      const previous = unsafe.length ? undefined : previousOutput(outDir);
      if (previous === 'bundle') {
        unlinkSync(file);
        removed = file;
        notes.push(`前にまとめた graph.json は、今の図と合わないので消しました: ${file}`);
      } else if (previous === 'other') {
        kept = file;
        notes.push(
          `出力先に graph.json が残っています（bundle が書いたものと確かめられないので、消していません）: ${file}`,
        );
      }
      log(
        options.json
          ? JSON.stringify({ ...report, written: null, removed, kept }, null, 2)
          : `${formatAtlasReport(report)}\n${notes.join('\n')}`,
      );
      return 1;
    }
    if (unsafe.length)
      return fail(`出力先にシンボリックリンクがあるので書きません: ${unsafe.join(', ')}`);
    const written = new SafeOutput(outDir).write(
      [GRAPH_FILE],
      JSON.stringify(graph, null, 2) + '\n',
    );
    // serve は、出力先に index.html があれば、同梱のビューアではなく、それを配信する。出力先は対象の repo の中のことがあるので、知らせる
    const notes = existsSync(join(outDir, 'index.html'))
      ? [
          `出力先に index.html があります。stack-atlas serve は、同梱のビューアではなく、この index.html を配信します（置いた覚えが無ければ、消してください）: ${join(outDir, 'index.html')}`,
        ]
      : [];
    log(
      options.json
        ? JSON.stringify({ ...report, written, notes }, null, 2)
        : [formatAtlasReport(report), `出力: ${written}`, ...notes].join('\n'),
    );
    return 0;
  } catch (e) {
    return fail(`まとめられませんでした: ${(e as Error).message}`);
  }
}
