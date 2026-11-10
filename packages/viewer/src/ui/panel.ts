/**
 * 詳細パネル: 種類・層、名前、ファイル、［スクショ欄］、［キャッシュ表］、コード抜粋、
 * 使っているもの／使われている場所（チップでその要素へ飛ぶ）、メモ（共有／ローカル未保存の印・書き出し・サーバー保存）、
 * カメラを寄せる。差分表示中は追加・変更の印と変わったフィールド
 */
import type { GraphModel, ModelNode } from '../graph/model';
import { TONE_COLORS } from '../graph/kinds';
import { h } from './dom';
import type { MemoStatus } from './memos';

export interface PanelHandlers {
  onClose(): void;
  onJump(id: string): void;
  onFocus(id: string): void;
  onMemo(id: string, text: string): void;
  onShot(id: string, file: File): void;
  onShotReset(id: string): void;
  /** 「memos.json を書き出す」 */
  onExportMemos(): void;
  /** 「サーバーに保存」（POST /api/memos） */
  onSaveMemos(): void;
}

export interface ScreenInfo {
  /** graph.json の screenshot（そのまま） */
  path?: string;
  /** 'none' | 'loading' | 'loaded' | 'error' */
  state: string;
  overridden: boolean;
  /** 解決できなかった（ファイル読み込み） */
  unresolved: boolean;
}

export class Panel {
  readonly el: HTMLElement;
  private readonly kind = h('div', { class: 'kind' });
  private readonly name = h('h2');
  private readonly file = h('div', { class: 'file' });
  private readonly shot = h('div');
  private readonly shotInfo = h('div', { class: 'src' });
  private readonly cache = h('div');
  private readonly cacheTbl = h('table', { class: 'ct' });
  private readonly code = h('pre');
  private readonly codeTitle = h('h3', {}, 'コード（抜粋）');
  private readonly uses = h('div', { class: 'chips' });
  private readonly used = h('div', { class: 'chips' });
  private readonly memo = h('textarea', {
    attrs: {
      placeholder:
        'ここに気づき・TODO・決定事項を書き込む（このブラウザに保存。共有するには memos.json を書き出すかサーバーに保存）',
    },
  });
  private readonly memoChip = h('span', { class: 'mchip' });
  private readonly saveBtn = h(
    'button',
    { class: 'btn', attrs: { type: 'button' } },
    'サーバーに保存',
  );
  private readonly saveMsg = h('div', { class: 'src msave' });
  private readonly diffInfo = h('div', { class: 'dinfo' });
  private current: ModelNode | null = null;

  constructor(
    private readonly model: GraphModel,
    private readonly handlers: PanelHandlers,
  ) {
    const close = h(
      'button',
      { class: 'x', attrs: { type: 'button', 'aria-label': '閉じる' } },
      '✕',
    );
    close.addEventListener('click', () => handlers.onClose());

    const shotInput = h('input', { attrs: { type: 'file', accept: 'image/*' } });
    shotInput.addEventListener('change', () => {
      const f = shotInput.files?.[0];
      if (f && this.current) handlers.onShot(this.current.id, f);
      shotInput.value = '';
    });
    const shotReset = h('button', { class: 'btn', attrs: { type: 'button' } }, '元に戻す');
    shotReset.addEventListener(
      'click',
      () => this.current && handlers.onShotReset(this.current.id),
    );
    this.shot.append(
      h('h3', {}, 'スクリーンショット'),
      h(
        'div',
        { class: 'row', style: 'margin-top:0' },
        h('label', { class: 'btn shotbtn' }, '画像を差し替え', shotInput),
        shotReset,
      ),
      this.shotInfo,
    );
    this.cache.append(h('h3', {}, '⚡ キャッシュ'), this.cacheTbl);

    this.memo.addEventListener('input', () => {
      if (this.current) handlers.onMemo(this.current.id, this.memo.value);
    });
    const exportBtn = h(
      'button',
      {
        class: 'btn',
        title: 'すべてのメモ（共有＋このブラウザの編集）を memos.json としてダウンロード',
        attrs: { type: 'button' },
      },
      'memos.json を書き出す',
    );
    exportBtn.addEventListener('click', () => handlers.onExportMemos());
    this.saveBtn.title =
      'serve --repo で開いているとき、リポジトリの .stack-atlas/memos.json に書き戻す';
    this.saveBtn.hidden = true;
    this.diffInfo.hidden = true;
    this.saveBtn.addEventListener('click', () => handlers.onSaveMemos());
    const focus = h(
      'button',
      { class: 'btn', attrs: { type: 'button' } },
      'この要素にカメラを寄せる',
    );
    focus.addEventListener('click', () => this.current && handlers.onFocus(this.current.id));

    this.el = h(
      'aside',
      { class: 'panel', attrs: { 'aria-label': '詳細' } },
      h('header', {}, this.kind, this.name, this.file, this.diffInfo, close),
      h(
        'div',
        { class: 'body' },
        this.shot,
        this.cache,
        this.codeTitle,
        this.code,
        h('h3', {}, '使っているもの'),
        this.uses,
        h('h3', {}, '使われている場所'),
        this.used,
        h('h3', { class: 'mhead' }, 'メモ', this.memoChip),
        this.memo,
        h('div', { class: 'row mrow' }, exportBtn, this.saveBtn),
        this.saveMsg,
        h('div', { class: 'row' }, focus),
      ),
    );
  }

