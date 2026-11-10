// 名前付きの始点（graph の views）のメニュー（docs/18 §3.4）: 題名の横の select。views が無ければ出さない。
// 選ぶと分岐を既定に戻して view の variants を当て、start から選ぶ（app.ts）。ほかを選んだらメニューは空に戻る
import type { ViewV2 } from '@stack-atlas/schema';
import {
  applyView,
  defaultState,
  findView,
  type GraphIndex,
  type Rect,
  type Selection,
  type VariantState,
  type WiringLayout,
} from '@stack-atlas/wiring';
import { h } from '../ui/dom';

/** 空の選択肢（選んでいない）の文言 */
export const VIEW_PLACEHOLDER = 'ビューを選ぶ…';

export interface ViewOption {
  value: string;
  label: string;
  title?: string;
}

/** select の選択肢: 先頭は空（選んでいない）、続いて views の宣言の順。views が無ければ空 */
export function viewOptions(views: readonly ViewV2[] | undefined): ViewOption[] {
  if (!views?.length) return [];
  return [
    { value: '', label: VIEW_PLACEHOLDER },
    ...views.map((v) => ({
      value: v.id,
      label: v.name,
      ...(v.description ? { title: v.description } : {}),
    })),
  ];
}

/**
 * 選んでいる view（DOM に触らない）。ほかを選んだ・分岐を変えたら外す（メニューは空の選択に戻る）。
 * 変わったときだけ onChange（メニューの表示と URL の ?view= を書き換える）
 */
export class ViewChoice {
  private current: string | null = null;

  constructor(
    private readonly views: readonly ViewV2[] | undefined,
    private readonly onChange: (id: string | null) => void,
  ) {}

  get id(): string | null {
    return this.current;
  }

  /** view を選ぶ。graph に無い id と null は外して undefined */
  pick(id: string | null): ViewV2 | undefined {
    const v = id ? findView(this.views, id) : undefined;
    this.set(v ? v.id : null);
    return v;
  }

  /** ほかを選んだ・分岐を変えた */
  clear(): void {
    this.set(null);
  }

  private set(id: string | null) {
    if (this.current === id) return;
    this.current = id;
    this.onChange(id);
  }
}

/**
 * メニューで選んだ view を当てた分岐の状態と選択。view は分岐を既定に戻して variants を当て、start から選ぶ。
 * 空の選択肢（view 無し）は分岐を既定に戻して選択なし（前の view の分岐を残さない）
 */
export function viewPick(
  index: GraphIndex,
  view: ViewV2 | undefined,
): { state: VariantState; selection: Selection | null } {
  return view ? applyView(index, view) : { state: defaultState(index), selection: null };
}

export interface ViewsMenu {
  el: HTMLSelectElement;
  /** 選んでいる view の id（空の選択なら null） */
  readonly value: string | null;
  /** メニューの表示だけを変える（onPick は呼ばない）。null で空の選択に戻す */
  set(id: string | null): void;
}

/** views のメニュー。ユーザーが選んだら onPick（空の選択を選んだら null） */
export function createViewsMenu(
  views: readonly ViewV2[] | undefined,
  onPick: (id: string | null) => void,
): ViewsMenu {
  const opts = viewOptions(views);
  const el = h(
    'select',
    { class: 'wv-views', attrs: { 'aria-label': 'ビュー（名前付きの始点）' } },
    ...opts.map((o) =>
      h('option', { attrs: { value: o.value }, ...(o.title ? { title: o.title } : {}) }, o.label),
    ),
  );
  el.hidden = opts.length === 0;
  el.addEventListener('change', () => onPick(el.value || null));
  return {
    el,
    get value() {
      return el.value || null;
    },
    set(id) {
      el.value = id && opts.some((o) => o.value === id) ? id : '';
    },
  };
}

/**
 * 選択の始点の位置（?view= で開いた直後に映す所）: 箱はその箱、host の枠はその枠、項目はその箱、線は送る側の箱。
 * 型の横断面と、配置に無いものは null
 */
export function selectionFocus(
  index: GraphIndex,
  layout: WiringLayout,
  sel: Selection | null,
): Rect | null {
  if (!sel) return null;
  switch (sel.kind) {
    case 'box':
      return layout.boxes.get(sel.id) ?? layout.hosts.get(sel.id) ?? null;
    case 'host':
      return layout.hosts.get(sel.id) ?? layout.boxes.get(sel.id) ?? null;
    case 'group': {
      // 地図の group（8-6 のモック）: 中の最初の箱
      const id = sel.members.find((m) => layout.boxes.has(m));
      return id === undefined ? null : (layout.boxes.get(id) ?? null);
    }
    case 'item': {
      const id = index.items.get(sel.ref)?.node.id;
      return id === undefined ? null : (layout.boxes.get(id) ?? null);
    }
    case 'wire': {
      const id = index.items.get(sel.from)?.node.id;
      return id === undefined ? null : (layout.boxes.get(id) ?? null);
    }
    case 'type':
      return null;
  }
}
