/**
 * `stack-atlas build <repo> [-o <outDir>] [--with-viewer] [--no-screenshots] [--v1]`
 *
 * <repo> は stack-atlas.config.yaml のあるディレクトリ。config に `repos` があれば、そこに並べた repo をまとめて解析する
 * （docs/12 §3.2）。overrides / flows / memos は <repo> から読む。
 *
 * out/ に graph.json（v2。配線図）・graph.v1.json（v1。3D の地図）・issues.json・memos.json（.stack-atlas/memos.json
 * があれば）を書く（docs/16 §10）。--v1 なら従来どおり graph.json に v1 だけを書く（graph.v1.json は消す）。
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
  /** graph.json に v1 だけを書く（Phase 8-1 より前の出力。graph.v1.json は書かない） */
  v1Only?: boolean;
}

const STATUS_LABEL: Record<string, string> = {
  disabled: '設定で無効',
  'not-detected': '対象なし',
  failed: '失敗',
};

/** build の結果を日本語の要約にする。v1Only なら graph.json は v1 */
export function formatBuildSummary(
  res: BuildGraphResult,
  outDir: string,
  orphans: string[] = [],
  v1Only = false,
): string {
  const { graph, graphV2, reports, issues } = res;
  const lines = ['', '── Stack Atlas build ──'];
  lines.push('抽出器:');
  if (!reports.length) lines.push('  （なし）');
  const multi = Object.keys(res.repos ?? {}).length > 1;
  for (const r of reports) {
    const perRepo = Object.entries(r.repos ?? {}).filter(
      ([, rr]) => rr.status === 'ok' || rr.status === 'failed',
    );
    if (multi && perRepo.length) {
      // 複数 repo: 動いた（か失敗した）repo ごとに 1 行
      for (const [repo, rr] of perRepo) {
        lines.push(
          rr.status === 'ok'
            ? `  ${r.name} (${repo}): ノード ${rr.nodes}、エッジ ${rr.edges}${rr.flows ? `、フロー ${rr.flows}` : ''}`
            : `  ${r.name} (${repo}): ${STATUS_LABEL.failed}${rr.error ? `（${rr.error}）` : ''}`,
        );
      }
      continue;
    }
    lines.push(
      r.status === 'ok'
        ? `  ${r.name}: ノード ${r.nodes}、エッジ ${r.edges}、フロー ${r.flows}`
        : `  ${r.name}: ${STATUS_LABEL[r.status] ?? r.status}${r.error ? `（${r.error}）` : ''}`,
    );
  }
  lines.push(
    `結果: ノード ${graph.nodes.length}、エッジ ${graph.edges.length}、フロー ${graph.flows?.length ?? 0}、層 ${graph.layers.length}`,
  );
  if (!v1Only) {
    const frames = new Set(graphV2.nodes.map((n) => n.host).filter((h): h is string => !!h));
    lines.push(
      `v2: 箱 ${graphV2.nodes.length}（うち枠 ${frames.size}）、線 ${graphV2.wires.length}、型 ${graphV2.types?.length ?? 0}、view ${graphV2.views?.length ?? 0}` +
        `（v2 の警告 ${res.v2Warnings.length} 件。箱の単位の変換なので口の単位の線が残る。stack-atlas validate で一覧）`,
    );
  }
  const errors = issues.filter((i) => i.level === 'error');
  const warnings = issues.filter((i) => i.level === 'warning');
  lines.push(`問題: エラー ${errors.length} 件、警告 ${warnings.length} 件`);
  for (const i of [...errors, ...warnings]) {
    lines.push(`  [${i.level === 'error' ? 'エラー' : '警告'}] ${i.path}: ${i.message}`);
  }
  if (orphans.length) lines.push(`孤立メモ（graph に無いノード ID）: ${orphans.join(', ')}`);
  if (v1Only) lines.push(`出力: ${join(outDir, 'graph.json')}（v1）`);
  else {
    lines.push(`出力: ${join(outDir, 'graph.json')}（v2。配線図）`);
    lines.push(`      ${join(outDir, 'graph.v1.json')}（v1。3D の地図）`);
  }
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
    const repoEntries = Object.entries(config.repos ?? {});
    if (repoEntries.length) {
      log.info(`repo（${repoEntries.length}）:`);
      for (const [name, p] of repoEntries) log.info(`  - ${name}: ${resolve(repo, p)}`);
    }
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
  const json = (v: unknown) => `${JSON.stringify(v, null, 2)}\n`;
  if (opts.v1Only) {
    writeFileSync(join(outDir, 'graph.json'), json(res.graph));
    // 前回の build の graph.v1.json が残ると、ビューアの「配線図」の行き来が古い組み合わせを指す
    rmSync(join(outDir, 'graph.v1.json'), { force: true });
  } else {
    writeFileSync(join(outDir, 'graph.json'), json(res.graphV2));
    writeFileSync(join(outDir, 'graph.v1.json'), json(res.graph));
  }
  writeFileSync(join(outDir, 'issues.json'), json(res.issues));
  let orphans: string[] = [];
  if (existsSync(memosFile(repo))) {
    const memos = loadMemos({ root: repo, log });
    writeFileSync(join(outDir, 'memos.json'), serializeMemos(memos));
    orphans = orphanMemos(memos, res.graph);
  } else {
    // リポジトリの memos.json が無くなったら、前回の build の memos.json も消す（古いメモが残らないように）
    rmSync(join(outDir, 'memos.json'), { force: true });
  }

  console.log(formatBuildSummary(res, outDir, orphans, opts.v1Only));
  return res.issues.some((i) => i.level === 'error') ? 1 : 0;
}
