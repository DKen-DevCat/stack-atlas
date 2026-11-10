// 2 面（Phase 8-6。docs/20）: 左に 3D の地図（v2 を projectMap で写した v1 を Viewer で描く）、右に配線図（mountWiring）。
// 同じ graph.json（v2）の 2 つの見え方で、選択と流れを写し合う。
// - 地図のノードのクリック → 配線図の選択（group は中の箱ごとにたどる）＋ 配線図を始点まで動かす（reveal）
// - 配線図の選択 → 地図は配線図の LitSelection を unitOf で写したものだけで光らせる（v1 の閉包は使わない。§5.1 #6）
// - 流れ（D106）: 時刻の正は配線図の Player。地図は schedule を mapFlow で写し、同じ tau で束の上の球と単位の脈動を描く。
//   再生・停止・シーク・速さは配線図の再生バー 1 つ
// - Esc・空白のクリックは、最後に触った面が受けて両方を 1 回だけ解く（選択は配線図の 1 か所にあり、地図はそれを写すだけ）
// - 境目はドラッグと矢印キー（25〜75%。localStorage）。窓の幅が 1100px 未満なら面は 1 つで、題名の横のリンクで切り替え
//   （両方を置いたまま隠し、隠れた面は描かない。最初は配線図）
// - メモの store は 1 つを両方で共有。孤立の判定は「v2 の箱 ∪ 型 ∪ group ∪ 地図のノード」
import type { Graph, GraphV2, ValidationIssue } from '@stack-atlas/schema';
import {
  litOnMap,
  mapFlow,
  mapFlowAt,
  projectMap,
  type LitSelection,
  type MapFlow,
  type MapLit,
  type MapProjection,
  type Selection,
} from '@stack-atlas/wiring';
import { Viewer } from '../app';
import { buildModel } from '../graph/model';
import type { LoadResult } from '../graph/load';
import { h } from '../ui/dom';
import { LocalShotStore, type SharedMemoStore } from '../ui/memos';
import { mountWiring, type WiringApp } from '../wiring/app';
import { LANE_TINT } from '../wiring/theme';
import { mapTargets, memoKeyOf, resolveSel, selectionForUnit, selParam } from './link';
import './split.css';

/** 窓の幅がこれ未満なら面を 1 つにする（docs/20 §2.2） */
export const NARROW_SPLIT = '(max-width: 1099px)';
const RATIO_KEY = 'stack-atlas-split';

export type Pane = 'map' | 'wiring';

export interface SplitOptions {
  root: HTMLElement;
  graph: GraphV2;
  load: Pick<LoadResult, 'source' | 'baseUrl'>;
  /** 検証の一覧（配線図の題名の横の「警告 N 件」。2 面では図の上の枠は出さない） */
  issues: readonly ValidationIssue[];
  memos: { store: SharedMemoStore; apiUrl?: string };
  /** 前回の graph（?prev=）。v2 なら地図も projectMap(prev) と比べ、v1 なら地図は比べない（§5.1 #13） */
  prev?: { v2: GraphV2 } | { v1: true };
  /** ?view= の id（?sel= に勝つ） */
  view?: string;
  onViewChange?: (id: string | null) => void;
  /** ?sel= の値（箱・地図のノード・host の id） */
  sel?: string;
  /** 選択が変わった（?sel= に書く値。書けない選択・view の選択は null） */
  onSelChange?: (id: string | null) => void;
  onOpenFile(f: File): void;
  onOpenPrev(f: File): void;
}

/** e2e・デバッグ用（window.__stackAtlas.split） */
export interface SplitDebug {
  readonly pane: Pane;
  readonly narrow: boolean;
  /** キーを受ける面（最後に触った面） */
  readonly active: Pane;
  readonly ratio: number;
  /** 地図で光っているもの（配線図の選択を写したもの） */
  readonly mapLit: { nodes: string[]; edges: number; starts: string[] } | null;
  /** 地図の流れ（schedule を写したもの）の数 */
  readonly mapFlow: { balls: number; pulses: number; cycle: number } | null;
  /** 今の時刻（配線図の Player）と、その時刻に地図で見えている球（束・進み具合・線） */
  flowAt(tau?: number): {
    tau: number;
    balls: { edge: string; from: string; to: string; progress: number; wires: string[] }[];
    pulses: string[];
  };
  showPane(p: Pane): void;
  setRatio(v: number): void;
}

export interface SplitApp {
  readonly map: Viewer;
  readonly wiring: WiringApp;
  readonly projection: MapProjection;
  readonly debug: SplitDebug;
  dispose(): void;
}

const readRatio = (): number => {
  try {
    const v = Number(localStorage.getItem(RATIO_KEY));
    return v >= 25 && v <= 75 ? v : 50;
  } catch {
    return 50;
  }
};

