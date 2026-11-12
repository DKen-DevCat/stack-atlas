/**
 * git の呼び出し（解析対象の repo は信用しない。2026-11-11 Phase 9-L0 のセキュリティレビュー）:
 * - `-c core.fsmonitor=false`（fsmonitor のコマンドを動かさない）、`-c safe.bareRepository=explicit`（repo の中に埋めた
 *   bare repo を見つけない）、`-c protocol.allow=never` と `GIT_NO_LAZY_FETCH=1`（partial clone の遅延の取得で
 *   sshCommand・uploadpack を動かさない）
 * - 呼んだ側の `GIT_*` の環境変数は外す（GIT_DIR などで別の repo を指さない）。認証の入力を求めない・ロックを取らない
 * - シェルを通さない（execFileSync に引数の配列）。時間の上限
 * - git は、PATH の絶対パスの段だけから探し、repo の外（一時ディレクトリ）で起動して `-C <repo>` を渡す
 *   （2026-11-13 Phase 10-1b の設計レビュー: PATH に空の段か `.` があると、repo に置いた `git` が実行された）
 */
import { execFileSync } from 'node:child_process';
import { accessSync, constants, lstatSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, isAbsolute, join, resolve, sep } from 'node:path';
import { pathWithin } from './util.js';

/** どの git の呼び出しにも付ける設定（上のコメント） */
export const GIT_SAFE_CONFIG: readonly string[] = [
  '-c',
  'core.fsmonitor=false',
  '-c',
  'safe.bareRepository=explicit',
  '-c',
  'protocol.allow=never',
];

/** git に渡す環境変数（呼んだ側の GIT_* を外し、遅延の取得・認証の入力・ロックを止める） */
export function gitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('GIT_')) env[k] = v;
  env.GIT_NO_LAZY_FETCH = '1';
  env.GIT_OPTIONAL_LOCKS = '0';
  env.GIT_TERMINAL_PROMPT = '0';
  return env;
}

/**
 * git の実行ファイル。PATH の段のうち、絶対パスのものだけを見る（空の段・`.`・相対の段は見ない。repo の中の `git` を
 * 実行しないため）。見つからなければ undefined
 */
export function gitExecutable(path: string | undefined = process.env.PATH): string | undefined {
  const names = process.platform === 'win32' ? ['git.exe', 'git.cmd'] : ['git'];
  for (const dir of (path ?? '').split(delimiter)) {
    if (!dir || !isAbsolute(dir)) continue;
    for (const name of names) {
      const file = join(dir, name);
      try {
        if (!statSync(file).isFile()) continue;
        accessSync(file, constants.X_OK);
        return file;
      } catch {
        // 次の段へ
      }
    }
  }
  return undefined;
}

/**
 * repo（cwd）について git を呼ぶ（GIT_SAFE_CONFIG・gitEnv 付き）。git は repo の外で起動し、`-C cwd` で repo を渡す。
 * 失敗したら undefined
 */
export function runGit(
  cwd: string,
  args: readonly string[],
  opts: { timeoutMs?: number; maxBuffer?: number } = {},
): Buffer | undefined {
  const exe = gitExecutable();
  if (!exe) return undefined;
  try {
    return execFileSync(exe, [...GIT_SAFE_CONFIG, '-C', cwd, ...args], {
      cwd: tmpdir(),
      env: gitEnv(),
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: opts.timeoutMs ?? 5000,
      maxBuffer: opts.maxBuffer ?? 16 * 1024 * 1024,
    });
  } catch {
    return undefined;
  }
}

function git(root: string, args: string[]): string | undefined {
  const out = runGit(root, args)?.toString('utf8').trim();
  return out || undefined;
}

const realOf = (p: string) => {
  try {
    return realpathSync(p);
  } catch {
    return undefined;
  }
};

/**
 * root（realpath）の git の repo を確かめる。使ってよいなら作業ツリーの一番上（realpath）、だめなら理由。
 * 使ってよいのは、`git rev-parse` の作業ツリーの一番上が root かその上で、その `.git` が
 * - 普通のディレクトリ（リンクでない）で、`--absolute-git-dir` がそれ自身、または
 * - gitfile（`gitdir: <dir>`）で、指す先が作業ツリーの外の、`HEAD` を持つディレクトリ（worktree なら `commondir`、
 *   submodule なら `.git/modules/` の下）で、`--absolute-git-dir` がその先
 * のとき。repo の中に埋めた bare repo（safe.bareRepository=explicit で見つけない）・中を指す gitfile・リンクの `.git` は使わない
 */
