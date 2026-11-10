/**
 * 段 0（Phase 9-L0。docs/23 §3.1、D171・D179）: 数える範囲・言語の判定・「読んだ」・報告の `coverage`。
 *
 * 数える範囲: git の repo なら追跡しているファイル（`git -c core.fsmonitor=false ls-files -z`。シェルを通さず、
 * cwd は repo、GIT_* の環境変数は外す）。git が無い・repo でない・追跡が 0 なら walk（内蔵の除外表だけ。.gitignore は
 * 当てない。報告の note に書く）。そこから生成物と依存の置き場を除き、理由ごとに数える（scope.excluded）。
 *
 * 安全（全ファイルに触る処理）: walk はリンクを辿らない。git の一覧のパスも、途中の段とファイルを lstat で確かめ
 * （リンクなら読まない）、O_NOFOLLOW で開く。repo の外（`..`・絶対パス）は読まない。秘密らしいファイル（isSecretFile）は
 * 数えるが中を読まない。1 ファイルの大きさ（1MB）と件数（20 万）の上限。中身は数えるのに使うだけで、報告に出さない。
 *
 * 「読んだ」: 最後の graph の箱・型・手書きの箱・補いの箱の `file` にあるか、抽出器が `read` で申告したファイル。
 * 割合は言語ごとに行数で数える（source の種類だけ）。
 */
import { execFileSync } from 'node:child_process';
import { lstatSync, readdirSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { CONFIG_FILES } from './config.js';
import { FLOWS_FILES } from './flows.js';
import { readNoFollowResult } from './fsafe.js';
import { HAND_ADAPTER } from './hand-graph.js';
import { detectLanguage, extOf, languageHint, type FileCategory } from './languages.js';
import { HARNESS_DIR } from './local-files.js';
import { OVERRIDES_FILE } from './overrides.js';
import { isSecretFile, repoPathProblem } from './secrets.js';
import type { BuildIssue, PartialGraph, StackAtlasConfig } from './types.js';
import { globToRegExp, pathWithin, toPosix } from './util.js';

/** 依存・生成物の既知のディレクトリ（どの深さでも。段の名前と完全一致） */
export const GENERATED_DIRS: readonly string[] = [
  '.build',
  'DerivedData',
  'Pods',
  'Carthage',
  '.venv',
  'venv',
  'node_modules',
  'dist',
  'build',
  '.next',
  '.svelte-kit',
  'target',
  '_next',
];
/** walk のときに降りないディレクトリ（版の管理の置き場） */
const VCS_DIRS = new Set(['.git', '.hg', '.svn']);
/** build の既定の出力先（repo の中。いつも除く） */
const DEFAULT_OUT_DIR = `${HARNESS_DIR}/out`;

export interface CoverageLimits {
  /** 1 repo の件数の上限（越えた分は数えずに overLimit に出す） */
  maxFiles: number;
  /** 1 ファイルの大きさの上限（越えたら tooLarge で除く） */
  maxFileBytes: number;
  /** 生成物の印・縮めたファイルを見る先頭の大きさ */
  headBytes: number;
  /** 縮めたファイルとみなす 1 行の長さ */
  minifiedLine: number;
  /** 生成物の印を探す先頭の行数 */
  headerLines: number;
  /** git の時間の上限（ミリ秒） */
  gitTimeoutMs: number;
}

export const COVERAGE_LIMITS: CoverageLimits = {
  maxFiles: 200_000,
  maxFileBytes: 1024 * 1024,
  headBytes: 64 * 1024,
  minifiedLine: 1000,
  headerLines: 5,
  gitTimeoutMs: 30_000,
};

/** 除いた理由（docs/23 §3.1 の 2） */
export type ExcludeReason =
  'dir' | 'output' | 'generated' | 'vendored' | 'header' | 'minified' | 'tooLarge';

const EXCLUDE_REASONS: readonly ExcludeReason[] = [
  'dir',
  'output',
  'generated',
  'vendored',
  'header',
  'minified',
  'tooLarge',
];

/** 数える範囲の 1 ファイル */
export interface ScopeFile {
  /** repo 相対（`/` 区切り） */
  path: string;
  language: string;
  category: FileCategory | 'other';
  /** 行数（source のときだけ） */
  lines?: number;
}

/** 1 つの repo の数える範囲 */
export interface RepoScope {
  repo: string;
  /** git: 追跡しているファイル。walk: git が使えないので内蔵の除外表だけで歩いた（.gitignore は当てていない） */
  method: 'git' | 'walk';
  note?: string;
  /** git の一覧（か walk で見つけた）ファイルの数（上限の中） */
  tracked: number;
  files: ScopeFile[];
  excluded: Record<ExcludeReason, number>;
  /** 秘密らしいファイル（数えるが中を読まない） */
  secret: number;
  /** シンボリックリンク（辿らない） */
  symlinks: number;
  /** 普通のファイルでない・無い・読めない（submodule・消えたファイルなど） */
  notFiles: number;
  /** walk のときに降りなかったディレクトリ（既知のディレクトリ・出力先・.git） */
  prunedDirs: number;
  /** 件数の上限を越えて数えなかったファイル */
  overLimit: number;
}

const zeroExcluded = (): Record<ExcludeReason, number> =>
  Object.fromEntries(EXCLUDE_REASONS.map((r) => [r, 0])) as Record<ExcludeReason, number>;

/** git に渡す環境変数（呼んだ側の GIT_* は外す。認証の入力を求めない・ロックを取らない） */
function gitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('GIT_')) env[k] = v;
  env.GIT_OPTIONAL_LOCKS = '0';
  env.GIT_TERMINAL_PROMPT = '0';
  return env;
}

