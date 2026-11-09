/**
 * エントリポイント: graph.json の入力（?graph=、ドロップ、ファイル選択）→ 検証 → Viewer。
 * - `version: 2` の graph は validateGraphV2 で検証し、3D の Viewer ではなく配線図（wiring/）で開く（SVG なので WebGL は要らない）
 * - `?prev=<URL>`（または「開く ▾ → 前回と比較…」）で前回の graph.json を読み、差分を色分けする。配線図は前も v2 のとき
 *   差分を描き、前が v1 なら題名の横に「前の graph が v1 です」（docs/18 §3.4）
 * - `?view=<id>` は配線図で graph の views を当てて開く（共有用。docs/18 §3.4）
 * - graph.json と同じディレクトリの memos.json（と serve の GET /api/memos）を共有メモとして読む（3D の地図と配線図の両方）
 * - 検証の一覧は 3D の地図では図の上の枠、配線図では題名の横の「警告 N 件」のリンク（D64）
 * - build の出力（docs/16 §10）の graph.json（v2）と graph.v1.json（v1）は、隣にあれば左上のリンクで行き来する
 */
import './style.css';
import type { Graph, GraphV2, ValidationIssue } from '@stack-atlas/schema';
import { Viewer } from './app';
import { buildModel } from './graph/model';
import {
  graphUrlFromSearch,
  prevUrlFromSearch,
  loadGraphFromFile,
  loadGraphFromUrl,
  wiringIssues,
  type LoadResult,
} from './graph/load';
import { alternateGraph, graphExists } from './graph/alternate';
import { hasWebGL } from './scene/renderer';
import { startPlan, viewFor } from './startup';
import { mountWiring, type WiringApp, type WiringDebug } from './wiring/app';
import { h } from './ui/dom';
import { createEmptyState, installDropTarget, type SampleEntry } from './ui/emptyState';
import { createIssuesBox } from './ui/issues';
import {
  loadSharedMemos,
  LocalShotStore,
  SharedMemoStore,
  storageScope,
  type SharedMemoSource,
} from './ui/memos';

type Status = 'loading' | 'empty' | 'ready' | 'error';
interface DebugHandle {
  viewer: Viewer | null;
  /** 配線図（v2）を開いているときのデバッグ用の口 */
  wiring: WiringDebug | null;
  status: Status;
}

declare global {
  interface Window {
    /** e2e テスト・デバッグ用 */
    __stackAtlas?: DebugHandle;
  }
}

const app = document.querySelector<HTMLDivElement>('#app')!;
const overlays = h('div', { class: 'overlays' });
document.body.append(overlays);

let viewer: Viewer | null = null;
let wiring: WiringApp | null = null;
/** 今表示している graph（「前回と比較…」で作り直すため） */
let current: { res: LoadResult; shared: SharedMemoSource } | null = null;
const debug: DebugHandle = { viewer: null, wiring: null, status: 'loading' };
window.__stackAtlas = debug;

function setStatus(s: Status) {
  debug.status = s;
  document.body.dataset.status = s;
}

async function fetchSamples(): Promise<SampleEntry[]> {
  try {
    const res = await fetch('samples/index.json');
    if (!res.ok) return [];
    const list: unknown = await res.json();
    return Array.isArray(list)
      ? list.filter(
          (x): x is SampleEntry => !!x && typeof x.name === 'string' && typeof x.path === 'string',
        )
      : [];
  } catch {
    return [];
  }
}

/** 3D の地図と配線図のどちらも片付ける */
function disposeAll() {
  viewer?.dispose();
  viewer = null;
  debug.viewer = null;
  wiring?.dispose();
  wiring = null;
  debug.wiring = null;
}

async function showEmpty(message?: string, note?: string) {
  disposeAll();
  const samples = await fetchSamples();
  app.replaceChildren(
    createEmptyState(openFile, {
      ...(message ? { message } : {}),
      ...(note ? { note } : {}),
      samples,
    }),
  );
  setStatus(message ? 'error' : 'empty');
}

interface PrevGraph {
  graph?: Graph;
  /** 前回の graph.json が v2 だった（配線図の差分の比較元） */
  graphV2?: GraphV2;
  /** 前回の graph.json を読めなかったときの警告 */
  issue?: ValidationIssue;
}

/** 前回の graph.json（差分の比較元）を LoadResult から取り出す。読めなければ警告にする */
function prevFrom(r: LoadResult): PrevGraph {
  if (r.graph) return { graph: r.graph };
  if (r.graphV2) return { graphV2: r.graphV2 };
  const first = r.issues.find((i) => i.level === 'error');
  return {
    issue: {
      level: 'warning',
      path: 'prev',
      message: `前回の graph.json（${r.source}）を読めないため差分は表示しません${first ? `: ${first.message}` : ''}`,
    },
  };
}