  get openId(): string | null {
    return this.current?.id ?? null;
  }

  open(n: ModelNode, memo: string, screen: ScreenInfo | null): void {
    this.current = n;
    const layer = this.model.layers[n.layerIndex];
    this.kind.textContent = `L${n.layerIndex} ${layer?.name ?? ''} · ${n.kind.ja}`;
    this.name.textContent = n.node.name;
    const f = n.node.file;
    this.file.textContent = f ? (n.node.line ? `${f}:${n.node.line}` : f) : '—';

    this.shot.style.display = n.isScreen ? '' : 'none';
    if (screen) this.updateScreenInfo(screen);

    const C = n.node.cache;
    this.cache.style.display = C ? '' : 'none';
    this.cacheTbl.replaceChildren();
    if (C) {
      for (const r of C.rules ?? [])
        this.cacheTbl.append(h('tr', {}, h('td', {}, r.key), h('td', {}, r.value)));
      if (C.note) {
        this.cacheTbl.append(
          h(
            'tr',
            {},
            h('td', { style: `color:${TONE_COLORS[C.tone] ?? TONE_COLORS.info}` }, '⚠'),
            h('td', {}, C.note),
          ),
        );
      }
    }

    const code = n.node.code;
    this.code.textContent = code ?? '';
    this.code.style.display = code ? '' : 'none';
    this.codeTitle.style.display = code ? '' : 'none';

    this.uses.replaceChildren(
      ...this.chips(
        n.out.map((e) => [e.to, e.kind]),
        'd',
      ),
    );
    this.used.replaceChildren(
      ...this.chips(
        n.inn.map((e) => [e.from, e.kind]),
        'u',
      ),
    );
    this.memo.value = memo;
    this.el.classList.add('open');
  }

  /** メモの状態の印: 「共有」「ローカル（未保存）」。メモが無ければ出さない */
  setMemoStatus(st: MemoStatus): void {
    this.memoChip.className = `mchip ${st}`;
    this.memoChip.textContent =
      st === 'shared' ? '共有' : st === 'local' ? 'ローカル（未保存）' : '';
    this.memoChip.title =
      st === 'shared'
        ? 'memos.json（共有）のメモです'
        : st === 'local'
          ? 'このブラウザでの編集です。memos.json を書き出すかサーバーに保存するまで共有されません'
          : '';
  }

  setCanSave(on: boolean): void {
    this.saveBtn.hidden = !on;
  }

  setSaveMessage(text: string, tone: 'ok' | 'error' | '' = ''): void {
    this.saveMsg.textContent = text;
    this.saveMsg.className = `src msave ${tone}`;
  }

  /** 差分の情報（追加・変更）。null なら隠す */
  setDiffInfo(info: { mark: 'added' | 'changed'; text: string } | null): void {
    this.diffInfo.hidden = !info;
    this.diffInfo.className = `dinfo ${info?.mark ?? ''}`;
    this.diffInfo.textContent = info?.text ?? '';
  }

  updateScreenInfo(s: ScreenInfo): void {
    const lines: string[] = [];
    if (s.overridden) lines.push('差し替えた画像を表示中（このブラウザに保存）。');
    if (s.path) {
      const st = s.unresolved
        ? 'ファイルから読み込んだ graph.json では相対パスの画像を表示できません'
        : s.state === 'loaded'
          ? '読み込み済み'
          : s.state === 'error'
            ? '読み込めませんでした'
            : '読み込み中';
      lines.push(`screenshot: ${s.path}（${st}）`);
    } else if (!s.overridden) {
      lines.push(
        'graph.json にスクリーンショットがないため、プレースホルダ（ルート名と領域の枠）を表示しています。',
      );
    }
    lines.push('画像の上に、コンポーネントの領域ハイライトが重なります。');
    this.shotInfo.textContent = lines.join(' ');
  }

  close(): void {
    this.current = null;
    this.el.classList.remove('open');
  }

  private chips(list: [string, string][], cls: 'd' | 'u'): HTMLElement[] {
    if (!list.length) return [h('span', { class: 'none' }, 'なし')];
    return list.map(([id, kind]) => {
      const c = h(
        'span',
        { class: `chip ${cls}`, attrs: { role: 'button', tabindex: '0' } },
        this.model.byId.get(id)?.node.name ?? id,
        h('span', { class: 't' }, kind),
      );
      c.addEventListener('click', () => this.handlers.onJump(id));
      c.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') this.handlers.onJump(id);
      });
      return c;
    });
  }
}
