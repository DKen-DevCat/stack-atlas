/**
 * `node.meta` の規約（抽出器どうし・core のルールが読み書きするキー）。
 * 抽出器の担当者と合意済みの形。ビューアは基本的に表示するだけ。
 *
 * | キー | 付けるノード | 形 |
 * |---|---|---|
 * | `meta.extractors` | すべて | `string[]`（そのノードを出した抽出器名。マージで和集合、出現順） |
 * | `meta.cdktf` | infra | `{ type, logicalId, path, stack }`（例 `{ type: 'aws_lambda_function', logicalId: 'next', path: 'web/next', stack: 'web' }`） |
 * | `meta.deployApp` | Next を載せている infra ノード（Lambda でも S3 でも。config.deploy の `app: next` で core が付ける） | `'next'` |
 * | `meta.go` | Go のパッケージノード | `{ pkg }`（module 相対パス。例 `{ pkg: 'cmd/api' }`。config.deploy の `go` の照合に使う） |
 * | `meta.next` | route / layout | `{ revalidate?: number \| false; dynamic?: string; segment: string }` |
 * | `meta.ts` | コード由来のノード（comp / hook / lib / type / handler / schema） | `{ exportName, symbolKind }` |
 * | `meta.api` | handler | `{ method, path }`（例 `{ method: 'GET', path: '/races/{id}' }`） |
 * | `meta.apiCalls` | api client の lib ノード | `Array<{ method, path }>` |
 *
 * 複数 repo（docs/12 §3.2）: `file` は `<repo>/<path>`。抽出器は repo 相対パスを返せばパイプラインが修飾する。
 * upstream の `file` を自分の repo のパスと比べるときは `fileInRepo(ctx, node.file)`（repo.ts）を使う。
 *
 * 分類（config.classify, classify.ts）:
 * - 抽出器はノードを作るときに `classifyKind(ctx, repoRelativeFile, defaultKind)` で kind を決める（ID の接頭辞も合わせる）
 * - パイプラインはマージ後に `applyClassify()` で kind / layer を上書きする（ID は変えない）
 * - glob の照合は `matchGlob(path, glob)`（repo 相対パス。`**` `*` `?` `{a,b}`）
 *
 * 読み取りは下の `get*Meta()` を使う（形が違えば undefined を返すので、抽出器の出力が多少ずれても落ちない）。
 */
import type { PartialNode } from './types.js';

export interface CdktfMeta {
  /** Terraform のリソース型。例 `aws_lambda_function` */
  type: string;
  /** cdk.tf.json 上の論理 ID */
  logicalId: string;
  /** construct path。例 `web/next` */
  path: string;
  /** スタック名。例 `web` */
  stack: string;
}

export interface NextMeta {
  /** route segment config の `revalidate`（秒）。`false` は無期限 */
  revalidate?: number | false;
  /** route segment config の `dynamic`。例 `force-dynamic` */
  dynamic?: string;
  /** app ディレクトリからのセグメントパス。例 `/races/[id]` */
  segment: string;
}

export type TsSymbolKind = 'function' | 'const' | 'type' | 'interface' | 'class' | 'zod';

export interface TsMeta {
  exportName: string;
  symbolKind: TsSymbolKind;
}

export interface ApiEndpoint {
  /** 大文字の HTTP メソッド。例 `GET` */
  method: string;
  /** API Gateway 形式のパス。例 `/races/{id}` */
  path: string;
}

/** 規約上の meta 全体（すべて省略可。抽出器固有のキーも自由に足してよい） */
export interface AtlasMeta {
  extractors?: string[];
  cdktf?: CdktfMeta;
  deployApp?: 'next';
  next?: NextMeta;
  ts?: TsMeta;
  api?: ApiEndpoint;
  apiCalls?: ApiEndpoint[];
  [key: string]: unknown;
}

type WithMeta = Pick<PartialNode, 'meta'>;

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const isEndpoint = (v: unknown): v is ApiEndpoint =>
  isObj(v) && typeof v.method === 'string' && typeof v.path === 'string';

/** meta を AtlasMeta として読む（無ければ空オブジェクト） */
export function atlasMeta(node: WithMeta): AtlasMeta {
  return (node.meta ?? {}) as AtlasMeta;
}

export function getExtractorsMeta(node: WithMeta): string[] {
  const v = node.meta?.extractors;
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

export function getCdktfMeta(node: WithMeta): CdktfMeta | undefined {
  const v = node.meta?.cdktf;
  return isObj(v) && typeof v.type === 'string' ? (v as unknown as CdktfMeta) : undefined;
}

export function getDeployApp(node: WithMeta): 'next' | undefined {
  return node.meta?.deployApp === 'next' ? 'next' : undefined;
}

export function getNextMeta(node: WithMeta): NextMeta | undefined {
  const v = node.meta?.next;
  return isObj(v) ? (v as unknown as NextMeta) : undefined;
}

/** `meta.next.revalidate` が正の数ならその秒数 */
export function getRevalidateSeconds(node: WithMeta): number | undefined {
  const r = getNextMeta(node)?.revalidate;
  return typeof r === 'number' && Number.isFinite(r) && r > 0 ? r : undefined;
}

export function getTsMeta(node: WithMeta): TsMeta | undefined {
  const v = node.meta?.ts;
  return isObj(v) && typeof v.exportName === 'string' ? (v as unknown as TsMeta) : undefined;
}

export function getApiMeta(node: WithMeta): ApiEndpoint | undefined {
  const v = node.meta?.api;
  return isEndpoint(v) ? v : undefined;
}

export function getApiCallsMeta(node: WithMeta): ApiEndpoint[] {
  const v = node.meta?.apiCalls;
  return Array.isArray(v) ? v.filter(isEndpoint) : [];
}

/** meta.extractors に name を（無ければ）足す。node.meta を書き換える */
export function addExtractorName<T extends WithMeta>(node: T, name: string): T {
  const list = getExtractorsMeta(node);
  if (!list.includes(name)) list.push(name);
  node.meta = { ...(node.meta ?? {}), extractors: list };
  return node;
}
