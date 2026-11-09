/**
 * 実ブラウザ（Chromium）で、消毒した fixture-poly の画面を確かめる（docs/18 §4「画面」の消毒の側）:
 * 標準モード・script 0・自分以外の origin への通信 0・写した CSS が効く・[data-component] が測れる。
 * 応答ヘッダの CSP は付けずに開く（HTML の側の消毒と meta の CSP だけで足りることを見る。serve のヘッダは cli のテスト）。
 * Chromium が起動できない環境では（skip せず）失敗させる（screenshots の e2e と同じ）。
 */
import { createServer, type Server } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, realpathSync, statSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Browser } from 'playwright';
import type { PartialGraph, RepoContext } from '@stack-atlas/core';
import { extractor } from '../index.js';

const poly = resolve(fileURLToPath(new URL('../../../../examples/fixture-poly', import.meta.url)));
const FALLBACK_EXECUTABLE = '/opt/pw-browsers/chromium';
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
};

function serve(dir: string): Server {
  return createServer((req, res) => {
    const path = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname);
    let file = normalize(join(dir, path));
    if (!file.startsWith(dir)) return void res.writeHead(403).end();
    if (existsSync(file) && statSync(file).isDirectory()) file = join(file, 'index.html');
    if (!existsSync(file)) return void res.writeHead(404).end();
    res.writeHead(200, {
      'content-type': MIME[extname(file)] ?? 'application/octet-stream',
      'x-content-type-options': 'nosniff',
    });
    res.end(readFileSync(file));
  });
}

describe('消毒した画面を Chromium で開く', () => {
  let server: Server;
  let browser: Browser;
  let origin = '';
  const out = realpathSync(mkdtempSync(join(tmpdir(), 'stack-atlas-screens-browser-')));

  beforeAll(async () => {
    const web = join(poly, 'web');
    const ctx: RepoContext = {
      root: web,
      repoName: 'web',
      repos: { web, platform: join(poly, 'platform') },
      configDir: poly,
      config: { screens: { repo: 'web', from: 'dir', dir: 'export', outDir: out } },
      log: { debug() {}, info() {}, warn() {}, error() {} },
      resolve: (...s) => resolve(web, ...s),
    };
    const upstream: PartialGraph = {
      nodes: ['/', '/calendar', '/push'].map((r) => ({
        id: `route:${r}`,
        kind: 'page',
        file: `web/src/app${r}/page.tsx`,
      })),
      edges: [],
    };
    const g = await extractor.extract(ctx, upstream);
    expect(g.nodes).toHaveLength(3);
    server = serve(out);
    await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const { chromium } = await import('playwright');
    try {
      browser = await chromium.launch({ headless: true });
    } catch (e) {
      if (!existsSync(FALLBACK_EXECUTABLE)) throw e;
      browser = await chromium.launch({ headless: true, executablePath: FALLBACK_EXECUTABLE });
    }
  }, 120_000);

  afterAll(async () => {
    await browser?.close();
    await new Promise((r) => server?.close(r));
  });

  it.each(['index', 'calendar', 'push'])(
    'screens/%s/index.html',
    async (slug) => {
      const context = await browser.newContext({
        viewport: { width: 1280, height: 800 },
        javaScriptEnabled: true,
      });
      const page = await context.newPage();
      const requests: string[] = [];
      page.on('request', (r) => requests.push(r.url()));
      const dialogs: string[] = [];
      page.on('dialog', (d) => {
        dialogs.push(d.message());
        void d.dismiss();
      });
      await page.goto(`${origin}/screens/${slug}/index.html`, { waitUntil: 'networkidle' });
      // ページの中で走らせる式（このパッケージの型は DOM を持たないので文字列で渡す）
      const r = (await page.evaluate(`({
      mode: document.compatMode,
      scripts: document.scripts.length,
      first: document.head.firstElementChild ? document.head.firstElementChild.outerHTML : '',
      maxWidth: getComputedStyle(document.querySelector('main')).maxWidth,
      regions: [...document.querySelectorAll('[data-component]')].map((el) => {
        const b = el.getBoundingClientRect();
        return { name: el.getAttribute('data-component'), w: Math.round(b.width), h: Math.round(b.height) };
      }),
    })`)) as {
        mode: string;
        scripts: number;
        first: string;
        maxWidth: string;
        regions: Array<{ name: string | null; w: number; h: number }>;
      };
      expect(r.mode).toBe('CSS1Compat');
      expect(r.scripts).toBe(0);
      expect(r.first).toMatch(
        /^<meta http-equiv="Content-Security-Policy" content="default-src 'none';/,
      );
      expect(r.maxWidth).toBe('960px'); // 写した CSS（_assets/）が style-src 'self' で効いている
      expect(r.regions.length).toBeGreaterThan(0);
      for (const reg of r.regions) expect(reg.w, reg.name ?? '').toBeGreaterThan(0);
      expect(requests.length).toBeGreaterThan(1);
      for (const u of requests) expect(u.startsWith(`${origin}/screens/`), u).toBe(true);
      expect(dialogs).toEqual([]);
      if (slug === 'index') {
        // 「閉じる」（元は onclick）と「詳しく」（元は &#x6A;avascript:）を押しても何も起きない
        await page.click('text=閉じる');
        await page.click('text=詳しく');
        expect(dialogs).toEqual([]);
        expect(page.url()).toBe(`${origin}/screens/index/index.html`);
        expect(r.regions.map((x) => x.name)).toEqual(['TodayIsland']);
        // ロゴの SVG は data: URL（ファイルにしない）。CSP の img-src data: で画像として描ける（decode が失敗すれば例外）
        const logo = (await page.evaluate(`(async () => {
          const img = document.querySelector('img[alt="ロゴ"]');
          await img.decode();
          return [img.getAttribute('src').slice(0, 26), img.naturalWidth];
        })()`)) as [string, number];
        expect(logo).toEqual(['data:image/svg+xml;base64,', 32]);
      }
      await context.close();
    },
    60_000,
  );
});
