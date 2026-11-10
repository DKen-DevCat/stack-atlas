import { existsSync } from 'node:fs';
import { defineConfig, devices } from '@playwright/test';

// 並べて動かす作業ツリーがぶつからないよう、ポートは環境変数で替えられる
const PORT = Number(process.env.STACK_ATLAS_E2E_PORT ?? 4179);
// ローカル環境に同梱の Chromium があればそれを使う（CI では `playwright install` したものを使う）
const bundled = '/opt/pw-browsers/chromium';

export default defineConfig({
  testDir: 'e2e',
  outputDir: 'test-results',
  fullyParallel: false,
  reporter: process.env.CI ? [['list'], ['github']] : 'list',
  timeout: 60_000,
  use: {
    baseURL: `http://localhost:${PORT}/`,
    trace: 'off',
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
    launchOptions: {
      ...(existsSync(bundled) ? { executablePath: bundled } : {}),
      // ヘッドレスでも WebGL（SwiftShader）を使えるようにする
      args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
    },
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1440, height: 900 },
        deviceScaleFactor: 1,
      },
    },
  ],
  webServer: {
    // ビルド（サンプルの同期を含む）してから静的配信する
    command: `pnpm run build && pnpm exec vite preview --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}/`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
