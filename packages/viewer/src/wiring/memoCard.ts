// 配線図のメモ（docs/18 §3.4）: 選んだ箱・型のメモを左下の固定の札に出し、その場で書ける。保存の仕組みは 3D の地図と同じ
// （SharedMemoStore: 共有の memos.json ＋ このブラウザの編集を localStorage。`serve --repo` なら「サーバーに保存」で
// POST /api/memos）。題名の横には孤立メモのリンク（`孤立メモ 1 件`。ui/orphans.ts の一覧で移す・消す）
import type { GraphIndex, Selection } from '@stack-atlas/wiring';
import { h } from '../ui/dom';
import {
  downloadMemos,
  memoOf,
  saveMemosToServer,
  UNSUPPORTED_SAVE_MESSAGE,
  type SharedMemoStore,
} from '../ui/memos';
import { OrphanList } from '../ui/orphans';
import { memoBoxIds, memoOrphans, memoTargets, type MemoTarget } from './memoRules';

export interface WiringMemosOptions {
  /** 今の graph の索引（差分の幽霊は入れない） */
  index: GraphIndex;
  store: SharedMemoStore;
  /** `GET /api/memos` が使えたときの API の URL（「サーバーに保存」を出す） */
  apiUrl?: string;
  /** メモのある箱が変わった（角の印を描き直す） */
  onMarksChange: () => void;
}

const sameSet = (a: ReadonlySet<string>, b: ReadonlySet<string>) =>
  a.size === b.size && [...a].every((x) => b.has(x));

/** 札・孤立メモのリンクと一覧 */
export class WiringMemos {
  /** 左下の札 */
  readonly card: HTMLElement;
  /** 題名の横のリンク（孤立メモが無ければ隠す） */
  readonly orphanLink: HTMLButtonElement;
  readonly orphans: OrphanList;
  private readonly entries: HTMLElement;
  private readonly action: HTMLButtonElement;
  private readonly msg: HTMLElement;
  private targets: MemoTarget[] = [];
  private marks: Set<string>;
  private apiUrl: string | undefined;
  private disposed = false;

  constructor(private readonly opts: WiringMemosOptions) {
    this.apiUrl = opts.apiUrl;
    this.marks = memoBoxIds(opts.index, opts.store.all());
    this.entries = h('div', { class: 'wv-memo-entries' });
    this.action = h('button', { class: 'wv-link', attrs: { type: 'button' } });
    this.action.addEventListener('click', () => void this.saveOrExport());
    this.msg = h('span', { class: 'wv-memo-msg' });
    this.card = h(
      'div',
      { class: 'wv-memo', attrs: { role: 'region', 'aria-label': 'メモ' } },
      this.entries,
      h('div', { class: 'wv-memo-foot' }, this.action, this.msg),
    );
    this.card.hidden = true;
    this.setAction();

    this.orphanLink = h('button', {
      class: 'wv-link',
      attrs: { type: 'button', 'data-orphans': '' },
    });
    const targets = [
      ...[...opts.index.nodes.values()].map((n) => ({ id: n.id, name: n.node.name })),
      ...[...opts.index.types.values()].map((t) => ({ id: t.id, name: t.name })),
    ];
    this.orphans = new OrphanList(targets, {
      onDelete: (id) => {
        opts.store.set(id, '');
        this.changed();
      },
      onMove: (from, to) => {
        opts.store.move(from, to);
        this.changed();
        this.refreshEntries();
      },
      onExport: () => downloadMemos(opts.store.all()),
      onClose: () => this.orphans.hide(),
    });
    this.orphanLink.addEventListener('click', () => {
      if (this.orphans.isOpen) this.orphans.hide();
      else this.orphans.show(this.orphanItems());
    });
    this.refreshOrphans();
  }

  /** 角を折る箱 */
  boxIds(): ReadonlySet<string> {
    return this.marks;
  }

