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
import { findAppDir, listRouteFiles, segmentToUrl } from '@stack-atlas/core';

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

/** next.config.{js,mjs,ts,cjs} の `output: 'export'`。app / pages の親ディレクトリから root まで探す */
export function readNextOutput(root: string, dirs: NextDirs): string | undefined {
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
    for (const name of [
      'next.config.ts',
      'next.config.mjs',
      'next.config.js',
      'next.config.cjs',
      'next.config.mts',
    ]) {
      const p = join(root, dir, name);
      if (!existsSync(p)) continue;
      const src = readFileSync(p, 'utf8').replace(/^\s*\/\/.*$/gm, '');
      return /\boutput\s*:\s*["'`](\w+)["'`]/.exec(src)?.[1];
    }
  }
  return undefined;
}
