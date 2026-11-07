#!/usr/bin/env node
// stack-atlas-validate <file...> — graph.json をスキーマ＋参照整合性で検証する
import { readFileSync } from 'node:fs';
import { validateAnyGraph } from './validate-v2.js';

function main(argv: string[]): number {
  const files = argv.filter((a) => a !== '--');
  if (files.length === 0) {
    console.error('使い方: stack-atlas-validate <graph.json> [<graph.json> ...]');
    return 2;
  }
  let failed = false;
  for (const file of files) {
    let json: unknown;
    try {
      json = JSON.parse(readFileSync(file, 'utf8'));
    } catch (e) {
      console.error(`✗ ${file}: 読み込みに失敗しました（${(e as Error).message}）`);
      failed = true;
      continue;
    }
    const { ok, issues } = validateAnyGraph(json);
    const nErr = issues.filter((e) => e.level === 'error').length;
    const nWarn = issues.length - nErr;
    console.log(`${ok ? '✓' : '✗'} ${file}: エラー ${nErr} 件、警告 ${nWarn} 件`);
    for (const e of issues) {
      const tag = e.level === 'error' ? 'エラー' : '警告';
      console.log(`  [${tag}] ${e.path}: ${e.message}`);
    }
    if (!ok) failed = true;
  }
  return failed ? 1 : 0;
}

process.exitCode = main(process.argv.slice(2));
