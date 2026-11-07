import { defineConfig, defaultClientConditions, defaultServerConditions } from 'vite';

// ワークスペース内の @stack-atlas/* はビルド済み dist ではなく src を直接読む（事前ビルド不要にする）
const sourceCondition = '@stack-atlas/source';

export default defineConfig({
  // 相対パスで出力し、dist/ をどのパスに置いても動くようにする（静的配信、docs/08 Q9）
  base: './',
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
  },
});
