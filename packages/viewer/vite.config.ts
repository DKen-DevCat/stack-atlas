/// <reference types="vitest/config" />
import { createReadStream, existsSync, statSync } from 'node:fs';
import { dirname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, defaultClientConditions, defaultServerConditions, type Plugin } from 'vite';

// ワークスペース内の @stack-atlas/* はビルド済み dist ではなく src を直接読む（事前ビルド不要にする）
const sourceCondition = '@stack-atlas/source';

const examplesDir = join(dirname(fileURLToPath(import.meta.url)), '../../examples');

/**
 * 開発用: リポジトリの examples/ を /examples/ で配信する（dev / preview のみ。ビルドには入らない）。
 * `?graph=../../examples/race-site.graph.json` のような URL でも開けるようにするため。
 */
function serveExamples(): Plugin {
  const handler = (url: string | undefined): string | null => {
    if (!url) return null;
    const path = decodeURIComponent(url.split('?')[0] ?? '');
    if (!path.startsWith('/examples/')) return null;
    const file = normalize(join(examplesDir, path.slice('/examples/'.length)));
    if (!file.startsWith(examplesDir + sep) || !existsSync(file) || !statSync(file).isFile()) {
      return null;
    }
    return file;
  };
  const mw = (
    req: { url?: string },
    res: { setHeader(k: string, v: string): void } & NodeJS.WritableStream,
    next: () => void,
  ) => {
    const file = handler(req.url);
    if (!file) return next();
    if (file.endsWith('.json')) res.setHeader('Content-Type', 'application/json; charset=utf-8');
    createReadStream(file).pipe(res);
  };
  return {
    name: 'stack-atlas-serve-examples',
    configureServer(server) {
      server.middlewares.use(mw);
    },
    configurePreviewServer(server) {
      server.middlewares.use(mw);
    },
  };
}

export default defineConfig({
  // 相対パスで出力し、dist/ をどのパスに置いても動くようにする（静的配信、docs/08 Q9）
  base: './',
  plugins: [serveExamples()],
  resolve: {
    conditions: [sourceCondition, ...defaultClientConditions],
  },
  ssr: {
    resolve: {
      conditions: [sourceCondition, ...defaultServerConditions],
    },
  },
  build: {
    outDir: 'dist',
    // three.js を同梱するため 500kB を超える
    chunkSizeWarningLimit: 1200,
  },
  test: {
    include: ['src/**/*.test.ts'],
  },
});
