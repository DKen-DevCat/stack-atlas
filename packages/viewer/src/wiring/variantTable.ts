// 分岐の表（docs/15 §3.4b、D32）: 分岐を持つ箱に hover すると右上の外側に出る。1 行 = 1 分岐、
// 左の列が「ない」、右の列が「ある」のチェックボックス（どちらか片方だけ）。選択中でも出る（表は切り替えの入口で、ハイライトではない）
import {
  variantValue,
  type GraphIndex,
  type VariantState,
  type WiringLayout,
} from '@stack-atlas/wiring';
import { esc } from './markup';

const SVG_NS = 'http://www.w3.org/2000/svg';
const ROW = 20;
/**
 * 箱の右辺から表までの間。この間には透明な橋（.vtable-bridge）を置き、ポインタが箱 → 表へ動く途中も「表の上」にする。
 * 橋は光る線の層の直前（= host の枠の直後。箱と光る線より下）に入れる（箱の右辺のピンと光る線のクリックを奪わない）。
 * 層は名前で探さず、要素を受け取る（見つからないと橋が最前面に付いてピンのクリックを奪う。docs/18 §11.3）
 */
const GAP = 6;
const WIDTH = 150;

export interface VariantTableDeps {
  index: GraphIndex;
  /** 今の配置（場面を差し替えると変わる） */
  layout: () => WiringLayout;
  /** 表を置く g（拡大縮小に追従するよう、#view の中） */
  target: () => SVGGElement | null;
  /** 橋をこの要素の直前に入れる（光る線の層）。無ければ g の先頭（いちばん下） */
  before: () => Element | null;
  state: () => VariantState;
  onChange: (nodeId: string, variantId: string, value: boolean) => void;
}

export class VariantTable {
  /** 表を出している箱 */
  nodeId: string | null = null;

  constructor(private readonly deps: VariantTableDeps) {}

  show(nodeId: string) {
    const { index } = this.deps;
    const layout = this.deps.layout();
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
    const before = this.deps.before();
    target.insertBefore(bridge, before?.parentNode === target ? before : target.firstChild);
  }

  /** 作り直した・付け替えたあとに、出ていた表を出し直す（対のチェックと、view で既定に戻した分岐を映す） */
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
