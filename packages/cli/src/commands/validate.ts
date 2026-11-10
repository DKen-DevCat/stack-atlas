import { validateAnyGraph } from '@stack-atlas/schema';
import { readFileSync } from 'node:fs';

/** `stack-atlas validate <graph.json...>`。version 1 / 2 を見て検証器を選ぶ。出力は stack-atlas-validate（@stack-atlas/schema）と同じ */
export function runValidate(files: string[], out: (line: string) => void = console.log): number {
  if (files.length === 0) {
    console.error('使い方: stack-atlas validate <graph.json> [<graph.json> ...]');
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
    out(`${ok ? '✓' : '✗'} ${file}: エラー ${nErr} 件、警告 ${nWarn} 件`);
    for (const e of issues) {
      const tag = e.level === 'error' ? 'エラー' : '警告';
      out(`  [${tag}] ${e.path}: ${e.message}`);
    }
    if (!ok) failed = true;
  }
  return failed ? 1 : 0;
}
