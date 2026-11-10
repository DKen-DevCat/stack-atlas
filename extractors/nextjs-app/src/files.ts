/**
 * Next のファイル → ノード ID（App Router の page / layout / route.ts、Pages Router）。
 * ts-imports も同じ ID を出すためにこれを使う。
 *
 * - App Router: `page.*` → `route:<URL>`、`layout.*` → `layout:<URL>`（core の listRouteFiles）、
 *   `route.(ts|js)` → `handler:<URL>`（`meta.apiRoutes` は export している GET / POST … から）
 * - Pages Router: `pages/x/[id].tsx` → `route:/x/[id]`、`index` はディレクトリ、`_app`（無ければ `_document`）→ `layout:/`、
 *   `pages/api/**` → `handler:<URL>`（メソッドは ANY）。`_error` などほかの `_` ファイルは対象外
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import {
  confineRepoPath,
  findAppDir,
  listRouteFiles,
  segmentToUrl,
  stripJsComments,
} from '@stack-atlas/core';

export type NextFileKind = 'page' | 'layout' | 'handler';

export interface NextFile {
  abs: string;
  /** root からの相対パス（/ 区切り） */
  rel: string;
  kind: NextFileKind;
  /** URL（Next 形式。`/races/[id]`） */
  url: string;
  /** app / pages ディレクトリからの相対ディレクトリ（App Router）、またはファイルのパス（Pages Router） */
  segment: string;
  id: string;
  router: 'app' | 'pages';
  /** handler のメソッド（route.ts は export、pages/api は ANY） */
  methods?: string[];
}

const toPosix = (p: string) => p.split(sep).join('/');
const SOURCE = /\.(tsx|ts|jsx|js|mjs)$/;
const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];

/** route.ts が export している HTTP メソッド */
export function exportedMethods(src: string): string[] {
  const out = new Set<string>();
  for (const m of src.matchAll(
    /export\s+(?:async\s+)?(?:function\s+|const\s+|let\s+)(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b/g,
  ))
    out.add(m[1]!);
  for (const m of src.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const part of m[1]!.split(',')) {
      const name = part
        .trim()
        .split(/\s+as\s+/)
        .pop()
        ?.trim();
      if (name && HTTP_METHODS.includes(name)) out.add(name);
    }
  }
  return HTTP_METHODS.filter((x) => out.has(x));
}

/** Next の URL（`/x/[id]`、`/docs/[...slug]`）→ API 形式のパス（`/x/{id}`、`/docs/{slug+}`） */
export function nextUrlToApiPath(url: string): string {
  return url
    .replace(/\[\[\.\.\.([^\]]+)\]\]/g, '{$1+}')
    .replace(/\[\.\.\.([^\]]+)\]/g, '{$1+}')
    .replace(/\[([^\]]+)\]/g, '{$1}');
}

