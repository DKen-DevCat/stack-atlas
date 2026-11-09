/**
 * end-to-end: examples/fixture-repo/site を静的サーバで配信し、実際に Chromium で撮る。
 * Chromium が起動できない環境では（skip せず）失敗させる。
 */
import { createServer, type Server } from 'node:http';
import { existsSync, readFileSync, rmSync, statSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PartialGraph, PartialNode, RepoContext } from '@stack-atlas/core';
import { extractor } from './index.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixtureRoot = resolve(here, '../../../examples/fixture-repo');
const siteDir = join(fixtureRoot, 'site');
// 以前はクラウドのセッション固有の /tmp パスが直書きされていて、他の環境では書けなかった
const outDir = process.env.STACK_ATLAS_SHOTS_TEST_DIR ?? join(tmpdir(), 'stack-atlas-shots-test');

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

function serve(dir: string): Server {
  return createServer((req, res) => {
    const path = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname);
    let file = normalize(join(dir, path));
    if (!file.startsWith(dir)) {
      res.writeHead(403).end();
      return;
    }
    if (existsSync(file) && statSync(file).isDirectory()) file = join(file, 'index.html');
    if (!existsSync(file)) {
      res.writeHead(404).end('not found');
      return;
    }
    res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
    res.end(readFileSync(file));
  });
}

const ROUTES = ['/', '/races', '/races/[id]', '/admin/entry', '/login'];
const upstream: PartialGraph = {
  nodes: [
    ...ROUTES.map((r): PartialNode => ({ id: `route:${r}`, kind: 'page', name: r })),
    { id: 'layout:/', kind: 'layout', name: 'RootLayout' },
    ...['Header', 'RaceCard', 'Pagination', 'ResultTable', 'EntryForm', 'AuthGuard'].map(
      (c): PartialNode => ({ id: `comp:${c}`, kind: 'component', name: c }),
    ),
    { id: 'hook:useSession', kind: 'hook', name: 'useSession' },
    { id: 'hook:useRaces', kind: 'hook', name: 'useRaces' },
  ],
  edges: [],
};

describe('screenshots extractor (e2e, real Chromium)', () => {
  let server: Server;
  let graph: PartialGraph;
  const warnings: string[] = [];

  beforeAll(async () => {
    rmSync(outDir, { recursive: true, force: true });
    server = serve(siteDir);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address() as AddressInfo;
    const ctx: RepoContext = {
      root: fixtureRoot,
      config: {
        screenshots: {
          baseUrl: `http://127.0.0.1:${port}`,
          viewport: { width: 1280, height: 800 },
          routes: { '/races/[id]': ['42'] },
          storageState: '.stack-atlas/auth.json',
          outDir,
        },
      },
      repoName: 'fixture',
      repos: { fixture: fixtureRoot },
      configDir: fixtureRoot,
      log: { debug() {}, info() {}, warn: (m) => warnings.push(m), error: (m) => warnings.push(m) },
      resolve: (...s) => resolve(fixtureRoot, ...s),
    };
    expect(await extractor.detect(ctx)).toBe(true);
    graph = await extractor.extract(ctx, upstream);
  }, 120_000);

  afterAll(async () => {
    await new Promise((r) => server?.close(r));
  });

  const screen = (route: string) => graph.nodes.find((n) => n.id === `route:${route}`)?.screen;

  it('returns one partial node with screen per route and no edges', () => {
    expect(graph.edges).toEqual([]);
    expect(graph.nodes.map((n) => n.id).sort()).toEqual(ROUTES.map((r) => `route:${r}`).sort());
    for (const n of graph.nodes) {
      expect(Object.keys(n).sort()).toEqual(['id', 'screen']);
    }
    // 2026-11-10 変更（8-4）: CI は STACK_ATLAS_CHROMIUM_NO_SANDBOX=1 で起動するので、その警告だけは許す
    expect(warnings.filter((w) => !w.includes('STACK_ATLAS_CHROMIUM_NO_SANDBOX=1'))).toEqual([]);
  });

  it('writes viewport-sized PNGs at shots/<slug>.png', () => {
    const slugs: Record<string, string> = {
      '/': 'index',
      '/races': 'races',
      '/races/[id]': 'races-id',
      '/admin/entry': 'admin-entry',
      '/login': 'login',
    };
    for (const [route, slug] of Object.entries(slugs)) {
      const s = screen(route)!;
      expect(s.screenshot).toBe(`shots/${slug}.png`);
      expect(s.width).toBe(1280);
      expect(s.height).toBe(800);
      const png = readFileSync(join(outDir, s.screenshot!));
      expect(png.subarray(1, 4).toString()).toBe('PNG');
      expect(png.readUInt32BE(16)).toBe(1280); // IHDR width
      expect(png.readUInt32BE(20)).toBe(800); // IHDR height
    }
  });

  it('maps data-component to comp:/hook: regions', () => {
    const races = screen('/races/[id]')!.regions!;
    const table = races.find((r) => r.ref === 'comp:ResultTable');
    expect(table).toBeDefined();
    expect(table!.w).toBeGreaterThan(0);
    expect(table!.h).toBeGreaterThan(0);
    expect(races.some((r) => r.ref === 'comp:Header')).toBe(true);
    for (const r of races) {
      for (const v of [r.x, r.y, r.w, r.h]) expect(Number.isInteger(v)).toBe(true);
      expect(r.x + r.w).toBeLessThanOrEqual(1280);
      expect(r.y + r.h).toBeLessThanOrEqual(800);
    }
    expect(screen('/login')!.regions!.some((r) => r.ref === 'hook:useSession')).toBe(true);
    console.log('regions /races/[id]:', JSON.stringify(races));
  });
});
