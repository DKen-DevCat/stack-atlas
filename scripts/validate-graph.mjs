// packages/schema の CLI（stack-atlas-validate）を呼ぶだけの互換ラッパ。新しい使い方: pnpm validate <graph.json>
// 旧形式 `node scripts/validate-graph.mjs <schema> <graph>` も動く（2 引数なら 1 つ目のスキーマは無視）
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let args = process.argv.slice(2);
if (args.length === 2 && /schema\.json$/.test(args[0])) args = args.slice(1);

const built = resolve(root, 'packages/schema/dist/cli.js');
let cmd;
if (existsSync(built)) {
  cmd = [process.execPath, [built, ...args]];
} else {
  // 未ビルドなら tsx でソースを直接実行する
  const require = createRequire(import.meta.url);
  const tsxCli = require.resolve('tsx/cli', { paths: [root] });
  cmd = [process.execPath, [tsxCli, resolve(root, 'packages/schema/src/cli.ts'), ...args]];
}
const r = spawnSync(cmd[0], cmd[1], { stdio: 'inherit' });
process.exit(r.status ?? 1);
