// 【8-6 のモック（Q20）】3D の地図 ⇄ 配線図の 2 面（docs/20 §2.2・§5.1）。mock-split.html から開く（vite の dev だけ。build に入らない）。
// 左 = 3D の地図（mock-map.html の iframe。v2 を projectMap で写した v1 を本物の Viewer で描く）、右 = 配線図（本物の mountWiring）。
// - 地図でノードをクリック → 配線図はそのノードの箱を選ぶ（group は中の箱ごとにたどって合併、始点の輪は中の箱それぞれ）
// - 配線図で箱・項目・線をクリック → 地図はその group のノードと、経路上の group を光らせる（提案の規則）
// - Esc・空白のクリックはどちらの面でも両方を解く。提案の規則では、選んでいる間はどちらの面でも hover が効かない
// - 題名の横の「今の地図 / 提案の規則」で地図の規則を切り替える（今の地図 = 赤と橙の閉包、hover が効く、パネルが開く）
// - 1100px 未満は面を 1 つにし、題名の横のリンク（「3D の地図」/「配線図」）で切り替える。選択は引き継ぐ
// URL: ?graph=<v2 の graph.json>（既定は examples/map-mock/graph.json）、?rules=current|proposed、?pane=map|wiring（狭い画面）
import '../style.css';
import './mock.css';
import { validateGraph, type GraphV2 } from '@stack-atlas/schema';
import {
  litOnMap,
  projectMap,
  type LitSelection,
  type MapLit,
  type Selection,
} from '@stack-atlas/wiring';
import { loadGraphFromUrl, wiringIssues } from '../graph/load';
import { h } from '../ui/dom';
import { SharedMemoStore, storageScope } from '../ui/memos';
import { mountWiring, type WiringApp } from '../wiring/app';
import { LANE_TINT } from '../wiring/theme';
import type { MapFrameHandle, Rules } from './map-frame';

const DEFAULT_GRAPH = '/examples/map-mock/graph.json';
const NARROW = '(max-width: 1099px)';
const SPLIT_KEY = 'stack-atlas-mock-split';

const params = new URLSearchParams(location.search);
let rules: Rules = params.get('rules') === 'current' ? 'current' : 'proposed';
let pane: 'map' | 'wiring' = params.get('pane') === 'map' ? 'map' : 'wiring';

function setParam(name: string, value: string | null) {
  const url = new URL(location.href);
  if (value === null) url.searchParams.delete(name);
  else url.searchParams.set(name, value);
  if (url.href !== location.href) history.replaceState(null, '', url);
}

const readSplit = (): number => {
  try {
    const v = Number(localStorage.getItem(SPLIT_KEY));
    return v >= 25 && v <= 75 ? v : 50;
  } catch {
    return 50;
  }
};

// ---- 骨組み ----
const frame = h('iframe', {
  class: 'mock-frame',
  attrs: { src: './mock-map.html', title: '3D の地図' },
}) as HTMLIFrameElement;
const left = h('div', { class: 'mock-pane mock-left' }, frame);
const wiringRoot = h('div', { class: 'mock-wiring' });
const right = h('div', { class: 'mock-pane mock-right' }, wiringRoot);
const divider = h('div', {
  class: 'mock-divider',
  attrs: {
    role: 'separator',
    tabindex: '0',
    'aria-orientation': 'vertical',
    'aria-label': '地図と配線図の境目',
    'aria-valuemin': '25',
    'aria-valuemax': '75',
  },
});
const split = h('div', { class: 'mock-split' }, left, divider, right);
document.querySelector('#app')!.append(split);

let ratio = readSplit();
const applyRatio = () => {
  split.style.setProperty('--left', `${ratio}%`);
  divider.setAttribute('aria-valuenow', String(Math.round(ratio)));
  // 配線図の平面は窓の resize で大きさを測り直す（iframe の中の 3D は自分の窓の resize で追従する）
  window.dispatchEvent(new Event('resize'));
};
const setRatio = (v: number) => {
  ratio = Math.min(75, Math.max(25, v));
  applyRatio();
  try {
    localStorage.setItem(SPLIT_KEY, String(ratio));
  } catch {
    // 保存できなくても動く
  }
};
applyRatio();
divider.addEventListener('pointerdown', (e) => {
  divider.setPointerCapture(e.pointerId);
  split.classList.add('dragging');
  const r = split.getBoundingClientRect();
  const move = (ev: PointerEvent) => setRatio(((ev.clientX - r.left) / r.width) * 100);
  const up = () => {
    split.classList.remove('dragging');
    divider.removeEventListener('pointermove', move);
    divider.removeEventListener('pointerup', up);
    divider.removeEventListener('pointercancel', up);
  };
  divider.addEventListener('pointermove', move);
  divider.addEventListener('pointerup', up);
  divider.addEventListener('pointercancel', up);
});
divider.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowLeft') setRatio(ratio - 5);
  else if (e.key === 'ArrowRight') setRatio(ratio + 5);
  else return;
  e.preventDefault();
});

// ---- 状態 ----
let wiring: WiringApp | null = null;
let map: MapFrameHandle | null = null;
/** 配線図の選択と、それを地図に写したもの */
let wiringSel: Selection | null = null;
let mapLit: MapLit | null = null;
/** 地図のクリックから配線図を選んでいる最中（配線図からの通知で地図を選び直さない） */
let fromMap = false;
/** 地図の選択を外から変えている最中（地図からの通知を配線図へ返さない） */
let syncing = false;

