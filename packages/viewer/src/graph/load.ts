/**
 * graph.json の入力（?graph=URL、ドラッグ＆ドロップ、ファイル選択）と検証。
 * ここにある関数は DOM 要素に触らない（fetch と File は使う）。画面への表示は ui/ 側。
 */
import { validateGraph, type Graph, type ValidationIssue } from '@stack-atlas/schema';

export const SUPPORTED_VERSION = 1;

export interface LoadResult {
  /** スキーマを通った graph。参照エラーがあっても返す（docs/08 D7） */
  graph?: Graph;
  /** 検証で見つかった問題（エラー・警告） */
  issues: ValidationIssue[];
  /** 未知の version だったときの警告文 */
  versionWarning?: string;
  /** スクショなど相対パスの基準。ファイルから読んだときは undefined */
  baseUrl?: string;
  /** 表示・メモのキーに使う出どころ（URL かファイル名） */
  source: string;
}

/**
 * JSON テキストを検証して LoadResult にする。
 * 未知の version は警告を出し、v1 として読めるか試す（前方互換）。
 */
export function parseGraphText(text: string, source: string, baseUrl?: string): LoadResult {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (e) {
    return {
      issues: [{ level: 'error', path: '/', message: `JSON として読めません: ${errMsg(e)}` }],
      source,
      ...(baseUrl ? { baseUrl } : {}),
    };
  }
  let versionWarning: string | undefined;
  if (isRecord(json) && json.version !== SUPPORTED_VERSION) {
    versionWarning = `graph.json の version ${JSON.stringify(json.version)} はこのビューアの対応範囲外です（対応: ${SUPPORTED_VERSION}）。v${SUPPORTED_VERSION} として読める範囲で描画します。`;
    json = { ...json, version: SUPPORTED_VERSION };
  }
  const res = validateGraph(json);
  const out: LoadResult = { issues: res.errors, source };
  if (res.graph) out.graph = res.graph;
  if (versionWarning) out.versionWarning = versionWarning;
  if (baseUrl) out.baseUrl = baseUrl;
  return out;
}

/** `?graph=` の値をページの URL 基準で絶対 URL にする。指定がなければ null */
export function graphUrlFromSearch(search: string, pageHref: string): string | null {
  return urlParam(search, pageHref, 'graph');
}

/** `?prev=`（差分表示の比較元の graph.json）の値をページの URL 基準で絶対 URL にする */
export function prevUrlFromSearch(search: string, pageHref: string): string | null {
  return urlParam(search, pageHref, 'prev');
}

function urlParam(search: string, pageHref: string, name: string): string | null {
  const v = new URLSearchParams(search).get(name);
  if (!v) return null;
  try {
    return new URL(v, pageHref).href;
  } catch {
    return null;
  }
}

const ABSOLUTE_RE = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i;

/**
 * graph.json 内の相対パス（screen.screenshot など）を解決する。
 * - 絶対 URL（http:, data:, blob: など）はそのまま
 * - baseUrl があればそれ基準
 * - baseUrl がない（ファイルから読んだ）なら相対パスは解決できないので undefined
 */
export function resolveAssetUrl(path: string | undefined, baseUrl?: string): string | undefined {
  if (!path) return undefined;
  if (ABSOLUTE_RE.test(path)) return path;
  if (!baseUrl) return undefined;
  try {
    return new URL(path, baseUrl).href;
  } catch {
    return undefined;
  }
}

export async function loadGraphFromUrl(url: string): Promise<LoadResult> {
  let res: Response;
  try {
    res = await fetch(url);
  } catch (e) {
    return fail(url, `graph.json を取得できません（${url}）: ${errMsg(e)}`);
  }
  if (!res.ok) return fail(url, `graph.json を取得できません（${url}）: HTTP ${res.status}`);
  return parseGraphText(await res.text(), url, url);
}

export async function loadGraphFromFile(file: Blob & { name?: string }): Promise<LoadResult> {
  const name = file.name ?? 'graph.json';
  try {
    return parseGraphText(await file.text(), name);
  } catch (e) {
    return fail(name, `ファイルを読めません（${name}）: ${errMsg(e)}`);
  }
}

/** 検証結果の要約（件数） */
export function summarizeIssues(issues: readonly ValidationIssue[]): {
  errors: number;
  warnings: number;
} {
  let errors = 0;
  let warnings = 0;
  for (const i of issues) {
    if (i.level === 'error') errors++;
    else warnings++;
  }
  return { errors, warnings };
}

function fail(source: string, message: string): LoadResult {
  return { issues: [{ level: 'error', path: '/', message }], source };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