  /** 選択が変わった: 札の中身を選び直す（同じメモの並びなら書きかけを残す） */
  show(selection: Selection | null): void {
    const next = memoTargets(this.opts.index, selection, this.opts.store.all());
    const same =
      next.length === this.targets.length && next.every((t, i) => t.id === this.targets[i]!.id);
    this.targets = next;
    this.card.hidden = next.length === 0;
    if (!same) {
      this.msg.textContent = '';
      this.entries.replaceChildren(...next.map((t) => this.entry(t)));
    }
    this.refreshEntries();
  }

  dispose(): void {
    this.disposed = true;
  }

  private entry(t: MemoTarget): HTMLElement {
    const ta = h('textarea', {
      attrs: {
        rows: '4',
        'aria-label': `${t.label} のメモ`,
        placeholder: 'メモを書く（このブラウザに保存）',
        'data-memo-id': t.id,
      },
    });
    ta.value = this.opts.store.get(t.id);
    ta.addEventListener('input', () => {
      this.opts.store.set(t.id, ta.value);
      this.changed();
      this.refreshEntries();
    });
    return h(
      'div',
      { class: `wv-memo-entry ${t.role}`, attrs: { 'data-memo': t.id } },
      h(
        'div',
        { class: 'wv-memo-head' },
        h('span', { class: 'wv-memo-label' }, t.label),
        h('span', { class: 'wv-memo-st' }),
      ),
      ta,
    );
  }

  /** 書いたもの・状態の文字を店（store）に合わせる（焦点のある欄の文字は触らない） */
  private refreshEntries(): void {
    for (const el of this.entries.querySelectorAll<HTMLElement>('.wv-memo-entry')) {
      const id = el.dataset.memo ?? '';
      const ta = el.querySelector('textarea');
      if (ta && document.activeElement !== ta) ta.value = this.opts.store.get(id);
      const st = el.querySelector('.wv-memo-st');
      if (st) st.textContent = this.opts.store.status(id) === 'local' ? '未保存' : '';
    }
  }

  /** メモが変わった: 角の印と孤立メモを数え直す */
  private changed(): void {
    const marks = memoBoxIds(this.opts.index, this.opts.store.all());
    const flip = !sameSet(marks, this.marks);
    this.marks = marks;
    this.refreshOrphans();
    if (flip) this.opts.onMarksChange();
  }

  private orphanItems() {
    const all = this.opts.store.all();
    return memoOrphans(this.opts.index, all).map((id) => ({ id, text: memoOf(all, id) ?? '' }));
  }

  private refreshOrphans(): void {
    const items = this.orphanItems();
    this.orphanLink.hidden = items.length === 0;
    this.orphanLink.textContent = `孤立メモ ${items.length} 件`;
    if (!this.orphans.isOpen) return;
    if (items.length) this.orphans.render(items);
    else this.orphans.hide();
  }

  private setAction(): void {
    this.action.textContent = this.apiUrl ? 'サーバーに保存' : 'memos.json を書き出す';
    this.action.title = this.apiUrl
      ? 'serve --repo で開いているとき、リポジトリの .stack-atlas/memos.json に書き戻す'
      : 'すべてのメモ（共有＋このブラウザの編集）を memos.json としてダウンロード';
  }

  private async saveOrExport(): Promise<void> {
    const store = this.opts.store;
    const url = this.apiUrl;
    if (!url) {
      downloadMemos(store.all());
      return;
    }
    const memos = { ...store.all() };
    this.msg.textContent = '保存中…';
    const r = await saveMemosToServer(url, memos);
    if (this.disposed) return;
    if (r.ok) {
      store.setShared(memos);
      this.msg.textContent = `サーバーに保存しました（${r.count} 件）`;
    } else {
      if (r.unsupported) {
        this.apiUrl = undefined;
        this.setAction();
      }
      this.msg.textContent = r.unsupported ? UNSUPPORTED_SAVE_MESSAGE : r.message;
    }
    this.refreshEntries();
  }
}
