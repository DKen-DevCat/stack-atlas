import { validateAnyGraph, type HarnessReportV2 } from '@stack-atlas/schema';
import { readFileSync } from 'node:fs';

export interface ValidateOptions {
  /**
   * graph.json の build の報告（project.generator.report）を読み、strict の違反・報告の無い graph・飛ばした言語アダプタを
   * エラーにする（docs/19 §3.3、D72。CI の関門は build --strict で、これは補助）
   */
  strict?: boolean;
}

/** report の strict の判定（エラーの文。無ければ空） */
export function strictReportErrors(json: unknown): string[] {
  const g = json as { version?: unknown; project?: { generator?: { report?: unknown } } };
  if (g?.version !== 2)
    return ['--strict は graph.json v2 だけを読みます（v1 には build の報告がありません）'];
  const report = g.project?.generator?.report as HarnessReportV2 | undefined;
  if (!report || typeof report !== 'object')
    return [
      'build の報告（project.generator.report）がありません。stack-atlas build で作った graph ではないので、strict を確かめられません',
    ];
  const errors: string[] = [];
  for (const [name, c] of Object.entries(report.checked ?? {}))
    if (c?.status === 'skipped' && c.role === 'language')
      errors.push(
        `言語アダプタ ${name} が飛ばされた graph です（${c.reason ?? '理由なし'}）。検査が弱まっているので strict ではエラー`,
      );
  const n = report.counts?.strictErrors ?? 0;
  if (n > 0) {
    errors.push(`build の strict の違反が ${n} 件あります`);
    for (const e of report.lists?.strictErrors ?? []) errors.push(`  ${e}`);
  }
  return errors;
}

/** `stack-atlas validate [--strict] <graph.json...>`。version 1 / 2 を見て検証器を選ぶ。出力は stack-atlas-validate（@stack-atlas/schema）と同じ */
export function runValidate(
  files: string[],
  out: (line: string) => void = console.log,
  opts: ValidateOptions = {},
): number {
  if (files.length === 0) {
    console.error('使い方: stack-atlas validate [--strict] <graph.json> [<graph.json> ...]');
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
    const strict = opts.strict ? strictReportErrors(json) : [];
    const nErr = issues.filter((e) => e.level === 'error').length;
    const nWarn = issues.length - nErr;
    const pass = ok && strict.length === 0;
    out(
      `${pass ? '✓' : '✗'} ${file}: エラー ${nErr} 件、警告 ${nWarn} 件${opts.strict ? `、strict のエラー ${strict.filter((l) => !l.startsWith('  ')).length} 件` : ''}`,
    );
    for (const e of issues) {
      const tag = e.level === 'error' ? 'エラー' : '警告';
      out(`  [${tag}] ${e.path}: ${e.message}`);
    }
    for (const l of strict) out(l.startsWith('  ') ? `  ${l}` : `  [strict] ${l}`);
    if (!pass) failed = true;
  }
  return failed ? 1 : 0;
}
