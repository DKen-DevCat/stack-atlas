/**
 * `stack-atlas build <repo> [-o <outDir>] [--with-viewer] [--no-screenshots]`
 *
 * out/ に graph.json・issues.json・memos.json（.stack-atlas/memos.json があれば）を書く。
 * --with-viewer ならビューアの dist/ も同梱し、out/ をそのまま静的ホスティングできる形にする。
 */
import {
  AtlasConfigError,
  buildGraph,
  createConsoleLogger,
  loadConfig,
  loadMemos,
  memosFile,
  orphanMemos,
  serializeMemos,
  type BuildGraphResult,
  type Extractor,
  type Logger,
} from '@stack-atlas/core';
import { cpSync, existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { loadExtractors } from '../extractors.js';
import { VIEWER_DIST } from '../paths.js';

export interface BuildOptions {
  repo: string;
  outDir?: string;
  withViewer?: boolean;
  screenshots?: boolean;
  log?: Logger;
  /** 抽出器の差し替え（テスト用）。省略時は抽出器パッケージを動的 import */
  extractors?: Extractor[];
  viewerDist?: string;
}

const STATUS_LABEL: Record<string, string> = {
  disabled: '設定で無効',
  'not-detected': '対象なし',
  failed: '失敗',
};

/** build の結果を日本語の要約にする */
export function formatBuildSummary(
  res: BuildGraphResult,
  outDir: string,
  orphans: string[] = [],
): string {
  const { graph, reports, issues } = res;
  const lines = ['', '── Stack Atlas build ──'];
  lines.push('抽出器:');
  if (!reports.length) lines.push('  （なし）');
  for (const r of reports) {
    lines.push(
      r.status === 'ok'
        ? `  ${r.name}: ノード ${r.nodes}、エッジ ${r.edges}、フロー ${r.flows}`
        : `  ${r.name}: ${STATUS_LABEL[r.status] ?? r.status}${r.error ? `（${r.error}）` : ''}`,
    );
  }
  lines.push(
    `結果: ノード ${graph.nodes.length}、エッジ ${graph.edges.length}、フロー ${graph.flows?.length ?? 0}、層 ${graph.layers.length}`,
  );
  const errors = issues.filter((i) => i.level === 'error');
  const warnings = issues.filter((i) => i.level === 'warning');
  lines.push(`問題: エラー ${errors.length} 件、警告 ${warnings.length} 件`);
  for (const i of [...errors, ...warnings]) {
    lines.push(`  [${i.level === 'error' ? 'エラー' : '警告'}] ${i.path}: ${i.message}`);
  }
  if (orphans.length) lines.push(`孤立メモ（graph に無いノード ID）: ${orphans.join(', ')}`);
  lines.push(`出力: ${join(outDir, 'graph.json')}`);
  return lines.join('\n');
}

export async function runBuild(opts: BuildOptions): Promise<number> {
  const log = opts.log ?? createConsoleLogger();
  const repo = resolve(opts.repo);
  if (!existsSync(repo) || !statSync(repo).isDirectory()) {
    log.error(`リポジトリ ${repo} がありません`);
    return 2;
  }
  const outDir = resolve(opts.outDir ?? join(repo, '.stack-atlas', 'out'));
  const viewerDist = opts.viewerDist ?? VIEWER_DIST;
  if (opts.withViewer && !existsSync(join(viewerDist, 'index.html'))) {
    log.error(
      `ビューアのビルド成果物（${viewerDist}）がありません。先に pnpm build を実行してください`,
    );
    return 2;
  }

  let res: BuildGraphResult;
  try {
    const config = loadConfig(repo, log);
    // スクショ抽出器は <outDir>/shots/<slug>.png に書き、graph.json からは shots/… で参照する。
    // そのため抽出器の outDir は graph.json と同じディレクトリにする
    config.screenshots = {
      ...config.screenshots,
      outDir: config.screenshots?.outDir ?? outDir,
    };
    log.info(`解析中: ${repo}`);
    const extractors =
      opts.extractors ??
      (await loadExtractors(log, { skip: opts.screenshots === false ? ['screenshots'] : [] }));
    res = await buildGraph({ root: repo, extractors, log, config });
  } catch (e) {
    if (e instanceof AtlasConfigError) {
      log.error(e.message);
      return 2;
    }
    throw e;
  }

  mkdirSync(outDir, { recursive: true });
  if (opts.withViewer) cpSync(viewerDist, outDir, { recursive: true });
  writeFileSync(join(outDir, 'graph.json'), `${JSON.stringify(res.graph, null, 2)}\n`);
  writeFileSync(join(outDir, 'issues.json'), `${JSON.stringify(res.issues, null, 2)}\n`);
  let orphans: string[] = [];
  if (existsSync(memosFile(repo))) {
    const memos = loadMemos({ root: repo, log });
    writeFileSync(join(outDir, 'memos.json'), serializeMemos(memos));
    orphans = orphanMemos(memos, res.graph);
  } else {
    // リポジトリの memos.json が無くなったら、前回の build の memos.json も消す（古いメモが残らないように）
    rmSync(join(outDir, 'memos.json'), { force: true });
  }

  console.log(formatBuildSummary(res, outDir, orphans));
  return res.issues.some((i) => i.level === 'error') ? 1 : 0;
}
