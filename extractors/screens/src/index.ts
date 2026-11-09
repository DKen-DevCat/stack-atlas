/**
 * screens 抽出器: ビルド成果物の HTML（Next の静的エクスポートか任意のディレクトリ）を route ごとに写し、
 * 許可リストで消毒して `<出力先>/screens/<slug>/index.html` に置く。箱の `screen = { html, width, height, source }`。
 * 設計は docs/18 §3.3（D62・D63）。ビューアは sandbox の iframe（allow-scripts 無し）で縮小して描く。
 *
 * - route → HTML: `/` → index.html、`/a` → a.html か a/index.html（trailingSlash なら後者を先に）、動的ルートは
 *   `screens.routes` のサンプル（最初の 1 件）。HTML が無ければ何もしない（プレースホルダのまま）
 * - 消毒（sanitize.ts・css.ts）と資産の写し（assets.ts・fsafe.ts）。落としたものの数と regions のカバー率（coverage.ts）を issues.json に出す
 * - 書き出し先は config.screens.outDir（CLI の build が出力先を入れる。設定ファイルからは書けない）。無ければ何もしない
 */
import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import {
  SCREENS_DIR,
  SCREENS_MARKER,
  isMultiRepo,
  sectionFor,
  type BuildIssue,
  type Extractor,
  type PartialGraph,
  type PartialNode,
} from '@stack-atlas/core';
import { findNextDirs, readNextConfig } from '@stack-atlas/extractor-nextjs-app';
import { routeToUrls, slugify } from '@stack-atlas/extractor-screenshots';
import { ASSETS_DIR, AssetStore, toSitePath } from './assets.js';
import { computeCoverage, type Coverage } from './coverage.js';
import { confineDir, findSiteFile, readNoFollow, SafeOutput } from './fsafe.js';
import { sanitizeHtml, type SanitizeStats } from './sanitize.js';

export { sanitizeHtml, SCREEN_CSP, type SanitizeStats } from './sanitize.js';
export { sanitizeStylesheet, sanitizeDeclarations } from './css.js';
export { computeCoverage, type Coverage } from './coverage.js';
export { AssetStore, toSitePath } from './assets.js';
export { classifyUrl } from './urls.js';

export const NAME = 'screens';
export const DEFAULT_VIEWPORT = { width: 1280, height: 800 } as const;
export const MAX_HTML_BYTES = 10 * 1024 * 1024;

type Issue = BuildIssue & { level: 'warning' | 'info' };

/** route の URL パス（routeToUrls の結果。段は URL エンコード済み）→ 探す HTML のサイトの中のパス */
export function htmlCandidates(urlPath: string, trailingSlash?: boolean): string[] {
  const base = toSitePath(urlPath.startsWith('/') ? urlPath : `/${urlPath}`, '');
  if (!base) return ['index.html'];
  const a = `${base}.html`;
  const b = `${base}/index.html`;
  return trailingSlash ? [b, a] : [a, b];
}

/** 画面の出力先の名前（screenshots と同じ slugify。英数字で始まらないものと衝突はハッシュで分ける） */
export function screenSlug(pattern: string, used: Map<string, string>): string {
  const h = (n: number) => createHash('sha1').update(pattern).digest('hex').slice(0, n);
  let base = slugify(pattern);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(base) || base.length > 100) base = `r-${h(8)}`;
  const owner = used.get(base);
  if (owner === undefined || owner === pattern) {
    used.set(base, pattern);
    return base;
  }
  const slug = `${base}-${h(6)}`;
  used.set(slug, pattern);
  return slug;
}

/** 消毒で落としたものの要約。何も落としていなければ undefined */
export function summarizeStats(s: SanitizeStats): { text: string; warn: boolean } | undefined {
  const parts: string[] = [];
  const els = Object.entries(s.elements).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  if (els.length) parts.push(`落とした要素 ${els.map(([k, v]) => `${k} ${v}`).join('・')}`);
  if (s.handlers) parts.push(`on* 属性 ${s.handlers}`);
  if (s.external) parts.push(`外部 URL ${s.external}`);
  if (s.unsafe) parts.push(`危険な URL ${s.unsafe}`);
  if (s.missing) parts.push(`写せない資産 ${s.missing}`);
  if (s.css.imports) parts.push(`CSS の @import ${s.css.imports}`);
  if (s.css.imageSets) parts.push(`image-set() などの宣言 ${s.css.imageSets}`);
  if (s.css.urlDrops) parts.push(`url() で落とした CSS の宣言・規則 ${s.css.urlDrops}`);
  if (s.css.other) parts.push(`壊れた・許可しない CSS ${s.css.other}`);
  if (!parts.length) return undefined;
  return { text: parts.join('、'), warn: s.external + s.unsafe + s.css.imports > 0 };
}

