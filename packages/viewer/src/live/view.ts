/**
 * ライブの画面を描く（docs/27 §4.4）。了承済みの試し（prototype/live/viewer）の見た目と動きを引き継ぐ:
 * 左にアプリ、右に挙動の一覧・経路・再生（部品だけ。文字を出さない）・時間の内訳・画面に反映されたもの。
 * 図とアプリから来た文字は、どれも textContent で入れる（h() は文字を文字として足す）。様式は、要素の様式の値で入れる
 * （ライブの画面の読みこみ元を絞るヘッダが、属性に書いた様式を止めるため）
 */
import type { BehaviorView, LiveRect, LiveShape, MaskedBody, StepView } from '@stack-atlas/wiring';
import { progressAt, routeKey } from '@stack-atlas/wiring';
import { h } from '../ui/dom';
import type { LiveModel, Played } from './model';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const KIND: Record<string, string> = {
  screen: '画面',
  component: '部品',
  fn: '処理',
  endpoint: '受け口',
  table: 'データの置き場',
  external: '外のサービス',
  actor: '利用者',
};
const VIA: Record<string, string> = {
  http: '通信',
  call: '呼ぶ',
  render: '描く',
  props: '渡す',
  return: '返す',
  sql: '問い合わせ',
  event: '知らせ',
  deliver: '届ける',
};
const ms = (v: number) => `${v >= 100 ? Math.round(v) : v >= 10 ? v.toFixed(1) : v.toFixed(2)} ms`;

/** 値を伏せた中身の形を、文字にする（キーの名前と型だけ） */
function shapeText(s: LiveShape, depth = 0): string {
  switch (s.t) {
    case 'string':
      return '文字';
    case 'number':
      return '数';
    case 'boolean':
      return '真偽';
    case 'null':
      return '空';
    case 'array':
      return `[${s.item ? shapeText(s.item, depth + 1) : ''}] × ${s.length}`;
    case 'object': {
      const pad = '  '.repeat(depth + 1);
      const rows = s.keys.map(([k, v]) => `${pad}${k}: ${shapeText(v, depth + 1)}`);
      if (s.more) rows.push(`${pad}…ほかに ${s.more}`);
      return rows.length ? `{\n${rows.join('\n')}\n${'  '.repeat(depth)}}` : '{}';
    }
  }
}
function bodyText(b: MaskedBody | undefined): string {
  if (!b) return '';
  if (b.value !== undefined) return b.value;
  if (b.kind === 'tree') return shapeText(b.shape);
  if (b.kind === 'form') return `欄: ${b.keys.join(', ')}`;
  return `${b.type}（${b.bytes} バイト）`;
}

export class LiveView {
  private selected: Played | undefined;
  /** 一覧から選んだ挙動（操作していないとき） */
  private picked: string | undefined;
  private readonly play = { pos: 0, running: false, speed: 0.2, raf: 0, last: 0 };

  constructor(
    private readonly model: LiveModel,
    private readonly signal: (s: { t: 'reveal' | 'hold'; on: boolean } | { t: 'reload' }) => void,
  ) {
    $('reveal').addEventListener('click', () =>
      this.signal({ t: 'reveal', on: !this.model.status?.reveal }),
    );
    $('hold').addEventListener('click', () =>
      this.signal({ t: 'hold', on: !this.model.status?.hold }),
    );
    $('reload').addEventListener('click', () => this.signal({ t: 'reload' }));
    $('copy').addEventListener('click', () => {
      void navigator.clipboard?.writeText($('lines').textContent ?? '').catch(() => {});
    });
    $<HTMLSelectElement>('screen').addEventListener('change', (e) => {
      const v = (e.target as HTMLSelectElement).value;
      this.model.chosenScreen = v || undefined;
      this.renderChips();
    });
    const seek = $<HTMLInputElement>('p-seek');
    seek.addEventListener('input', () => {
      this.stop();
      this.play.pos = Number(seek.value);
      this.paint();
    });
    const speed = $<HTMLInputElement>('p-speed');
    speed.addEventListener('input', () => (this.play.speed = Number(speed.value)));
    $('p-play').addEventListener('click', () => {
      if (this.play.running) this.stop();
      else
        this.start(
          this.selected && this.play.pos >= this.selected.timeline.total ? 0 : this.play.pos,
        );
    });
  }

