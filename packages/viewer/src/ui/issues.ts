/** 検証結果の一覧（エラーは赤、警告は黄）。閉じられる。問題があっても描画は続ける（D7） */
import type { ValidationIssue } from '@stack-atlas/schema';
import { summarizeIssues } from '../graph/load';
import { h } from './dom';

export function createIssuesBox(
  issues: readonly ValidationIssue[],
  versionWarning: string | undefined,
  rendered: boolean,
): HTMLElement | null {
  if (!issues.length && !versionWarning) return null;
  const { errors, warnings } = summarizeIssues(issues);
  const parts: string[] = [];
  if (errors) parts.push(`エラー ${errors} 件`);
  if (warnings) parts.push(`警告 ${warnings} 件`);
  const title = parts.length
    ? `graph.json の検証: ${parts.join('・')}${rendered ? '（読める範囲で描画しています）' : ''}`
    : 'graph.json のバージョン警告';
  const close = h('button', { class: 'x', attrs: { type: 'button', 'aria-label': '閉じる' } }, '✕');
  const list = h(
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
  const box = h(
    'div',
    { class: `issues${errors ? ' has-error' : ''}`, attrs: { role: 'alert' } },
    h('div', { class: 'ihead' }, h('strong', {}, title), close),
    versionWarning ? h('div', { class: 'vwarn' }, versionWarning) : null,
    issues.length ? list : null,
  );
  close.addEventListener('click', () => box.remove());
  return box;
}
