#!/usr/bin/env node
// examples/*.graph.json（と同じ階層の画像フォルダ）を packages/viewer/public/samples/ にコピーする。
// ビューアの dev / build の前に自動で走る（packages/viewer の predev / prebuild / pree2e）。
// public/samples/ は生成物なので Git には入れない（.gitignore）。
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'examples');
const dest = join(root, 'packages/viewer/public/samples');

rmSync(dest, { recursive: true, force: true });
mkdirSync(dest, { recursive: true });

const index = [];
for (const name of readdirSync(src).sort()) {
  const p = join(src, name);
  if (name.endsWith('.graph.json')) {
    cpSync(p, join(dest, name));
    index.push({ name: name.replace(/\.graph\.json$/, ''), path: `samples/${name}` });
  } else if (statSync(p).isDirectory() && /^(shots|screenshots|images)$/.test(name)) {
    // スクショ等のアセット（graph.json からの相対パスで参照されるもの）
    cpSync(p, join(dest, name), { recursive: true });
  }
}
writeFileSync(join(dest, 'index.json'), JSON.stringify(index, null, 2) + '\n');
if (!existsSync(join(dest, 'index.json'))) process.exit(1);
console.log(`[sync-samples] ${index.length} 件を ${dest} にコピーしました`);