  /** 状態（値を見る・止めて見る・アプリの置き方）が変わった */
  status(): void {
    const s = this.model.status;
    if (!s) return;
    $('reveal').setAttribute('aria-pressed', String(s.reveal));
    $('hold').setAttribute('aria-pressed', String(s.hold));
    $<HTMLButtonElement>('hold').disabled = s.holdLocked;
    let app: URL | undefined;
    try {
      app = new URL(s.app);
    } catch {
      app = undefined;
    }
    $('url').textContent = app?.href ?? '';
    const pane = $('app-pane');
    const frame = pane.querySelector('iframe');
    if (s.mode === 'frame' && app && (app.protocol === 'http:' || app.protocol === 'https:')) {
      if (!frame) pane.append(h('iframe', { title: 'アプリ', attrs: { src: app.href } }));
      this.note('');
    } else {
      frame?.remove();
      this.note('アプリは、別の窓で開いています。その窓で操作してください。');
    }
    if (this.selected) this.renderReqs(this.selected);
  }

  /** 図が届いた */
  graph(): void {
    const screens = this.model.screens();
    const select = $<HTMLSelectElement>('screen');
    select.replaceChildren(h('option', { attrs: { value: '' } }, '（すべて）'));
    for (const id of screens) select.append(h('option', { attrs: { value: id } }, id));
    this.renderChips();
  }

  /** 開いた画面が変わった（道具が画面を決められないときは、選ぶ欄を出す） */
  screenChanged(): void {
    $('screens').hidden = this.model.screen !== undefined || this.model.screens().length < 2;
    this.renderChips();
  }

  /** 値が届いた（「値を見る」を入れたとき） */
  valuesArrived(): void {
    if (this.selected) this.renderReqs(this.selected);
  }

  /** 部品の場所が変わった（一覧から挙動を選んでいれば、囲み直す） */
  rects(): void {
    if (this.picked) this.showPicked();
  }

  /** 操作が閉じた。いちばん新しいものを、始めから再生する */
  played(list: Played[]): void {
    const last = list[list.length - 1];
    this.renderHistory();
    if (last) this.select(last, true);
  }

  private note(text: string) {
    $('note').textContent = text;
  }

  private renderChips() {
    const box = $('behaviors');
    box.replaceChildren();
    const list = this.model.behaviors();
    if (!list.length)
      box.append(h('span', { class: 'empty' }, 'この画面の挙動は、図にありません。'));
    for (const b of list) {
      const on = (this.picked ?? this.selected?.choice.behavior) === b.id;
      const btn = h('button', { attrs: { type: 'button', 'aria-pressed': String(on) } }, b.name);
      btn.addEventListener('click', () => this.pick(b.id));
      box.append(btn);
    }
  }

  private renderHistory() {
    const ol = $('history');
    ol.replaceChildren();
    for (const p of [...this.model.played].reverse().slice(0, 20)) {
      const name = p.view?.name ?? '図に無い操作';
      const btn = h(
        'button',
        { attrs: { type: 'button' }, class: p === this.selected ? 'on' : '' },
        `${p.n}. ${name}（${ms(p.timeline.total)}）`,
      );
      btn.addEventListener('click', () => this.select(p, true));
      ol.append(h('li', {}, btn));
    }
  }

  /** 一覧から挙動を選ぶ: 操作していなくても、経路と、始まりの部品の場所を出す */
  private pick(id: string) {
    this.stop();
    this.selected = undefined;
    this.picked = id;
    const view = this.model.view(id);
    $('player').hidden = true;
    this.head(view?.name ?? id, '図のまま', undefined);
    this.renderPath(view, undefined);
    for (const sid of ['sec-lines']) $(sid).hidden = true;
    $('s-times').replaceChildren(
      h('div', { class: 'empty' }, 'この挙動を、左のアプリで操作すると、ここに出ます。'),
    );
    $('s-dom').replaceChildren(h('div', { class: 'empty' }, 'まだありません。'));
    $('s-reqs').replaceChildren(h('div', { class: 'empty' }, 'まだありません。'));
    this.renderChips();
    this.showPicked();
  }

