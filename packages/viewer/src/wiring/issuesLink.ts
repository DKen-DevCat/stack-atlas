// 検証の一覧（D64）: 配線図では図の上の枠をやめ、題名の横に文字のリンク（`警告 2 件`）を出し、クリックで一覧を開く。
// Esc・外のクリックで閉じる。3D の地図は今のまま（ui/issues.ts の枠）
import type { ValidationIssue } from '@stack-atlas/schema';
import { summarizeIssues } from '../graph/load';
import { h } from '../ui/dom';

/** リンクの文言（`エラー 1 件・警告 2 件`）。問題が無ければ空 */
export function issuesLabel(issues: readonly ValidationIssue[]): string {
  const { errors, warnings } = summarizeIssues(issues);
  const parts: string[] = [];
  if (errors) parts.push(`エラー ${errors} 件`);
  if (warnings) parts.push(`警告 ${warnings} 件`);
  return parts.join('・');
}

export interface IssuesLink {
  /** 題名の横のリンク（問題が無ければ隠す） */
  link: HTMLButtonElement;
  /** 一覧（.wv の中に置く） */
  panel: HTMLElement;
  readonly isOpen: boolean;
  open(): void;
  close(): void;
  dispose(): void;
}

export function createIssuesLink(issues: readonly ValidationIssue[]): IssuesLink {
  const label = issuesLabel(issues);
  const { errors } = summarizeIssues(issues);
  const link = h(
    'button',
    {
      class: `wv-link${errors ? ' error' : ''}`,
      attrs: { type: 'button', 'data-issues': '', 'aria-expanded': 'false' },
    },
    label,
  );
  link.hidden = !label;
  const panel = h(
    'div',
    { class: 'wv-issues', attrs: { role: 'dialog', 'aria-label': 'graph.json の検証' } },
    h(
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
    ),
  );
  panel.hidden = true;

  const setOpen = (on: boolean) => {
    panel.hidden = !on;
    link.setAttribute('aria-expanded', String(on));
  };
  link.addEventListener('click', () => setOpen(panel.hidden !== false));
  // Esc は一覧だけを閉じる（選択の解除まで届かないよう、捕捉の段階で止める）
  const onKey = (ev: KeyboardEvent) => {
    if (ev.key !== 'Escape' || panel.hidden) return;
    setOpen(false);
    ev.stopPropagation();
  };
  // 一覧とリンクの外を押したら閉じる（押したものの操作はそのまま通す）
  const onDown = (ev: PointerEvent) => {
    if (panel.hidden) return;
    const t = ev.target;
    if (t instanceof Node && (panel.contains(t) || link.contains(t))) return;
    setOpen(false);
  };
  window.addEventListener('keydown', onKey, true);
  document.addEventListener('pointerdown', onDown, true);
  return {
    link,
    panel,
    get isOpen() {
      return !panel.hidden;
    },
    open: () => setOpen(true),
    close: () => setOpen(false),
    dispose() {
      window.removeEventListener('keydown', onKey, true);
      document.removeEventListener('pointerdown', onDown, true);
    },
  };
}
