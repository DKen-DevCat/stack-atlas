/**
 * files 抽出器（docs/12 §3.1, D19）: `config.files` の glob に合うファイルを、そのまま 1 ファイル 1 ノードにする。
 * パーサの無い言語や独自の構成でも、設定だけで地図に載せるための最低保証。
 *
 * ```yaml
 * files:
 *   - { glob: "reference/*.py", kind: lib, name: "{basename}", layer: types }
 *   - { glob: "jobs/**\/*.sh", kind: cron, id: "{repo}/{path}", repo: platform }
 * ```
 *
 * - ID: `<kind>:<id テンプレート>`（既定 `{path}`）。name: テンプレート（既定 `{stem}`）
 * - テンプレートの置換: `{path}`（repo 相対パス）`{dir}` `{basename}`（拡張子あり）`{stem}`（拡張子なし）`{repo}`
 * - `file` は repo 相対（複数 repo ならパイプラインが `<repo>/` を付ける）、`line: 1`、`code` はテキストファイルの先頭 20 行
 * - `rule.repo` があればその repo でだけ走る。node_modules / .git は見ない
 *
 * ノードを作るだけでエッジは出さない（結線は overrides で）。そのため CLI では最初に走らせる。
 */
import { closeSync, openSync, readdirSync, readSync } from 'node:fs';
import { join, posix } from 'node:path';
import {
  globBase,
  globToRegExp,
  sectionFor,
  type Extractor,
  type FileRule,
  type PartialGraph,
  type PartialNode,
  type RepoContext,
} from '@stack-atlas/core';

export const NAME = 'files';

/** code に出す行数 */
export const CODE_LINES = 20;
/** 1 つのルールで作るノードの上限（glob の書き間違いで巨大な graph にならないように） */
export const MAX_FILES_PER_RULE = 2000;

const SKIP_DIRS = new Set(['node_modules', '.git']);

/** 中身を読まない拡張子（バイナリ） */
export const BINARY_EXTENSIONS = new Set(
  (
    'png jpg jpeg gif webp avif ico bmp tiff psd pdf zip gz tgz bz2 xz 7z rar tar jar war class ' +
    'woff woff2 ttf otf eot mp3 mp4 m4a wav ogg flac mov avi mkv webm wasm exe dll so dylib a o ' +
    'bin dat db sqlite sqlite3 pyc pyo node parquet'
  ).split(' '),
);

/** rule の glob に合う repo 相対パス（/ 区切り、ソート済み） */
export function globFiles(root: string, glob: string): string[] {
  const re = globToRegExp(glob.replace(/^\.\//, ''));
  const base = globBase(glob.replace(/^\.\//, ''));
  const out: string[] = [];
  const walk = (rel: string) => {
    let entries;
    try {
      entries = readdirSync(join(root, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) walk(p);
      } else if (e.isFile() && re.test(p)) out.push(p);
    }
  };
  walk(base);
  return out.sort();
}

/** `{path}` などを置換する */
export function fillTemplate(template: string, path: string, repo: string): string {
  const basename = posix.basename(path);
  const dot = basename.lastIndexOf('.');
  const vars: Record<string, string> = {
    path,
    dir: posix.dirname(path),
    basename,
    stem: dot > 0 ? basename.slice(0, dot) : basename,
    repo,
  };
  return template.replace(/\{(path|dir|basename|stem|repo)\}/g, (_, k: string) => vars[k]!);
}

/** テキストファイルなら先頭 lines 行。バイナリ（拡張子か NUL を含む）なら undefined */
export function readHead(abs: string, lines = CODE_LINES): string | undefined {
  const ext = posix.extname(abs).slice(1).toLowerCase();
  if (BINARY_EXTENSIONS.has(ext)) return undefined;
  let fd: number | undefined;
  try {
    fd = openSync(abs, 'r');
    const buf = Buffer.alloc(16 * 1024);
    const n = readSync(fd, buf, 0, buf.length, 0);
    const chunk = buf.subarray(0, n);
    if (chunk.includes(0)) return undefined;
    const text = chunk.toString('utf8').replace(/\r\n/g, '\n');
    return text.split('\n').slice(0, lines).join('\n').replace(/\n+$/, '');
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** この repo に効くルール */
function rulesFor(ctx: RepoContext): FileRule[] {
  return (ctx.config.files ?? []).filter(
    (r) => r && typeof r.glob === 'string' && typeof r.kind === 'string' && !!sectionFor(ctx, r),
  );
}

export function extractFiles(ctx: RepoContext): PartialGraph {
  const nodes: PartialNode[] = [];
  const seen = new Set<string>();
  for (const rule of rulesFor(ctx)) {
    if (!/^[a-z]+$/.test(rule.kind)) {
      ctx.log.warn(
        `files: kind "${rule.kind}" は英小文字だけにしてください（ID の接頭辞になるため。無視します）`,
      );
      continue;
    }
    let files = globFiles(ctx.root, rule.glob);
    if (!files.length) {
      ctx.log.warn(`files: "${rule.glob}" に合うファイルがありません（${ctx.repoName}）`);
      continue;
    }
    if (files.length > MAX_FILES_PER_RULE) {
      ctx.log.warn(
        `files: "${rule.glob}" に合うファイルが ${files.length} 個あります。先頭 ${MAX_FILES_PER_RULE} 個だけノードにします`,
      );
      files = files.slice(0, MAX_FILES_PER_RULE);
    }
    for (const path of files) {
      const id = `${rule.kind}:${fillTemplate(rule.id ?? '{path}', path, ctx.repoName)}`;
      if (seen.has(id)) {
        ctx.log.debug(`files: ${id} は先のルールで作成済み（${rule.glob}）`);
        continue;
      }
      seen.add(id);
      const node: PartialNode = {
        id,
        kind: rule.kind,
        name: fillTemplate(rule.name ?? '{stem}', path, ctx.repoName),
        file: path,
        line: 1,
      };
      const code = readHead(ctx.resolve(path));
      if (code) node.code = code;
      if (rule.layer) node.layer = rule.layer;
      nodes.push(node);
    }
    ctx.log.debug(`files: "${rule.glob}" → ${files.length} ノード`);
  }
  return { nodes, edges: [] };
}

export const extractor: Extractor = {
  name: NAME,
  detect: async (ctx) => rulesFor(ctx).length > 0,
  extract: async (ctx) => extractFiles(ctx),
};

export default extractor;
