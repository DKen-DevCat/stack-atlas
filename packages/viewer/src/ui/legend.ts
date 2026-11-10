/** 凡例 */
import type { Layer } from '@stack-atlas/schema';
import { DEFAULT_LAYER_COLOR } from '../scene/plates';
import { h } from './dom';

export function createLegend(layers: readonly Layer[]): HTMLElement {
  const colors = layers.slice(0, -1).map((l) => l.color ?? DEFAULT_LAYER_COLOR);
  const grad =
    colors.length > 1
      ? `linear-gradient(90deg,${colors.join(',')})`
      : (colors[0] ?? DEFAULT_LAYER_COLOR);
  const bar = (bg: string) => h('b', { style: `background:${bg}` });
  const dot = (bg: string) => h('span', { class: 'dot', style: `background:${bg}` });
  return h(
    'div',
    { class: 'legend' },
    h('div', {}, bar('var(--red)'), '依存先（使っている型・部品）'),
    h('div', {}, bar('var(--coral)'), '影響範囲（これを使う画面・部品）'),
    h('div', {}, bar('var(--cyan)'), 'データフロー'),
    h('div', {}, bar(grad), '層またぎの線 = 上の層の色'),
    h(
      'div',
      { class: 'cl' },
      'キャッシュ:',
      dot('var(--ok)'),
      '効いている',
      dot('var(--warn)'),
      '要注意',
      dot('var(--off)'),
      'なし',
    ),
    h(
      'div',
      { class: 'hint' },
      'ドラッグ: 回転 / 右ドラッグ: 移動 / ホイール: ズーム',
      h('br'),
      '画面の中のパーツにもホバーできます',
    ),
  );
}
