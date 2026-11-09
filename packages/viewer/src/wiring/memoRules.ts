// 配線図のメモの規則（docs/18 §3.4）。DOM に触らない（単体テストできる）。
// メモのキーは 3D の地図と同じ（memos.json。v1 のノード id）。配線図では箱 id・型 id・group（v1 の箱の id。D56）を見る
import type { GraphIndex, Rect, Selection } from '@stack-atlas/wiring';
import { memoOf } from '../ui/memos';

export type MemoMap = Readonly<Record<string, string>>;

/** id に空でないメモがあるか（自分のプロパティだけ。group が `constructor` などでも落ちない） */
const hasMemo = (memos: MemoMap, id: string | undefined): id is string =>
  id !== undefined && (memoOf(memos, id)?.trim() ?? '') !== '';

/** 箱の group（v1 の箱の id。箱 id と同じなら無いのと同じ） */
const groupOf = (index: GraphIndex, id: string): string | undefined => {
  const g = index.nodes.get(id)?.node.group;
  return g !== undefined && g !== id ? g : undefined;
};

/**
 * 右下の角を折って描く箱: 箱 id か、その箱の group にメモがある箱（group のメモも札に出るので、印が無いと見つけられない）。
 * host の枠になる箱は箱として描かないので入れない
 */
export function memoBoxIds(index: GraphIndex, memos: MemoMap): Set<string> {
  const out = new Set<string>();
  for (const n of index.nodes.values()) {
    if (index.hosts.has(n.id)) continue;
    if (hasMemo(memos, n.id) || hasMemo(memos, groupOf(index, n.id))) out.add(n.id);
  }
  return out;
}

/** 孤立メモ: 箱（host の枠を含む）・型・group のどれの id でもないメモ。id の昇順 */
export function memoOrphans(index: GraphIndex, memos: MemoMap): string[] {
  const known = new Set<string>([...index.nodes.keys(), ...index.types.keys()]);
  for (const n of index.nodes.values()) if (n.node.group !== undefined) known.add(n.node.group);
  return Object.keys(memos)
    .filter((id) => !known.has(id) && hasMemo(memos, id))
    .sort();
}

export interface MemoTarget {
  /** メモのキー */
  id: string;
  /** 札の見出し（箱・型の名前、group は値そのもの） */
  label: string;
  role: 'box' | 'type' | 'group';
}

/**
 * 選択から札に並べるメモ。箱・項目・host の枠は「その箱のメモ（無くても書けるよう空で出す）」＋「group のメモ（あれば）」、
 * 型の横断面は型の id のメモ。線の選択と選択なしは札を出さない
 */
export function memoTargets(
  index: GraphIndex,
  selection: Selection | null,
  memos: MemoMap,
): MemoTarget[] {
  if (!selection) return [];
  if (selection.kind === 'type') {
    const t = index.types.get(selection.typeRef);
    return [{ id: selection.typeRef, label: t?.name ?? selection.typeRef, role: 'type' }];
  }
  if (selection.kind === 'wire') return [];
  const id = selection.kind === 'item' ? index.items.get(selection.ref)?.node.id : selection.id;
  const n = id === undefined ? undefined : index.nodes.get(id);
  if (!n) return [];
  const out: MemoTarget[] = [{ id: n.id, label: n.node.name, role: 'box' }];
  const g = groupOf(index, n.id);
  if (hasMemo(memos, g)) out.push({ id: g, label: g, role: 'group' });
  return out;
}

/** 折った角の大きさ（px） */
export const FOLD = 10;
/** 角を切る clipPath を箱の外へ広げる幅（光る箱の drop-shadow を切らないように） */
const MARGIN = 20;

const r1 = (v: number) => Math.round(v * 10) / 10;

/**
 * 右下の角を折った形。`clip` は角を斜めに切った多角形（clipPath の中身。箱の外は MARGIN だけ広げる）、
 * `fold` は折り返し（切った線を斜辺にした直角三角形。箱の中へ折れている）の path の d
 */
export function memoFold(b: Rect): { clip: string; fold: string } {
  const cx = b.x + b.w;
  const cy = b.y + b.h;
  const x0 = b.x - MARGIN;
  const y0 = b.y - MARGIN;
  const x1 = cx + MARGIN;
  const y1 = cy + MARGIN;
  const clip = `M${r1(x0)},${r1(y0)} L${r1(x1)},${r1(y0)} L${r1(x1)},${r1(cy - FOLD - MARGIN)} L${r1(cx - FOLD - MARGIN)},${r1(y1)} L${r1(x0)},${r1(y1)} Z`;
  const fold = `M${r1(cx - FOLD)},${r1(cy)} L${r1(cx - FOLD)},${r1(cy - FOLD)} L${r1(cx)},${r1(cy - FOLD)} Z`;
  return { clip, fold };
}