function walk(dir: string, out: string[] = []): string[] {
  let names: string[];
  try {
    names = readdirSync(dir).sort();
  } catch {
    return out;
  }
  for (const name of names) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

/** pages ディレクトリ（config.next.pagesDir → src/pages → pages、App Router の兄弟でもよい） */
export function findPagesDir(root: string, configured?: string): string | undefined {
  const ok = (d: string) => {
    try {
      return readdirSync(join(root, d)).some(
        (f) => SOURCE.test(f) || statSync(join(root, d, f)).isDirectory(),
      );
    } catch {
      return false;
    }
  };
  if (configured) return existsSync(join(root, configured)) ? configured : undefined;
  return ['src/pages', 'pages'].find(ok);
}

/** App Router の route.ts */
function listAppHandlers(root: string, appDir: string): NextFile[] {
  const base = join(root, appDir);
  const out: NextFile[] = [];
  for (const abs of walk(base)) {
    if (!/(^|[\\/])route\.(ts|js|mjs)$/.test(abs)) continue;
    const segment = toPosix(relative(base, dirname(abs)));
    const r = segmentToUrl(segment);
    if ('skip' in r) continue;
    const methods = exportedMethods(readFileSync(abs, 'utf8'));
    out.push({
      abs,
      rel: toPosix(relative(root, abs)),
      kind: 'handler',
      url: r.url,
      segment,
      id: `handler:${r.url}`,
      router: 'app',
      methods: methods.length > 0 ? methods : ['ANY'],
    });
  }
  return out;
}

/** Pages Router */
export function listPagesFiles(root: string, pagesDir: string): NextFile[] {
  const base = join(root, pagesDir);
  const out: NextFile[] = [];
  let layout: NextFile | undefined;
  for (const abs of walk(base)) {
    if (!SOURCE.test(abs) || /\.(test|spec|stories)\.[jt]sx?$/.test(abs) || abs.endsWith('.d.ts'))
      continue;
    const relToBase = toPosix(relative(base, abs)).replace(SOURCE, '');
    const rel = toPosix(relative(root, abs));
    const parts = relToBase.split('/');
    const last = parts[parts.length - 1]!;
    if (parts.length === 1 && (last === '_app' || last === '_document')) {
      if (!layout || last === '_app')
        layout = {
          abs,
          rel,
          kind: 'layout',
          url: '/',
          segment: relToBase,
          id: 'layout:/',
          router: 'pages',
        };
      continue;
    }
    if (parts.some((p) => p.startsWith('_'))) continue;
    const urlParts = last === 'index' ? parts.slice(0, -1) : parts;
    const url = '/' + urlParts.join('/');
    if (parts[0] === 'api') {
      out.push({
        abs,
        rel,
        kind: 'handler',
        url,
        segment: relToBase,
        id: `handler:${url}`,
        router: 'pages',
        methods: ['ANY'],
      });
    } else {
      out.push({
        abs,
        rel,
        kind: 'page',
        url,
        segment: relToBase,
        id: `route:${url}`,
        router: 'pages',
      });
    }
  }
  return layout ? [layout, ...out] : out;
}

export interface NextDirs {
  appDir?: string;
  pagesDir?: string;
}

export function findNextDirs(
  root: string,
  cfg: { appDir?: string; pagesDir?: string } = {},
): NextDirs {
  const out: NextDirs = {};
  // 設定の appDir・pagesDir が repo の外（絶対パス・`..`・外へ出るリンク）なら読まない（2026-11-10 8-4 のレビュー S2）
  const inRepo = (p: string | undefined) =>
    p && 'abs' in confineRepoPath(root, p) ? p : undefined;
  if (cfg.appDir !== undefined && !inRepo(cfg.appDir)) return out;
  if (cfg.pagesDir !== undefined && !inRepo(cfg.pagesDir)) return out;
  const appDir = findAppDir(root, cfg.appDir);
  if (appDir) out.appDir = toPosix(appDir);
  const pagesDir = findPagesDir(root, cfg.pagesDir);
  if (pagesDir) out.pagesDir = pagesDir;
  return out;
}

/** すべての Next ファイル（App Router が先。同じ ID は App Router を残す）。skipped は対象外の理由 */
export function listNextFiles(
  root: string,
  dirs: NextDirs,
): { files: NextFile[]; skipped: string[] } {
  const files: NextFile[] = [];
  const skipped: string[] = [];
  if (dirs.appDir) {
    const r = listRouteFiles(root, dirs.appDir);
    skipped.push(...r.skipped);
    for (const f of r.files) files.push({ ...f, router: 'app' });
    files.push(...listAppHandlers(root, dirs.appDir));
  }
  if (dirs.pagesDir) {
    const ids = new Set(files.map((f) => f.id));
    for (const f of listPagesFiles(root, dirs.pagesDir)) {
      if (ids.has(f.id)) skipped.push(`${f.rel}: App Router と同じ ${f.id}`);
      else files.push(f);
    }
  }
  return { files, skipped };
}

export const NEXT_CONFIG_FILES = [
  'next.config.ts',
  'next.config.mjs',
  'next.config.js',
  'next.config.cjs',
  'next.config.mts',
] as const;

/** next.config から読む値（静的に読める文字列・真偽値のリテラルだけ。環境変数などで決まる値は undefined） */
export interface NextConfigInfo {
  /** next.config のあるディレクトリ（root 相対、/ 区切り。直下なら `.`） */
  dir: string;
  /** next.config のファイル（root 相対） */
  file: string;
  /** `output`（`export` / `standalone`） */
  output?: string;
  /** `distDir`（static export ではエクスポートの出力先。既定 `out`） */
  distDir?: string;
  /** `trailingSlash`（true なら `/a` → `a/index.html`） */
  trailingSlash?: boolean;
  /** `basePath`（`/docs` など。HTML の参照は basePath 付き、エクスポートのファイルは basePath 無し） */
  basePath?: string;
  /** `assetPrefix`（`https://cdn.example.com` か `/prefix`。`/_next/` の参照の前に付く） */
  assetPrefix?: string;
  /** MAX_NEXT_CONFIG_BYTES を超えたので値を読まなかった（読んだファイルとして申告しない。docs/23 §3.1） */
  tooLarge?: true;
}

const stringOption = (src: string, key: string) =>
  new RegExp(`\\b${key}\\s*:\\s*(["'\`])([^"'\`$]*)\\1`).exec(src)?.[2];

/** next.config を読む大きさの上限（バイト）。超えたら値を読まない（警告。2026-11-09（8-3b のレビュー）） */
export const MAX_NEXT_CONFIG_BYTES = 1024 * 1024;

/** next.config のコメントを外す（core へ移した。coverage の書き出し先の判定と同じもの。2026-11-11 Phase 9-L0 のレビュー） */
export { stripJsComments };

/**
 * next.config.{ts,mjs,js,cjs,mts} を探して `output`・`distDir`・`trailingSlash`・`basePath`・`assetPrefix` を読む
 * （docs/18 §3.3。app / pages の親ディレクトリから root まで、深い方から探す）。無ければ undefined。
 * MAX_NEXT_CONFIG_BYTES を超えるファイルは値を読まずに `{ dir, file }` だけ返し、warn で知らせる
 */
export function readNextConfig(
  root: string,
  dirs: NextDirs,
  warn?: (message: string) => void,
): NextConfigInfo | undefined {
  const starts = new Set<string>(['.']);
  for (const d of [dirs.appDir, dirs.pagesDir]) {
    if (!d) continue;
    let cur = dirname(d);
    if (cur.endsWith('/src') || cur === 'src') cur = dirname(cur);
    while (cur && cur !== '.' && cur !== '/') {
      starts.add(cur);
      cur = dirname(cur);
    }
  }
  for (const dir of [...starts].sort((a, b) => b.length - a.length)) {
    for (const name of NEXT_CONFIG_FILES) {
      const p = join(root, dir, name);
      if (!existsSync(p)) continue;
      const info: NextConfigInfo = { dir, file: toPosix(join(dir, name)) };
      const st = statSync(p);
      if (!st.isFile()) continue;
      if (st.size > MAX_NEXT_CONFIG_BYTES) {
        warn?.(
          `${info.file} が ${MAX_NEXT_CONFIG_BYTES / 1024 / 1024} MB を超える（${Math.ceil(st.size / 1024)} KB）ので、output などの値を読みません`,
        );
        info.tooLarge = true;
        return info;
      }
      const src = stripJsComments(readFileSync(p, 'utf8'));
      const output = /\boutput\s*:\s*["'`](\w+)["'`]/.exec(src)?.[1];
      if (output) info.output = output;
      const trailing = /\btrailingSlash\s*:\s*(true|false)\b/.exec(src)?.[1];
      if (trailing) info.trailingSlash = trailing === 'true';
      for (const key of ['distDir', 'basePath', 'assetPrefix'] as const) {
        const v = stringOption(src, key);
        if (v !== undefined) info[key] = v;
      }
      return info;
    }
  }
  return undefined;
}

/** next.config.{js,mjs,ts,cjs} の `output: 'export'`。app / pages の親ディレクトリから root まで探す */
export function readNextOutput(
  root: string,
  dirs: NextDirs,
  warn?: (message: string) => void,
): string | undefined {
  return readNextConfig(root, dirs, warn)?.output;
}
