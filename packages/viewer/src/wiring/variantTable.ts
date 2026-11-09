// 分岐の表（docs/15 §3.4b、D32）: 分岐を持つ箱に hover すると右上の外側に出る。1 行 = 1 分岐、
// 左の列が「ない」、右の列が「ある」のチェックボックス（どちらか片方だけ）。選択中でも出る（表は切り替えの入口で、ハイライトではない）
import {
  variantValue,
  type GraphIndex,
  type VariantState,
  type WiringLayout,
} from '@stack-atlas/wiring';
import { esc } from './render';

const SVG_NS = 'http://www.w3.org/2000/svg';
const ROW = 20;
/**
 * 箱の右辺から表までの間。この間には透明な橋（.vtable-bridge）を置き、ポインタが箱 → 表へ動く途中も「表の上」にする。
 * 橋は箱の層より下に入れる（箱の右辺のピンのクリックを奪わない）
 */
const GAP = 6;
const WIDTH = 150;

export interface VariantTableDeps {
  index: GraphIndex;
  layout: WiringLayout;
  /** 表を置く g（拡大縮小に追従するよう、#view の中） */
  target: () => SVGGElement | null;
  state: () => VariantState;
  onChange: (nodeId: string, variantId: string, value: boolean) => void;
}

export class VariantTable {
  /** 表を出している箱 */
  nodeId: string | null = null;

  constructor(private readonly deps: VariantTableDeps) {}

  show(nodeId: string) {
    const { index, layout } = this.deps;
    const n = index.nodes.get(nodeId);
    const b = layout.boxes.get(nodeId);
    this.remove();
    this.nodeId = null;
    if (!n || !b || !n.node.variants?.length) return;
    const target = this.deps.target();
    if (!target) return;
    this.nodeId = nodeId;
    const state = this.deps.state();
    const variants = n.node.variants;
    const fo = document.createElementNS(SVG_NS, 'foreignObject');
    fo.setAttribute('class', 'vtable-fo');
    const height = variants.length * ROW + 12;
    fo.setAttribute('x', String(b.x + b.w + GAP));
    fo.setAttribute('y', String(b.y - 4));
    fo.setAttribute('width', String(WIDTH));
    fo.setAttribute('height', String(height));
    fo.dataset.node = nodeId;
    const rows = variants
      .map((v) => {
        const on = variantValue(index, state, nodeId, v.id);
        const name = esc(v.name);
        const id = esc(v.id);
        return (
          `<div class="vrow" data-variant="${id}">` +
          `<input type="checkbox" data-v="${id}" data-val="0" aria-label="${name}: ない"${on ? '' : ' checked'}>` +
          `<input type="checkbox" data-v="${id}" data-val="1" aria-label="${name}: ある"${on ? ' checked' : ''}>` +
          `<span>${name}</span></div>`
        );
      })
      .join('');
    fo.innerHTML = `<div xmlns="http://www.w3.org/1999/xhtml" class="vtable">${rows}</div>`;
    fo.addEventListener('change', (ev) => {
      const cb = ev.target as HTMLInputElement;
      const vid = cb.dataset.v;
      if (!vid || this.nodeId !== nodeId) return;
      this.deps.onChange(nodeId, vid, cb.dataset.val === '1');
    });
    target.append(fo);
    const bridge = document.createElementNS(SVG_NS, 'rect');
    bridge.setAttribute('class', 'vtable-bridge');
    bridge.setAttribute('x', String(b.x + b.w));
    bridge.setAttribute('y', String(b.y - 4));
    bridge.setAttribute('width', String(GAP));
    bridge.setAttribute('height', String(height));
    bridge.dataset.node = nodeId;
    target.insertBefore(bridge, target.querySelector(':scope > g.base-boxes'));
  }

  /** 描き直したあとに、出ていた表を出し直す */
  refresh() {
    if (this.nodeId) this.show(this.nodeId);
  }

  hide() {
    this.remove();
    this.nodeId = null;
  }

  private remove() {
    this.deps
      .target()
      ?.querySelectorAll('.vtable-fo, .vtable-bridge')
      .forEach((e) => e.remove());
  }
}
