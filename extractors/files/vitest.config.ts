import { defineConfig } from 'vitest/config';

// ワークスペース内の @stack-atlas/* は dist ではなく src を読む（事前ビルド不要）
export default defineConfig({
  resolve: { conditions: ['@stack-atlas/source'] },
  ssr: { resolve: { conditions: ['@stack-atlas/source'] } },
});
