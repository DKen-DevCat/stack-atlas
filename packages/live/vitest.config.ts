import { defineConfig } from 'vitest/config';

// ワークスペース内の @stack-atlas/* は dist ではなく src を読む（事前ビルド不要）
export default defineConfig({
  resolve: { conditions: ['@stack-atlas/source'] },
  ssr: { resolve: { conditions: ['@stack-atlas/source'] } },
  test: {
    // 実際のブラウザで確かめるので、「成り立つまで待つ」は長めにする（既定の 1 秒では、操作が閉じる前に諦める）
    expect: { poll: { timeout: 10_000 } },
  },
});