export function checkGitRepo(root: string, timeoutMs = 5000): { top: string } | { why: string } {
  const out = runGit(root, ['rev-parse', '--show-toplevel', '--absolute-git-dir'], { timeoutMs });
  if (!out) return { why: 'git の repo ではない（か git が無い）' };
  const [topRaw, gitDirRaw] = out.toString('utf8').trim().split('\n');
  const top = topRaw && realOf(topRaw);
  const gitDir = gitDirRaw && realOf(gitDirRaw);
  if (!top || !gitDir) return { why: 'git の作業ツリーではない（bare repo など）' };
  if (!pathWithin(top, root, true)) return { why: 'git の作業ツリーの外' };
  const dotGit = join(top, '.git');
  const st = lstatSync(dotGit, { throwIfNoEntry: false });
  if (!st || st.isSymbolicLink()) return { why: '作業ツリーの .git が無いかリンク' };
  if (st.isDirectory())
    return realOf(dotGit) === gitDir ? { top } : { why: '.git と git の場所が食い違う' };
  if (!st.isFile()) return { why: '作業ツリーの .git が普通のファイルでない' };
  let target: string | undefined;
  try {
    const m = /^gitdir:\s*(.+?)\s*$/m.exec(readFileSync(dotGit, 'utf8').slice(0, 4096));
    target = m ? realOf(isAbsolute(m[1]!) ? m[1]! : resolve(top, m[1]!)) : undefined;
  } catch {
    target = undefined;
  }
  if (!target || target !== gitDir)
    return { why: '.git（gitfile）の指す先と git の場所が食い違う' };
  if (pathWithin(top, target, true)) return { why: '.git（gitfile）が作業ツリーの中を指す' };
  const isFile = (p: string) => lstatSync(p, { throwIfNoEntry: false })?.isFile() === true;
  if (!isFile(join(target, 'HEAD'))) return { why: '.git（gitfile）の指す先に HEAD が無い' };
  const worktree = isFile(join(target, 'commondir'));
  const submodule = `${target}${sep}`.includes(`${sep}.git${sep}modules${sep}`);
  if (!worktree && !submodule)
    return { why: '.git（gitfile）の指す先が worktree・submodule の git の場所でない' };
  return { top };
}

/** root が Git 管理下なら HEAD のコミット SHA */
export function gitCommit(root: string): string | undefined {
  return git(root, ['rev-parse', 'HEAD']);
}

/** origin の URL（認証情報は取り除く）。無ければ undefined */
export function gitRemote(root: string): string | undefined {
  const url = git(root, ['remote', 'get-url', 'origin']);
  if (!url) return undefined;
  const clean = url.replace(/^(\w+:\/\/)[^@/]+@/, '$1');
  // ローカルのプロキシ経由など、外から辿れない URL は使わない
  return /^\w+:\/\/(localhost|127\.0\.0\.1)[:/]/.test(clean) ? undefined : clean;
}

/** 追跡しているファイル（root からの相対パス）と、その種類 */
export interface TrackedFiles {
  /** 普通のファイル（モード 100644・100755）で、手元にあるもの */
  files: string[];
  /** 数えないもの: シンボリックリンク・submodule・手元で消したもの */
  others: number;
}

/**
 * root（git の作業ツリーの中のディレクトリ）の下で、git が追跡しているファイル。git の repo でない・使ってよい repo で
 * ないときは、理由（checkGitRepo）
 */
export function trackedRegularFiles(
  root: string,
  opts: { maxFiles?: number } = {},
): TrackedFiles | { why: string } {
  const real = realOf(root);
  if (!real) return { why: 'ディレクトリが無い' };
  const repo = checkGitRepo(real);
  if ('why' in repo) return repo;
  const out = runGit(real, ['ls-files', '-z', '-s'], {
    timeoutMs: 20_000,
    maxBuffer: 256 * 1024 * 1024,
  });
  if (!out) return { why: '追跡しているファイルの一覧を得られない' };
  const files: string[] = [];
  let others = 0;
  for (const entry of out.toString('utf8').split('\0')) {
    if (!entry) continue;
    // "<モード> <オブジェクト> <段>\t<パス>"
    const tab = entry.indexOf('\t');
    const mode = entry.slice(0, 6);
    const path = entry.slice(tab + 1);
    if (tab < 0 || (mode !== '100644' && mode !== '100755')) {
      others++;
      continue;
    }
    const st = lstatSync(join(real, path), { throwIfNoEntry: false });
    if (!st?.isFile()) {
      others++;
      continue;
    }
    files.push(path);
    if (opts.maxFiles !== undefined && files.length >= opts.maxFiles) break;
  }
  return { files, others };
}
