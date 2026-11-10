/**
 * config.classify（docs/12 §3.1, D19）: glob → kind / layer の上書き。上から順に見て、最初に合ったルールだけを使う。
 *
 * - `applyClassify()`: マージ後・overrides 前にパイプラインが呼ぶ。`file` を持つノードの kind / layer を書き換える。
 *   **ID は変えない**（ID はメモ・overrides・flows の結合キー）。
 * - `classifyKind()`: 抽出器（ts-imports / go など）がノードを作るときに呼ぶ。ここで kind を決めれば
 *   ID の接頭辞も合わせられる（例 `type:` で作る）。
 *
 * glob は **repo 相対パス**で照合する（複数 repo で `file` が `<repo>/…` のときは先頭を外してから）。
 * `rule.repo` があればその repo のファイルにだけ効く。
 */
import { isAbsolute, relative } from 'node:path';
import { splitRepoFile } from './repo.js';
import { silentLogger } from './logger.js';
import type { ClassifyRule, Logger, PartialGraph, RepoContext, StackAtlasConfig } from './types.js';
import { clone, globToRegExp, toPosix } from './util.js';

const cache = new Map<string, RegExp>();

/** path（/ 区切りの相対パス）が glob（`**` `*` `?` `{a,b}`）に合うか */
export function matchGlob(path: string, glob: string): boolean {
  let re = cache.get(glob);
  if (!re) {
    re = globToRegExp(toPosix(glob));
    cache.set(glob, re);
  }
  return re.test(toPosix(path));
}

/** repo 相対パスに合う最初のルール */
export function findClassifyRule(
  rules: readonly ClassifyRule[] | undefined,
  path: string,
  repo: string | undefined,
): ClassifyRule | undefined {
  for (const r of rules ?? []) {
    if (!r || typeof r.glob !== 'string') continue;
    if (r.repo && r.repo !== repo) continue;
    if (matchGlob(path, r.glob)) return r;
  }
  return undefined;
}

/**
 * 抽出器向け: ctx の repo のファイル（repo 相対パスか絶対パス）の kind。
 * 最初に合ったルールに kind があればそれ、無ければ（合わない・layer だけのルール）defaultKind。
 */
export function classifyKind(
  ctx: Pick<RepoContext, 'config' | 'repoName' | 'root'>,
  file: string,
  defaultKind: string,
): string {
  const rel = isAbsolute(file) ? relative(ctx.root, file) : file;
  return findClassifyRule(ctx.config.classify, toPosix(rel), ctx.repoName)?.kind ?? defaultKind;
}

/** graph の `file` → { repo, path }（applyClassify / deploy で使う） */
export type RepoOf = (file: string) => { repo?: string; path: string };

/** repo 名の一覧から RepoOf を作る */
export function repoOfNames(names: readonly string[]): RepoOf {
  return (file) => splitRepoFile(file, names);
}

/** config.repos のキーから RepoOf を作る（repos 省略時は repo 名なし＝ rule.repo 付きのルールは効かない） */
function defaultRepoOf(config: StackAtlasConfig): RepoOf {
  return repoOfNames(Object.keys(config.repos ?? {}));
}

/** config.classify をノードに当てる（新しい graph を返す）。ID は変えない */
export function applyClassify(
  graph: PartialGraph,
  config: StackAtlasConfig,
  repoOf: RepoOf = defaultRepoOf(config),
  log: Logger = silentLogger,
): PartialGraph {
  const rules = config.classify;
  if (!rules?.length) return graph;
  const g = clone(graph);
  for (const n of g.nodes) {
    if (!n.file) continue;
    const { repo, path } = repoOf(n.file);
    const rule = findClassifyRule(rules, path, repo);
    if (!rule) continue;
    if (rule.kind && rule.kind !== n.kind) {
      log.debug(`classify: ${n.id} の kind ${n.kind ?? '(なし)'} → ${rule.kind}（${rule.glob}）`);
      n.kind = rule.kind;
    }
    if (rule.layer && rule.layer !== n.layer) {
      log.debug(`classify: ${n.id} の層 ${n.layer ?? '(既定)'} → ${rule.layer}（${rule.glob}）`);
      n.layer = rule.layer;
    }
  }
  return g;
}