/** 画面を出し直した回数（隣の graph の確かめが終わる前に別の graph を開いたら、リンクを出さない） */
let shownSeq = 0;

function showResult(
  res: LoadResult,
  shared: SharedMemoSource,
  prev: PrevGraph = {},
  viewId?: string,
) {
  shownSeq++;
  overlays.replaceChildren();
  // 配線図は、v1 から変換した箱の単位の v2 で必ず出る警告（口の単位・置き場の項目の wireType unknown）を一覧に出さない
  const issues0 = res.v2 ? wiringIssues(res) : res.issues;
  const view = viewFor(res, hasWebGL());
  // 3D の地図は v1 どうしで比べる（前が v2 なら警告だけ）
  const prevIssue =
    prev.issue ??
    (view !== 'wiring' && prev.graphV2
      ? {
          level: 'warning' as const,
          path: 'prev',
          message:
            '前回の graph.json は version 2 のため差分は表示しません（3D の地図は version 1 どうしで比べます）',
        }
      : undefined);
  const allIssues = prevIssue ? [...issues0, prevIssue] : issues0;
  // 検証の一覧の枠（3D の地図と、配線図を描けなかったとき）。配線図は題名の横のリンク（D64）
  const showIssuesBox = () => {
    const box = createIssuesBox(allIssues, res.versionWarning, !!(res.graph ?? res.graphV2));
    if (box) overlays.append(box);
  };
  if (view === 'wiring') {
    showWiring(res, { shared, issues: allIssues, prev, viewId, showIssuesBox });
    return;
  }
  showIssuesBox();
  if (view === 'unrenderable' || !res.graph) {
    void showEmpty('graph.json を描画できませんでした。上の一覧を確認してください。');
    return;
  }
  if (view === 'no-webgl') {
    showNoWebGL();
    return;
  }
  const model = buildModel(res.graph);
  console.info(
    `[stack-atlas] ${res.source}: ノード ${model.nodes.length}、エッジ ${model.edges.length}、フロー ${model.flows.length}`,
  );
  disposeAll();
  app.replaceChildren();
  const scope = storageScope(res.graph.project?.name, res.source);
  current = { res, shared };
  viewer = new Viewer({
    root: app,
    model,
    load: res,
    memos: new SharedMemoStore(scope, shared.memos),
    ...(shared.api && shared.apiUrl ? { memoApiUrl: shared.apiUrl } : {}),
    shots: new LocalShotStore(scope),
    ...(prev.graph ? { prev: prev.graph } : {}),
    onOpenFile: openFile,
    onOpenPrev: openPrevFile,
  });
  debug.viewer = viewer;
  void showAltLink(res, 1, (link) => viewer?.setAltLink(link));
  document.title = res.graph.project?.name
    ? `${res.graph.project.name} — Stack Atlas`
    : 'Stack Atlas';
  setStatus('ready');
}

interface WiringStart {
  shared: SharedMemoSource;
  issues: ValidationIssue[];
  prev: PrevGraph;
  /** ?view= の id（URL から開いたときだけ） */
  viewId: string | undefined;
  /** 描けなかったときに検証の一覧の枠を出す */
  showIssuesBox: () => void;
}

/** graph v2 を配線図で開く（メモ・差分・views・検証の一覧のリンク。docs/18 §3.4） */
function showWiring(res: LoadResult, w: WiringStart) {
  if (!res.graphV2) {
    w.showIssuesBox();
    void showEmpty('graph.json（version 2）を描画できませんでした。上の一覧を確認してください。');
    return;
  }
  disposeAll();
  current = null;
  const scope = storageScope(res.graphV2.project?.name, res.source);
  try {
    wiring = mountWiring({
      root: app,
      graph: res.graphV2,
      source: res.source,
      ...(res.baseUrl ? { baseUrl: res.baseUrl } : {}),
      issues: w.issues,
      memos: {
        store: new SharedMemoStore(scope, w.shared.memos),
        ...(w.shared.api && w.shared.apiUrl ? { apiUrl: w.shared.apiUrl } : {}),
      },
      ...(w.prev.graphV2
        ? { prev: { v2: w.prev.graphV2 } }
        : w.prev.graph
          ? { prev: { v1: true } }
          : {}),
      ...(w.viewId ? { view: w.viewId } : {}),
      onViewChange: (id) => setParam('view', id),
    });
  } catch (e) {
    // 参照が解けない graph は索引が作れない（一覧のエラーを見て直す）
    w.showIssuesBox();
    void showEmpty(
      `graph.json（version 2）を描画できませんでした: ${e instanceof Error ? e.message : String(e)}`,
    );
    return;
  }
  debug.wiring = wiring.debug;
  void showAltLink(res, 2, (link) => wiring?.setAltLink(link));
  document.title = res.graphV2.project?.name
    ? `${res.graphV2.project.name} — 配線図 — Stack Atlas`
    : '配線図 — Stack Atlas';
  const { nodes, wires } = res.graphV2;
  console.info(`[stack-atlas] ${res.source}: 箱 ${nodes.length}、線 ${wires.length}（配線図）`);
  setStatus('ready');
}

