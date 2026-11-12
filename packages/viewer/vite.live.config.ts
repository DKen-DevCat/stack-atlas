// ライブの画面（docs/27 §4.4）の組み立て。決まった名前のファイル（index.html・live.js・live.css）を dist-live/ に出す。
// 見張り（packages/live）の手元のサーバーは、この名前のファイルだけを配る。読みこみ元を絞るヘッダ（スクリプトと様式は自分の
// 出所だけ）に合うよう、インラインのスクリプトと様式を出さない
import { fileURLToPath } from 'node:url';
import { defineConfig, defaultClientConditions } from 'vite';

export default defineConfig({
  root: fileURLToPath(new URL('./live', import.meta.url)),
  base: './',
  resolve: { conditions: ['@stack-atlas/source', ...defaultClientConditions] },
  build: {
    outDir: fileURLToPath(new URL('./dist-live', import.meta.url)),
    emptyOutDir: true,
    modulePreload: false,
    cssCodeSplit: false,
    assetsInlineLimit: 0,
    rollupOptions: {
      output: {
        entryFileNames: 'live.js',
        chunkFileNames: 'live-[name].js',
        assetFileNames: (info) =>
          (info.names ?? []).some((n) => n.endsWith('.css')) ? 'live.css' : 'live-[name][extname]',
      },
    },
  },
});