/**
 * git が追跡しているファイル（root 相対）。git が無い・repo でない・失敗したら undefined。
 * root が上の repo の中のディレクトリなら、その下だけが返る（ls-files は cwd の下を cwd 相対で出す）
 */
export function gitTrackedFiles(
  root: string,
  timeoutMs = COVERAGE_LIMITS.gitTimeoutMs,
): string[] | undefined {
  try {
    const out = execFileSync('git', ['-c', 'core.fsmonitor=false', 'ls-files', '-z'], {
      cwd: root,
      env: gitEnv(),
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: timeoutMs,
      maxBuffer: 512 * 1024 * 1024,
    });
    return out.toString('utf8').split('\0').filter(Boolean);
  } catch {
    return undefined;
  }
}

/** 途中の段がリンクでないディレクトリか（root 相対の dir。'' は root）。結果は cache に覚える */
function dirOk(root: string, dir: string, cache: Map<string, boolean>): boolean {
  if (dir === '') return true;
  const hit = cache.get(dir);
  if (hit !== undefined) return hit;
  const i = dir.lastIndexOf('/');
  const parent = i < 0 ? '' : dir.slice(0, i);
  let ok = dirOk(root, parent, cache);
  if (ok) {
    const st = lstatSync(join(root, dir), { throwIfNoEntry: false });
    ok = !!st && st.isDirectory() && !st.isSymbolicLink();
  }
  cache.set(dir, ok);
  return ok;
}

type Stat = { size: number } | 'symlink' | 'not-file';

/** root/rel を、途中の段もファイルもリンクを辿らずに確かめる */
function safeStat(root: string, rel: string, cache: Map<string, boolean>): Stat {
  const i = rel.lastIndexOf('/');
  if (!dirOk(root, i < 0 ? '' : rel.slice(0, i), cache)) return 'not-file';
  const st = lstatSync(join(root, rel), { throwIfNoEntry: false });
  if (!st) return 'not-file';
  if (st.isSymbolicLink()) return 'symlink';
  return st.isFile() ? { size: st.size } : 'not-file';
}

/** root/rel を読む（途中の段もファイルもリンクを辿らない。maxBytes まで）。読めなければ undefined */
function safeRead(
  root: string,
  rel: string,
  maxBytes: number,
  cache: Map<string, boolean>,
): Buffer | undefined {
  if (repoPathProblem(rel)) return undefined;
  const st = safeStat(root, rel, cache);
  if (typeof st !== 'object' || st.size > maxBytes) return undefined;
  const r = readNoFollowResult(join(root, rel), maxBytes);
  return 'data' in r ? r.data : undefined;
}

/** 行数（最後の改行の後に文字があれば 1 行に数える） */
export function countLines(buf: Buffer): number {
  if (!buf.length) return 0;
  let n = 0;
  for (let i = buf.indexOf(10); i !== -1; i = buf.indexOf(10, i + 1)) n++;
  return buf[buf.length - 1] === 10 ? n : n + 1;
}

const GENERATED_HEADER = [
  /\bgenerated\b.*\bdo not edit\b/i,
  /\bdo not edit\b.*\bgenerated\b/i,
  /@generated\b/,
];

/** 先頭の行に生成物の印（`Code generated … DO NOT EDIT`・`@generated`）があるか */
export function hasGeneratedHeader(head: string, lines = COVERAGE_LIMITS.headerLines): boolean {
  return head.split('\n', lines).some((l) => GENERATED_HEADER.some((re) => re.test(l)));
}

