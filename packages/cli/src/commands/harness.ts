/**
 * build のハーネスの出力（Phase 8-4。docs/19 §3.2・§3.3）: `build --dry-run --json` の JSON、strict の違反と補いの要約、
 * JSON のときにログを標準エラーへ出すロガー。build.ts の外に置き、build.ts の変更を小さくする
 */
import {
  countSupplements,
  formatCoverage,
  supplementText,
  type BuildGraphResult,
  type LogLevel,
  type Logger,
  type StrictResult,
} from '@stack-atlas/core';

/** すべてのログを標準エラーに出すロガー（--json のとき。標準出力は JSON だけにする） */
export function createStderrLogger(opts: { level?: LogLevel } = {}): Logger {
  const order: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };
  const min = order[opts.level ?? 'info'];
  const emit = (level: LogLevel, prefix: string) => (msg: string) => {
    if (order[level] >= min) process.stderr.write(`${prefix}${msg}\n`);
  };
  return {
    debug: emit('debug', '  '),
    info: emit('info', ''),
    warn: emit('warn', '⚠ '),
    error: emit('error', '✗ '),
  };
}

/**
 * 抽出の間、console.log を標準エラーへ向ける（--json のとき。抽出器が直に console.log しても JSON が壊れないように）。
 * 戻す関数を返す
 */
export function redirectConsoleLog(): () => void {
  const orig = console.log;
  console.log = (...args: unknown[]) => console.error(...args);
  return () => {
    console.log = orig;
  };
}

/** build --dry-run --json の標準出力（docs/19 §3.2 の表のキー） */
export function harnessJson(res: BuildGraphResult): Record<string, unknown> {
  const h = res.harness;
  return {
    checked: h?.checked ?? {},
    adapters: h?.adapters ?? { names: [] },
    contracts: h?.contracts ?? { names: [] },
    unjoined: h?.unjoined ?? {
      calls: [],
      endpointsWithoutHandler: [],
      routesWithoutEndpoint: [],
      sql: [],
    },
    undetermined: h?.undetermined ?? [],
    opaque: h?.opaque ?? { boxes: [], crude: [] },
    estimates: h?.estimates ?? [],
    screens: h?.screens ?? { configured: false, routes: [], dropped: [] },
    supplements: h?.supplements ?? [],
    // 段 0 の報告（数える範囲・言語ごとの読めた行・読めていないソース。docs/23 §3.1、Phase 9-L0）
    coverage: h?.coverage ?? null,
    strict: res.strict ?? { errors: [], warnings: [] },
    issues: res.issues,
  };
}

/** 補いと strict の要約（build の要約の後に出す） */
export function formatHarnessSummary(
  res: BuildGraphResult,
  opts: { strict?: boolean; dryRun?: boolean } = {},
): string {
  const lines: string[] = [];
  // 数える範囲と言語ごとの読めた行（docs/23 §3.1）。読めていないソースの行は、strict の一覧を出すときはそこ（警告）に
  // 出るので、ここでは strict の一覧を出さないときだけ出す（1 回だけ）
  if (res.harness?.coverage)
    lines.push(
      ...formatCoverage(res.harness.coverage, { unreadLines: !(opts.strict || opts.dryRun) }),
    );
  const sup = res.harness?.supplements ?? [];
  if (sup.length) {
    const c = countSupplements(sup);
    lines.push(
      `補い: ${sup.length} 件（効いた ${c.applied}、解けない ${c.unresolved}、指紋が合わない ${c.mismatch}${c.noReason ? `、reason の無いもの ${c.noReason}` : ''}）`,
    );
    for (const r of sup) if (r.status !== 'applied') lines.push(`  ${supplementText(r)}`);
  }
  if (opts.strict || opts.dryRun) lines.push(...formatStrict(res.strict));
  if (opts.dryRun)
    lines.push('dry-run: 出力先には何も書いていません（一時ディレクトリに書いて消しました）');
  return lines.join('\n');
}

/** strict の違反の一覧 */
export function formatStrict(strict: StrictResult | undefined): string[] {
  if (!strict) return ['strict: 判定できません（v2 の graph がありません）'];
  const lines = [`strict: エラー ${strict.errors.length} 件、警告 ${strict.warnings.length} 件`];
  for (const e of strict.errors) lines.push(`  [エラー] ${e.rule} ${e.path}: ${e.message}`);
  for (const w of strict.warnings) lines.push(`  [警告] ${w.rule} ${w.path}: ${w.message}`);
  return lines;
}
