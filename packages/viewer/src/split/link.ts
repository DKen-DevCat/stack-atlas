// 2 面（3D の地図 ⇄ 配線図。Phase 8-6、docs/20）の写しの規則。DOM に触らない（単体テストできる）。
// - 地図のノードのクリック → 配線図の選択（docs/20 §5.1 #7）。箱そのもの・host はそのまま、group は中の箱ごとにたどる
// - `?sel=`（docs/20 §5.1 #16）: 箱・地図のノード・host の id。`?view=` が勝つ。選択から書く値は、箱・host・地図の group だけ
// - メモのキー（docs/20 §5.1 #2）: 地図のノードの id から @runtime を外したもの
import type { GraphV2 } from '@stack-atlas/schema';
import { stripRuntime, type MapProjection, type Selection } from '@stack-atlas/wiring';

/** 地図のノード → 配線図の選択。地図に無いノードは null */
export function selectionForUnit(p: MapProjection, unit: string): Selection | null {
  const kind = p.unitKind.get(unit);
  if (kind === 'box') return { kind: 'box', id: unit };
  if (kind === 'host') return { kind: 'host', id: unit };
  if (kind === 'group') {
    const name = p.graph.nodes.find((n) => n.id === unit)?.name;
    // id はメモの札のキー（@runtime を外した id）。どの写しを選んだかは members で分かる
    return {
      kind: 'group',
      id: stripRuntime(unit),
      members: p.members.get(unit) ?? [],
      ...(name ? { label: name } : {}),
    };
  }
  return null;
}

/**
 * `?sel=` の値 → 配線図の選択。地図のノード（`group:` の付いた id・`@runtime` の写しも）を先に見て、次に host、次に箱。
 * 解けなければ null
 */
export function resolveSel(
  p: MapProjection,
  g: Pick<GraphV2, 'nodes'>,
  raw: string,
): Selection | null {
  if (!raw) return null;
  if (p.unitKind.has(raw)) return selectionForUnit(p, raw);
  const hosts = new Set(g.nodes.flatMap((n) => (n.host ? [n.host] : [])));
  if (hosts.has(raw)) return { kind: 'host', id: raw };
  if (g.nodes.some((n) => n.id === raw)) return { kind: 'box', id: raw };
  return null;
}

/** 配線図の選択 → `?sel=` の値。箱・host・地図の group だけ（項目・線・型の選択は書かない = null） */
export function selParam(p: MapProjection, sel: Selection | null): string | null {
  if (!sel) return null;
  if (sel.kind === 'box' || sel.kind === 'host') return sel.id;
  if (sel.kind === 'group') {
    const m = sel.members[0];
    return (m !== undefined ? p.unitOf.get(m) : undefined) ?? sel.id;
  }
  return null;
}

/** `?pane=wiring` で配線図だけ（e2e の 1 面のテストと、2 面を使わないとき。docs/20 §5.1 #17） */
export function wiringOnly(search: string): boolean {
  return new URLSearchParams(search).get('pane') === 'wiring';
}

/** 地図のノード（孤立メモの判定と「移す…」の候補に足す。docs/20 §5.1 #12） */
export function mapTargets(p: MapProjection): { id: string; name: string }[] {
  return p.graph.nodes.map((n) => ({ id: n.id, name: n.name }));
}

/** メモのキー（@runtime を外した id） */
export const memoKeyOf = (id: string): string => stripRuntime(id);
