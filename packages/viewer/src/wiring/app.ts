// 配線図（graph.json v2）のアプリ。索引・レイアウト・たどる規則は @stack-atlas/wiring、ここは描画と入力だけ（D44）。
// 部品: render（SVG）、interaction（クリック・hover・Esc）、balls（球と再生バー）、variantTable（分岐の表）、canvas（無限の平面）、
// screenLayer（画面の箱の中のビルド成果物の HTML。SVG の下の iframe の層。docs/18 §3.3）、
// viewsMenu・memoCard・issuesLink（views のメニュー、メモの札、検証の一覧のリンク。docs/18 §3.4）、差分は diffOverlayV2
import type { GraphV2, ValidationIssue } from '@stack-atlas/schema';
import {
  applyView,
  defaultState,
  diffOverlayV2,
  findView,
  indexGraph,
  layoutWiring,
  select,
  variantKey,
  type DiffOverlayV2,
  type GraphIndex,
  type LitSelection,
  type Selection,
  type VariantState,
  type WiringLayout,
} from '@stack-atlas/wiring';
import { createAltLink, type AltLink } from '../graph/altLink';
import { h } from '../ui/dom';
import type { SharedMemoStore } from '../ui/memos';
import { Player, type BallPosition } from './balls';
import { createCanvas, type Canvas } from './canvas';
import { installInteraction, TABLE } from './interaction';
import { createIssuesLink } from './issuesLink';
import { WiringMemos } from './memoCard';
import { renderScene } from './render';
import { ScreenLayer, type ScreenDebug } from './screenLayer';
import { renderRegions } from './screens';
import { VariantTable } from './variantTable';
import { openingFocus } from './view';
import { createViewsMenu, selectionFocus, ViewChoice } from './viewsMenu';
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
  /** 画面の層（生かしている iframe・状態・測った領域・描く領域） */
  readonly screens: ScreenDebug;
  /** views のメニューで選んでいる view の id（docs/18 §3.4） */
  readonly viewId: string | null;
  /** 右下の角を折った箱（メモのある箱） */
  readonly memoBoxes: string[];
  /** 差分の印（?prev= が v2 のとき。幽霊・今だけ・型の変わった項目） */
  readonly diff: {
    ghost: { nodes: string[]; items: string[]; wires: string[] };
    added: { nodes: string[]; items: string[]; wires: string[] };
    changed: string[];
  } | null;
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

export interface WiringOptions {
  root: HTMLElement;
  graph: GraphV2;
  /** 出どころ（上端の帯に出す） */
  source: string;
  /** graph.json の URL（screen.html を解く。ファイルで開いたときは無く、画面はプレースホルダ） */
  baseUrl?: string;
  /** 検証の一覧（題名の横の「警告 N 件」から開く。D64） */
  issues?: readonly ValidationIssue[];
  /** 共有メモ（memos.json ＋ このブラウザの編集）と、`serve` の API の URL */
  memos?: { store: SharedMemoStore; apiUrl?: string };
  /** 前回の graph（?prev=）。v2 なら差分を描き、v1 なら題名の横に「前の graph が v1 です」 */
  prev?: { v2: GraphV2 } | { v1: true };
  /** 開いた直後に当てる view の id（?view=）。開いた直後の表示はその始点のあたり */
  view?: string;
  /** views のメニューで view を選んだ・外れた（main.ts が URL の ?view= を書き換える） */
  onViewChange?: (id: string | null) => void;
}

const sortedSets = (s: { nodes: Set<string>; items: Set<string>; wires: Set<string> }) => ({
  nodes: [...s.nodes].sort(),
  items: [...s.items].sort(),
  wires: [...s.wires].sort(),
});