  private showPicked() {
    const overlay = $('overlay');
    overlay.replaceChildren();
    const view = this.picked ? this.model.view(this.picked) : undefined;
    const part = view?.trigger.part;
    const rect = part ? this.model.rects.get(part.id) : undefined;
    if (rect) overlay.append(this.box('part stay', rect));
  }

  private select(p: Played, autoplay: boolean) {
    this.stop();
    this.picked = undefined;
    this.selected = p;
    const v = p.verdict;
    this.head(
      p.view?.name ?? '図に無い操作',
      p.op.closed === 'limit' ? '上限で打ち切り' : undefined,
      v ? (v.ok ? '図と合っている' : '図と食い違い') : p.view ? undefined : '図に無い',
    );
    $('player').hidden = false;
    $<HTMLInputElement>('p-seek').max = String(Math.max(p.timeline.total, 1));
    this.renderPath(p.view, p);
    this.renderSegs(p);
    this.renderTimes(p);
    this.renderDom(p);
    this.renderReqs(p);
    $('sec-lines').hidden = p.lines.length === 0;
    $('lines').textContent = p.lines.join('\n');
    this.renderChips();
    this.renderHistory();
    if (autoplay) this.start(0);
    else this.paint();
  }

  private head(name: string, state: string | undefined, verdict: string | undefined) {
    $('f-name').textContent = name;
    const st = $('f-state');
    st.hidden = state === undefined;
    st.textContent = state ?? '';
    const vt = $('f-verdict');
    vt.hidden = verdict === undefined;
    vt.textContent = verdict ?? '';
    vt.className = `tag ${verdict === '図と合っている' ? 'ok' : verdict ? 'ng' : ''}`;
  }

  // --- 経路 ---
  private renderPath(view: BehaviorView | undefined, p: Played | undefined) {
    const path = $('path');
    path.replaceChildren();
    if (!view) {
      if (p)
        for (const r of p.op.requests)
          path.append(
            h('div', { class: 'row' }, h('div', { class: 'line' }, `${r.method} ${r.path}`)),
          );
      return;
    }
    let lastTo: string | undefined;
    const node = (box: StepView['from'], c: string, depth: number) => {
      const el = h(
        'div',
        { class: 'pnode', attrs: { 'data-c': c, 'data-k': box.kind } },
        h('span', { class: 'kind' }, KIND[box.kind] ?? box.kind),
        h('span', { class: 'nm' }, box.name),
        box.file
          ? h('span', { class: 'src' }, `${box.file}${box.line ? `:${box.line}` : ''}`)
          : null,
      );
      el.style.marginLeft = `${Math.min(depth, 6) * 14}px`;
      return el;
    };
    for (const s of view.steps) {
      if (s.from.id !== lastTo) path.append(node(s.from, `f${s.index}`, s.depth));
      const timing = p?.timings.find((t) => t.index === s.index);
      const hop = h(
        'div',
        {
          class: `hop ${timing?.observed ? '' : 'drawn'} ${timing?.missing ? 'missing' : ''}`,
          attrs: { 'data-c': String(s.index) },
        },
        h(
          'div',
          { class: 'rails' },
          h('span', { class: 'rail go' }),
          s.back.length ? h('span', { class: 'rail back' }) : null,
        ),
        h(
          'div',
          { class: 'lbs' },
          h('span', { class: 'lb go' }, `→ ${s.send.join('、')}`),
          s.back.length ? h('span', { class: 'lb back' }, `← ${s.back.join('、')}`) : null,
          h(
            'span',
            { class: 'how' },
            [
              s.vias.map((x) => VIA[x] ?? x).join('・'),
              s.request ? routeKey(s.request) : '',
              timing?.missing ? '図にあるが、出なかった' : '',
              s.say ?? '',
            ]
              .filter(Boolean)
              .join(' — '),
          ),
        ),
      );
      hop.style.marginLeft = `${Math.min(s.depth, 6) * 14 + 12}px`;
      path.append(hop, node(s.to, `t${s.index}`, s.depth + 1));
      lastTo = s.to.id;
    }
  }

