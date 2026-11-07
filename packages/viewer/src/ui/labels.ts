/** ノードのラベル（CSS2D で 3D 空間に貼る HTML） */
import type { ModelNode } from '../graph/model';
import { h } from './dom';

export function makeNodeLabel(n: ModelNode): { el: HTMLDivElement; memoBadge: HTMLSpanElement } {
  const memoBadge = h('span', { class: 'memo' });
  const C = n.node.cache;
  const el = h(
    'div',
    { class: 'nl', attrs: { 'data-id': n.id } },
    h('span', { class: 'k' }, n.node.kind),
    n.node.name,
    memoBadge,
    C ? h('span', { class: `cb ${C.tone}` }, C.badge) : null,
  );
  return { el, memoBadge };
}