/** カバー率の issue（0 なら警告） */
export function coverageIssue(pattern: string, c: Coverage): Issue {
  const path = `screens:${pattern}`;
  const total = c.reachable.length;
  const extra = [
    c.absent.length ? `HTML に無い部品: ${c.absent.join(', ')}` : '',
    c.unresolved.length ? `箱に解けない data-component: ${c.unresolved.join(', ')}` : '',
  ].filter(Boolean);
  if (total === 0)
    return {
      level: 'info',
      path,
      message: `regions のカバー率: この画面から uses でたどれる部品がありません${extra.length ? `（${extra.join('。')}）` : ''}`,
    };
  if (c.covered.length === 0)
    return {
      level: 'warning',
      path,
      message:
        `regions が取れません（data-component で解けた部品 0 / たどれる部品 ${total}）。` +
        `部品のルート要素に data-component を付けてください（docs/10）${extra.length ? `。${extra.join('。')}` : ''}`,
    };
  const pct = Math.round((c.covered.length / total) * 100);
  return {
    level: 'info',
    path,
    message: `regions のカバー率 ${c.covered.length}/${total}（${pct}%）${extra.length ? `。${extra.join('。')}` : ''}`,
  };
}

export const extractor: Extractor = {
  name: NAME,

  async detect(ctx) {
    return Boolean(sectionFor(ctx, ctx.config.screens));
  },

  async extract(ctx, upstream): Promise<PartialGraph> {
    const empty: PartialGraph = { nodes: [], edges: [] };
    const cfg = sectionFor(ctx, ctx.config.screens);
    if (!cfg) return empty;
    if (!cfg.outDir) {
      ctx.log.debug('screens: 書き出し先（build の出力先）が無いので画面を写さない');
      return empty;
    }
    const issues: Issue[] = [];
    const from = cfg.from ?? 'next-export';
    const next = readNextConfig(
      ctx.root,
      findNextDirs(ctx.root, sectionFor(ctx, ctx.config.next) ?? {}),
    );
    if (from === 'next-export' && next?.output && next.output !== 'export') {
      ctx.log.warn(
        `screens: ${next.file} の output が "${next.output}"（export でない）。静的エクスポートの HTML が無ければ screens.from: dir で HTML のディレクトリを指す`,
      );
    }
    const dirRel =
      from === 'dir' ? cfg.dir : (cfg.dir ?? posix.join(next?.dir ?? '.', next?.distDir ?? 'out'));
    if (!dirRel) {
      issues.push({
        level: 'warning',
        path: 'screens',
        message: 'screens.from が dir のときは screens.dir が要ります',
      });
      return { ...empty, issues };
    }
    const exportDir = confineDir(ctx.root, dirRel);
    if (!('dir' in exportDir)) {
      const why =
        exportDir.why === 'outside'
          ? `が repo（${ctx.repoName}）の外を指すので読みません`
          : `がありません（${from === 'next-export' ? 'next build で静的エクスポートを作る' : 'HTML を置く'}）`;
      issues.push({
        level: 'warning',
        path: 'screens',
        message: `HTML のディレクトリ ${dirRel} ${why}`,
      });
      ctx.log.warn(`screens: HTML のディレクトリ ${dirRel} ${why}`);
      return { ...empty, issues };
    }
    const roots = [exportDir.dir];
    const pubRel =
      cfg.publicDir ??
      (from === 'next-export' ? posix.join(next?.dir ?? '.', 'public') : undefined);
    if (pubRel) {
      const pub = confineDir(ctx.root, pubRel);
      if ('dir' in pub) roots.push(pub.dir);
      else if (cfg.publicDir)
        issues.push({
          level: 'warning',
          path: 'screens',
          message: `screens.publicDir ${pubRel} を読めません（${pub.why}）`,
        });
    }

    const out = new SafeOutput(cfg.outDir);
    const store = new AssetStore({
      roots,
      out,
      dir: SCREENS_DIR,
      ...(next?.basePath ? { basePath: next.basePath } : {}),
      ...(next?.assetPrefix ? { assetPrefix: next.assetPrefix } : {}),
    });
    const viewport = cfg.viewport ?? { ...DEFAULT_VIEWPORT };
    const source = from === 'dir' ? ('dir' as const) : ('next-export' as const);
    const multi = isMultiRepo(ctx);
    const routes = upstream.nodes.filter(
      (n) =>
        n.id.startsWith('route:') && (!multi || !n.file || n.file.startsWith(`${ctx.repoName}/`)),
    );

    const nodes: PartialNode[] = [];
    const slugs = new Map<string, string>();
    const noSample: string[] = [];
    const noHtml: string[] = [];
    for (const r of routes) {
      const pattern = r.id.slice('route:'.length);
      const urls = routeToUrls(pattern, cfg.routes?.[pattern]);
      if (!urls.length) {
        noSample.push(pattern);
        continue;
      }
      let found: { file: string; sitePath: string } | undefined;
      for (const u of urls) {
        for (const cand of htmlCandidates(u, next?.trailingSlash)) {
          const f = findSiteFile([exportDir.dir], cand);
          if ('file' in f) {
            found = { file: f.file, sitePath: cand };
            break;
          }
        }
        if (found) break;
      }
      if (!found) {
        noHtml.push(pattern);
        continue;
      }
      const buf = readNoFollow(found.file, MAX_HTML_BYTES);
      if (!buf) {
        issues.push({
          level: 'warning',
          path: `screens:${pattern}`,
          message: `${found.sitePath} を読めません（${MAX_HTML_BYTES / 1024 / 1024}MB を超える・普通のファイルでない）`,
        });
        continue;
      }
      const page = found;
      const result = sanitizeHtml(buf.toString('utf8'), {
        url: (raw, kind) => store.verdict(raw, kind, page.sitePath, `../${ASSETS_DIR}/`),
      });
      if (!result.ok) {
        issues.push({
          level: 'warning',
          path: `screens:${pattern}`,
          message: `${found.sitePath} の ${result.reason}ので、画面を出しません`,
        });
        continue;
      }
      const slug = screenSlug(pattern, slugs);
      out.write([SCREENS_DIR, slug, 'index.html'], result.html);
      nodes.push({
        id: r.id,
        screen: {
          html: `${SCREENS_DIR}/${slug}/index.html`,
          width: viewport.width,
          height: viewport.height,
          source,
        },
      });
      // 写した CSS ファイルで落としたものは、ファイルごとに 1 回だけ出す（下）
      const sum = summarizeStats(result.stats);
      if (sum)
        issues.push({
          level: sum.warn ? 'warning' : 'info',
          path: `screens:${pattern}`,
          message: `消毒（${found.sitePath}）: ${sum.text}${sum.warn ? '。外部・危険な URL は読み込まない（画面に出ない）' : ''}`,
        });
      issues.push(coverageIssue(pattern, computeCoverage(r.id, upstream, result.dataComponents)));
    }
    for (const [sitePath, f] of store.cssFiles) {
      const sum = summarizeStats(f.stats);
      if (!sum) continue;
      issues.push({
        level: sum.warn ? 'warning' : 'info',
        path: `screens:${sitePath}`,
        message: `消毒（CSS。${SCREENS_DIR}/${ASSETS_DIR}/${f.name} に写した）: ${sum.text}${sum.warn ? '。外部・危険な URL は読み込まない（画面に出ない）' : ''}`,
      });
    }
    if (nodes.length) {
      out.write(
        [SCREENS_DIR, SCREENS_MARKER],
        'stack-atlas build が書いた画面（screens 抽出器）。次の build はこのディレクトリを消して書き直す\n',
      );
    }
    if (noSample.length)
      ctx.log.info(
        `screens: サンプルの無い動的ルート（screens.routes に足す）: ${noSample.join(', ')}`,
      );
    if (noHtml.length)
      ctx.log.info(`screens: HTML の無いルート（プレースホルダのまま）: ${noHtml.join(', ')}`);
    ctx.log.info(
      `screens: ${nodes.length} 画面（資産 ${store.written}）を ${SCREENS_DIR}/ に写した`,
    );
    return { nodes, edges: [], issues };
  },
};

export default extractor;