  // --- 再生バー・時間の内訳・画面・通信 ---
  private renderSegs(p: Played) {
    const segs = $('p-segs');
    segs.replaceChildren();
    const total = Math.max(p.timeline.total, 1);
    p.timeline.slices.forEach((s, i) => {
      const seg = h('i', {
        class: `${s.kind === 'wait' ? 'req' : s.kind === 'after' || s.kind === 'local' ? 'dom' : ''} ${i === p.timeline.longest ? 'max' : ''}`,
      });
      seg.style.flexGrow = String(Math.max(s.to - s.from, total / 200));
      segs.append(seg);
    });
  }

  private sliceLabel(p: Played, kind: string, request?: string) {
    if (kind === 'wait') {
      const r = p.op.requests.find((x) => x.id === request);
      return r ? `${r.method} ${r.path} の返事を待つ` : '返事を待つ';
    }
    return (
      {
        before: '押してから、送るまで',
        between: '通信と通信のあいだ',
        after: '返ってから、画面に反映されるまで',
        local: '画面の中だけで済んだ',
      } as Record<string, string>
    )[kind]!;
  }

  private renderTimes(p: Played) {
    const box = $('s-times');
    box.replaceChildren();
    const { slices, longest, total } = p.timeline;
    if (!slices.length) {
      box.append(h('div', { class: 'empty' }, '時間のかかる所は、ありませんでした。'));
      return;
    }
    const max = Math.max(...slices.map((s) => s.to - s.from), 1);
    slices.forEach((s, i) => {
      const bar = h('i');
      bar.style.width = `${((s.to - s.from) / max) * 100}%`;
      box.append(
        h(
          'div',
          {
            class: `trow ${s.kind === 'after' || s.kind === 'local' ? 'dom' : s.kind === 'wait' ? '' : 'gap'} ${i === longest ? 'max' : ''}`,
            attrs: { 'data-i': String(i) },
          },
          h('span', { class: 'lbl' }, this.sliceLabel(p, s.kind, s.request)),
          h('span', { class: 'bar' }, bar),
          h('span', { class: 'ms' }, ms(s.to - s.from)),
        ),
      );
    });
    box.append(h('div', { class: 'total' }, `合計 ${ms(total)}`));
  }

  private renderDom(p: Played) {
    const box = $('s-dom');
    box.replaceChildren();
    if (!p.changes.length) {
      box.append(h('div', { class: 'empty' }, '画面は変わりませんでした。'));
      return;
    }
    const ul = h('ul', { class: 'changes' });
    for (const c of p.changes)
      ul.append(
        h(
          'li',
          { class: c.kind },
          c.kind === 'added'
            ? `増えた: ${c.text}`
            : c.kind === 'removed'
              ? `消えた: ${c.text}`
              : `${c.before} → ${c.text}`,
        ),
      );
    box.append(ul);
  }

  private renderReqs(p: Played) {
    const box = $('s-reqs');
    box.replaceChildren();
    if (!p.op.requests.length) {
      box.append(h('div', { class: 'empty' }, '通信はありませんでした。'));
      return;
    }
    const reveal = this.model.status?.reveal === true;
    for (const r of p.op.requests) {
      const v = reveal ? this.model.values.get(r.id) : undefined;
      const state =
        r.failed === 'held'
          ? '止めた'
          : r.failed === 'outside'
            ? '手元の外なので、つながらない'
            : r.failed === 'error'
              ? '失敗'
              : r.status !== undefined
                ? `${r.status}${r.inBrowser ? '（ブラウザの中で返事）' : ''}`
                : '返事なし';
      const row = h(
        'div',
        { class: 'row' },
        h(
          'div',
          { class: 'line' },
          h('b', {}, r.method),
          h('span', {}, v?.raw ?? r.raw ?? r.path),
          h('span', { class: 'small' }, state),
          r.end !== undefined ? h('span', { class: 'small' }, ms(r.end - r.start)) : null,
        ),
      );
      const sent = v?.sent ?? bodyText(r.sent);
      const got = v?.received ?? bodyText(r.received);
      if (sent) row.append(h('span', { class: 'small' }, '送ったもの'), h('pre', {}, sent));
      if (got) row.append(h('span', { class: 'small' }, '返ったもの'), h('pre', {}, got));
      box.append(row);
    }
    if (!reveal)
      box.append(
        h('div', { class: 'small' }, '値は伏せています。見るときは「値を見る」を入れてください。'),
      );
  }