/**
 * build の graph.json（v2）と graph.v1.json（v1）の隣があれば（HEAD で確かめる）、題名の横にリンクを出す。
 * URL から読んだときだけ（ファイルのドロップは隣が無い）。確かめている間に別の graph を開いたら何もしない
 */
async function showAltLink(
  res: LoadResult,
  version: 1 | 2,
  set: (link: { href: string; label: string } | null) => void,
) {
  if (!res.baseUrl) return;
  const alt = alternateGraph(res.source, location.href, version);
  if (!alt) return;
  const seq = shownSeq;
  try {
    const head = await fetch(alt.url, { method: 'HEAD', cache: 'no-store' });
    if (!graphExists(head)) return;
  } catch {
    return;
  }
  if (seq !== shownSeq) return;
  set({ href: alt.href, label: alt.label });
}

function showNoWebGL() {
  disposeAll();
  app.replaceChildren(
    h(
      'div',
      { class: 'empty' },
      h(
        'div',
        { class: 'card' },
        h('h1', {}, 'Stack Atlas'),
        h(
          'p',
          { class: 'emsg' },
          'このブラウザでは WebGL が使えないため、3D マップを表示できません。',
        ),
        h(
          'p',
          {},
          'ブラウザの設定でハードウェアアクセラレーション（WebGL）を有効にするか、別のブラウザで開いてください。',
        ),
      ),
    ),
  );
  setStatus('error');
}

/** URL のクエリを 1 つ書き換える（null で外す）。共有できるよう、views のメニューで選んだ view を ?view= に残す */
function setParam(name: string, value: string | null) {
  const url = new URL(location.href);
  if (value === null) url.searchParams.delete(name);
  else url.searchParams.set(name, value);
  if (url.href !== location.href) history.replaceState(null, '', url);
}

/** URL から指定のクエリを外す（再読み込みで別の graph に戻らないように） */
function dropParams(...names: string[]) {
  const url = new URL(location.href);
  if (!names.some((n) => url.searchParams.has(n))) return;
  for (const n of names) url.searchParams.delete(n);
  history.replaceState(null, '', url);
}

async function openFile(f: File) {
  setStatus('loading');
  showResult(await loadGraphFromFile(f), { memos: {}, api: false });
  dropParams('graph', 'prev', 'view');
}

/** 「前回と比較…」: 今の graph はそのままに、選んだファイルを比較元にして作り直す */
async function openPrevFile(f: File) {
  if (!current) return;
  const { res, shared } = current;
  setStatus('loading');
  showResult(res, shared, prevFrom(await loadGraphFromFile(f)));
  dropParams('prev');
}

async function start() {
  const url = graphUrlFromSearch(location.search, location.href);
  // ドロップとファイル選択は WebGL が無くても受け付ける（配線図の v2 は SVG なので開ける）。
  // 3D の地図（v1）は、読んでから WebGL が無ければ showNoWebGL
  installDropTarget(openFile);
  const plan = startPlan(!!url, hasWebGL());
  if (plan.kind === 'empty' || !url) {
    await showEmpty(undefined, plan.kind === 'empty' ? plan.note : undefined);
    return;
  }
  app.replaceChildren(h('div', { class: 'loading' }, 'graph.json を読み込み中…'));
  // 差分（?prev=）: 3D の地図は v1 どうし、配線図は v2 どうし（前が v1 なら題名の横に文言だけ）
  const prevUrl = prevUrlFromSearch(location.search, location.href);
  const [res, prevRes] = await Promise.all([
    loadGraphFromUrl(url),
    prevUrl ? loadGraphFromUrl(prevUrl) : Promise.resolve(null),
  ]);
  const shared =
    res.graph || res.graphV2
      ? await loadSharedMemos(res.baseUrl, location.href)
      : { memos: {}, api: false };
  const viewId = new URLSearchParams(location.search).get('view') ?? undefined;
  showResult(res, shared, prevRes ? prevFrom(prevRes) : {}, viewId);
}

void start();
