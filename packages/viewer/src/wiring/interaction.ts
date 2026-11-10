// 操作（docs/15 §3.5・§3.6）: クリックで選ぶ（型 → 項目 → 光っている線 → 箱 → 枠 → 空白の順に見る）、Esc で解く
// （文字を打つ欄の中では欄から焦点を外すだけ）、`F` キーで全体表示（docs/18 §3.2。画面に文字は出さない）。
// hover は何も選んでいないときだけ箱とその線を少し明るくする（選択中は hover が効かない）。分岐の表だけは選択中でも出る。
// hover の class を付け外すのは場面の DOM（sceneView.ts）。ここはポインタがどの箱の上にいるかを知らせるだけ（docs/18 §11.3）
import type { Selection } from '@stack-atlas/wiring';
import { createTableHover } from './tableHover';

export interface InteractionDeps {
  svg: SVGSVGElement;
  /** いま選んでいるか */
  selected: () => boolean;
  /** 箱が光っているか */
  isLitBox: (id: string) => boolean;
  /** 線のキー → 線の from / to */
  wireEnds: (key: string) => { from: string; to: string } | null;
  select: (sel: Selection | null) => void;
  /**
   * ポインタが箱の上に来た（id）・箱の外へ出た（null）。選択中も呼ぶ（明るくするかは受ける側が決める。要素を作り直さなく
   * なったので、解除したときにポインタの下の箱を出し直せるよう、最後に入った箱を受ける側が覚える）
   */
  hover: (boxId: string | null) => void;
  /** 直前の操作がドラッグだったか（クリックにしない） */
  consumeDrag: () => boolean;
  /** 分岐の表 */
  hasVariants: (id: string) => boolean;
  tableNode: () => string | null;
  showTable: (id: string) => void;
  hideTable: () => void;
  /** 全体が収まる倍率にする（`F` キー） */
  fitAll: () => void;
  /** キー（Esc・F）を受けるか。2 面のときは最後に触った面だけ（docs/20 §5.1 #8）。省略時は常に受ける */
  keys?: () => boolean;
}

type KeyTarget = { tagName?: string; isContentEditable?: boolean; type?: string } | null;

/**
 * 文字を打つ欄か: textarea・contenteditable・文字の input（メモの札・孤立メモの移し先など）。
 * チェックボックス・範囲のスライダー・ボタンは含めない（焦点があってもキーの操作は効かせる）
 */
export function isTextEntry(target: EventTarget | null): boolean {
  const t = target as KeyTarget;
  const tag = t?.tagName?.toLowerCase();
  if (t?.isContentEditable || tag === 'textarea') return true;
  if (tag === 'input') return !['checkbox', 'range', 'button', 'radio'].includes(t?.type ?? 'text');
  return false;
}

/** `F` キーを全体表示にするか（修飾キー付き・入力欄の中・IME の変換中は除く。⌘F のページ内検索を奪わない） */
export function isFitKey(ev: {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  isComposing?: boolean;
  target: EventTarget | null;
}): boolean {
  if (ev.key !== 'f' && ev.key !== 'F') return false;
  if (ev.ctrlKey || ev.metaKey || ev.altKey || ev.isComposing) return false;
  // select も除く（文字を打つと選択肢へ飛ぶ。views のメニュー）
  return !isTextEntry(ev.target) && (ev.target as KeyTarget)?.tagName?.toLowerCase() !== 'select';
}

/**
 * Esc で何をするか（isFitKey と同じ文字を打つ欄の規則）: 文字を打つ欄の中は欄から焦点を外すだけ（'blur'。選択は解かない）、
 * IME の変換中は何もしない（Esc は変換の取り消し）、それ以外は選択を解く（'clear'）。Esc でなければ null。
 * 閉じた select（views のメニュー）は Esc に意味が無いので選択を解く（開いた一覧の Esc はブラウザが受ける）
 */
export function escapeAction(ev: {
  key: string;
  isComposing?: boolean;
  target: EventTarget | null;
}): 'clear' | 'blur' | null {
  if (ev.key !== 'Escape' || ev.isComposing) return null;
  return isTextEntry(ev.target) ? 'blur' : 'clear';
}

