// 配線図（graph.json v2）のアプリ。索引・レイアウト・たどる規則は @stack-atlas/wiring、ここは描画と入力だけ（D44）。
// 部品: render（SVG）、interaction（クリック・hover・Esc）、balls（球と再生バー）、variantTable（分岐の表）、canvas（無限の平面）
import type { GraphV2 } from '@stack-atlas/schema';
import {
  defaultState,
  indexGraph,
  layoutWiring,
  select,
  variantKey,
  type GraphIndex,
  type LitSelection,
  type Selection,
  type VariantState,
  type WiringLayout,
} from '@stack-atlas/wiring';
import { h } from '../ui/dom';
import { Player, type BallPosition } from './balls';
import { createCanvas, type Canvas } from './canvas';
import { installInteraction, TABLE } from './interaction';
import { renderScene } from './render';
import { VariantTable } from './variantTable';
import './style.css';

/** e2e・デバッグ用（window.__stackAtlas.wiring） */
export interface WiringDebug {
  readonly selection: Selection | null;
  /** 光っているもの（選択が無ければ null） */
  readonly lit: { boxes: string[]; items: string[]; wires: string[]; links: string[] } | null;
  /** 球の時刻（流れない選択なら null） */
  readonly schedule: {
    cycle: number;
    end: number;
    balls: {
      key: string;
      kind: 'wire' | 'link';
      from: string;
      to: string;
      t0: number;
      dur: number;
    }[];
  } | null;
  readonly state: VariantState;
  readonly paused: boolean;
  readonly time: number;
  readonly size: { width: number; height: number };
  readonly view: { k: number; tx: number; ty: number };
  select(sel: Selection | null): void;
  setVariant(nodeId: string, variantId: string, value: boolean): void;
  seek(t: number): void;
  setPaused(paused: boolean): void;
  ballPositions(): BallPosition[];
}

export interface WiringApp {
  readonly index: GraphIndex;
  readonly layout: WiringLayout;
  readonly debug: WiringDebug;
  /**
   * 左上の題名の横に、隣の graph（build の graph.v1.json = 3D の地図）を開く小さなリンクを出す。null で消す。
   * 凡例やバッジは置かない（docs/15 §3.6 の表示の規則）。文字のリンク 1 つだけ
   */
  setAltLink(link: AltLink | null): void;
  dispose(): void;
}

/** 隣の graph を開くリンク（graph/alternate.ts の alternateGraph の結果） */
export interface AltLink {
  href: string;
  label: string;
}

export interface WiringOptions {
  root: HTMLElement;
  graph: GraphV2;
  /** 出どころ（上端の帯に出す） */
  source: string;
}