/**
 * 2 面を root に作る。地図（WebGL）を作れなければ例外を投げる（呼ぶ側が配線図だけにする。§5.1 #9）。
 * そのときは root を元に戻す
 */
export function mountSplit(o: SplitOptions): SplitApp {
  const projection = projectMap(o.graph, { laneColors: LANE_TINT });
  const prevMap: Graph | undefined =
    o.prev && 'v2' in o.prev ? projectMap(o.prev.v2, { laneColors: LANE_TINT }).graph : undefined;

  // ---- 骨組み ----
  const mapPane = h('div', { class: 'split-pane split-map', attrs: { 'data-pane': 'map' } });
  const wiringPane = h('div', {
    class: 'split-pane split-wiring',
    attrs: { 'data-pane': 'wiring' },
  });
  const divider = h('div', {
    class: 'split-divider',
    attrs: {
      role: 'separator',
      tabindex: '0',
      'aria-orientation': 'vertical',
      'aria-label': '地図と配線図の境目',
      'aria-valuemin': '25',
      'aria-valuemax': '75',
    },
  });
  const root = h('div', { class: 'split' }, mapPane, divider, wiringPane);
  o.root.replaceChildren(root);

  // ---- 状態 ----
  let wiring: WiringApp | null = null;
  let mapLit: MapLit | null = null;
  let flow: MapFlow | null = null;
  let active: Pane = 'wiring';
  let pane: Pane = 'wiring';
  let ratio = readRatio();
  const narrowMq = window.matchMedia(NARROW_SPLIT);

  // ---- 地図（先に作る。WebGL を作れなければここで投げる） ----
  let map: Viewer;
  try {
    map = new Viewer({
      root: mapPane,
      model: buildModel(projection.graph),
      load: {
        graph: projection.graph,
        issues: [],
        source: o.load.source,
        ...(o.load.baseUrl ? { baseUrl: o.load.baseUrl } : {}),
      },
      memos: o.memos.store,
      shots: new LocalShotStore(`${o.graph.project?.name ?? o.load.source}#map`),
      ...(prevMap ? { prev: prevMap } : {}),
      onOpenFile: o.onOpenFile,
      onOpenPrev: o.onOpenPrev,
      embed: {
        lit: () => mapLit,
        hoverLocked: () => !!wiring?.selection,
        onSelect: (id) => selectFromMap(id),
        keys: () => active === 'map',
        memoKey: memoKeyOf,
        flow: () => {
          const clock = wiring?.clock;
          return flow && clock
            ? { flow, tau: (now: number) => clock.tau(now), playing: clock.playing }
            : null;
        },
        onSwitchPane: () => showPane('wiring'),
      },
    });
  } catch (e) {
    root.remove();
    throw e;
  }

  // ---- 写す ----
  /** 地図のクリック → 配線図の選択（光り方は配線図の選択を写して返ってくる） */
  const selectFromMap = (id: string | null) => {
    if (!wiring) return;
    if (id === null) {
      wiring.select(null);
      return;
    }
    const sel = selectionForUnit(projection, id);
    if (!sel) return;
    wiring.select(sel);
    wiring.reveal();
  };
  /** 配線図の選択 → 地図の光り（配線図の LitSelection を対応表で写したものだけ） */
  const onWiringChange = (sel: Selection | null, lit: LitSelection | null) => {
    mapLit = lit ? litOnMap(projection, o.graph, lit) : null;
    map.refresh();
    // ?sel=（view で選んだときは書かない。?view= が勝つ）
    o.onSelChange?.(wiring?.debug.viewId ? null : selParam(projection, sel));
  };
  /** 配線図の球の時刻が変わった → 地図の流れを写し直す（D106） */
  const syncClock = () => {
    const s = wiring?.clock.schedule ?? null;
    flow = s ? mapFlow(projection, s) : null;
    map.flowChanged();
  };

  // ---- ?sel=（?view= が勝つ） ----
  const issues = [...o.issues];
  let initial: Selection | undefined;
  if (o.sel && !o.view) {
    const r = resolveSel(projection, o.graph, o.sel);
    if (r) initial = r;
    else {
      issues.push({
        level: 'warning',
        path: '?sel',
        message: `選択 "${o.sel}" は graph.json の箱・地図のノード・host にありません`,
      });
      o.onSelChange?.(null);
    }
  } else if (o.sel && o.view) o.onSelChange?.(null);

  // ---- 配線図 ----
  try {
    wiring = mountWiring({
      root: wiringPane,
      graph: o.graph,
      source: o.load.source,
      ...(o.load.baseUrl ? { baseUrl: o.load.baseUrl } : {}),
      issues,
      memos: { ...o.memos, extraTargets: mapTargets(projection) },
      ...(o.prev ? { prev: o.prev } : {}),
      ...(o.view ? { view: o.view } : {}),
      ...(o.onViewChange ? { onViewChange: o.onViewChange } : {}),
      ...(initial ? { select: initial } : {}),
      onSelectionChange: onWiringChange,
      onClock: syncClock,
      keys: () => active === 'wiring',
    });
  } catch (e) {
    map.dispose();
    root.remove();
    throw e;
  }
  const w = wiring;
  // 開いた直後の選択（?view= か ?sel=）を地図に写す
  mapLit = w.lit ? litOnMap(projection, o.graph, w.lit) : null;
  map.refresh();
  syncClock();

  // ---- キーは最後に触った面へ（§5.1 #8） ----
  const touch = (p: Pane) => () => (active = p);
  for (const [el, p] of [
    [mapPane, 'map'],
    [wiringPane, 'wiring'],
  ] as const) {
    el.addEventListener('pointerdown', touch(p), true);
    el.addEventListener('focusin', touch(p));
  }

  // ---- 境目 ----
  const applyRatio = () => {
    root.style.setProperty('--left', `${ratio}%`);
    divider.setAttribute('aria-valuenow', String(Math.round(ratio)));
  };
  const setRatio = (v: number) => {
    ratio = Math.min(75, Math.max(25, v));
    applyRatio();
    try {
      localStorage.setItem(RATIO_KEY, String(ratio));
    } catch {
      // 保存できなくても動く
    }
  };
  applyRatio();
  const onDividerDown = (e: PointerEvent) => {
    divider.setPointerCapture(e.pointerId);
    root.classList.add('dragging');
    const r = root.getBoundingClientRect();
    const move = (ev: PointerEvent) => setRatio(((ev.clientX - r.left) / r.width) * 100);
    const up = () => {
      root.classList.remove('dragging');
      divider.removeEventListener('pointermove', move);
      divider.removeEventListener('pointerup', up);
      divider.removeEventListener('pointercancel', up);
    };
    divider.addEventListener('pointermove', move);
    divider.addEventListener('pointerup', up);
    divider.addEventListener('pointercancel', up);
  };
  divider.addEventListener('pointerdown', onDividerDown);
  divider.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowLeft') setRatio(ratio - 5);
    else if (e.key === 'ArrowRight') setRatio(ratio + 5);
    else return;
    e.preventDefault();
  });

  // ---- 狭い画面（§5.1 #9） ----
  const showPane = (p: Pane) => {
    pane = p;
    root.dataset.pane = p;
    const narrow = narrowMq.matches;
    if (narrow) active = p;
    map.setHidden(narrow && p !== 'map');
    w.setHidden(narrow && p !== 'wiring');
  };
  const syncNarrow = () => {
    const narrow = narrowMq.matches;
    root.classList.toggle('narrow', narrow);
    // 2 面のときは「3D の地図」・「配線図」のリンクを出さない（§5.1 #14）。狭い画面はもう片方の面へのリンク
    w.setAltLink(narrow ? { href: '#map', label: '3D の地図' } : null);
    map.setAltLink(narrow ? { href: '#wiring', label: '配線図' } : null);
    showPane(pane);
  };
  // 配線図の題名の横のリンクはページを移らずに地図の面へ
  const wiringAlt = wiringPane.querySelector<HTMLAnchorElement>('.wv-top a[data-alt]');
  wiringAlt?.addEventListener('click', (e) => {
    e.preventDefault();
    showPane('map');
  });
  narrowMq.addEventListener('change', syncNarrow);
  syncNarrow();

  const debug: SplitDebug = {
    get pane() {
      return pane;
    },
    get narrow() {
      return narrowMq.matches;
    },
    get active() {
      return active;
    },
    get ratio() {
      return ratio;
    },
    get mapLit() {
      return mapLit
        ? {
            nodes: [...mapLit.nodes].sort(),
            edges: mapLit.edges.size,
            starts: [...mapLit.starts].sort(),
          }
        : null;
    },
    get mapFlow() {
      return flow
        ? { balls: flow.balls.length, pulses: flow.pulses.length, cycle: flow.cycle }
        : null;
    },
    flowAt(tau0?: number) {
      const tau = tau0 ?? w.clock.tau(performance.now());
      const at = flow ? mapFlowAt(flow, tau) : { balls: [], pulses: [] };
      return {
        tau,
        balls: at.balls.map((b) => ({
          edge: b.ball.edge,
          from: b.ball.from,
          to: b.ball.to,
          progress: b.progress,
          wires: [...b.ball.wires],
        })),
        pulses: at.pulses.map((p) => p.pulse.node),
      };
    },
    showPane,
    setRatio,
  };

  return {
    map,
    wiring: w,
    projection,
    debug,
    dispose() {
      narrowMq.removeEventListener('change', syncNarrow);
      w.dispose();
      map.dispose();
      root.remove();
    },
  };
}
