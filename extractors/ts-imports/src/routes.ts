/**
 * App Router のディレクトリ → URL。
 * ★ extractors/nextjs-app/src/routes.ts と同じ実装にしておくこと（route / layout の ID を一致させるため）。
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

export const ROUTE_FILE = /^(page|layout)\.(tsx|ts|jsx|js)$/;

export type SegmentResult = { url: string } | { skip: string };

/**
 * app ディレクトリからの相対ディレクトリ（`races/[id]`、`(shop)/cart` など）を URL にする。
 * - `(group)` は URL から除く
 * - `[id]` / `[...slug]` / `[[...slug]]` はそのまま
 * - `@slot`（パラレルルート）、`(.)x` などのインターセプト、`_private` フォルダは対象外
 */
export function segmentToUrl(relDir: string): SegmentResult {
  const parts = relDir.split(/[\\/]/).filter((p) => p !== '' && p !== '.');
  const out: string[] = [];
  for (const p of parts) {
    if (p.startsWith('@')) return { skip: `parallel route ${p}` };
    if (/^\(\.{1,3}\)/.test(p) || p.startsWith('(..)')) return { skip: `intercepting route ${p}` };
    if (p.startsWith('_')) return { skip: `private folder ${p}` };
    if (/^\(.*\)$/.test(p)) continue;
    out.push(p);
  }
  return { url: '/' + out.join('/') };
}

/** app ディレクトリ（root からの相対パス）を決める。config.next.appDir → apps/*\/app → src/app → app */
export function findAppDir(root: string, configured?: string): string | undefined {
  const hasRouteFile = (dir: string) => {
    try {
      return readdirSync(dir).some((f) => ROUTE_FILE.test(f));
    } catch {
      return false;
    }
  };
  if (configured) return existsSync(join(root, configured)) ? configured : undefined;
  const candidates: string[] = [];
  const apps = join(root, 'apps');
  if (existsSync(apps)) {
    for (const a of readdirSync(apps).sort()) candidates.push(join('apps', a, 'app'));
  }
  candidates.push(join('src', 'app'), 'app');
  return candidates.find((c) => hasRouteFile(join(root, c)));
}

export interface RouteFile {
  /** 絶対パス */
  abs: string;
  /** root からの相対パス（/ 区切り） */
  rel: string;
  kind: 'page' | 'layout';
  url: string;
  /** app ディレクトリからの相対ディレクトリ */
  segment: string;
  id: string;
}

/** app ディレクトリ以下の page / layout を列挙する。skipped は対象外にした理由 */
export function listRouteFiles(
  root: string,
  appDir: string,
): { files: RouteFile[]; skipped: string[] } {
  const files: RouteFile[] = [];
  const skipped: string[] = [];
  const base = join(root, appDir);
  const walk = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      if (name === 'node_modules') continue;
      const p = join(dir, name);
      if (statSync(p).isDirectory()) {
        walk(p);
        continue;
      }
      const m = ROUTE_FILE.exec(name);
      if (!m) continue;
      const segment = relative(base, dir).split(sep).join('/');
      const r = segmentToUrl(segment);
      if ('skip' in r) {
        skipped.push(`${relative(root, p)}: ${r.skip}`);
        continue;
      }
      const kind = m[1] as 'page' | 'layout';
      files.push({
        abs: p,
        rel: relative(root, p).split(sep).join('/'),
        kind,
        url: r.url,
        segment,
        id: `${kind === 'page' ? 'route' : 'layout'}:${r.url}`,
      });
    }
  };
  if (existsSync(base)) walk(base);
  return { files, skipped };
}
