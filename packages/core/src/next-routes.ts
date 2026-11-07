/**
 * Next.js App Router のディレクトリ → URL と、page / layout の列挙。
 * nextjs-app 抽出器と ts-imports 抽出器が同じノード ID を出すために core に置く。
 *
 * ID の規約:
 * - page は `route:<URL>`。`(group)` は URL から除くので `app/(shop)/cart/page.tsx` → `route:/cart`
 * - layout は `layout:<URL>` だが、`(group)` の中の layout は group を残す
 *   （`app/layout.tsx` → `layout:/`、`app/(shop)/layout.tsx` → `layout:/(shop)`）。
 *   除くと root の layout と同じ ID になり、マージで片方が消えるため
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

export const ROUTE_FILE = /^(page|layout)\.(tsx|ts|jsx|js)$/;

export type SegmentResult = { url: string } | { skip: string };

export interface SegmentToUrlOptions {
  /** `(group)` を URL に残す（layout の ID 用） */
  keepGroups?: boolean;
}

/**
 * app ディレクトリからの相対ディレクトリ（`races/[id]`、`(shop)/cart` など）を URL にする。
 * - `(group)` は URL から除く（keepGroups なら残す）
 * - `[id]` / `[...slug]` / `[[...slug]]` はそのまま
 * - `@slot`（パラレルルート）、`(.)x` などのインターセプト、`_private` フォルダは対象外
 */
export function segmentToUrl(relDir: string, opts: SegmentToUrlOptions = {}): SegmentResult {
  const parts = relDir.split(/[\\/]/).filter((p) => p !== '' && p !== '.');
  const out: string[] = [];
  for (const p of parts) {
    if (p.startsWith('@')) return { skip: `parallel route ${p}` };
    if (/^\(\.{1,3}\)/.test(p) || p.startsWith('(..)')) return { skip: `intercepting route ${p}` };
    if (p.startsWith('_')) return { skip: `private folder ${p}` };
    if (/^\(.*\)$/.test(p) && !opts.keepGroups) continue;
    out.push(p);
  }
  return { url: '/' + out.join('/') };
}

/** route / layout ファイルのノード ID */
export function routeNodeId(kind: 'page' | 'layout', segment: string): string | undefined {
  const r = segmentToUrl(segment, { keepGroups: kind === 'layout' });
  if ('skip' in r) return undefined;
  return `${kind === 'page' ? 'route' : 'layout'}:${r.url}`;
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
  /** 実際の URL（`(group)` は除いたもの） */
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
        id: routeNodeId(kind, segment)!,
      });
    }
  };
  if (existsSync(base)) walk(base);
  return { files, skipped };
}