/** 分岐の表と、箱との間の透明な橋 */
export const TABLE = '.vtable-fo, .vtable-bridge';

export function installInteraction(d: InteractionDeps): () => void {
  const { svg } = d;
  // 分岐の表: 箱に入ったら出す、箱からも表からも離れたら少し待って消す（箱 → 表へ動かす間の隙間で消さない）
  const tableHover = createTableHover({
    hasVariants: d.hasVariants,
    tableNode: d.tableNode,
    showTable: d.showTable,
    hideTable: d.hideTable,
  });
  const closest = (t: EventTarget | null, sel: string) =>
    t instanceof Element ? (t.closest(sel) as HTMLElement | SVGElement | null) : null;

  const onClick = (ev: MouseEvent) => {
    if (d.consumeDrag()) return; // ドラッグの終わりはクリックにしない
    const t = ev.target;
    if (closest(t, TABLE)) return; // 分岐の表（と箱との間の橋）の上のクリックは選択にしない
    const typeEl = closest(t, '[data-type]');
    if (typeEl?.dataset.type) return d.select({ kind: 'type', typeRef: typeEl.dataset.type });
    const itemEl = closest(t, '[data-item]');
    if (itemEl?.dataset.item) return d.select({ kind: 'item', ref: itemEl.dataset.item });
    const wireEl = closest(t, '[data-wire]');
    if (wireEl?.dataset.wire) {
      const ends = d.wireEnds(wireEl.dataset.wire);
      if (ends) return d.select({ kind: 'wire', ...ends });
    }
    const boxEl = closest(t, '[data-box]');
    if (boxEl?.dataset.box) {
      const id = boxEl.dataset.box;
      // 光っている箱 → そこから下流だけ
      if (d.selected() && d.isLitBox(id)) return d.select({ kind: 'box', id, downOnly: true });
      return d.select({ kind: 'box', id });
    }
    const hostEl = closest(t, '[data-host]');
    if (hostEl?.dataset.host) return d.select({ kind: 'host', id: hostEl.dataset.host });
    d.select(null);
  };

  const onOver = (ev: MouseEvent) => {
    const boxEl = closest(ev.target, '[data-box]');
    const fo = closest(ev.target, TABLE);
    tableHover.over(boxEl?.dataset.box ?? null, !!fo);
    // 箱の外（空白・線）に来たら null（作り直しで消えた要素には mouseout が来ないので、ここでも外す）。
    // 分岐の表と橋の上では変えない（表の持ち主の箱の hover を残す。2026-11-10 のレビュー指摘）
    if (!fo) d.hover(boxEl?.dataset.box ?? null);
  };
  const onOut = (ev: MouseEvent) => {
    const boxEl = closest(ev.target, '[data-box]');
    if (!boxEl) return;
    if (ev.relatedTarget instanceof Node && boxEl.contains(ev.relatedTarget)) return;
    if (closest(ev.relatedTarget, TABLE)) return; // 自分の分岐の表へ移った（hover は残す）
    d.hover(null);
  };
  const onKey = (ev: KeyboardEvent) => {
    if (d.keys && !d.keys()) return;
    if (ev.key === 'Escape') {
      const a = escapeAction(ev);
      if (a === 'clear') d.select(null);
      else if (a === 'blur' && ev.target instanceof HTMLElement) ev.target.blur();
    } else if (isFitKey(ev)) d.fitAll();
  };
  // 図の外へ出た: 表を消し、hover も外す（表の上から外へ出たときは箱の mouseout が来ない）
  const onLeave = () => {
    tableHover.leave();
    d.hover(null);
  };

  svg.addEventListener('click', onClick);
  svg.addEventListener('mouseover', onOver);
  svg.addEventListener('mouseout', onOut);
  svg.addEventListener('mouseleave', onLeave);
  window.addEventListener('keydown', onKey);
  return () => {
    tableHover.dispose();
    svg.removeEventListener('click', onClick);
    svg.removeEventListener('mouseover', onOver);
    svg.removeEventListener('mouseout', onOut);
    svg.removeEventListener('mouseleave', onLeave);
    window.removeEventListener('keydown', onKey);
  };
}