const narrow = window.matchMedia(NARROW);
const showPane = (p: 'map' | 'wiring') => {
  pane = p;
  split.dataset.pane = p;
  if (narrow.matches) setParam('pane', p === 'wiring' ? null : p);
  if (p === 'wiring') window.dispatchEvent(new Event('resize'));
};
const syncNarrow = () => {
  split.classList.toggle('narrow', narrow.matches);
  // 2 面のときは「3D の地図」/「配線図」のリンクを出さない（docs/20 §5.1 #14）
  wiring?.setAltLink(narrow.matches ? { href: '#map', label: '3D の地図' } : null);
  map?.showPaneLink(narrow.matches);
  showPane(pane);
};
narrow.addEventListener('change', syncNarrow);

/** 地図の選択を外から変える（地図からの通知は無視する） */
const quietly = (f: () => void) => {
  syncing = true;
  try {
    f();
  } finally {
    syncing = false;
  }
};

/** 今の地図の規則: 配線図の選択の始点のノードを地図でも選ぶ（閉包の赤と橙）。提案: 地図の選択にしない（光らせるだけ） */
const reflectOnMap = () => {
  if (!map) return;
  const v = map.viewer;
  if (rules === 'current') {
    const start = mapLit ? [...mapLit.starts][0] : undefined;
    quietly(() => (start ? v.select(start) : v.deselect()));
  } else {
    quietly(() => v.deselect());
  }
};

const onWiringChange = (sel: Selection | null, lit: LitSelection | null) => {
  wiringSel = sel;
  mapLit = lit && projection && graphV2 ? litOnMap(projection, graphV2, lit) : null;
  if (fromMap) {
    // 地図のクリックから: 地図はもう選んでいる（今の規則）か、写したものを光らせ直すだけ（提案）
    map?.viewer.refresh();
    return;
  }
  reflectOnMap();
};

const selectionFor = (unit: string): Selection | null => {
  if (!projection) return null;
  const kind = projection.unitKind.get(unit);
  if (kind === 'box') return { kind: 'box', id: unit };
  if (kind === 'host') return { kind: 'host', id: unit };
  if (kind === 'group')
    return { kind: 'group', id: unit, members: projection.members.get(unit) ?? [] };
  return null;
};

const onMapSelect = (id: string | null) => {
  if (syncing || !wiring) return;
  fromMap = true;
  try {
    wiring.debug.select(id ? selectionFor(id) : null);
    if (id) wiring.reveal();
  } finally {
    fromMap = false;
  }
};

const setRules = (r: Rules) => {
  rules = r;
  setParam('rules', r === 'proposed' ? null : r);
  map?.syncRules();
  reflectOnMap();
  map?.viewer.refresh();
};

// ---- 読み込み ----
let graphV2: GraphV2 | null = null;
let projection: ReturnType<typeof projectMap> | null = null;

async function start() {
  const url = new URL(params.get('graph') ?? DEFAULT_GRAPH, location.href).href;
  const res = await loadGraphFromUrl(url);
  if (!res.graphV2) {
    wiringRoot.textContent = `graph.json（version 2）を読めませんでした: ${url}`;
    return;
  }
  graphV2 = res.graphV2;
  projection = projectMap(graphV2, { laneColors: LANE_TINT });
  const v1 = validateGraph(projection.graph);
  const groups = [...projection.unitKind.values()].filter((k) => k === 'group').length;
  console.info(
    `[mock-split] 箱 ${graphV2.nodes.length}・線 ${graphV2.wires.length} → 地図のノード ${projection.graph.nodes.length}（group ${groups}）・線 ${projection.graph.edges.length}・層 ${projection.graph.layers.length}。v1 の検証: エラー ${v1.errors.filter((e) => e.level === 'error').length}・警告 ${v1.errors.filter((e) => e.level === 'warning').length}`,
  );
  const scope = storageScope(graphV2.project?.name, res.source);
  // メモの store は 1 つを両方の面で共有する（docs/20 §5.1 #12）
  const memos = new SharedMemoStore(scope, {});
  wiring = mountWiring({
    root: wiringRoot,
    graph: graphV2,
    source: res.source,
    ...(res.baseUrl ? { baseUrl: res.baseUrl } : {}),
    issues: wiringIssues(res),
    memos: { store: memos },
    onSelectionChange: onWiringChange,
  });
  wiringRoot.querySelector<HTMLAnchorElement>('a[data-alt]')?.addEventListener('click', (e) => {
    e.preventDefault();
    showPane('map');
  });

  // iframe の中の module は load の前に走る（最初の about:blank のあいだは __mapFrame が無いので、load を待つ）
  const mountMap = () => {
    const w = frame.contentWindow;
    if (!w?.__mapFrame || !projection || map) return;
    map = w.__mapFrame.mount({
      graph: projection.graph,
      source: res.source,
      ...(res.baseUrl ? { baseUrl: res.baseUrl } : {}),
      memos,
      scope,
      link: {
        rules: () => rules,
        lit: () => mapLit,
        selected: () => !!wiringSel,
        onSelect: onMapSelect,
        onRules: setRules,
        onSwitchPane: () => showPane('wiring'),
      },
    });
    syncNarrow();
    reflectOnMap();
    document.body.dataset.status = 'ready';
  };
  frame.addEventListener('load', mountMap);
  mountMap();
  syncNarrow();
}

/** e2e・確認用 */
declare global {
  interface Window {
    __mockSplit?: unknown;
  }
}
window.__mockSplit = {
  get rules() {
    return rules;
  },
  get pane() {
    return pane;
  },
  get projection() {
    return projection;
  },
  get wiring() {
    return wiring?.debug ?? null;
  },
  get map() {
    return map?.viewer ?? null;
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
  setRules,
  showPane,
};

void start();
