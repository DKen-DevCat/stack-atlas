// 選択（docs/15 §3.5 の 7 操作）。箱・項目・線・host の枠・型 → 光るもの（Lit）と球の始点
import type { GraphIndex, IndexedItem, IndexedNode } from './graph-index.js';
import { emptyLit, mergeLit, traverse, type Lit, type Segment } from './traverse.js';
import { itemActive, type VariantState } from './variants.js';

export type Selection =
  | { kind: 'box'; id: string; downOnly?: boolean }
  | { kind: 'item'; ref: string; downOnly?: boolean }
  | { kind: 'wire'; from: string; to: string }
  | { kind: 'host'; id: string }
  | { kind: 'type'; typeRef: string };

export interface LitSelection extends Lit {
  selection: Selection;
  /** 始点の箱（箱・枠をクリックしたとき） */
  startBoxes: Set<string>;
  /** 始点の項目の ref（項目・型をクリックしたとき） */
  startItems: Set<string>;
  /** 球の出発点（時刻 0 の項目）。型の横断面では空 */
  flowStarts: Set<string>;
  /** 線をクリックしたときの、その線の区間のキー */
  startSeg?: string;
  /** 流れをたどる選択か（型の横断面は false） */
  flows: boolean;
}

const activeRoots = (index: GraphIndex, state: VariantState, n: IndexedNode) =>
  n.roots.filter((i) => itemActive(index, state, i));

/**
 * 選択を光るものに変える。
 * - box: 箱の全項目を始点に、下流＋上流（downOnly なら下流だけ）
 * - item: その 1 項目の上流と下流
 * - wire: その線から下流だけ
 * - host: 枠の中の箱ごとに独立にたどって合併（§8 #17）
 * - type: 同じ typeRef の項目を全部（横断面。線はたどらない）
 */
export function select(
  index: GraphIndex,
  state: VariantState,
  selection: Selection,
): LitSelection | null {
  const base = (lit: Lit): LitSelection => ({
    ...lit,
    selection,
    startBoxes: new Set(),
    startItems: new Set(),
    flowStarts: new Set(),
    flows: true,
  });

  switch (selection.kind) {
    case 'host': {
      const members = index.hosts.get(selection.id) ?? [];
      if (members.length === 0 && !index.nodes.has(selection.id)) return null;
      const lit = emptyLit();
      for (const n of members)
        mergeLit(lit, traverse(index, state, n.roots, { up: true, down: true }));
      const r = base(lit);
      r.startBoxes = new Set(members.map((n) => n.id));
      r.flowStarts = new Set(
        members.flatMap((n) => activeRoots(index, state, n).map((i) => i.ref)),
      );
      return r;
    }
    case 'box': {
      const n = index.nodes.get(selection.id);
      if (!n) return null;
      const r = base(traverse(index, state, n.roots, { up: !selection.downOnly, down: true }));
      r.startBoxes = new Set([n.id]);
      r.flowStarts = new Set(activeRoots(index, state, n).map((i) => i.ref));
      return r;
    }
    case 'item': {
      const it = index.items.get(selection.ref);
      if (!it) return null;
      const r = base(traverse(index, state, [it], { up: !selection.downOnly, down: true }));
      r.startItems = new Set([it.ref]);
      r.flowStarts = new Set([it.ref]);
      return r;
    }
    case 'wire': {
      const w = index.wires.find(
        (x) => x.wire.from === selection.from && x.wire.to === selection.to,
      );
      if (!w) return null;
      const lit = traverse(index, state, [w.to], { up: false, down: true });
      const key = `${w.key}|${w.from.ref}|${w.to.ref}`;
      if (!lit.wires.has(key)) {
        const seg: Segment = { key, kind: 'wire', wire: w, from: w.from, to: w.to };
        lit.wires.set(key, seg);
        lit.segs.unshift(seg);
      }
      lit.items.add(w.from.ref);
      lit.boxes.add(w.fromNode.id);
      const r = base(lit);
      r.startSeg = key;
      r.flowStarts = new Set([w.from.ref]);
      return r;
    }
    case 'type': {
      const items: IndexedItem[] = index.byTypeRef.get(selection.typeRef) ?? [];
      const lit = emptyLit();
      for (const it of items) {
        lit.items.add(it.ref);
        lit.boxes.add(it.node.id);
      }
      const r = base(lit);
      r.startItems = new Set(items.map((i) => i.ref));
      r.flows = false;
      return r;
    }
  }
}
