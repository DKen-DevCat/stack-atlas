// 操作（docs/15 §3.5・§3.6）: クリックで選ぶ（型 → 項目 → 光っている線 → 箱 → 枠 → 空白の順に見る）、Esc で解く。
// hover は何も選んでいないときだけ箱とその線を少し明るくする（選択中は hover が効かない）。分岐の表だけは選択中でも出る
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
  /** 直前の操作がドラッグだったか（クリックにしない） */
  consumeDrag: () => boolean;
  /** 分岐の表 */
  hasVariants: (id: string) => boolean;
  tableNode: () => string | null;
  showTable: (id: string) => void;
  hideTable: () => void;
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
    // hover の明るさは何も選んでいないときだけ
    if (d.selected() || !boxEl?.dataset.box) return;
    boxEl.classList.add('hov');
    const id = boxEl.dataset.box;
    svg.querySelectorAll<SVGPathElement>('[data-ends]').forEach((p) => {
      const [a, b] = (p.dataset.ends ?? '').split('|');
      if (a === id || b === id) p.classList.add('hov');
    });
  };
  const onOut = (ev: MouseEvent) => {
    const boxEl = closest(ev.target, '[data-box]');
    if (!boxEl) return;
    if (ev.relatedTarget instanceof Node && boxEl.contains(ev.relatedTarget)) return;
    boxEl.classList.remove('hov');
    svg.querySelectorAll('.wire.hov').forEach((p) => p.classList.remove('hov'));
  };
  const onKey = (ev: KeyboardEvent) => {
    if (ev.key === 'Escape') d.select(null);
  };
  const onLeave = () => tableHover.leave();

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
