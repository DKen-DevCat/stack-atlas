// 箱の中の対応（links。docs/16 §6）と、線の有効判定
import type { LinkV2 } from '@stack-atlas/schema';
import {
  resolveLocal,
  type GraphIndex,
  type IndexedItem,
  type IndexedNode,
  type IndexedWire,
} from './graph-index.js';
import { isActive, itemActive, type VariantState } from './variants.js';

/** 解決済みの箱の中の対応 */
export interface ResolvedLink {
  node: IndexedNode;
  from: IndexedItem;
  to: IndexedItem;
  /** 書かれていた links。既定で生成したものは undefined */
  link?: LinkV2;
}

/** 既定の links を作る。全 in → 全 out（最上位の項目どうし）。table は key → read だけ。endpoint は in→req / res→out の恒等 */
export function defaultLinks(node: IndexedNode): ResolvedLink[] {
  const kind = node.node.kind;
  const roots = (dir: 'in' | 'out', portId?: string) =>
    node.roots.filter((i) => i.dir === dir && (portId === undefined || i.port.id === portId));
  const product = (ins: IndexedItem[], outs: IndexedItem[]) => {
    const out: ResolvedLink[] = [];
    for (const a of ins) for (const b of outs) out.push({ node, from: a, to: b });
    return out;
  };
  if (kind === 'table') return product(roots('in', 'key'), roots('out', 'read'));
  if (kind === 'endpoint') {
    const portIds = new Set(node.node.ports.map((p) => p.id));
    if (portIds.has('req') || portIds.has('res')) {
      const identity = (fromPort: string, toPort: string) => {
        const outs = roots('out', toPort);
        const links: ResolvedLink[] = [];
        for (const a of roots('in', fromPort)) {
          const b = outs.find((o) => o.id === a.id);
          if (b) links.push({ node, from: a, to: b });
        }
        return links;
      };
      return [...identity('in', 'req'), ...identity('res', 'out')];
    }
  }
  return product(roots('in'), roots('out'));
}

/** 箱の中の対応。書かれていれば今の状態に合うものだけ（解けないものは落とす）。無ければ既定 */
export function linksOf(index: GraphIndex, state: VariantState, node: IndexedNode): ResolvedLink[] {
  const links = node.node.links;
  if (!links) return defaultLinks(node);
  const out: ResolvedLink[] = [];
  for (const l of links) {
    if (!isActive(index, state, l.when, [node])) continue;
    const from = resolveLocal(index, node, l.from);
    const to = resolveLocal(index, node, l.to);
    if (!from || !to) continue;
    out.push({ node, from, to, link: l });
  }
  return out;
}

/** 線が今の状態で存在するか（線の when と両端の項目の when） */
export function wireActive(index: GraphIndex, state: VariantState, w: IndexedWire): boolean {
  return (
    isActive(index, state, w.wire.when, [w.fromNode, w.toNode]) &&
    itemActive(index, state, w.from) &&
    itemActive(index, state, w.to)
  );
}
