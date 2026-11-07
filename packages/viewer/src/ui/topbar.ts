/**
 * トップバー: 展開／重ねる、フロー切替（graph.flows から生成）、キャッシュ、視点リセット、開く（▾ メニュー）、
 * 差分のピル（?prev= があるとき）、孤立メモ（あるとき）
 */
import type { Flow } from '@stack-atlas/schema';
import { h } from './dom';

export interface TopbarOptions {
  projectName?: string;
  sources?: string[];
  flows: readonly Flow[];
  onExplode(v: number): void;
  onFlow(id: string | null): void;
  onCache(on: boolean): void;
  onReset(): void;
  onOpenFile(file: File): void;
  /** 「前回と比較…」で選んだ graph.json */
  onOpenPrev(file: File): void;
  /** 差分のピルの文言とツールチップ（?prev= が無ければ渡さない） */
  diff?: { text: string; title: string };
  onDiffToggle(on: boolean): void;
  onOrphans(): void;
}

export interface Topbar {
  el: HTMLElement;
  setFlow(id: string | null): void;
  setCache(on: boolean): void;
  /** 孤立メモの件数（0 なら隠す） */
  setOrphanCount(n: number): void;
}

function segment(
  items: { label: string; value: string; cls?: string }[],
  initial: string,
  onChange: (v: string) => void,
): { el: HTMLDivElement; set(v: string): void } {
  const el = h('div', { class: 'seg' });
  const buttons = items.map((it) => {
    const b = h(
      'button',
      { class: it.cls ?? '', attrs: { type: 'button', 'data-v': it.value } },
      it.label,
    );
    b.addEventListener('click', () => {
      set(it.value);
      onChange(it.value);
    });
    el.append(b);
    return b;
  });
  const set = (v: string) => buttons.forEach((b) => b.classList.toggle('on', b.dataset.v === v));
  set(initial);
  return { el, set };
}

export function createTopbar(o: TopbarOptions): Topbar {
  const title = h('h1', {}, 'Stack Atlas', o.projectName ? h('small', {}, o.projectName) : null);
  const explode = segment(
    [
      { label: 'レイヤー展開', value: '1' },
      { label: '重ねる', value: '0' },
    ],
    '1',
    (v) => o.onExplode(Number(v)),
  );
  const flow = segment(
    [
      { label: 'フローなし', value: '' },
      ...o.flows.map((f) => ({
        label: f.name,
        value: f.id,
        cls: f.tone === 'cache-hit' ? 'hit' : '',
      })),
    ],
    '',
    (v) => o.onFlow(v || null),
  );
  flow.el.id = 'flowSeg';
  if (!o.flows.length) flow.el.hidden = true;

  let cacheOn = false;
  const cacheBtn = h('button', { class: 'btn', attrs: { type: 'button' } }, '⚡ キャッシュ');
  cacheBtn.addEventListener('click', () => {
    cacheOn = !cacheOn;
    cacheBtn.classList.toggle('on', cacheOn);
    o.onCache(cacheOn);
  });
  const resetBtn = h('button', { class: 'btn', attrs: { type: 'button' } }, '視点リセット');
  resetBtn.addEventListener('click', () => o.onReset());

  // 「開く ▾」メニュー: graph.json を開く／前回と比較
  const menu = h('div', { class: 'menu', attrs: { role: 'menu' } });
  const openBtn = h(
    'button',
    { class: 'btn', attrs: { type: 'button', 'aria-haspopup': 'menu', 'aria-expanded': 'false' } },
    '開く ▾',
  );
  const openMenu = h('div', { class: 'openmenu' }, openBtn, menu);
  const setMenu = (on: boolean) => {
    openMenu.classList.toggle('open', on);
    openBtn.setAttribute('aria-expanded', String(on));
  };
  openBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    setMenu(!openMenu.classList.contains('open'));
  });
  const onDocClick = (e: MouseEvent) => {
    if (!openMenu.isConnected) return document.removeEventListener('click', onDocClick);
    if (!openMenu.contains(e.target as Node)) setMenu(false);
  };
  document.addEventListener('click', onDocClick);
  const fileItem = (label: string, title: string, onFile: (f: File) => void) => {
    const input = h('input', { attrs: { type: 'file', accept: '.json,application/json' } });
    input.addEventListener('change', () => {
      const f = input.files?.[0];
      setMenu(false);
      if (f) onFile(f);
      input.value = '';
    });
    return h('label', { class: 'mi filebtn', title, attrs: { role: 'menuitem' } }, label, input);
  };
  menu.append(
    fileItem('graph.json を開く…', 'graph.json を開く（ページにドロップしても開けます）', (f) =>
      o.onOpenFile(f),
    ),
    fileItem(
      '前回と比較…',
      '前回の graph.json を選ぶと、追加（緑）・削除（灰）・変更（黄）を色分けします（URL の ?prev= と同じ）',
      (f) => o.onOpenPrev(f),
    ),
  );

  let diffBtn: HTMLButtonElement | null = null;
  if (o.diff) {
    let diffOn = true;
    const b = h(
      'button',
      { class: 'btn diffpill on', title: o.diff.title, attrs: { type: 'button' } },
      o.diff.text,
    );
    b.addEventListener('click', () => {
      diffOn = !diffOn;
      b.classList.toggle('on', diffOn);
      o.onDiffToggle(diffOn);
    });
    diffBtn = b;
  }

  const orphanBtn = h(
    'button',
    {
      class: 'btn orphanbtn',
      title: 'graph.json に無いノード ID のメモ（ID が変わった・ノードが消えた）',
      attrs: { type: 'button' },
    },
    '',
  );
  orphanBtn.hidden = true;
  orphanBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    o.onOrphans();
  });

  const repo = o.sources?.length
    ? h('div', { class: 'repo' }, `source: ${o.sources.join(' · ')}`)
    : null;
  const el = h(
    'div',
    { class: 'top' },
    title,
    explode.el,
    flow.el,
    cacheBtn,
    resetBtn,
    openMenu,
    diffBtn,
    orphanBtn,
    h('div', { class: 'sp' }),
    repo,
  );
  return {
    el,
    setFlow: (id) => flow.set(id ?? ''),
    setCache(on) {
      cacheOn = on;
      cacheBtn.classList.toggle('on', on);
    },
    setOrphanCount(n) {
      orphanBtn.hidden = n <= 0;
      orphanBtn.textContent = `孤立メモ (${n})`;
    },
  };
}
