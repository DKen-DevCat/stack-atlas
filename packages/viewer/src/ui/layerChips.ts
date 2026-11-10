/** 層チップ（graph.layers から生成）。クリックで層の表示を切り替える */
import type { Layer } from '@stack-atlas/schema';
import { DEFAULT_LAYER_COLOR } from '../scene/plates';
import { h } from './dom';

export function createLayerChips(
  layers: readonly Layer[],
  onToggle: (index: number, visible: boolean) => void,
): HTMLElement {
  const el = h('div', { class: 'layers' });
  layers.forEach((L, i) => {
    let visible = true;
    const chip = h(
      'div',
      { class: 'lchip', attrs: { role: 'button', tabindex: '0' } },
      h('i', { style: `background:${L.color ?? DEFAULT_LAYER_COLOR}` }),
      `L${i} ${L.name}`,
      L.source ? h('span', {}, L.source.split(' ')[0] ?? '') : null,
    );
    const toggle = () => {
      visible = !visible;
      chip.classList.toggle('off', !visible);
      onToggle(i, visible);
    };
    chip.addEventListener('click', toggle);
    chip.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        toggle();
      }
    });
    el.append(chip);
  });
  return el;
}
