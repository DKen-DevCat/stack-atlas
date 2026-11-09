/**
 * 秘密情報と repo の外のファイルを graph に入れない（2026-11-10 8-4 のレビュー S2。docs/19 §12）。
 *
 * - 設定（stack-atlas.config.yaml）のパス・glob は解析対象の repo のもので、信用しない。repo の外（絶対パス・`..`・
 *   repo の外へ出るシンボリックリンク）を指すものは読まない（checkConfig が字面で外し、抽出器は読む前に repoPath で
 *   realpath を確かめる）
 * - 秘密らしいファイル（dotfile、`.env*`・`*.pem`・`*.key`・`id_*`・`*secret*`・`.npmrc`・認証情報など）と repo の外の
 *   ファイルは、箱は作ってよいが `code`（中身の抜粋）を入れない（stripSecretCode。抽出器の出力の後で一括）
 */
import { lstatSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import type { RepoContext } from './types.js';
import { globBase, pathWithin } from './util.js';

/** 中身を載せないディレクトリ（その下のファイルは全部秘密らしいものとして扱う） */
const SECRET_DIRS = new Set(['.ssh', '.aws', '.gnupg', '.docker', '.kube', '.azure', '.gcloud']);
/** 中身を載せない拡張子 */
const SECRET_EXT = /\.(pem|key|p12|pfx|jks|keystore|crt|cer|der|asc|gpg|kdbx|ovpn|env)$/i;
/** 中身を載せない名前（拡張子を除いた名前の一部） */
const SECRET_NAME = /(secret|credential|private[-_]?key|htpasswd)/i;

/**
 * `file`（repo 相対。複数 repo なら `<repo>/` 付き）が秘密らしいファイルか、repo の外か。
 * true なら code を載せない
 */
export function isSecretFile(file: string): boolean {
  const norm = file.replace(/\\/g, '/');
  if (isAbsolute(file) || /^[A-Za-z]:\//.test(norm) || norm.startsWith('~')) return true;
  const segs = norm.split('/').filter((x) => x && x !== '.');
  if (segs.includes('..')) return true;
  if (segs.slice(0, -1).some((d) => SECRET_DIRS.has(d.toLowerCase()))) return true;
  const base = segs[segs.length - 1] ?? '';
  if (!base) return false;
  if (base.startsWith('.')) return true; // dotfile（.env・.env.local・.npmrc・.netrc・.pgpass など）
  if (/^id_/i.test(base)) return true; // ssh の鍵（id_rsa・id_ed25519 など）
  if (SECRET_EXT.test(base)) return true;
  return SECRET_NAME.test(base);
}

/** 秘密らしいファイル・repo の外のファイルの箱の code を外す（書き換える）。外した箱 id を返す */
export function stripSecretCode(
  nodes: Array<{ id: string; file?: string; code?: string }>,
): string[] {
  const out: string[] = [];
  for (const n of nodes) {
    if (n.code === undefined || typeof n.file !== 'string' || !isSecretFile(n.file)) continue;
    delete n.code;
    out.push(n.id);
  }
  return out;
}

/** 設定のパス・glob が字面で repo の外を指すか（絶対パス・`~`・`..` の段）。外なら理由 */
export function repoPathProblem(rel: string): 'absolute' | 'parent' | undefined {
  const norm = rel.replace(/\\/g, '/');
  if (isAbsolute(rel) || /^[A-Za-z]:/.test(norm) || norm.startsWith('~')) return 'absolute';
  if (norm.split('/').includes('..')) return 'parent';
  return undefined;
}

/**
 * root（repo）の中の rel を絶対パスにする。字面で外（repoPathProblem）か、在る一番深い段の realpath が root の realpath の
 * 外（repo の外へ出るシンボリックリンク）なら why。まだ無いパスは在る段までで判定する（無いことは呼ぶ側が扱う）
 */
export function confineRepoPath(
  root: string,
  rel: string,
): { abs: string } | { why: 'absolute' | 'parent' | 'outside' } {
  const lexical = repoPathProblem(rel);
  if (lexical) return { why: lexical };
  const abs = resolve(root, rel);
  let realRoot: string;
  try {
    realRoot = realpathSync(root);
  } catch {
    return { abs }; // repo が無い（呼ぶ側が扱う）
  }
  let cur = abs;
  for (;;) {
    if (lstatSync(cur, { throwIfNoEntry: false })) {
      let real: string;
      try {
        real = realpathSync(cur);
      } catch {
        return { why: 'outside' }; // 壊れたリンク（先が分からない）は辿らない
      }
      return pathWithin(realRoot, real, true) ? { abs } : { why: 'outside' };
    }
    const up = dirname(cur);
    if (up === cur || !pathWithin(resolve(root), up, true)) return { abs };
    cur = up;
  }
}

const WHY_TEXT = {
  absolute: '絶対パスな',
  parent: '`..` で repo の外に出る',
  outside: 'repo の外を指す（シンボリックリンク）',
} as const;

/**
 * 抽出器が設定のパス・glob の静的な先頭を読む前に呼ぶ。repo の中なら絶対パス、外なら警告して undefined（読まない）。
 * what は警告の文に入れる設定のキー（`files[0].glob` など）
 */
export function repoPath(
  ctx: Pick<RepoContext, 'root' | 'repoName' | 'log'>,
  rel: string,
  what: string,
): string | undefined {
  const r = confineRepoPath(ctx.root, rel);
  if ('abs' in r) return r.abs;
  ctx.log.warn(`${what} の "${rel}" は${WHY_TEXT[r.why]}ので読みません（${ctx.repoName}）`);
  return undefined;
}

/** glob の静的な先頭（`apps/api/**\/*.sql` → `apps/api`）が repo の中のものだけ（外は警告して外す） */
export function repoGlobs(
  ctx: Pick<RepoContext, 'root' | 'repoName' | 'log'>,
  globs: readonly string[],
  what: string,
): string[] {
  return globs.filter((g) => repoPath(ctx, globBase(g.replace(/^\.\//, '')) || '.', what));
}

/** glob の静的な先頭が repo の中か（警告しない。detect など、同じ確かめを 2 回出さない所） */
export const globInRepo = (root: string, g: string) =>
  'abs' in confineRepoPath(root, globBase(g.replace(/^\.\//, '')) || '.');
