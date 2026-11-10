/**
 * screens 抽出器: ビルド成果物の HTML（Next の静的エクスポートか任意のディレクトリ）を route ごとに写し、
 * 許可リストで消毒して `<出力先>/screens/<slug>/index.html` に置く。箱の `screen = { html, width, height, source }`。
 * 設計は docs/18 §3.3（D62・D63）。ビューアは sandbox の iframe（allow-scripts 無し）で縮小して描く。
 *
 * - route → HTML: `/` → index.html、`/a` → a.html か a/index.html（trailingSlash なら後者を先に）、動的ルートは
 *   `screens.routes` のサンプル（最初の 1 件）。HTML が無ければ何もしない（プレースホルダのまま）
 * - 消毒（sanitize.ts・css.ts）と資産の写し（assets.ts・fsafe.ts）。落としたものの数と regions のカバー率（coverage.ts）を issues.json に出す
 * - 書き出し先は config.screens.outDir（CLI の build が出力先を入れる。設定ファイルからは書けない）。無ければ何もしない。
 *   そこの screens/ が印の無いディレクトリ（stack-atlas が書いていない）かリンクなら、書かずに警告する（screensDirState）
 * - 1 画面に data: URL で埋め込む SVG は合計 2 MB まで、書き出す HTML は 10 MB まで（assets.ts の DEFAULT_LIMITS）
 */
import { posix } from 'node:path';
import {
  SCREENS_DIR,
  SCREENS_MARKER,
  isMultiRepo,
  screensDirState,
  screensSkipMessage,
  sectionFor,
  type BuildIssue,
  type Extractor,
  type PartialGraph,
  type PartialNode,
} from '@stack-atlas/core';
import { findNextDirs, readNextConfig } from '@stack-atlas/extractor-nextjs-app';
import { routeToUrls, uniqueSlug } from '@stack-atlas/extractor-screenshots';
import { ASSETS_DIR, AssetStore, DEFAULT_LIMITS, toSitePath } from './assets.js';
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

/**
 * route の URL パス（routeToUrls の結果。段は URL エンコード済み）→ 探す HTML のサイトの中のパス。
 * 根（`/`）だけが index.html。サイトの中のパスにできないもの（`/../a`・壊れた `%` エンコード・段の中の `/` `\` NUL）は
 * 空の配列（2026-11-09（8-3b のレビュー）: 以前は index.html を返し、別の画面を写していた）
 */
export function htmlCandidates(urlPath: string, trailingSlash?: boolean): string[] {
  const base = toSitePath(urlPath.startsWith('/') ? urlPath : `/${urlPath}`, '');
  if (base === undefined) return [];
  if (base === '') return ['index.html'];
  const a = `${base}.html`;
  const b = `${base}/index.html`;
  return trailingSlash ? [b, a] : [a, b];
}

