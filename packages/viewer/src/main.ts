/**
 * エントリポイント: graph.json の入力（?graph=、ドロップ、ファイル選択）→ 検証 → Viewer。
 */
import './style.css';
import { Viewer } from './app';
import { buildModel } from './graph/model';
import {
  graphUrlFromSearch,
  loadGraphFromFile,
  loadGraphFromUrl,
  type LoadResult,
} from './graph/load';
import { hasWebGL } from './scene/renderer';
import { h } from './ui/dom';
import { createEmptyState, installDropTarget, type SampleEntry } from './ui/emptyState';
import { createIssuesBox } from './ui/issues';
import { LocalMemoStore, LocalShotStore, storageScope } from './ui/memos';

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

function showResult(res: LoadResult) {
  overlays.replaceChildren();
  const issues = createIssuesBox(res.issues, res.versionWarning, !!res.graph);
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
  viewer = new Viewer({
    root: app,
    model,
    load: res,
    memos: new LocalMemoStore(scope),
    shots: new LocalShotStore(scope),
    onOpenFile: openFile,
  });
  debug.viewer = viewer;
  document.title = res.graph.project?.name
    ? `${res.graph.project.name} — Stack Atlas`
    : 'Stack Atlas';
  setStatus('ready');
}

async function openFile(f: File) {
  setStatus('loading');
  showResult(await loadGraphFromFile(f));
  // ファイルから開いたら ?graph= は外す（再読み込みで別の graph に戻らないように）
  const url = new URL(location.href);
  if (url.searchParams.has('graph')) {
    url.searchParams.delete('graph');
    history.replaceState(null, '', url);
  }
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
  showResult(await loadGraphFromUrl(url));
}

void start();
