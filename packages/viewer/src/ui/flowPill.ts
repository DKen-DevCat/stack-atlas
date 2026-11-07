/** フローの進行表示「4/14 /races/[id]: …」 */
import type { Flow } from '@stack-atlas/schema';
import { h } from './dom';

export interface FlowPill {
  el: HTMLElement;
  show(flow: Flow, step: number, nodeName: string): void;
  hide(): void;
}

export function createFlowPill(): FlowPill {
  const el = h('div', { class: 'flowpill', attrs: { role: 'status', 'aria-live': 'polite' } });
  return {
    el,
    show(flow, step, nodeName) {
      const s = flow.steps[step];
      el.classList.toggle('hit', flow.tone === 'cache-hit');
      el.replaceChildren(
        h('em', {}, `${step + 1}/${flow.steps.length}`),
        `${nodeName}: ${s?.text ?? ''}`,
      );
      el.style.display = 'block';
    },
    hide() {
      el.style.display = 'none';
    },
  };
}
