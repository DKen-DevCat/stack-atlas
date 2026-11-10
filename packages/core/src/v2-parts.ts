/**
 * 言語アダプタの v2 の部分グラフ（PartialGraph.v2）どうしのマージと、項目の木の小さな道具（docs/17 §3.1）。
 * 抽出器どうしのマージ（mergePartialGraphs）と、upgrade の箱へのマージ（mergeV2）の両方で使う。
 */
import type { ItemV2, LinkV2, NamedType, PortV2, VariantV2, WireV2 } from '@stack-atlas/schema';
import type { PartialGraphV2, PartialNodeV2 } from './types.js';
import { clone, deepMerge } from './util.js';

/** 口の単位の項目の id（upgrade が全部の箱に置く置き場の項目。docs/16 §10） */
export const UNDERSCORE = '_';

/** 置き場の項目（upgrade の ITEM_ANY と同じ形） */
export const underscoreItem = (): ItemV2 => ({
  id: UNDERSCORE,
  name: '値',
  type: 'unknown',
  wireType: 'unknown',
});

/** 項目 id の文字集合（docs/16 §3）。それ以外は _ に（言語アダプタと openapi で共有する） */
export const itemId = (name: string) => name.replace(/[^A-Za-z0-9_$-]/g, '_') || '_';

export const wireKey = (w: Pick<WireV2, 'from' | 'to'>) => `${w.from}\u0000${w.to}`;

/** 参照の箱 id（最初の # まで） */
export const boxOf = (ref: string) => ref.slice(0, Math.max(0, ref.indexOf('#')));

/** 参照が口の単位（`<box>#<port>/_`）か */
export const isUnderscoreRef = (ref: string) => ref.endsWith(`/${UNDERSCORE}`);

/** 項目の並びを id で合わせる（先に出た方を残し、子は再帰で合わせる） */
export function mergeItemLists(a: ItemV2[], b: ItemV2[]): ItemV2[] {
  const out = a.map((x) => clone(x));
  const at = new Map(out.map((x, i) => [x.id, i]));
  for (const it of b) {
    const i = at.get(it.id);
    if (i === undefined) {
      at.set(it.id, out.length);
      out.push(clone(it));
      continue;
    }
    const prev = out[i]!;
    if (it.children?.length)
      prev.children = prev.children
        ? mergeItemLists(prev.children, it.children)
        : clone(it.children);
  }
  return out;
}

/** 口の並びを口 id で合わせる（項目は mergeItemLists） */
export function mergePortLists(a: PortV2[], b: PortV2[]): PortV2[] {
  const out = a.map((p) => clone(p));
  const at = new Map(out.map((p, i) => [p.id, i]));
  for (const p of b) {
    const i = at.get(p.id);
    if (i === undefined) {
      at.set(p.id, out.length);
      out.push(clone(p));
    } else out[i]!.items = mergeItemLists(out[i]!.items, p.items);
  }
  return out;
}

const linkKey = (l: LinkV2) => `${l.from}\u0000${l.to}\u0000${JSON.stringify(l.when ?? {})}`;

/** links の和（同じ from / to / when は先のもの） */
export function mergeLinkLists(a: LinkV2[] | undefined, b: LinkV2[] | undefined) {
  if (!a) return b && clone(b);
  if (!b) return clone(a);
  const out = clone(a);
  const seen = new Set(out.map(linkKey));
  for (const l of b) if (!seen.has(linkKey(l))) out.push(clone(l));
  return out;
}

/** 分岐の和（同じ id は先のもの） */
export function mergeVariants(a: VariantV2[] | undefined, b: VariantV2[] | undefined) {
  if (!a) return b && clone(b);
  if (!b) return clone(a);
  const out = clone(a);
  for (const v of b) if (!out.some((x) => x.id === v.id)) out.push(clone(v));
  return out;
}

/** アダプタの箱どうし（同じ id）のマージ。先に出た値を残し、口・項目・links・分岐は和にする */
export function mergePartialNodeV2(a: PartialNodeV2, b: PartialNodeV2): PartialNodeV2 {
  const out: PartialNodeV2 = { ...clone(b), ...clone(a) };
  out.ports = mergePortLists(a.ports, b.ports);
  const links = mergeLinkLists(a.links, b.links);
  if (links) out.links = links;
  const variants = mergeVariants(a.variants, b.variants);
  if (variants) out.variants = variants;
  if (a.meta || b.meta) out.meta = deepMerge(a.meta ?? {}, b.meta ?? {}, { prefer: 'target' });
  return out;
}

/** v2 の部分グラフの和（箱は id、線は (from, to)、型は id、groups はキーで、先に出たものを残す。refs は箱ごとの和） */
export function mergePartialV2(
  parts: ReadonlyArray<PartialGraphV2 | undefined>,
): PartialGraphV2 | undefined {
  const present = parts.filter((p): p is PartialGraphV2 => !!p);
  if (!present.length) return undefined;
  const nodes = new Map<string, PartialNodeV2>();
  const wires = new Map<string, WireV2>();
  const types = new Map<string, NamedType>();
  let groups: Record<string, string> | undefined;
  const refs = new Map<string, Set<string>>();
  for (const p of present) {
    for (const [k, list] of Object.entries(p.refs ?? {})) {
      const acc = refs.get(k) ?? new Set<string>();
      for (const x of list) acc.add(x);
      refs.set(k, acc);
    }
    for (const n of p.nodes) {
      const prev = nodes.get(n.id);
      nodes.set(n.id, prev ? mergePartialNodeV2(prev, n) : clone(n));
    }
    for (const w of p.wires) if (!wires.has(wireKey(w))) wires.set(wireKey(w), clone(w));
    for (const t of p.types ?? []) if (!types.has(t.id)) types.set(t.id, clone(t));
    for (const [k, v] of Object.entries(p.groups ?? {})) {
      groups ??= {};
      if (!(k in groups)) groups[k] = v;
    }
  }
  const out: PartialGraphV2 = { nodes: [...nodes.values()], wires: [...wires.values()] };
  if (types.size) out.types = [...types.values()];
  if (groups) out.groups = groups;
  if (refs.size) out.refs = Object.fromEntries([...refs].map(([k, v]) => [k, [...v]]));
  return out;
}

/** 項目の木を深さ優先で回す（path は口の中の `a.b.c`） */
export function walkItems(
  items: readonly ItemV2[],
  visit: (it: ItemV2, path: string, depth: number) => void,
  prefix = '',
  depth = 0,
) {
  for (const it of items) {
    const path = prefix ? `${prefix}.${it.id}` : it.id;
    visit(it, path, depth);
    if (it.children) walkItems(it.children, visit, path, depth + 1);
  }
}

/** 口の中のパス（`a.b.c`）の項目。無ければ undefined */
export function itemAt(port: PortV2 | undefined, path: string): ItemV2 | undefined {
  if (!port) return undefined;
  let list: ItemV2[] | undefined = port.items;
  let cur: ItemV2 | undefined;
  for (const seg of path.split('.')) {
    cur = list?.find((x) => x.id === seg);
    if (!cur) return undefined;
    list = cur.children;
  }
  return cur;
}