/** 先頭の中に、1 行が limit 字を超える行があるか（縮めたファイル） */
export function isMinified(head: string, limit = COVERAGE_LIMITS.minifiedLine): boolean {
  let start = 0;
  for (;;) {
    const nl = head.indexOf('\n', start);
    const end = nl < 0 ? head.length : nl;
    if (end - start > limit) return true;
    if (nl < 0) return false;
    start = nl + 1;
  }
}

/** .gitattributes の 1 行の規則（linguist-generated・linguist-vendored だけ） */
export interface AttrRule {
  /** .gitattributes のあるディレクトリ（root 相対。'' は root） */
  dir: string;
  re: RegExp;
  generated?: boolean;
  vendored?: boolean;
}

const globBody = (g: string) => globToRegExp(g).source.replace(/^\^/, '').replace(/\$$/, '');

/**
 * .gitattributes を読む（簡単な glob だけ。引用符で囲んだパターンとマクロは読まない）。`/` を含むパターンはその
 * ディレクトリからの相対、含まないものはどの深さのファイル名にも当てる。末尾の `/` は `/**` とみなす（git より緩い）
 */
export function parseGitattributes(text: string, dir = ''): AttrRule[] {
  const rules: AttrRule[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith('"') || line.startsWith('[')) continue;
    const [pat, ...attrs] = line.split(/\s+/);
    if (!pat) continue;
    const rule: AttrRule = { dir, re: /$^/ };
    for (const a of attrs) {
      const m = /^([-!]?)linguist-(generated|vendored)(?:=(\S+))?$/.exec(a);
      if (!m) continue;
      const on = !m[1] && (m[3] === undefined || !/^(false|0|no)$/i.test(m[3]));
      rule[m[2] as 'generated' | 'vendored'] = on;
    }
    if (rule.generated === undefined && rule.vendored === undefined) continue;
    let p = pat.endsWith('/') ? `${pat}**` : pat;
    const anchored = p.includes('/');
    p = p.replace(/^\//, '');
    rule.re = new RegExp(anchored ? `^${globBody(p)}$` : `^(?:.*/)?${globBody(p)}$`);
    rules.push(rule);
  }
  return rules;
}

/** rel（root 相対）の linguist の属性。浅い .gitattributes から順に当て、後に当たった規則が勝つ */
export function attributesFor(
  rules: readonly AttrRule[],
  rel: string,
): 'generated' | 'vendored' | undefined {
  let generated = false;
  let vendored = false;
  for (const r of rules) {
    if (r.dir && !rel.startsWith(`${r.dir}/`)) continue;
    const sub = r.dir ? rel.slice(r.dir.length + 1) : rel;
    if (!r.re.test(sub)) continue;
    if (r.generated !== undefined) generated = r.generated;
    if (r.vendored !== undefined) vendored = r.vendored;
  }
  return vendored ? 'vendored' : generated ? 'generated' : undefined;
}

/** 正規化した repo 相対のディレクトリ（`./a/b/` → `a/b`）。repo の外なら undefined */
function normDir(d: unknown): string | undefined {
  if (typeof d !== 'string' || !d || repoPathProblem(d)) return undefined;
  const n = toPosix(d)
    .replace(/\/+$/, '')
    .replace(/^(\.\/)+/, '');
  return n && n !== '.' ? n : undefined;
}

const NEXT_CONFIG_RE = /^next\.config\.(ts|mjs|js|cjs|mts)$/;

/**
 * 設定の書き出し先（repo 相対のディレクトリ）: screens.dir、静的エクスポートの next.config（`output: 'export'`）の
 * ディレクトリの out と distDir、build の既定の出力先（.stack-atlas/out）
 */