/** graph v2 を配線図として root に描く。参照が解けない graph は indexGraph が例外を投げる */
export function mountWiring(opts: WiringOptions): WiringApp {
  const index = indexGraph(opts.graph);
  const issues: ValidationIssue[] = [...(opts.issues ?? [])];
  // 差分（docs/18 §3.4）: 前が v2 なら、今の graph に前にしか無い箱・項目・線を足した graph を 1 回だけ配置して描く。
  // 選ぶ・たどる・分岐は今の graph の索引（index）で行うので、幽霊は光らない
  let overlay: DiffOverlayV2 | null = null;
  let drawIndex = index;
  if (opts.prev && 'v2' in opts.prev) {
    try {
      overlay = diffOverlayV2(opts.prev.v2, opts.graph);
      drawIndex = indexGraph(overlay.graph);
    } catch (e) {
      overlay = null;
      drawIndex = index;
      issues.push({
        level: 'warning',
        path: 'prev',
        message: `前回の graph.json と比べられないため差分は表示しません: ${e instanceof Error ? e.message : String(e)}`,
      });
    }
  }
  const layout = layoutWiring(drawIndex);
  let state: VariantState = defaultState(index);
  let selection: Selection | null = null;
  let lit: LitSelection | null = null;
  const initialView = opts.view ? findView(opts.graph.views, opts.view) : undefined;
  if (opts.view && !initialView)
    issues.push({
      level: 'warning',
      path: '?view',
      message: `view "${opts.view}" は graph.json の views にありません`,
    });

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
  const alt = createAltLink();
  const views = createViewsMenu(opts.graph.views, (id) => pickView(id));
  // 選んでいる view。ほかを選ぶ・分岐を変えると外れ、メニューは空の選択に、URL の ?view= は消える
  const choice = new ViewChoice(opts.graph.views, (id) => {
    views.set(id);
    opts.onViewChange?.(id);
  });
  const issuesLink = createIssuesLink(issues);
  const memoUi = opts.memos
    ? new WiringMemos({
        index,
        store: opts.memos.store,
        ...(opts.memos.apiUrl ? { apiUrl: opts.memos.apiUrl } : {}),
        onMarksChange: () => render(false),
      })
    : null;
  const prevNote =
    opts.prev && 'v1' in opts.prev
      ? h('span', { class: 'wv-note' }, '前の graph が v1 です')
      : null;
  const root = h(
    'div',
    { class: 'wv' },
    h(
      'div',
      { class: 'wv-top' },
      'Stack Atlas — 配線図',
      views.el,
      alt.el,
      issuesLink.link,
      memoUi?.orphanLink,
      prevNote,
      h('small', {}, name),
    ),
    stage,
    h('div', { class: 'wv-speed' }, play, seek, speed, speedLabel),
    memoUi?.card,
    memoUi?.orphans.el,
    issuesLink.panel,
  );
  opts.root.replaceChildren(root);

  const viewG = () => svg.querySelector<SVGGElement>('g.view');
  const regionsSvg = () => renderRegions(screens.specs, screens.regions(), lit);
  const screens = new ScreenLayer({
    stage,
    svg,
    index,
    layout,
    baseUrl: opts.baseUrl,
    // 測り終えた（か読めなかった）画面の領域の枠だけ描き直す（球と経路はそのまま）
    onRegions: () => {
      const g = svg.querySelector('g.regions');
      if (g) g.innerHTML = regionsSvg();
    },
  });
  stage.prepend(screens.el);
  const canvas: Canvas = createCanvas({
    stage,
    target: viewG,
    size: { w: layout.width, h: layout.height },
    ignore: (t) => t instanceof Element && !!t.closest(TABLE),
    onApply: (v) => screens.setView(v),
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
    svg.innerHTML = `<g class="view">${renderScene({
      index: drawIndex,
      layout,
      state,
      lit,
      regions: regionsSvg(),
      ...(memoUi ? { memos: memoUi.boxIds() } : {}),
      ...(overlay ? { diff: overlay } : {}),
    })}</g>`;
    screens.decorate();
    screens.setLit(lit);
    canvas.apply();
    player.setup(lit, restart);
    table.refresh();
    root.classList.toggle('has-sel', !!lit);
  };
  const doSelect = (next: Selection | null, fromView = false) => {
    selection = next;
    lit = next ? select(index, state, next) : null;
    if (!lit) selection = null;
    if (!fromView) choice.clear();
    memoUi?.show(selection);
    render(true);
  };
  // 経路を計算し直して 0 秒から
  const setVariant = (nodeId: string, variantId: string, value: boolean) => {
    state = { ...state, [variantKey(nodeId, variantId)]: value };
    lit = selection ? select(index, state, selection) : null;
    choice.clear();
    render(true);
  };
  // view を選ぶ: 分岐を既定に戻して variants を当て、start から選ぶ。空の選択肢は選択の解除
  const pickView = (id: string | null) => {
    const v = choice.pick(id);
    if (!v) return doSelect(null);
    const a = applyView(index, v);
    state = a.state;
    doSelect(a.selection, true);
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
    fitAll: () => canvas.fit(),
  });

  // 配置は graph ごとにここで 1 回だけ（選択・分岐の切り替えは描き直すだけで、箱を動かさない。docs/18 §3.1）
  render(true);
  // ?view= は開いた直後に当て、その始点のあたりを映す（無ければ最初の画面の箱のあたり）
  if (initialView) pickView(initialView.id);
  canvas.open(
    (initialView && selectionFocus(index, layout, selection)) || openingFocus(index, layout),
  );

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
    get screens() {
      return screens.debug;
    },
    get viewId() {
      return choice.id;
    },
    get memoBoxes() {
      return memoUi ? [...memoUi.boxIds()].sort() : [];
    },
    get diff() {
      if (!overlay) return null;
      return {
        ghost: sortedSets(overlay.ghost),
        added: sortedSets(overlay.added),
        changed: [...overlay.changed].sort(),
      };
    },
    select: (sel) => doSelect(sel),
    setVariant,
    seek: (t) => player.seek(t),
    setPaused: (p) => player.setPaused(p),
    ballPositions: () => player.positions(),
  };

  return {
    index,
    layout,
    debug,
    setAltLink: (link) => alt.set(link),
    dispose() {
      offInteraction();
      issuesLink.dispose();
      memoUi?.dispose();
      player.dispose();
      canvas.dispose();
      screens.dispose();
      root.remove();
    },
  };
}
