/** 検証結果の一覧（エラーは赤、警告は黄）。閉じられる。問題があっても描画は続ける（D7） */
import type { ValidationIssue } from '@stack-atlas/schema';
import { summarizeIssues } from '../graph/load';
import { h } from './dom';

/** 件数の文言（`エラー 1 件・警告 2 件`）。問題が無ければ空。3D の地図の枠の見出しと配線図のリンク（D64）で使う */
export function issuesLabel(issues: readonly ValidationIssue[]): string {
  const { errors, warnings } = summarizeIssues(issues);
  const parts: string[] = [];
  if (errors) parts.push(`エラー ${errors} 件`);
  if (warnings) parts.push(`警告 ${warnings} 件`);
  return parts.join('・');
}

/** 一覧の行（`エラー` / `警告` の札、path、文）。3D の地図の枠と配線図のリンクの一覧で同じ形 */
export function issuesList(issues: readonly ValidationIssue[]): HTMLUListElement {
  return h(
    'ul',
    {},
    ...issues.map((i) =>
      h(
        'li',
        { class: i.level },
        h('span', { class: 'lv' }, i.level === 'error' ? 'エラー' : '警告'),
        h('code', {}, i.path),
        ' ',
        i.message,
      ),
    ),
  );
}

export function createIssuesBox(
  issues: readonly ValidationIssue[],
  versionWarning: string | undefined,
  rendered: boolean,
): HTMLElement | null {
  if (!issues.length && !versionWarning) return null;
  const { errors } = summarizeIssues(issues);
  const label = issuesLabel(issues);
  const title = label
    ? `graph.json の検証: ${label}${rendered ? '（読める範囲で描画しています）' : ''}`
    : 'graph.json のバージョン警告';
  const close = h('button', { class: 'x', attrs: { type: 'button', 'aria-label': '閉じる' } }, '✕');
  const box = h(
    'div',
    { class: `issues${errors ? ' has-error' : ''}`, attrs: { role: 'alert' } },
    h('div', { class: 'ihead' }, h('strong', {}, title), close),
    versionWarning ? h('div', { class: 'vwarn' }, versionWarning) : null,
    issues.length ? issuesList(issues) : null,
  );
  close.addEventListener('click', () => box.remove());
  return box;
}
