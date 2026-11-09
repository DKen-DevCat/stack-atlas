/**
 * 言語アダプタの v2 の部分グラフ（PartialGraph.v2）どうしのマージと、項目の木の小さな道具（docs/17 §3.1）。
 * 抽出器どうしのマージ（mergePartialGraphs）と、upgrade の箱へのマージ（mergeV2）の両方で使う。
 */
import {
  parseWhenKey,
  type ItemV2,
  type LinkV2,
  type NamedType,
  type NodeV2,
  type PortV2,
  type VariantV2,
  type When,
  type WireV2,
} from '@stack-atlas/schema';
import { defaultLinks, indexGraph } from '@stack-atlas/wiring';
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

/** ref がその項目（root）か、その子孫か（補いの意味の参照と strict の数え直しで共用） */
export const under = (ref: string, root: string) => ref === root || ref.startsWith(`${root}.`);

/** 項目の参照の最上位の項目（`<箱>#<口>/a.b` → `<箱>#<口>/a`） */
export const topRef = (ref: string) => {
  const slash = ref.indexOf('/', ref.indexOf('#'));
  const dot = ref.indexOf('.', slash);
  return dot < 0 ? ref : ref.slice(0, dot);
};

/** 箱の dir の口の最上位の項目と、その参照（`<箱>#<口>/<項目>`） */
export const topItems = (n: Pick<NodeV2, 'id' | 'ports'>, dir: 'in' | 'out') =>
  n.ports
    .filter((p) => p.dir === dir)
    .flatMap((p) => p.items.map((it) => ({ port: p, item: it, ref: `${n.id}#${p.id}/${it.id}` })));

/**
 * links を書いていない箱の既定の links の本数と、書き出すときの上限（2026-11-10 8-4 のレビュー S3: 全 in × 全 out を
 * 書き出すので、項目の多い箱で数千万本になり heap を使い切った。補いの links と掃除の `_` の links で共用）
 */
export const MAX_DEFAULT_LINKS = 10_000;

/** 既定の links の本数（書き出さずに数える。wiring の defaultLinks と同じ規則） */
export function defaultLinkCount(n: Pick<NodeV2, 'kind' | 'ports'>): number {
  const count = (dir: 'in' | 'out', portId?: string) =>
    n.ports
      .filter((p) => p.dir === dir && (portId === undefined || p.id === portId))
      .reduce((s, p) => s + p.items.length, 0);
  if (n.kind === 'table') return count('in', 'key') * count('out', 'read');
  if (n.kind === 'endpoint' && n.ports.some((p) => p.id === 'req' || p.id === 'res'))
    return count('in', 'in') + count('in', 'res');
  return count('in') * count('out');
}

/**
 * links の無い箱の既定の links を書き出す（規則は @stack-atlas/wiring の defaultLinks。全 in → 全 out は crude、
 * table の key → read と endpoint の恒等は confidence なし）。MAX_DEFAULT_LINKS を超えるなら undefined（書き出さない）
 */
export function materializeDefaultLinks(n: NodeV2): LinkV2[] | undefined {
  if (defaultLinkCount(n) > MAX_DEFAULT_LINKS) return undefined;
  const inode = indexGraph({ version: 2, nodes: [n], wires: [] }).nodes.get(n.id)!;
  const exact =
    n.kind === 'table' ||
    (n.kind === 'endpoint' && n.ports.some((p) => p.id === 'req' || p.id === 'res'));
  return defaultLinks(inode).map((l): LinkV2 => ({
    from: `${l.from.port.id}/${l.from.path}`,
    to: `${l.to.port.id}/${l.to.path}`,
    ...(exact ? {} : { confidence: 'crude' }),
  }));
}

/**
 * when のキーが宣言した分岐に解けるか（validateGraphV2 の checkWhen と同じ規則）。owners は無修飾のキーの候補の箱
 * （線なら両端、links ならその箱）。解けなければ理由の文
 */
export function whenProblem(
  when: When,
  owners: readonly string[],
  nodes: ReadonlyMap<string, Pick<NodeV2, 'variants'>>,
): string | undefined {
  const declares = (id: string, v: string) =>
    nodes.get(id)?.variants?.some((x) => x.id === v) ?? false;
  for (const key of Object.keys(when)) {
    const { nodeId, variantId } = parseWhenKey(key);
    if (nodeId !== undefined) {
      if (!nodes.has(nodeId)) return `when のキー "${key}" の箱 ${nodeId} がありません`;
      if (!declares(nodeId, variantId))
        return `when のキー "${key}": ${nodeId} は分岐 ${variantId} を宣言していません（v2.variants で足す）`;
      continue;
    }
    const found = [...new Set(owners)].filter((o) => declares(o, variantId));
    if (!found.length)
      return `when のキー "${key}" を宣言している箱がありません（候補 ${[...new Set(owners)].join(', ')}。v2.variants で足す）`;
    if (found.length > 1)
      return `when のキー "${key}" は ${found.join(', ')} が宣言しています。"<箱>#${key}" で書いてください`;
  }
  return undefined;
}

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

/** 契約の出どころ（D65。言語アダプタの型より正） */
const CONTRACT_SOURCES = new Set(['openapi', 'sql']);
const isContractType = (t: NamedType) => CONTRACT_SOURCES.has(t.source ?? '');
const locationOf = (t: NamedType) =>
  t.file ? (t.line !== undefined ? `${t.file}:${t.line}` : t.file) : undefined;

