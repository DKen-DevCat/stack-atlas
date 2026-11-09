/**
 * build の出力（docs/16 §10）の 2 つの graph を行き来する: graph.json（v2。配線図）と graph.v1.json（v1。3D の地図）。
 * 配線図は graph.v1.json が隣にあれば左上に「3D の地図」、3D の地図は graph.v1.json を開いていて graph.json があれば
 * 「配線図」を出す。DOM に触らない（単体テストできる）。有無の確認（HEAD）は main.ts
 */

/** 配線図で開く build の graph と、3D の地図で開く build の graph のファイル名 */
export const WIRING_GRAPH = 'graph.json';
export const MAP_GRAPH = 'graph.v1.json';

export interface AlternateGraph {
  /** 隣の graph の絶対 URL（有無の確認に使う） */
  url: string;
  /** 開くページの URL（`?graph=` だけ差し替え、`?prev=` は外す） */
  href: string;
  /** リンクの文言 */
  label: '3D の地図' | '配線図';
}

const lastSegment = (pathname: string) => pathname.slice(pathname.lastIndexOf('/') + 1);

/**
 * 今開いている graph（`graphUrl`、絶対 URL）の隣の graph。v2 の graph.json なら graph.v1.json（3D の地図）、
 * v1 の graph.v1.json なら graph.json（配線図）。それ以外（サンプル・手書きの graph）は null。
 * `?graph=` の値が相対パスなら、最後の名前だけを差し替えた相対パスにする（`./graph.json` → `./graph.v1.json`）
 */
export function alternateGraph(
  graphUrl: string,
  pageHref: string,
  version: 1 | 2,
): AlternateGraph | null {
  let graph: URL;
  let page: URL;
  try {
    graph = new URL(graphUrl);
    page = new URL(pageHref);
  } catch {
    return null;
  }
  const name = lastSegment(graph.pathname);
  const to =
    version === 2 && name === WIRING_GRAPH
      ? { file: MAP_GRAPH, label: '3D の地図' as const }
      : version === 1 && name === MAP_GRAPH
        ? { file: WIRING_GRAPH, label: '配線図' as const }
        : null;
  if (!to) return null;
  const target = new URL(to.file, graph);
  target.search = graph.search;
  const raw = page.searchParams.get('graph');
  let param = target.href;
  if (raw) {
    try {
      if (new URL(raw, page).href === graph.href) {
        // ?graph= の書き方（相対パス）を保つ。クエリ・フラグメントの付いた値は絶対 URL にする
        const m = /^(.*\/)?([^/?#]*)$/.exec(raw);
        if (m && m[2] === name) param = `${m[1] ?? ''}${to.file}`;
      }
    } catch {
      // 読めない ?graph= は絶対 URL で置き換える
    }
  }
  const next = new URL(page.href);
  next.searchParams.set('graph', param);
  next.searchParams.delete('prev');
  next.hash = '';
  return { url: target.href, href: next.href, label: to.label };
}

/**
 * HEAD の応答から、隣の graph があるとみなすか。SPA の fallback（無いパスに index.html を 200 で返す静的サーバ。
 * vite preview など）を「ある」と取り違えないよう、HTML は「無い」にする
 */
export function graphExists(res: { ok: boolean; headers: { get(name: string): string | null } }) {
  if (!res.ok) return false;
  const type = res.headers.get('content-type') ?? '';
  return !/text\/html/i.test(type);
}
