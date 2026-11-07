/**
 * エントリポイント: graph.json の入力（?graph=、ドロップ、ファイル選択）→ 検証 → Viewer。
 * - `?prev=<URL>`（または「開く ▾ → 前回と比較…」）で前回の graph.json を読み、差分を色分けする
 * - graph.json と同じディレクトリの memos.json（と serve の GET /api/memos）を共有メモとして読む
 */
import './style.css';
import type { Graph, ValidationIssue } from '@stack-atlas/schema';
import { Viewer } from './app';
import { buildModel } from './graph/model';
import {
  graphUrlFromSearch,
  prevUrlFromSearch,
  loadGraphFromFile,
  loadGraphFromUrl,
  type LoadResult,
} from './graph/load';
import { hasWebGL } from './scene/renderer';
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
/** 今表示している graph（「前回と比較…」で作り直すため） */
let current: { res: LoadResult; shared: SharedMemoSource } | null = null;
const debug: DebugHandle = { viewer: null, status: 'loading' };
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

async function showEmpty(message?: string) {
  viewer?.dispose();
  viewer = null;
  debug.viewer = null;
  const samples = await fetchSamples();
  app.replaceChildren(createEmptyState(openFile, { ...(message ? { message } : {}), samples }));
  setStatus(message ? 'error' : 'empty');
}

interface PrevGraph {
  graph?: Graph;
  /** 前回の graph.json を読めなかったときの警告 */
  issue?: ValidationIssue;
}

/** 前回の graph.json（差分の比較元）を LoadResult から取り出す。読めなければ警告にする */
function prevFrom(r: LoadResult): PrevGraph {
  if (r.graph) return { graph: r.graph };
  const first = r.issues.find((i) => i.level === 'error');
  return {
    issue: {
      level: 'warning',
      path: 'prev',
      message: `前回の graph.json（${r.source}）を読めないため差分は表示しません${first ? `: ${first.message}` : ''}`,
    },
  };
}

function showResult(res: LoadResult, shared: SharedMemoSource, prev: PrevGraph = {}) {
  overlays.replaceChildren();
  const allIssues = prev.issue ? [...res.issues, prev.issue] : res.issues;
  const issues = createIssuesBox(allIssues, res.versionWarning, !!res.graph);
  if (issues) overlays.append(issues);
  if (!res.graph) {
    void showEmpty('graph.json を描画できませんでした。上の一覧を確認してください。');
    return;
  }
  const model = buildModel(res.graph);
  console.info(
    `[stack-atlas] ${res.source}: ノード ${model.nodes.length}、エッジ ${model.edges.length}、フロー ${model.flows.length}`,
  );
  viewer?.dispose();
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
  document.title = res.graph.project?.name
    ? `${res.graph.project.name} — Stack Atlas`
    : 'Stack Atlas';
  setStatus('ready');
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
  dropParams('graph', 'prev');
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
  if (!hasWebGL()) {
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
    return;
  }
  installDropTarget(openFile);
  const url = graphUrlFromSearch(location.search, location.href);
  if (!url) {
    await showEmpty();
    return;
  }
  app.replaceChildren(h('div', { class: 'loading' }, 'graph.json を読み込み中…'));
  const prevUrl = prevUrlFromSearch(location.search, location.href);
  const [res, prevRes] = await Promise.all([
    loadGraphFromUrl(url),
    prevUrl ? loadGraphFromUrl(prevUrl) : Promise.resolve(null),
  ]);
  const shared = res.graph
    ? await loadSharedMemos(res.baseUrl, location.href)
    : { memos: {}, api: false };
  showResult(res, shared, prevRes ? prevFrom(prevRes) : {});
}

void start();
