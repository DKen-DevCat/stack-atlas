/**
 * 孤立メモの一覧（memos.json・ローカルのメモのうち、graph.json に無いノード ID のもの）。
 * 1 件ごとに「削除」と「移す…」（ノード ID を datalist から選んでメモを移す）。
 * 変更は呼び出し側（SharedMemoStore）に渡し、ローカル未保存になる。
 */
import { h } from './dom';

export interface OrphanListHandlers {
  onDelete(id: string): void;
  onMove(from: string, to: string): void;
  onExport(): void;
  onClose(): void;
}

export interface OrphanItem {
  id: string;
  text: string;
}

export class OrphanList {
  readonly el: HTMLElement;
  private readonly list = h('ul');
  private readonly count = h('strong');
  private readonly datalistId = `orphan-targets-${Math.random().toString(36).slice(2, 8)}`;

  constructor(
    private readonly nodeIds: readonly { id: string; name: string }[],
    private readonly handlers: OrphanListHandlers,
  ) {
    const close = h(
      'button',
      { class: 'x', attrs: { type: 'button', 'aria-label': '閉じる' } },
      '✕',
    );
    close.addEventListener('click', () => handlers.onClose());
    const datalist = h(
      'datalist',
      { attrs: { id: this.datalistId } },
      ...nodeIds.map((n) => h('option', { attrs: { value: n.id, label: n.name } })),
    );
    const exportBtn = h(
      'button',
      { class: 'btn', attrs: { type: 'button' } },
      'memos.json を書き出す',
    );
    exportBtn.addEventListener('click', () => handlers.onExport());
    this.el = h(
      'div',
      { class: 'orphans', attrs: { role: 'dialog', 'aria-label': '孤立メモ' } },
      h('div', { class: 'ohead' }, this.count, close),
      h(
        'p',
        { class: 'src' },
        'graph.json に無いノード ID のメモです（リネーム・削除で ID が変わった）。今のノードへ移すか、削除してください。変更はこのブラウザに保存され、「memos.json を書き出す」か「サーバーに保存」で共有されます。',
      ),
      this.list,
      h('div', { class: 'row' }, exportBtn),
      datalist,
    );
    this.el.hidden = true;
    this.el.addEventListener('click', (e) => e.stopPropagation());
  }

  get isOpen(): boolean {
    return !this.el.hidden;
  }

  show(items: readonly OrphanItem[]): void {
    this.el.hidden = false;
    this.render(items);
  }

  hide(): void {
    this.el.hidden = true;
  }

  render(items: readonly OrphanItem[]): void {
    this.count.textContent = `孤立メモ (${items.length})`;
    if (!items.length) {
      this.list.replaceChildren(h('li', { class: 'none' }, '孤立メモはありません'));
      return;
    }
    this.list.replaceChildren(...items.map((it) => this.item(it)));
  }

  private item(it: OrphanItem): HTMLLIElement {
    const del = h('button', { class: 'btn', attrs: { type: 'button' } }, '削除');
    del.addEventListener('click', () => this.handlers.onDelete(it.id));
    const moveBtn = h('button', { class: 'btn', attrs: { type: 'button' } }, '移す…');
    const input = h('input', {
      class: 'mv',
      attrs: {
        type: 'text',
        list: this.datalistId,
        placeholder: '移し先のノード ID',
        'aria-label': '移し先のノード ID',
      },
    });
    const go = h('button', { class: 'btn primary', attrs: { type: 'button' } }, '移す');
    const err = h('span', { class: 'err' });
    const moveRow = h('div', { class: 'row moverow' }, input, go, err);
    moveRow.hidden = true;
    moveBtn.addEventListener('click', () => {
      moveRow.hidden = !moveRow.hidden;
      if (!moveRow.hidden) input.focus();
    });
    const submit = () => {
      const to = input.value.trim();
      if (!this.nodeIds.some((n) => n.id === to)) {
        err.textContent = 'graph.json に無い ID です';
        return;
      }
      this.handlers.onMove(it.id, to);
    };
    go.addEventListener('click', submit);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') submit();
    });
    return h(
      'li',
      { attrs: { 'data-id': it.id } },
      h('code', {}, it.id),
      h('div', { class: 'otext' }, it.text),
      h('div', { class: 'row' }, moveBtn, del),
      moveRow,
    );
  }
}
