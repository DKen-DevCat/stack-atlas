/**
 * graph.json が読み込まれていないときの案内（ファイル選択・ドロップ・サンプル）と、
 * ページ全体へのドラッグ＆ドロップ受け付け。
 */
import { h } from './dom';

export interface SampleEntry {
  name: string;
  path: string;
}

export function createEmptyState(
  onFile: (f: File) => void,
  opts: { message?: string; samples?: SampleEntry[] } = {},
): HTMLElement {
  const input = h('input', { attrs: { type: 'file', accept: '.json,application/json' } });
  input.addEventListener('change', () => {
    const f = input.files?.[0];
    if (f) onFile(f);
    input.value = '';
  });
  const samples = opts.samples?.length
    ? h(
        'div',
        { class: 'samples' },
        'サンプル: ',
        ...opts.samples.map((s) => {
          const a = h('a', { attrs: { href: `?graph=${encodeURIComponent(s.path)}` } }, s.name);
          return a;
        }),
      )
    : null;
  return h(
    'div',
    { class: 'empty' },
    h(
      'div',
      { class: 'card' },
      h('h1', {}, 'Stack Atlas'),
      h(
        'p',
        {},
        'graph.json を読み込むと、インフラ → 画面 → コンポーネント → 型 を 3D で表示します。',
      ),
      opts.message ? h('p', { class: 'emsg' }, opts.message) : null,
      h('label', { class: 'btn primary filebtn' }, 'graph.json を選ぶ', input),
      h(
        'p',
        { class: 'hint' },
        'ファイルをこの画面にドラッグ＆ドロップしても開けます。URL で開くには ',
        h('code', {}, '?graph=<graph.json の URL>'),
        ' を付けます。',
      ),
      samples,
    ),
  );
}

/** ページ全体で .json のドロップを受け付ける。戻り値で解除 */
export function installDropTarget(onFile: (f: File) => void): () => void {
  const overlay = h(
    'div',
    { class: 'dropover' },
    h('div', {}, 'ここにドロップして graph.json を開く'),
  );
  document.body.append(overlay);
  let depth = 0;
  const hasFiles = (e: DragEvent) =>
    !!e.dataTransfer && [...e.dataTransfer.types].includes('Files');
  const onEnter = (e: DragEvent) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth++;
    overlay.classList.add('on');
  };
  const onOver = (e: DragEvent) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
  };
  const onLeave = () => {
    depth = Math.max(0, depth - 1);
    if (!depth) overlay.classList.remove('on');
  };
  const onDrop = (e: DragEvent) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth = 0;
    overlay.classList.remove('on');
    const f = e.dataTransfer?.files[0];
    if (f) onFile(f);
  };
  window.addEventListener('dragenter', onEnter);
  window.addEventListener('dragover', onOver);
  window.addEventListener('dragleave', onLeave);
  window.addEventListener('drop', onDrop);
  return () => {
    window.removeEventListener('dragenter', onEnter);
    window.removeEventListener('dragover', onOver);
    window.removeEventListener('dragleave', onLeave);
    window.removeEventListener('drop', onDrop);
    overlay.remove();
  };
}
