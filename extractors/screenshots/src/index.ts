/**
 * screenshots 抽出器: Playwright で各 `route:` を開き、ビューポートのスクショと
 * `data-component` 属性の付いた要素の矩形（screen.regions）を取る。
 * 方法は docs/04-extractors.md §6、設定は docs/09-design-phase2-5.md §3.3、使い方は docs/10-screenshots-guide.md。
 */
import { existsSync, mkdirSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import type { Browser, LaunchOptions } from 'playwright';
import type { Extractor, PartialGraph, PartialNode, RepoContext } from '@stack-atlas/core';

export const NAME = 'screenshots';

/** CLI の既定の出力先（graph.json と同じディレクトリ）。config.screenshots.outDir で変える */
export const DEFAULT_OUT_DIR = '.stack-atlas/out';
export const DEFAULT_VIEWPORT = { width: 1280, height: 800 } as const;
export const DEFAULT_TIMEOUT_MS = 15_000;
/** グローバルに入っている Chromium（launch() が失敗したときの代替） */
export const FALLBACK_EXECUTABLE = '/opt/pw-browsers/chromium';

const DYNAMIC_SEGMENT = /^\[{1,2}(\.\.\.)?([^\]]+)\]{1,2}$/;

/** ルートパターンに動的セグメント（`[id]` / `[...slug]` / `[[...slug]]`）があるか */
export function isDynamicRoute(pattern: string): boolean {
  return pattern.split('/').some((s) => DYNAMIC_SEGMENT.test(s));
}

/**
 * ルートパターン → 実際に開く URL パス。
 * - 静的ルートは `[pattern]`
 * - 動的ルートは samples の各要素で動的セグメントを置き換える。
 *   動的セグメントが 1 つならサンプル全体を入れる（catch-all なら `a/b` も可）。
 *   複数なら `/` で区切って順に当てはめ、最後が catch-all なら残りを全部入れる。
 *   `/` で始まるサンプルはそのまま URL パスとして使う。
 * - 動的ルートでサンプルが無いときは `[]`（オプショナル catch-all `[[...x]]` だけなら、それを省いたパス）
 */
export function routeToUrls(pattern: string, samples?: readonly string[]): string[] {
  const segments = pattern.split('/');
  const dynamicIdx = segments.flatMap((s, i) => (DYNAMIC_SEGMENT.test(s) ? [i] : []));
  if (dynamicIdx.length === 0) return [pattern];
  if (!samples || samples.length === 0) {
    const allOptional = dynamicIdx.every((i) => segments[i]!.startsWith('[['));
    if (!allOptional) return [];
    return [segments.filter((_, i) => !dynamicIdx.includes(i)).join('/') || '/'];
  }
  return samples.map((sample) => {
    if (sample.startsWith('/')) return sample;
    const parts = dynamicIdx.length === 1 ? [sample] : sample.split('/');
    const out = [...segments];
    dynamicIdx.forEach((segIdx, n) => {
      const isLast = n === dynamicIdx.length - 1;
      const catchAll = DYNAMIC_SEGMENT.exec(segments[segIdx]!)?.[1] === '...';
      const value = isLast && catchAll ? parts.slice(n).join('/') : (parts[n] ?? '');
      out[segIdx] = value
        .split('/')
        .map((p) => encodeURIComponent(p))
        .join('/');
    });
    return out.join('/').replace(/\/{2,}/g, '/') || '/';
  });
}

