/**
 * 画面の変化の差（docs/27 §4.3）。一覧を丸ごと描き直すアプリでは、全部が「消えて、増えた」に見える。
 * 同じ中身の「消えた」と「増えた」を打ち消して、差だけを残す。文字の変化は、変わる前とあとが同じなら捨てる
 */
import type { LiveChange } from './events.js';

export function netChanges<T extends LiveChange>(changes: readonly T[]): T[] {
  const drop = new Set<number>();
  /** 中身 → まだ打ち消されていない出来事の番号（消えた・増えたの別に） */
  const open = { added: new Map<string, number[]>(), removed: new Map<string, number[]>() };
  for (const [i, c] of changes.entries()) {
    if (c.kind === 'text') {
      if (c.before === c.text) drop.add(i);
      continue;
    }
    if (c.text === '') continue; // 文字の無い要素は、中身で見分けられないので、打ち消さない
    const partner = open[c.kind === 'added' ? 'removed' : 'added'].get(c.text);
    if (partner?.length) {
      drop.add(partner.pop()!);
      drop.add(i);
    } else {
      const list = open[c.kind].get(c.text) ?? [];
      list.push(i);
      open[c.kind].set(c.text, list);
    }
  }
  return changes.filter((_, i) => !drop.has(i));
}