/** graph v2 を配線図として root に描く。参照が解けない graph は indexGraph が例外を投げる */
export function mountWiring(opts: WiringOptions): WiringApp {
  const index = indexGraph(opts.graph);
  const layout = layoutWiring(index);
  let state: VariantState = defaultState(index);
  let selection: Selection | null = null;
  let lit: LitSelection | null = null;

  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'wv-svg');
  const stage = h('div', { class: 'wv-stage' });
  stage.append(svg);
  const play = h(
    'button',
    { class: 'tl', attrs: { type: 'button', 'aria-label': '一時停止' } },
    '❚❚',
  );
  const seek = h('input', {
    class: 'tl seek',
    attrs: {
      type: 'range',
      min: '0',
      max: '1',
      step: '0.01',
      value: '0',
      'aria-label': '再生位置',
    },
  });
  const speed = h('input', {
    class: 'speed-in',
    attrs: {
      type: 'range',
      min: '0.25',
      max: '4',
      step: '0.05',
      value: '1',
      'aria-label': '球の速さ',
    },
  });
  const speedLabel = h('span', { class: 'speed-v' }, '×1.0');
  play.hidden = true;
  seek.hidden = true;
  const name = opts.graph.project?.name ?? opts.source;
  const alt = h('a', { class: 'wv-alt', attrs: { 'data-alt': '' } });
  alt.hidden = true;
  const root = h(
    'div',
    { class: 'wv' },
    h('div', { class: 'wv-top' }, 'Stack Atlas — 配線図', alt, h('small', {}, name)),
    stage,
    h('div', { class: 'wv-speed' }, play, seek, speed, speedLabel),
  );
  opts.root.replaceChildren(root);

  const viewG = () => svg.querySelector<SVGGElement>('g.view');
  const canvas: Canvas = createCanvas({
    stage,
    target: viewG,
    size: { w: layout.width, h: layout.height },
    ignore: (t) => t instanceof Element && !!t.closest(TABLE),
  });
  const player = new Player(svg, layout, { play, seek, speed, speedLabel });
  const table = new VariantTable({
    index,
    layout,
    target: viewG,
    state: () => state,
    onChange: (nodeId, vid, value) => setVariant(nodeId, vid, value),
  });

  const render = (restart: boolean) => {
    svg.innerHTML = `<g class="view">${renderScene({ index, layout, state, lit })}</g>`;
    canvas.apply();
    player.setup(lit, restart);
    table.refresh();
    root.classList.toggle('has-sel', !!lit);
  };
  const doSelect = (next: Selection | null) => {
    selection = next;
    lit = next ? select(index, state, next) : null;
    if (!lit) selection = null;
    render(true);
  };
  // 経路を計算し直して 0 秒から
  const setVariant = (nodeId: string, variantId: string, value: boolean) => {
    state = { ...state, [variantKey(nodeId, variantId)]: value };
    lit = selection ? select(index, state, selection) : null;
    render(true);
  };

  const wireByKey = new Map(index.wires.map((w) => [w.key, w]));
  const offInteraction = installInteraction({
    svg,
    selected: () => !!lit,
    isLitBox: (id) => !!lit && lit.boxes.has(id),
    wireEnds: (key) => {
      const w = wireByKey.get(key);
      return w ? { from: w.wire.from, to: w.wire.to } : null;
    },
    select: doSelect,
    consumeDrag: () => canvas.consumeDrag(),
    hasVariants: (id) => !!index.nodes.get(id)?.node.variants?.length,
    tableNode: () => table.nodeId,
    showTable: (id) => table.show(id),
    hideTable: () => table.hide(),
  });

  render(true);
  canvas.fit();

  const debug: WiringDebug = {
    get selection() {
      return selection;
    },
    get lit() {
      if (!lit) return null;
      return {
        boxes: [...lit.boxes].sort(),
        items: [...lit.items].sort(),
        wires: [...new Set([...lit.wires.values()].map((s) => s.wire!.key))].sort(),
        links: [...lit.links.keys()].sort(),
      };
    },
    get schedule() {
      const s = player.schedule;
      if (!s) return null;
      return {
        cycle: s.cycle,
        end: s.end,
        balls: s.balls.map((b) => ({
          key: b.seg.key,
          kind: b.seg.kind,
          from: b.seg.from.ref,
          to: b.seg.to.ref,
          t0: b.t0,
          dur: b.dur,
        })),
      };
    },
    get state() {
      return { ...state };
    },
    get paused() {
      return player.isPaused;
    },
    get time() {
      return player.tau(performance.now());
    },
    get size() {
      return { width: layout.width, height: layout.height };
    },
    get view() {
      return { ...canvas.view };
    },
    select: doSelect,
    setVariant,
    seek: (t) => player.seek(t),
    setPaused: (p) => player.setPaused(p),
    ballPositions: () => player.positions(),
  };

  return {
    index,
    layout,
    debug,
    setAltLink(link) {
      alt.hidden = !link;
      alt.textContent = link?.label ?? '';
      if (link) alt.setAttribute('href', link.href);
      else alt.removeAttribute('href');
    },
    dispose() {
      offInteraction();
      player.dispose();
      canvas.dispose();
      root.remove();
    },
  };
}