/** ルートパターン → スクショのファイル名（拡張子なし）。`/races/[id]` → `races-id`、`/` → `index` */
export function slugify(pattern: string): string {
  const slug = pattern
    .replace(/[[\]]/g, '')
    .replace(/\.\.\./g, '')
    .replace(/[()@]/g, '')
    .replace(/\//g, '-')
    .replace(/[^A-Za-z0-9._-]/g, '_')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'index';
}

/**
 * `data-component` の名前 → ノード ID。`comp:<name>` → `hook:<name>` → `:<name>` で終わる ID の順に探す。
 * 見つからなければ undefined。
 */
export function resolveRegionRef(name: string, nodeIds: Iterable<string>): string | undefined {
  const ids = nodeIds instanceof Set ? (nodeIds as Set<string>) : new Set(nodeIds);
  if (ids.has(name)) return name; // data-component="comp:Foo" のように ID を直接書いた場合
  for (const prefix of ['comp:', 'hook:']) {
    if (ids.has(prefix + name)) return prefix + name;
  }
  for (const id of ids) {
    if (id.endsWith(`:${name}`)) return id;
  }
  return undefined;
}

export interface RawRegion {
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** ビューポートに入る部分だけに切り詰め、整数に丸める。はみ出して面積 0 になるものは捨てる */
export function clipRegion(
  r: RawRegion,
  viewport: { width: number; height: number },
): RawRegion | undefined {
  const x1 = Math.max(0, r.x);
  const y1 = Math.max(0, r.y);
  const x2 = Math.min(viewport.width, r.x + r.w);
  const y2 = Math.min(viewport.height, r.y + r.h);
  if (x2 <= x1 || y2 <= y1) return undefined;
  const x = Math.round(x1);
  const y = Math.round(y1);
  const w = Math.round(x2) - x;
  const h = Math.round(y2) - y;
  if (w <= 0 || h <= 0) return undefined;
  return { name: r.name, x, y, w, h };
}

/** baseUrl とパスを結合する（baseUrl にパスが付いていても壊さない） */
export function joinUrl(baseUrl: string, path: string): string {
  return baseUrl.replace(/\/+$/, '') + (path.startsWith('/') ? path : `/${path}`);
}

async function launchBrowser(ctx: RepoContext): Promise<Browser> {
  const { chromium } = await import('playwright');
  const opts: LaunchOptions = { headless: true };
  try {
    return await chromium.launch(opts);
  } catch (err) {
    if (!existsSync(FALLBACK_EXECUTABLE)) throw err;
    ctx.log.debug(
      `screenshots: chromium.launch() に失敗したので ${FALLBACK_EXECUTABLE} で再試行: ${(err as Error).message.split('\n')[0]}`,
    );
    return chromium.launch({ ...opts, executablePath: FALLBACK_EXECUTABLE });
  }
}

export const extractor: Extractor = {
  name: NAME,

  async detect(ctx) {
    return Boolean(ctx.config.screenshots?.baseUrl);
  },

  async extract(ctx, upstream): Promise<PartialGraph> {
    const cfg = ctx.config.screenshots ?? {};
    const baseUrl = cfg.baseUrl;
    if (!baseUrl) return { nodes: [], edges: [] };

    const viewport = cfg.viewport ?? { ...DEFAULT_VIEWPORT };
    const timeout = (cfg as { timeout?: number }).timeout ?? DEFAULT_TIMEOUT_MS; // config 型に無い拡張キー
    const outDir = resolveOutDir(ctx, cfg.outDir);
    const shotsDir = join(outDir, 'shots');

    const nodeIds = new Set(upstream.nodes.map((n) => n.id));
    const routes = upstream.nodes.filter((n) => n.id.startsWith('route:')).map((n) => n.id);

    // 開く URL を決める
    const targets: Array<{ id: string; pattern: string; url: string }> = [];
    const noSample: string[] = [];
    for (const id of routes) {
      const pattern = id.slice('route:'.length);
      const urls = routeToUrls(pattern, cfg.routes?.[pattern]);
      if (urls.length === 0) {
        noSample.push(pattern);
        continue;
      }
      if (urls.length > 1) {
        ctx.log.info(
          `screenshots: ${pattern} はサンプルが ${urls.length} 件あるが、最初の ${urls[0]} だけ撮る（残り: ${urls.slice(1).join(', ')}）`,
        );
      }
      targets.push({ id, pattern, url: urls[0]! });
    }
    if (noSample.length > 0) {
      ctx.log.warn(
        `screenshots: サンプルパラメータが無い動的ルートを飛ばした（config.screenshots.routes に追加する）: ${noSample.join(', ')}`,
      );
    }
    if (targets.length === 0) return { nodes: [], edges: [] };

    mkdirSync(shotsDir, { recursive: true });
    const storageState = cfg.storageState ? ctx.resolve(cfg.storageState) : undefined;
    const useStorage = storageState !== undefined && existsSync(storageState);
    if (storageState && !useStorage) {
      ctx.log.debug(`screenshots: storageState ${storageState} が無いので未ログインで撮る`);
    }

    const nodes: PartialNode[] = [];
    const browser = await launchBrowser(ctx);
    try {
      const context = await browser.newContext({
        viewport,
        deviceScaleFactor: 1,
        ...(useStorage ? { storageState } : {}),
      });
      const unresolved = new Set<string>();
      for (const t of targets) {
        const page = await context.newPage();
        const href = joinUrl(baseUrl, t.url);
        try {
          const res = await page.goto(href, { waitUntil: 'networkidle', timeout });
          if (res && !res.ok()) {
            ctx.log.warn(`screenshots: ${href} が HTTP ${res.status()} を返した（そのまま撮る）`);
          }
          const slug = slugify(t.pattern);
          await page.screenshot({ path: join(shotsDir, `${slug}.png`), fullPage: false });
          const raw = await page.$$eval('[data-component]', (els) =>
            els.map((el) => {
              const r = el.getBoundingClientRect();
              return {
                name: el.getAttribute('data-component') ?? '',
                x: r.x,
                y: r.y,
                w: r.width,
                h: r.height,
              };
            }),
          );
          const regions: Array<{ ref: string; x: number; y: number; w: number; h: number }> = [];
          for (const r of raw) {
            const clipped = clipRegion(r, viewport);
            if (!clipped || !r.name) continue;
            const ref = resolveRegionRef(r.name, nodeIds);
            if (!ref) {
              unresolved.add(`${r.name} (${t.pattern})`);
              continue;
            }
            regions.push({ ref, x: clipped.x, y: clipped.y, w: clipped.w, h: clipped.h });
          }
          nodes.push({
            id: t.id,
            screen: {
              screenshot: `shots/${slug}.png`,
              width: viewport.width,
              height: viewport.height,
              regions,
            },
          });
        } catch (err) {
          ctx.log.warn(
            `screenshots: ${href} を撮れなかったので飛ばす: ${(err as Error).message.split('\n')[0]}`,
          );
        } finally {
          await page.close().catch(() => {});
        }
      }
      if (unresolved.size > 0) {
        ctx.log.warn(
          `screenshots: ノードに対応しない data-component を無視した: ${[...unresolved].join(', ')}`,
        );
      }
      await context.close();
    } finally {
      await browser.close();
    }
    return { nodes, edges: [] };
  },
};

function resolveOutDir(ctx: RepoContext, outDir: string | undefined): string {
  const dir = outDir ?? DEFAULT_OUT_DIR;
  return isAbsolute(dir) ? dir : resolve(ctx.root, dir);
}

export default extractor;