function outputDirs(
  repoName: string,
  config: StackAtlasConfig,
  listed: readonly string[],
  read: (rel: string) => Buffer | undefined,
): string[] {
  const dirs = new Set<string>([DEFAULT_OUT_DIR]);
  const screens = config.screens;
  if (screens && (!screens.repo || screens.repo === repoName)) {
    const d = normDir(screens.dir);
    if (d) dirs.add(d);
  }
  for (const rel of listed) {
    const base = rel.slice(rel.lastIndexOf('/') + 1);
    if (!NEXT_CONFIG_RE.test(base) || inGeneratedDir(rel)) continue;
    const text = read(rel)?.toString('utf8');
    if (!text || !/\boutput\s*:\s*["'`]export["'`]/.test(text)) continue;
    const dir = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '';
    const join2 = (x: string) => (dir ? `${dir}/${x}` : x);
    dirs.add(join2('out'));
    const dist = /\bdistDir\s*:\s*["'`]([^"'`]+)["'`]/.exec(text)?.[1];
    const d = normDir(dist);
    if (d) dirs.add(join2(d));
  }
  return [...dirs].sort();
}

const GENERATED_DIR_SET = new Set(GENERATED_DIRS);
const inGeneratedDir = (rel: string) =>
  rel
    .split('/')
    .slice(0, -1)
    .some((s) => GENERATED_DIR_SET.has(s));
const under = (rel: string, dir: string) => rel === dir || rel.startsWith(`${dir}/`);

/** walk（git が使えないとき）。リンクを辿らず、版の管理の置き場・既知のディレクトリ・出力先には降りない */
function walkRepo(
  root: string,
  limits: CoverageLimits,
  pruneDir: (rel: string, name: string) => boolean,
): { files: string[]; symlinks: number; prunedDirs: number; overLimit: number } {
  const files: string[] = [];
  let symlinks = 0;
  let prunedDirs = 0;
  let overLimit = 0;
  const walk = (dir: string) => {
    let entries;
    try {
      entries = readdirSync(dir ? join(root, dir) : root, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const d of entries) {
      const rel = dir ? `${dir}/${d.name}` : d.name;
      if (d.isSymbolicLink()) symlinks++;
      else if (d.isDirectory()) {
        if (VCS_DIRS.has(d.name) || pruneDir(rel, d.name)) prunedDirs++;
        else walk(rel);
      } else if (d.isFile()) {
        if (files.length >= limits.maxFiles) overLimit++;
        else files.push(rel);
      }
    }
  };
  walk('');
  return { files, symlinks, prunedDirs, overLimit };
}

/**
 * 1 つの repo の数える範囲（docs/23 §3.1 の 1〜3）。root は repo の絶対パス。config は書き出し先（screens.dir）を除くのに使う
 */
export function scanRepoScope(
  root: string,
  repoName: string,
  config: StackAtlasConfig = {},
  limits: CoverageLimits = COVERAGE_LIMITS,
): RepoScope {
  const scope: RepoScope = {
    repo: repoName,
    method: 'git',
    tracked: 0,
    files: [],
    excluded: zeroExcluded(),
    secret: 0,
    symlinks: 0,
    notFiles: 0,
    prunedDirs: 0,
    overLimit: 0,
  };
  let realRoot: string;
  try {
    realRoot = realpathSync(root);
  } catch {
    scope.method = 'walk';
    scope.note = 'repo のディレクトリを開けません';
    return scope;
  }
  const dirCache = new Map<string, boolean>();
  const read = (rel: string) => safeRead(realRoot, rel, limits.maxFileBytes, dirCache);

  let listed = gitTrackedFiles(realRoot, limits.gitTimeoutMs);
  let outs: string[];
  if (listed?.length) {
    listed = [...new Set(listed.map((p) => toPosix(p)))].sort();
    outs = outputDirs(repoName, config, listed, read);
    if (listed.length > limits.maxFiles) {
      scope.overLimit = listed.length - limits.maxFiles;
      listed = listed.slice(0, limits.maxFiles);
    }
  } else {
    scope.method = 'walk';
    scope.note = listed
      ? 'git が追跡しているファイルが無いので、.gitignore を当てずに内蔵の除外表だけで数えました'
      : 'git の repo ではない（か git が無い）ので、.gitignore を当てずに内蔵の除外表だけで数えました';
    // 出力先は next.config を見てから決めるので、まず既知のディレクトリだけで歩いて next.config を探す
    const first = walkRepo(realRoot, limits, (_rel, name) => GENERATED_DIR_SET.has(name));
    outs = outputDirs(repoName, config, first.files, read);
    const w = walkRepo(
      realRoot,
      limits,
      (rel, name) => GENERATED_DIR_SET.has(name) || outs.some((o) => under(rel, o)),
    );
    listed = w.files;
    scope.symlinks += w.symlinks;
    scope.prunedDirs = w.prunedDirs;
    scope.overLimit = w.overLimit;
  }
  scope.tracked = listed.length;

  // .gitattributes（浅いものから。同じ深さはパスの順）
  const attrRules = listed
    .filter((p) => p === '.gitattributes' || p.endsWith('/.gitattributes'))
    .sort((a, b) => a.split('/').length - b.split('/').length || (a < b ? -1 : 1))
    .flatMap((p) => {
      const text = read(p)?.toString('utf8');
      return text
        ? parseGitattributes(text, p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '')
        : [];
    });

  for (const rel of listed) {
    if (repoPathProblem(rel)) {
      scope.notFiles++;
      continue;
    }
    if (inGeneratedDir(rel)) {
      scope.excluded.dir++;
      continue;
    }
    if (outs.some((o) => under(rel, o))) {
      scope.excluded.output++;
      continue;
    }
    const attr = attributesFor(attrRules, rel);
    if (attr) {
      scope.excluded[attr]++;
      continue;
    }
    const st = safeStat(realRoot, rel, dirCache);
    if (st === 'symlink') {
      scope.symlinks++;
      continue;
    }
    if (st === 'not-file') {
      scope.notFiles++;
      continue;
    }
    if (isSecretFile(rel)) {
      scope.secret++;
      continue;
    }
    if (st.size > limits.maxFileBytes) {
      scope.excluded.tooLarge++;
      continue;
    }
    const guess = detectLanguage(rel);
    const text =
      guess.category === 'source' || guess.category === 'config' || guess.category === 'other';
    if (!text) {
      scope.files.push({ path: rel, ...guess });
      continue;
    }
    const r = readNoFollowResult(join(realRoot, rel), limits.maxFileBytes);
    if (!('data' in r)) {
      if (r.why === 'too-large') scope.excluded.tooLarge++;
      else scope.notFiles++;
      continue;
    }
    const head = r.data.subarray(0, limits.headBytes).toString('utf8');
    const det =
      guess.category === 'other'
        ? detectLanguage(rel, head.slice(0, head.indexOf('\n') >>> 0))
        : guess;
    if (
      (det.category === 'source' || det.category === 'config') &&
      hasGeneratedHeader(head, limits.headerLines)
    ) {
      scope.excluded.header++;
      continue;
    }
    if (det.category === 'source' && isMinified(head, limits.minifiedLine)) {
      scope.excluded.minified++;
      continue;
    }
    const f: ScopeFile = { path: rel, ...det };
    if (det.category === 'source') f.lines = countLines(r.data);
    scope.files.push(f);
  }
  return scope;
}

/** 読めた行の段（1 ファイルは最も上の段 1 つに数える）。9-L1 で syntax、9-L3 で type が入る */
export interface CoverageReadTiers {
  /** 専用版（言語アダプタ ts-types・go-types） */
  adapter: number;
  /** ほかの抽出器（画面・IaC・契約・パッケージの箱など） */
  extractor: number;
  /** 手書きの部分グラフ・overrides の補い */
  hand: number;
  /** 読めていない */
  none: number;
}

export interface CoverageLanguage {
  language: string;
  files: number;
  lines: number;
  read: CoverageReadTiers;
  /** 読んだもの（抽出器の名前・hand・overrides）→ 行数。2 つが読んだファイルは両方に数える */
  readBy: Record<string, number>;
  unread: { files: number; lines: number };
}

export interface CoverageFormat {
  /** 形式（json・yaml・plist・dockerfile・swiftpm など。languages.ts の表） */
  format: string;
  files: number;
  /** 読んだもの（抽出器の名前・stack-atlas（設定・補いのファイル）など）。無ければ空 */
  readBy: string[];
}

export interface CoverageUnread {
  language: string;
  files: number;
  lines: number;
  /** なぜ読めていないか・どうすれば読めるか */
  why: string;
  /** 読めていないファイルの例（パスの順に 10 件まで。複数 repo なら `<repo>/` 付き） */
  examples: string[];
}

/** 報告の `coverage`（build --dry-run --json。docs/23 §3.1） */
export interface CoverageReport {
  scope: {
    /** 数える範囲のファイル（除いた後。秘密らしいファイルを除く） */
    files: number;
    /** git の一覧（walk なら見つけた）ファイル */
    tracked: number;
    excluded: Record<ExcludeReason, number>;
    secret: number;
    symlinks: number;
    notFiles: number;
    prunedDirs: number;
    overLimit: number;
    repos: Array<{
      repo: string;
      method: 'git' | 'walk';
      tracked: number;
      files: number;
      note?: string;
    }>;
  };
  /** 種類ごとのファイルの数（source は行数も） */
  categories: Record<FileCategory | 'other', { files: number; lines?: number }>;
  /** source の言語ごと（行数の多い順） */
  languages: CoverageLanguage[];
  /** config の形式ごと（ファイルの多い順） */
  formats: CoverageFormat[];
  /** 表に無い拡張子（ファイルの多い順に 20 まで。拡張子の無いものは `(なし)`） */
  other: Array<{ ext: string; files: number }>;
  /** 読めていないソースのある言語（行数の多い順） */
  unread: CoverageUnread[];
}

export interface CoverageInput {
  /** repo 名 → 絶対パス（宣言順） */
  repos: Record<string, string>;
  /** config のあるディレクトリ（そこにある設定・補いのファイルは stack-atlas が読んだものにする） */
  configDir: string;
  config: StackAtlasConfig;
  /** 抽出器名 → 出力（複数 repo なら file・read は `<repo>/` 付き）。手書きの部分グラフは hand */
  partials: Readonly<Record<string, PartialGraph>>;
  /** 抽出器名 → 役割（language は専用版） */
  roles: ReadonlyMap<string, 'language' | 'contract' | undefined>;
  /** 最後の graph の file（v1 の箱・v2 の箱・型・group） */
  graphFiles: Iterable<string | undefined>;
  limits?: CoverageLimits;
  /** 数える範囲を渡す（テスト用。省略時は scanRepoScope） */
  scopes?: RepoScope[];
}

const READER_OVERRIDES = 'overrides';
const READER_CORE = 'stack-atlas';
const EXAMPLES_MAX = 10;
const OTHER_MAX = 20;

const byCount =
  <T>(n: (x: T) => number, name: (x: T) => string) =>
  (a: T, b: T) =>
    n(b) - n(a) || (name(a) < name(b) ? -1 : name(a) > name(b) ? 1 : 0);
const sortedRecord = (m: Map<string, number>) =>
  Object.fromEntries([...m.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));

/** 報告の coverage を作る（最後の graph の後に呼ぶ） */
export function computeCoverage(input: CoverageInput): CoverageReport {
  const names = Object.keys(input.repos);
  const multi = names.length > 1;
  const limits = input.limits ?? COVERAGE_LIMITS;
  const scopes =
    input.scopes ?? names.map((n) => scanRepoScope(input.repos[n]!, n, input.config, limits));
  const roots = names.map((n) => {
    const abs = resolve(input.repos[n]!);
    let real = abs;
    try {
      real = realpathSync(abs);
    } catch {
      /* 無い repo は resolveRepos が外している */
    }
    return { name: n, abs, real };
  });
  /** graph の file → 数える範囲の鍵（複数 repo なら `<repo>/<path>`）。repo の外の絶対パスは undefined */
  const keyOf = (file: string | undefined): string | undefined => {
    if (typeof file !== 'string' || !file) return undefined;
    const f = file.replace(/\\/g, '/');
    if (isAbsolute(file)) {
      for (const r of roots)
        for (const base of [r.abs, r.real])
          if (pathWithin(base, file)) {
            const rel = toPosix(relative(base, file));
            return multi ? `${r.name}/${rel}` : rel;
          }
      return undefined;
    }
    return f.replace(/^(\.\/)+/, '');
  };

  const finalFiles = new Set<string>();
  for (const f of input.graphFiles) {
    const k = keyOf(f);
    if (k) finalFiles.add(k);
  }
  const declared = new Set<string>();
  const readersOf = new Map<string, Set<string>>();
  const addReader = (k: string, who: string) => {
    let s = readersOf.get(k);
    if (!s) readersOf.set(k, (s = new Set()));
    s.add(who);
  };
  for (const [name, p] of Object.entries(input.partials)) {
    const own = (f: string | undefined) => {
      const k = keyOf(f);
      if (k) addReader(k, name);
      return k;
    };
    for (const n of p.nodes) own(n.file);
    for (const n of p.v2?.nodes ?? []) own(n.file);
    for (const t of p.v2?.types ?? []) own(t.file);
    for (const r of p.read ?? []) {
      const k = own(r);
      if (k) declared.add(k);
    }
  }
  // config のあるディレクトリの設定・補いのファイル（stack-atlas が読む）
  const configReal = (() => {
    try {
      return realpathSync(input.configDir);
    } catch {
      return resolve(input.configDir);
    }
  })();
  const coreRoot = roots.find((r) => r.real === configReal || r.abs === resolve(input.configDir));
  const coreFiles = new Set<string>();
  if (coreRoot) {
    const pre = multi ? `${coreRoot.name}/` : '';
    for (const f of [...CONFIG_FILES, OVERRIDES_FILE, ...FLOWS_FILES]) coreFiles.add(pre + f);
  }
  const isCoreFile = (k: string) =>
    coreFiles.has(k) ||
    (!!coreRoot &&
      k.startsWith(`${multi ? `${coreRoot.name}/` : ''}${HARNESS_DIR}/`) &&
      !k.startsWith(`${multi ? `${coreRoot.name}/` : ''}${DEFAULT_OUT_DIR}/`));

  /** 読んだもの（読んでいなければ空） */
  const readers = (k: string): string[] => {
    const s = new Set<string>();
    const isRead = finalFiles.has(k) || declared.has(k);
    if (isRead) {
      for (const r of readersOf.get(k) ?? []) s.add(r);
      if (!s.size) s.add(READER_OVERRIDES); // 抽出器の出力に無く、最後の graph にだけある（overrides・補い）
    }
    if (isCoreFile(k)) s.add(READER_CORE);
    return [...s].sort();
  };
  const tierOf = (rs: readonly string[]): keyof CoverageReadTiers => {
    if (rs.some((r) => r !== HAND_ADAPTER && input.roles.get(r) === 'language')) return 'adapter';
    if (rs.some((r) => r !== HAND_ADAPTER && r !== READER_OVERRIDES && r !== READER_CORE))
      return 'extractor';
    return rs.some((r) => r === HAND_ADAPTER || r === READER_OVERRIDES) ? 'hand' : 'none';
  };

  const categories: CoverageReport['categories'] = {
    source: { files: 0, lines: 0 },
    config: { files: 0 },
    doc: { files: 0 },
    asset: { files: 0 },
    other: { files: 0 },
  };
  const langs = new Map<
    string,
    { row: CoverageLanguage; by: Map<string, number>; unread: string[] }
  >();
  const formats = new Map<string, { files: number; by: Set<string> }>();
  const otherExt = new Map<string, number>();
  const scope: CoverageReport['scope'] = {
    files: 0,
    tracked: 0,
    excluded: zeroExcluded(),
    secret: 0,
    symlinks: 0,
    notFiles: 0,
    prunedDirs: 0,
    overLimit: 0,
    repos: [],
  };
  for (const s of scopes) {
    scope.files += s.files.length;
    scope.tracked += s.tracked;
    for (const r of EXCLUDE_REASONS) scope.excluded[r] += s.excluded[r];
    scope.secret += s.secret;
    scope.symlinks += s.symlinks;
    scope.notFiles += s.notFiles;
    scope.prunedDirs += s.prunedDirs;
    scope.overLimit += s.overLimit;
    scope.repos.push({
      repo: s.repo,
      method: s.method,
      tracked: s.tracked,
      files: s.files.length,
      ...(s.note ? { note: s.note } : {}),
    });
    for (const f of s.files) {
      const k = multi ? `${s.repo}/${f.path}` : f.path;
      const c = categories[f.category];
      c.files++;
      if (f.category === 'source') {
        const lines = f.lines ?? 0;
        c.lines = (c.lines ?? 0) + lines;
        let l = langs.get(f.language);
        if (!l)
          langs.set(
            f.language,
            (l = {
              row: {
                language: f.language,
                files: 0,
                lines: 0,
                read: { adapter: 0, extractor: 0, hand: 0, none: 0 },
                readBy: {},
                unread: { files: 0, lines: 0 },
              },
              by: new Map(),
              unread: [],
            }),
          );
        l.row.files++;
        l.row.lines += lines;
        const rs = readers(k).filter((r) => r !== READER_CORE);
        const tier = tierOf(rs);
        l.row.read[tier] += lines;
        for (const r of rs) l.by.set(r, (l.by.get(r) ?? 0) + lines);
        if (tier === 'none') {
          l.row.unread.files++;
          l.row.unread.lines += lines;
          l.unread.push(k);
        }
      } else if (f.category === 'config') {
        let fm = formats.get(f.language);
        if (!fm) formats.set(f.language, (fm = { files: 0, by: new Set() }));
        fm.files++;
        for (const r of readers(k)) fm.by.add(r);
      } else if (f.category === 'other') {
        const base = f.path.slice(f.path.lastIndexOf('/') + 1);
        const ext = extOf(base) || '(なし)';
        otherExt.set(ext, (otherExt.get(ext) ?? 0) + 1);
      }
    }
  }

  const languages = [...langs.values()]
    .map((l) => ({ ...l.row, readBy: sortedRecord(l.by) }))
    .sort(
      byCount(
        (x) => x.lines,
        (x) => x.language,
      ),
    );
  const unread: CoverageUnread[] = [...langs.values()]
    .filter((l) => l.row.unread.files > 0)
    .map((l) => ({
      language: l.row.language,
      files: l.row.unread.files,
      lines: l.row.unread.lines,
      why: unreadWhy(l.row),
      examples: [...l.unread].sort().slice(0, EXAMPLES_MAX),
    }))
    .sort(
      byCount(
        (x) => x.lines,
        (x) => x.language,
      ),
    );
  return {
    scope,
    categories,
    languages,
    formats: [...formats.entries()]
      .map(([format, v]) => ({ format, files: v.files, readBy: [...v.by].sort() }))
      .sort(
        byCount(
          (x) => x.files,
          (x) => x.format,
        ),
      ),
    other: [...otherExt.entries()]
      .map(([ext, files]) => ({ ext, files }))
      .sort(
        byCount(
          (x) => x.files,
          (x) => x.ext,
        ),
      )
      .slice(0, OTHER_MAX),
    unread,
  };
}

/** 読めていない理由（設定で読める言語なら、その設定のヒント。無ければ構文の段の予定） */
function unreadWhy(row: CoverageLanguage): string {
  const hint = languageHint(row.language);
  const some = row.lines - row.read.none > 0;
  if (hint) return some ? `一部が読めていない（${hint}）` : `読めていない（${hint}）`;
  return '構文の段（9-L1）で読めるようになる予定';
}

const fmt = (n: number) => n.toLocaleString('en-US');

/** 読めていないソースの 1 行（警告の文と要約） */
export function unreadText(
  u: Pick<CoverageUnread, 'language' | 'files' | 'lines' | 'why'>,
): string {
  return `読めていないソース: ${u.language} ${fmt(u.files)} ファイル（${fmt(u.lines)} 行）— ${u.why}`;
}

/** 読めていないソースの警告（言語ごとに 1 件。path は coverage。docs/23 §3.1 の strict の 9-L0） */
export function coverageIssues(c: CoverageReport): Array<BuildIssue & { level: 'warning' }> {
  return c.unread.map((u) => ({
    level: 'warning',
    path: 'coverage',
    message: unreadText(u),
    data: { language: u.language, files: u.files, lines: u.lines },
  }));
}

/** 箱が 0 の graph の strict のエラーの文（見つけた言語を添える） */
export function emptyGraphText(c: CoverageReport | undefined): string {
  const langs = (c?.languages ?? []).filter((l) => l.files > 0);
  if (!langs.length)
    return '箱が 0 の graph です。数える範囲にソースが見つかりません（repo のパス・repos の設定を確かめる）';
  const top = langs
    .slice(0, 5)
    .map((l) => `${l.language} ${fmt(l.files)} ファイル（${fmt(l.lines)} 行）`)
    .join('・');
  const more = langs.length > 5 ? ` ほか ${langs.length - 5} 言語` : '';
  return `箱が 0 の graph です。数える範囲のソースは ${top}${more}で、どの抽出器も読めませんでした（構文の段（9-L1）で読めるようになる予定。今は設定か手書きの部分グラフで補う）`;
}

/** 要約（標準出力）の行: 数える範囲と、言語ごとの読めた割合 */
export function formatCoverage(c: CoverageReport): string[] {
  const s = c.scope;
  const ex = s.excluded;
  const excludedParts: Array<[string, number]> = [
    ['既知のディレクトリ', ex.dir],
    ['書き出し先', ex.output],
    ['linguist-generated', ex.generated],
    ['linguist-vendored', ex.vendored],
    ['生成物の印', ex.header],
    ['縮めたファイル', ex.minified],
    ['1MB 超', ex.tooLarge],
  ];
  const parts = excludedParts.filter(([, n]) => n > 0).map(([w, n]) => `${w} ${fmt(n)}`);
  const extra: string[] = [];
  if (s.secret) extra.push(`秘密らしいファイル ${fmt(s.secret)}（数えるが読まない）`);
  if (s.symlinks) extra.push(`リンク ${fmt(s.symlinks)}（辿らない）`);
  if (s.overLimit) extra.push(`上限を越えて数えなかった ${fmt(s.overLimit)}`);
  const lines = [
    `数える範囲: ${fmt(s.files)} ファイル（一覧 ${fmt(s.tracked)}${parts.length ? `、除いた ${parts.join('・')}` : ''}${extra.length ? `、${extra.join('・')}` : ''}）`,
  ];
  for (const r of s.repos) if (r.note) lines.push(`  ${r.repo}: ${r.note}`);
  for (const l of c.languages) {
    const read = l.lines - l.read.none;
    const pct = l.lines ? Math.floor((read / l.lines) * 100) : 100;
    const by = Object.entries(l.readBy)
      .map(([k, v]) => `${k} ${fmt(v)}`)
      .join('・');
    lines.push(
      `  ${l.language}: ${fmt(l.files)} ファイル・${fmt(l.lines)} 行、読めた ${fmt(read)} 行（${pct}%${by ? `。${by}` : ''}）`,
    );
  }
  return lines;
}

/** graph の file を集める（v1 の箱・v2 の箱・型・group） */
export function graphFilesOf(
  ...lists: Array<ReadonlyArray<{ file?: string | undefined }> | undefined>
): string[] {
  const out: string[] = [];
  for (const l of lists) for (const x of l ?? []) if (typeof x.file === 'string') out.push(x.file);
  return out;
}
