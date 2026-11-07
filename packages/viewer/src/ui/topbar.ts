/** トップバー: 展開／重ねる、フロー切替（graph.flows から生成）、キャッシュ、視点リセット */
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
}

export interface Topbar {
  el: HTMLElement;
  setFlow(id: string | null): void;
  setCache(on: boolean): void;
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

  const fileInput = h('input', { attrs: { type: 'file', accept: '.json,application/json' } });
  fileInput.addEventListener('change', () => {
    const f = fileInput.files?.[0];
    if (f) o.onOpenFile(f);
    fileInput.value = '';
  });
  const openBtn = h(
    'label',
    { class: 'btn filebtn', title: 'graph.json を開く（ページにドロップしても開けます）' },
    '開く',
    fileInput,
  );

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
    openBtn,
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
  };
}