/**
 * 同じ id の型 2 つから 1 つを選ぶ（D65。2026-11-09 8-2b の決定）: 契約（openapi・sql）が言語アダプタ（typescript・go）に
 * 勝つ。同じ側どうしは先のもの。meta は勝った側が先の和（配列は連結）、負けた側の宣言の場所（`file:line`）は勝った側の
 * `meta.copies` に足す（手で組んだ例の `type:Transaction` の copies と同じ。他言語の写しの場所）
 */
export function pickNamedType(first: NamedType, second: NamedType): NamedType {
  const swap = isContractType(second) && !isContractType(first);
  const win = swap ? second : first;
  const lose = swap ? first : second;
  const out: NamedType = clone(win);
  if (lose.meta || win.meta)
    out.meta = deepMerge(win.meta ?? {}, lose.meta ?? {}, { prefer: 'target' });
  const loc = locationOf(lose);
  if (loc && lose.file !== win.file) {
    const copies = Array.isArray(out.meta?.copies) ? (out.meta.copies as unknown[]) : [];
    if (!copies.includes(loc)) out.meta = { ...(out.meta ?? {}), copies: [...copies, loc] };
  }
  return out;
}

/** 型の並びの和（id で 1 つ。pickNamedType。順は先に出た位置） */
export function mergeNamedTypes(a: readonly NamedType[], b: readonly NamedType[]): NamedType[] {
  const out = a.map((t) => clone(t));
  const at = new Map(out.map((t, i) => [t.id, i]));
  for (const t of b) {
    const i = at.get(t.id);
    if (i === undefined) {
      at.set(t.id, out.length);
      out.push(clone(t));
    } else out[i] = pickNamedType(out[i]!, t);
  }
  return out;
}

/** 言語アダプタの箱 id の衝突で付け替えたもの */
export interface RenamedBoxV2 {
  from: string;
  to: string;
  /** 先に同じ id を出した持ち主（`<抽出器>@<repo>`） */
  other: string;
}

/**
 * 言語アダプタの箱 id の衝突（2026-11-09 8-2b レビュー C6）: 先に別の持ち主（別の言語アダプタか、同じアダプタの別の
 * repo）が出した箱と同じ id の箱を、後の方だけ `<種類>:<file>~<名前>`（TS の衝突の退避と同じ形。file が無ければ
 * `~2` …）に付け替える。part の線・refs・groups の参照も付け替える。owners（箱 id → 持ち主）に part の箱を足す。
 * 黙って mergePartialV2 で混ぜると、無関係な箱（TS の `fn:api.list` と Go の根のパッケージ api の list）の口が混ざる
 */
export function disambiguateV2(
  part: PartialGraphV2,
  owners: Map<string, string>,
  owner: string,
): { part: PartialGraphV2; renamed: RenamedBoxV2[] } {
  const renamed: RenamedBoxV2[] = [];
  const map = new Map<string, string>();
  const taken = new Set([...owners.keys(), ...part.nodes.map((n) => n.id)]);
  for (const n of part.nodes) {
    const other = owners.get(n.id);
    if (other === undefined || other === owner || map.has(n.id)) continue;
    const colon = n.id.indexOf(':');
    const kind = n.id.slice(0, colon + 1);
    const rest = n.id.slice(colon + 1);
    const base = n.file ? `${kind}${n.file}~${rest}` : `${kind}${rest}~2`;
    let id = base;
    for (let k = 2; taken.has(id); k++) id = `${base}_${k}`;
    taken.add(id);
    map.set(n.id, id);
    renamed.push({ from: n.id, to: id, other });
  }
  let out = part;
  if (map.size) {
    const box = (ref: string) => {
      const hash = ref.indexOf('#');
      const b = hash < 0 ? ref : ref.slice(0, hash);
      const to = map.get(b);
      return to === undefined ? ref : to + ref.slice(b.length);
    };
    out = {
      ...part,
      nodes: part.nodes.map((n) => (map.has(n.id) ? { ...n, id: map.get(n.id)! } : n)),
      wires: part.wires.map((w) => ({ ...w, from: box(w.from), to: box(w.to) })),
    };
    if (part.refs)
      out.refs = Object.fromEntries(
        Object.entries(part.refs).map(([k, list]) => [map.get(k) ?? k, list.map(box)]),
      );
    if (part.groups)
      out.groups = Object.fromEntries(
        Object.entries(part.groups).map(([k, v]) => [map.get(k) ?? k, v]),
      );
  }
  for (const n of out.nodes) if (!owners.has(n.id)) owners.set(n.id, owner);
  return { part: out, renamed };
}

/**
 * v2 の部分グラフの和（箱は id、線は (from, to)、groups はキーで、先に出たものを残す。型は id で、契約が言語アダプタに
 * 勝つ（D65）。refs は箱ごとの和）
 */
export function mergePartialV2(
  parts: ReadonlyArray<PartialGraphV2 | undefined>,
): PartialGraphV2 | undefined {
  const present = parts.filter((p): p is PartialGraphV2 => !!p);
  if (!present.length) return undefined;
  const nodes = new Map<string, PartialNodeV2>();
  const wires = new Map<string, WireV2>();
  let types: NamedType[] = [];
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
    if (p.types?.length) types = mergeNamedTypes(types, p.types);
    for (const [k, v] of Object.entries(p.groups ?? {})) {
      groups ??= {};
      if (!(k in groups)) groups[k] = v;
    }
  }
  const out: PartialGraphV2 = { nodes: [...nodes.values()], wires: [...wires.values()] };
  if (types.length) out.types = types;
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
