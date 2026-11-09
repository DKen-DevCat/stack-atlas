/**
 * 解析対象の repo の `.stack-atlas/` に置く補いのファイル（views.yaml・graph/*.v2.yaml・screens/*.regions.yaml。docs/19 §1）を
 * 読む入口。ハーネスのエージェントが書くファイルなので信用しない: 途中のどの段もシンボリックリンクなら読まない、O_NOFOLLOW で
 * 開いて大きさの上限の中だけ読む、YAML の別名の展開に上限を付ける（openapi と同じ 100。倍々の別名で指数時間にしない）
 */
import { lstatSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parseDocument } from 'yaml';
import { readNoFollowResult } from './fsafe.js';

/** 補いのファイルの置き場（config のあるディレクトリの下） */
export const HARNESS_DIR = '.stack-atlas';
/** YAML の別名の展開の上限（yaml の既定。openapi と同じ） */
export const MAX_YAML_ALIASES = 100;

export type LocalReadResult =
  | { text: string; file: string }
  | { why: 'missing' | 'symlink' | 'not-file' | 'too-large' | 'unreadable'; file: string };

/** root/<segments...> の途中の段（root は含まない）と最後がシンボリックリンクなら symlink。無ければ missing */
function walk(
  root: string,
  segments: readonly string[],
  last: 'file' | 'dir',
): { path: string; why?: 'missing' | 'symlink' | 'not-file' } {
  let cur = root;
  for (const [k, seg] of segments.entries()) {
    cur = join(cur, seg);
    const st = lstatSync(cur, { throwIfNoEntry: false });
    if (!st) return { path: cur, why: 'missing' };
    if (st.isSymbolicLink()) return { path: cur, why: 'symlink' };
    const isLast = k === segments.length - 1;
    if (!isLast && !st.isDirectory()) return { path: cur, why: 'missing' };
    if (isLast && (last === 'file' ? !st.isFile() : !st.isDirectory()))
      return { path: cur, why: 'not-file' };
  }
  return { path: cur };
}

/** root/<segments...> の普通のファイルを、シンボリックリンクを辿らずに maxBytes まで読む（UTF-8） */
export function readLocalFile(
  root: string,
  segments: readonly string[],
  maxBytes: number,
): LocalReadResult {
  const w = walk(root, segments, 'file');
  if (w.why) return { why: w.why, file: w.path };
  const r = readNoFollowResult(w.path, maxBytes);
  if ('data' in r) return { text: r.data.toString('utf8'), file: w.path };
  return { why: r.why, file: w.path };
}

/** root/<segments...> のディレクトリの中の名前（シンボリックリンクの段があれば symlink、無ければ missing） */
export function listLocalDir(
  root: string,
  segments: readonly string[],
): { names: string[]; dir: string } | { why: 'missing' | 'symlink' | 'not-file'; dir: string } {
  const w = walk(root, segments, 'dir');
  if (w.why) return { why: w.why, dir: w.path };
  return { names: readdirSync(w.path).sort(), dir: w.path };
}

/** YAML を読む（別名の展開は MAX_YAML_ALIASES まで）。構文エラーと上限超えは error */
export function parseLocalYaml(text: string): { value: unknown } | { error: string } {
  try {
    const doc = parseDocument(text, { uniqueKeys: true });
    if (doc.errors.length) return { error: doc.errors[0]!.message };
    return { value: doc.toJS({ maxAliasCount: MAX_YAML_ALIASES }) as unknown };
  } catch (e) {
    return { error: (e as Error).message };
  }
}

/** 読めなかった理由の文 */
export const whyText = (why: string): string =>
  ({
    missing: 'ありません',
    symlink: 'シンボリックリンクなので読みません',
    'not-file': '普通のファイル・ディレクトリではありません',
    'too-large': '大きすぎるので読みません',
    unreadable: '読めません',
  })[why] ?? why;
