/**
 * 検索（トップバーのテキストボックス。`/` でフォーカス）と kind チップ。
 * - 入力: name / id / file の部分一致（大文字小文字を区別しない）。一致は state.searchMatches に入れ、
 *   見た目は computeVisuals が決める（一致 = sel、それ以外 = dim）
 * - Enter: 一致を順にめぐってカメラを寄せる。Shift+Enter で逆順。Esc でクリア
 * - kind チップ: 存在する kind ごとに 1 つ。クリックで表示／非表示（層チップと同じ扱い）
 */
import type { ModelNode } from '../graph/model';
import { h } from './dom';

export interface SearchableNode {
  id: string;
  name: string;
  file?: string | undefined;
}

/** 検索語を正規化する。空白だけなら ''（= 検索していない） */
export function normalizeQuery(q: string): string {
  return q.trim().toLowerCase();
}

/** name / id / file の部分一致（純関数）。空の検索語なら null（検索なし） */
export function matchNodes(nodes: readonly SearchableNode[], query: string): string[] | null {
  const q = normalizeQuery(query);
  if (!q) return null;
  const out: string[] = [];
  for (const n of nodes) {
    if (
      n.name.toLowerCase().includes(q) ||
      n.id.toLowerCase().includes(q) ||
      (n.file ?? '').toLowerCase().includes(q)
    )
      out.push(n.id);
  }
  return out;
}

/** 件数の表示文言 */
export function countText(matches: readonly string[] | null, cursor = -1): string {
  if (!matches) return '';
  if (matches.length === 0) return '0 件';
  return cursor >= 0 ? `${cursor + 1} / ${matches.length} 件` : `${matches.length} 件`;
}

export interface SearchBoxOptions {
  nodes: readonly SearchableNode[];
  /** 一致が変わった（null = 検索をやめた） */
  onMatches(ids: readonly string[] | null): void;
  /** Enter でめぐるとき: その id に寄せる */
  onJump(id: string): void;
}

export interface SearchBox {
  el: HTMLElement;
  input: HTMLInputElement;
  focus(): void;
  clear(): void;
  readonly matches: readonly string[] | null;
}

export function createSearchBox(o: SearchBoxOptions): SearchBox {
  let matches: string[] | null = null;
  let cursor = -1;
  const input = h('input', {
    class: 'search',
    attrs: {
      type: 'search',
      placeholder: '検索（名前 / id / ファイル）  /',
      'aria-label': 'ノードを検索',
      autocomplete: 'off',
      spellcheck: 'false',
    },
  });
  const count = h('span', { class: 'count' });
  const el = h('div', { class: 'searchbox' }, input, count);

  const update = () => {
    const next = matchNodes(o.nodes, input.value);
    matches = next;
    cursor = -1;
    count.textContent = countText(matches, cursor);
    el.classList.toggle('active', !!matches);
    el.classList.toggle('empty', !!matches && matches.length === 0);
    o.onMatches(matches);
  };
  const clear = () => {
    if (!input.value && !matches) return;
    input.value = '';
    update();
  };
  const step = (dir: 1 | -1) => {
    if (!matches || matches.length === 0) return;
    cursor = (cursor + dir + matches.length) % matches.length;
    count.textContent = countText(matches, cursor);
    o.onJump(matches[cursor]!);
  };
  input.addEventListener('input', update);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      step(e.shiftKey ? -1 : 1);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      clear();
      input.blur();
    }
    e.stopPropagation();
  });
  return {
    el,
    input,
    focus: () => {
      input.focus();
      input.select();
    },
    clear,
    get matches() {
      return matches;
    },
  };
}

/** 存在する kind（出現順）とその色・件数 */
export function kindsOf(
  nodes: readonly ModelNode[],
): { kind: string; color: string; ja: string; count: number }[] {
  const map = new Map<string, { kind: string; color: string; ja: string; count: number }>();
  for (const n of nodes) {
    const k = n.node.kind;
    const cur = map.get(k);
    if (cur) cur.count++;
    else map.set(k, { kind: k, color: n.kind.color, ja: n.kind.ja, count: 1 });
  }
  return [...map.values()];
}

/** kind チップ（層チップの下）。クリックで表示／非表示 */
export function createKindChips(
  nodes: readonly ModelNode[],
  onToggle: (kind: string, visible: boolean) => void,
): HTMLElement {
  const el = h('div', { class: 'kinds', attrs: { 'aria-label': 'kind で絞り込む' } });
  for (const k of kindsOf(nodes)) {
    let visible = true;
    const chip = h(
      'button',
      {
        class: 'kchip',
        title: `${k.ja}（${k.count}）を表示／非表示`,
        attrs: { type: 'button', 'data-kind': k.kind, 'aria-pressed': 'true' },
      },
      h('i', { style: `background:${k.color}` }),
      k.kind,
      h('span', {}, String(k.count)),
    );
    chip.addEventListener('click', () => {
      visible = !visible;
      chip.classList.toggle('off', !visible);
      chip.setAttribute('aria-pressed', String(visible));
      onToggle(k.kind, visible);
    });
    el.append(chip);
  }
  return el;
}