// 制御文字の範囲そのものが目的（issues.json と端末に出す前に外す）
// eslint-disable-next-line no-control-regex
const UNPRINTABLE = /[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;

/**
 * issues.json と build の要約（端末）に出す文字列の制御文字（C0・DEL・C1・双方向の上書き）を `\u{1b}` の形にする
 * （2026-11-09（8-3b のレビュー）: タグ名・rel・data-component の値は解析対象の HTML のもので、ESC で端末を操作できた）
 */
export function printable(s: string): string {
  return s.replace(UNPRINTABLE, (c) => `\\u{${c.codePointAt(0)!.toString(16)}}`);
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

/** 1 つの文書の埋め込みの上限（DEFAULT_LIMITS.inline）で入れなかった SVG の参照の info */
export function inlineDroppedIssue(path: string, sitePath: string, dropped: number): Issue {
  return {
    level: 'info',
    path,
    message: `${sitePath} に data: URL で埋め込む SVG が合計 ${DEFAULT_LIMITS.inline / 1024 / 1024} MB を超えるので、${dropped} 件の参照を入れない（写せない資産に数えた）`,
  };
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
    const done = (g: PartialGraph): PartialGraph => ({
      ...g,
      issues: issues.map((i) => ({ ...i, path: printable(i.path), message: printable(i.message) })),
    });
    const state = screensDirState(cfg.outDir);
    if (state === 'foreign' || state === 'link') {
      const message = screensSkipMessage(state);
      issues.push({ level: 'warning', path: 'screens', message });
      ctx.log.warn(`screens: ${message}`);
      return done(empty);
    }
    const from = cfg.from ?? 'next-export';
    const next = readNextConfig(
      ctx.root,
      findNextDirs(ctx.root, sectionFor(ctx, ctx.config.next) ?? {}),
      (m) => issues.push({ level: 'warning', path: 'screens', message: m }),
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
      return done(empty);
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
      ctx.log.warn(printable(`screens: HTML のディレクトリ ${dirRel} ${why}`));
      return done(empty);
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
      const invalid: string[] = [];
      for (const u of urls) {
        const cands = htmlCandidates(u, next?.trailingSlash);
        if (!cands.length) invalid.push(u);
        for (const cand of cands) {
          const f = findSiteFile([exportDir.dir], cand);
          if ('file' in f) {
            found = { file: f.file, sitePath: cand };
            break;
          }
        }
        if (found) break;
      }
      if (!found) {
        if (invalid.length === urls.length) {
          issues.push({
            level: 'warning',
            path: `screens:${pattern}`,
            message: `ルートの URL ${invalid.join(', ')} をサイトの中のパスにできない（\`..\` で根の外に出る・壊れた % エンコードなど）ので、HTML を探しません`,
          });
        } else noHtml.push(pattern);
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
      const budget = store.budget();
      let result: ReturnType<typeof sanitizeHtml>;
      try {
        result = sanitizeHtml(buf.toString('utf8'), {
          url: (raw, kind) => store.verdict(raw, kind, page.sitePath, `../${ASSETS_DIR}/`, budget),
        });
      } catch (e) {
        // 上限で止めきれない大きさ（文字列の長さの上限）。その画面だけ出さない
        if (!(e instanceof RangeError)) throw e;
        issues.push({
          level: 'warning',
          path: `screens:${pattern}`,
          message: `${found.sitePath} の消毒の結果が大きすぎる（${e.message}）ので、画面を出しません`,
        });
        continue;
      }
      if (!result.ok) {
        issues.push({
          level: 'warning',
          path: `screens:${pattern}`,
          message: `${found.sitePath} の ${result.reason}ので、画面を出しません`,
        });
        continue;
      }
      const bytes = Buffer.byteLength(result.html);
      if (bytes > store.outputLimit) {
        issues.push({
          level: 'warning',
          path: `screens:${pattern}`,
          message: `${found.sitePath} の消毒した HTML（${Math.ceil(bytes / 1024 / 1024)} MB）が上限 ${store.outputLimit / 1024 / 1024} MB を超えるので、画面を出しません`,
        });
        continue;
      }
      const slug = uniqueSlug(pattern, slugs);
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
      if (budget.dropped)
        issues.push(inlineDroppedIssue(`screens:${pattern}`, found.sitePath, budget.dropped));
      issues.push(coverageIssue(pattern, computeCoverage(r.id, upstream, result.dataComponents)));
    }
    for (const [sitePath, f] of store.cssFiles) {
      if (f.inlineDropped)
        issues.push(inlineDroppedIssue(`screens:${sitePath}`, sitePath, f.inlineDropped));
      const sum = summarizeStats(f.stats);
      if (!sum) continue;
      issues.push({
        level: sum.warn ? 'warning' : 'info',
        path: `screens:${sitePath}`,
        message: `消毒（CSS。${SCREENS_DIR}/${ASSETS_DIR}/${f.name} に写した）: ${sum.text}${sum.warn ? '。外部・危険な URL は読み込まない（画面に出ない）' : ''}`,
      });
    }
    // SVG は data: URL にして埋め込む（ファイルにしない）。上限を超えたものは画面に入れない（写せない資産に数えてある）
    for (const [sitePath, size] of store.oversized)
      issues.push({
        level: 'info',
        path: `screens:${sitePath}`,
        message: `SVG（${Math.ceil(size / 1024)} KB）が data: URL にする上限 ${DEFAULT_LIMITS.svg / 1024} KB を超えるので、画面に入れない（写せない資産に数えた）`,
      });
    for (const [sitePath, size] of store.oversizedCss)
      issues.push({
        level: 'warning',
        path: `screens:${sitePath}`,
        message: `消毒した CSS（${Math.ceil(size / 1024 / 1024)} MB）が上限 ${store.outputLimit / 1024 / 1024} MB を超えるので、写さない（写せない資産に数えた）`,
      });
    if (nodes.length) {
      out.write(
        [SCREENS_DIR, SCREENS_MARKER],
        'stack-atlas build が書いた画面（screens 抽出器）。次の build はこのディレクトリを消して書き直す\n',
      );
    }
    if (noSample.length)
      ctx.log.info(
        printable(
          `screens: サンプルの無い動的ルート（screens.routes に足す）: ${noSample.join(', ')}`,
        ),
      );
    if (noHtml.length)
      ctx.log.info(
        printable(`screens: HTML の無いルート（プレースホルダのまま）: ${noHtml.join(', ')}`),
      );
    ctx.log.info(
      `screens: ${nodes.length} 画面（資産 ${store.written}、data: URL にした SVG ${store.inlined}）を ${SCREENS_DIR}/ に写した`,
    );
    return done({ nodes, edges: [] });
  },
};

export default extractor;
