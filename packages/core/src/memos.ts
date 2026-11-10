/**
 * チーム共有メモ（docs/09 §3.5）。正は解析対象リポジトリの `.stack-atlas/memos.json`（`Record<nodeId, string>`）。
 */
import type { Graph } from '@stack-atlas/schema';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { RepoContext } from './types.js';
import { isPlainObject } from './util.js';

export type Memos = Record<string, string>;

export const MEMOS_PATH = join('.stack-atlas', 'memos.json');

export function memosFile(root: string): string {
  return join(root, MEMOS_PATH);
}

export function isMemos(v: unknown): v is Memos {
  return isPlainObject(v) && Object.values(v).every((x) => typeof x === 'string');
}

/** memos.json を読む。無ければ `{}`。壊れていれば警告して `{}`、文字列でない値は捨てる */
export function loadMemos(ctx: Pick<RepoContext, 'root' | 'log'>): Memos {
  const file = memosFile(ctx.root);
  if (!existsSync(file)) return {};
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    ctx.log.warn(`${file} を JSON として読めません（${(e as Error).message}）`);
    return {};
  }
  if (!isPlainObject(raw)) {
    ctx.log.warn(`${file} は { "ノードID": "メモ" } の形にしてください`);
    return {};
  }
  const out: Memos = {};
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v === 'string') out[k] = v;
    else ctx.log.warn(`${file}: "${k}" のメモが文字列ではないので無視します`);
  }
  return out;
}

/** memos.json を書く（キー順で整形、空文字のメモは消す） */
export function saveMemos(root: string, memos: Memos): string {
  const file = memosFile(root);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, serializeMemos(memos));
  return file;
}

export function serializeMemos(memos: Memos): string {
  const sorted: Memos = {};
  for (const k of Object.keys(memos).sort()) if (memos[k]!.trim()) sorted[k] = memos[k]!;
  return `${JSON.stringify(sorted, null, 2)}\n`;
}

/** graph に無いノード ID を指しているメモの ID */
export function orphanMemos(memos: Memos, graph: Pick<Graph, 'nodes'>): string[] {
  const ids = new Set(graph.nodes.map((n) => n.id));
  return Object.keys(memos).filter((k) => !ids.has(k));
}
