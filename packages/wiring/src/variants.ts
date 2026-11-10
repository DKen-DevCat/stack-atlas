// 分岐（variants / when。docs/16 §7）。表示は常に 1 つの組み合わせで、状態は `<nodeId>#<variantId>` → boolean
import { parseWhenKey, type When } from '@stack-atlas/schema';
import type { GraphIndex, IndexedItem, IndexedNode } from './graph-index.js';

/** 分岐の今の状態。キーは `<nodeId>#<variantId>`。無いキーは宣言の default */
export type VariantState = Record<string, boolean>;

export const variantKey = (nodeId: string, variantId: string) => `${nodeId}#${variantId}`;

/** 全部の箱の宣言から既定の状態を作る */
export function defaultState(index: GraphIndex): VariantState {
  const state: VariantState = {};
  for (const n of index.nodes.values()) {
    for (const v of n.node.variants ?? []) state[variantKey(n.id, v.id)] = v.default === true;
  }
  return state;
}

/** 状態に views[].variants を重ねる */
export function withVariants(
  state: VariantState,
  overrides: Record<string, boolean> | undefined,
): VariantState {
  return { ...state, ...(overrides ?? {}) };
}

const declares = (n: IndexedNode, variantId: string) =>
  (n.node.variants ?? []).some((v) => v.id === variantId);

/** 分岐の値（state に無ければ宣言の default、宣言も無ければ false） */
export function variantValue(
  index: GraphIndex,
  state: VariantState,
  nodeId: string,
  variantId: string,
): boolean {
  const key = variantKey(nodeId, variantId);
  if (key in state) return state[key]!;
  const n = index.nodes.get(nodeId);
  return n?.node.variants?.find((v) => v.id === variantId)?.default === true;
}

export interface ResolvedWhen {
  key: string;
  /** 解けなければ null（validate で止まる想定。たどりでは無視して「存在する」扱い） */
  nodeId: string | null;
  variantId: string;
  expected: boolean;
}

/**
 * `when` のキーの持ち主を決める。`<nodeId>#<variantId>` ならその箱。`<variantId>` だけなら owners のうち宣言している箱
 * （線なら両端、links・項目ならその箱。両端が宣言していたら先頭を採る。validate は修飾を要求する）
 */
export function resolveWhen(when: When | undefined, owners: IndexedNode[]): ResolvedWhen[] {
  if (!when) return [];
  return Object.entries(when).map(([key, expected]) => {
    const { nodeId, variantId } = parseWhenKey(key);
    if (nodeId !== undefined) return { key, nodeId, variantId, expected };
    const owner = owners.find((o) => declares(o, variantId));
    return { key, nodeId: owner ? owner.id : null, variantId, expected };
  });
}

/** `when` が今の状態に合うか（複数キーは AND。解けないキーは無視） */
export function isActive(
  index: GraphIndex,
  state: VariantState,
  when: When | undefined,
  owners: IndexedNode[],
): boolean {
  for (const r of resolveWhen(when, owners)) {
    if (r.nodeId === null) continue;
    if (variantValue(index, state, r.nodeId, r.variantId) !== r.expected) return false;
  }
  return true;
}

/** 項目が今の状態で存在するか（祖先の when も見る） */
export function itemActive(index: GraphIndex, state: VariantState, item: IndexedItem): boolean {
  for (let x: IndexedItem | null = item; x; x = x.parent) {
    if (!isActive(index, state, x.item.when, [x.node])) return false;
  }
  return true;
}
