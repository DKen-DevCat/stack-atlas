/**
 * 複数リポジトリ（docs/12 §3.2, D14）の補助関数。
 *
 * - repo が 1 つなら `file` は従来どおり repo 相対パス。
 * - repo が 2 つ以上なら、graph（と抽出器に渡す upstream）の `file` は `<repoName>/<repo 相対パス>`。
 *   パイプラインが各抽出器の出力を受け取った直後に付けるので、抽出器は repo 相対パスを返せばよい
 *   （自分で `repoFile()` を付けて返しても二重にはならない）。
 * - upstream のノードの `file` を自分の repo のファイルと突き合わせるときは `fileInRepo()` を使う。
 */
import { existsSync, statSync } from 'node:fs';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import type { PartialGraph, RepoContext, StackAtlasConfig } from './types.js';
import { issue, toPosix } from './util.js';
import type { ValidationIssue } from '@stack-atlas/schema';

type RepoInfo = Pick<RepoContext, 'repoName' | 'repos'>;

/** repo が 2 つ以上か（file を `<repo>/` で修飾するか） */
export function isMultiRepo(ctx: Pick<RepoContext, 'repos'>): boolean {
  return Object.keys(ctx.repos).length > 1;
}

/** repo 相対パス（または絶対パス）→ graph の `file` の形（複数 repo なら `<repo>/` 付き） */
export function repoFile(ctx: RepoInfo & Partial<Pick<RepoContext, 'root'>>, path: string): string {
  let rel = path;
  if (isAbsolute(rel) && ctx.root) rel = relative(ctx.root, rel);
  rel = toPosix(rel);
  return isMultiRepo(ctx) ? `${ctx.repoName}/${rel}` : rel;
}

/**
 * graph の `file` → `{ repo, path }`。repo が 1 つなら repo はその名前（names[0]）で path はそのまま。
 * 複数なら先頭のセグメントが repo 名のときだけ分ける（そうでなければ repo は undefined）。
 */
export function splitRepoFile(
  file: string,
  repoNames: readonly string[],
): { repo?: string; path: string } {
  const f = toPosix(file);
  if (repoNames.length <= 1) return repoNames[0] ? { repo: repoNames[0], path: f } : { path: f };
  const i = f.indexOf('/');
  const head = i > 0 ? f.slice(0, i) : undefined;
  if (head && repoNames.includes(head)) return { repo: head, path: f.slice(i + 1) };
  return { path: f };
}

/** upstream のノードの `file` がこの ctx の repo のものなら repo 相対パス、違えば undefined */
export function fileInRepo(ctx: RepoInfo, file: string | undefined): string | undefined {
  if (!file) return undefined;
  const s = splitRepoFile(file, Object.keys(ctx.repos));
  if (!isMultiRepo(ctx)) return s.path;
  return s.repo === ctx.repoName ? s.path : undefined;
}

/**
 * 抽出器の出力の `file` を `<repoName>/` で修飾する（複数 repo のときだけ）。v2 の部分グラフの箱と型の `file`、`read` も。
 * すでに `<repoName>/` で始まり、かつ repo 相対パスとしては存在しないものは修飾済みとみなす。
 */
export function prefixRepoFiles(
  part: PartialGraph,
  ctx: RepoInfo & Pick<RepoContext, 'root'>,
): PartialGraph {
  if (!isMultiRepo(ctx)) return part;
  const pre = `${ctx.repoName}/`;
  const qualify = <T extends { file?: string }>(n: T): T => {
    if (!n.file) return n;
    let f = n.file;
    if (isAbsolute(f)) f = relative(ctx.root, f);
    f = toPosix(f);
    if (f.startsWith(pre) && !existsSync(join(ctx.root, f))) return { ...n, file: f };
    return { ...n, file: pre + f };
  };
  const out: PartialGraph = { ...part, nodes: part.nodes.map(qualify) };
  // 抽出器が申告した読んだファイル（docs/23 §3.1）も同じ規則で
  if (part.read) out.read = part.read.map((f) => qualify({ file: f }).file!);
  // v2 の部分グラフ（言語アダプタ）も同じ規則で修飾する。線は箱 id で書くのでそのまま
  if (part.v2) {
    out.v2 = { ...part.v2, nodes: part.v2.nodes.map(qualify) };
    if (part.v2.types) out.v2.types = part.v2.types.map(qualify);
  }
  return out;
}

/**
 * config.repos を絶対パスにする（configDir 基準。宣言順）。
 * 省略時は `{ [basename(configDir)]: configDir }`。ディレクトリが無い repo はエラーにして外す。
 */
export function resolveRepos(
  configDir: string,
  config: StackAtlasConfig,
): { repos: Record<string, string>; issues: ValidationIssue[] } {
  const dir = resolve(configDir);
  const issues: ValidationIssue[] = [];
  const entries = Object.entries(config.repos ?? {});
  if (!entries.length) return { repos: { [basename(dir)]: dir }, issues };
  const repos: Record<string, string> = {};
  for (const [name, p] of entries) {
    if (typeof p !== 'string' || !p) {
      issues.push(
        issue('error', `config#/repos/${name}`, `repos.${name} にはパス（文字列）を書いてください`),
      );
      continue;
    }
    if (!/^[A-Za-z0-9._-]+$/.test(name)) {
      issues.push(
        issue(
          'error',
          `config#/repos/${name}`,
          `repo 名 "${name}" は英数字と . _ - だけにしてください`,
        ),
      );
      continue;
    }
    const abs = resolve(dir, p);
    if (!existsSync(abs) || !statSync(abs).isDirectory()) {
      issues.push(
        issue('error', `config#/repos/${name}`, `repos.${name} のディレクトリ ${abs} がありません`),
      );
      continue;
    }
    repos[name] = abs;
  }
  return { repos, issues };
}