  // --- 再生 ---
  private box(kind: string, r: LiveRect) {
    const pane = $('overlay').getBoundingClientRect();
    const el = h('div', { class: `box ${kind}` });
    // 場所はアプリが知らせたもの。アプリの枠の中に切りつめる（押せない線だけの枠。守りの部品の上には描かない）
    const x = Math.max(0, Math.min(r.x, pane.width));
    const y = Math.max(0, Math.min(r.y, pane.height));
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
    el.style.width = `${Math.max(0, Math.min(r.w, pane.width - x))}px`;
    el.style.height = `${Math.max(0, Math.min(r.h, pane.height - y))}px`;
    return el;
  }

  private paint() {
    const p = this.selected;
    if (!p) return;
    const pos = this.play.pos;
    const at = progressAt(p.timeline, pos);
    $<HTMLInputElement>('p-seek').value = String(pos);
    const segs = [...$('p-segs').children];
    segs.forEach((s, i) => {
      s.classList.toggle('past', i < at.slice);
      s.classList.toggle('now', i === at.slice);
    });
    for (const row of $('s-times').querySelectorAll<HTMLElement>('.trow')) {
      const i = Number(row.dataset.i);
      row.classList.toggle('done', i < at.slice);
      row.classList.toggle('now', i === at.slice);
    }
    const path = $('path');
    for (const t of p.timings) {
      const hop = path.querySelector(`.hop[data-c="${t.index}"]`);
      const to = path.querySelector(`.pnode[data-c="t${t.index}"]`);
      const from = path.querySelector(`.pnode[data-c="f${t.index}"]`);
      const sent = t.sendAt !== undefined && t.sendAt <= pos;
      const back = t.backAt !== undefined && t.backAt <= pos;
      hop?.classList.toggle('go-on', sent);
      hop?.classList.toggle('back-on', back);
      to?.classList.toggle('lit', sent);
      to?.classList.toggle('drawn', !t.observed);
      to?.classList.toggle('wait', t.observed && sent && !back);
      from?.classList.toggle('lit', sent || pos > 0);
    }
  }

  private flash(p: Played, from: number, to: number) {
    const overlay = $('overlay');
    if (from <= 0 && to >= 0) {
      overlay.replaceChildren();
      const rect = p.op.gestures.find((g) => g.rect)?.rect;
      if (rect) overlay.append(this.box('part on', rect));
    }
    for (const c of p.changes) {
      const t = c.at - p.op.start;
      if (c.rect && t > from && t <= to) overlay.append(this.box('dom on', c.rect));
    }
  }

  private start(pos: number) {
    const p = this.selected;
    if (!p) return;
    this.play.pos = pos;
    this.play.running = true;
    this.play.last = performance.now();
    $('p-play').classList.add('playing');
    this.flash(p, pos - 1, pos);
    const step = (now: number) => {
      if (!this.play.running) return;
      const prev = this.play.pos;
      this.play.pos = Math.min(p.timeline.total, prev + (now - this.play.last) * this.play.speed);
      this.play.last = now;
      this.flash(p, prev, this.play.pos);
      this.paint();
      if (this.play.pos >= p.timeline.total) {
        this.stop();
        (window as unknown as { __stackAtlasLiveReplayed?: number }).__stackAtlasLiveReplayed =
          ((window as unknown as { __stackAtlasLiveReplayed?: number }).__stackAtlasLiveReplayed ??
            0) + 1;
        return;
      }
      this.play.raf = requestAnimationFrame(step);
    };
    this.paint();
    this.play.raf = requestAnimationFrame(step);
  }

  private stop() {
    cancelAnimationFrame(this.play.raf);
    this.play.running = false;
    $('p-play').classList.remove('playing');
  }
}
