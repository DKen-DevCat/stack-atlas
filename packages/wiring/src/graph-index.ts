// graph.json v2 の索引。参照の文字列を切り（最初の # で箱、次の / で口、残りを . で項目。D36）、
// 項目の木（親・パス・深さ）、線の from / to の表、呼び出し元・戻り先、host の中身を作る
import {
  parseItemRef,
  parseLocalRef,
  type GraphV2,
  type ItemV2,
  type NamedType,
  type NodeV2,
  type PortV2,
  type WireV2,
} from '@stack-atlas/schema';

/** 索引された項目 */
export interface IndexedItem {
  /** `<nodeId>#<portId>/<path>` */
  ref: string;
  id: string;
  /** 口の中のパス（`a.b.c`） */
  path: string;
  depth: number;
  node: IndexedNode;
  port: PortV2;
  dir: 'in' | 'out';
  parent: IndexedItem | null;
  children: IndexedItem[];
  /** 子孫の全部（深さ優先。indexGraph で先に作る。たどるたびに箱の全項目を見ないように） */
  descendants: IndexedItem[];
  item: ItemV2;
}

/** 索引された箱 */
export interface IndexedNode {
  id: string;
  node: NodeV2;
  /** 入れ子を含む全項目（口の順、深さ優先） */
  items: IndexedItem[];
  /** 最上位の項目だけ */
  roots: IndexedItem[];
  /** host の枠として持つ箱（kind infra）。無ければ null */
  host: IndexedNode | null;
}

/** 索引された線 */
export interface IndexedWire {
  /** `w<index>` */
  key: string;
  index: number;
  wire: WireV2;
  from: IndexedItem;
  to: IndexedItem;
  fromNode: IndexedNode;
  toNode: IndexedNode;
  reply: boolean;
}

export interface GraphIndex {
  graph: GraphV2;
  nodes: Map<string, IndexedNode>;
  /** ref → 項目 */
  items: Map<string, IndexedItem>;
  wires: IndexedWire[];
  /** from の項目の ref → 線 */
  wiresFrom: Map<string, IndexedWire[]>;
  /** to の項目の ref → 線 */
  wiresTo: Map<string, IndexedWire[]>;
  /**
   * 箱 id → 往復の相手（docs/15 §3.5）: その箱へ行きの線（reply でない）を引き、かつその箱から戻りの線（reply）を受ける箱。
   * テーブルへ書くだけの箱（戻りを受けない）や、戻りを受けるだけの箱（呼ばない）は数えない。下流へたどるときの戻りの絞り込みに使う
   */
  requesters: Map<string, Set<string>>;
  /** 箱 id → 往復の相手（requesters と同じ集合）。上流へたどるとき、行きの線を逆にたどる絞り込み（対称）に使う */
  repliers: Map<string, Set<string>>;
  /** host の箱 id → その枠の中の箱 */
  hosts: Map<string, IndexedNode[]>;
  types: Map<string, NamedType>;
  /** typeRef → その型に所属する項目 */
  byTypeRef: Map<string, IndexedItem[]>;
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V) {
  const arr = map.get(key);
  if (arr) arr.push(value);
  else map.set(key, [value]);
}

function addTo<K>(map: Map<K, Set<string>>, key: K, value: string) {
  const set = map.get(key);
  if (set) set.add(value);
  else map.set(key, new Set([value]));
}

/** 箱の中の参照 `<portId>/<path>` を項目に解く */
export function resolveLocal(
  index: GraphIndex,
  node: IndexedNode,
  ref: string,
): IndexedItem | undefined {
  const p = parseLocalRef(ref);
  if (!p) return undefined;
  return index.items.get(`${node.id}#${p.portId}/${p.path.join('.')}`);
}

/** 項目の参照を項目に解く（形が違えば undefined） */
export function resolveRef(index: GraphIndex, ref: string): IndexedItem | undefined {
  if (!parseItemRef(ref)) return undefined;
  return index.items.get(ref);
}

/** x が a の子孫か（同じ箱・同じ口） */
export function isDescendantOf(x: IndexedItem, a: IndexedItem): boolean {
  return x !== a && x.node === a.node && x.port === a.port && x.path.startsWith(a.path + '.');
}

/** 項目とその祖先（自分が先頭） */
export function ancestorsOf(item: IndexedItem): IndexedItem[] {
  const out: IndexedItem[] = [];
  for (let x: IndexedItem | null = item; x; x = x.parent) out.push(x);
  return out;
}

/**
 * graph.json v2 を索引にする。参照が解けない線は例外（validate を先に通す前提）。
 */
export function indexGraph(graph: GraphV2): GraphIndex {
  const nodes = new Map<string, IndexedNode>();
  const items = new Map<string, IndexedItem>();
  const byTypeRef = new Map<string, IndexedItem[]>();

  for (const n of graph.nodes) {
    const inode: IndexedNode = { id: n.id, node: n, items: [], roots: [], host: null };
    nodes.set(n.id, inode);
    for (const port of n.ports) {
      const walk = (it: ItemV2, parent: IndexedItem | null) => {
        const path = parent ? `${parent.path}.${it.id}` : it.id;
        const ii: IndexedItem = {
          ref: `${n.id}#${port.id}/${path}`,
          id: it.id,
          path,
          depth: parent ? parent.depth + 1 : 0,
          node: inode,
          port,
          dir: port.dir,
          parent,
          children: [],
          descendants: [],
          item: it,
        };
        for (let a = parent; a; a = a.parent) a.descendants.push(ii);
        if (parent) parent.children.push(ii);
        else inode.roots.push(ii);
        inode.items.push(ii);
        items.set(ii.ref, ii);
        if (it.typeRef) push(byTypeRef, it.typeRef, ii);
        for (const c of it.children ?? []) walk(c, ii);
      };
      for (const it of port.items) walk(it, null);
    }
  }

  const hosts = new Map<string, IndexedNode[]>();
  for (const inode of nodes.values()) {
    const hostId = inode.node.host;
    if (hostId === undefined) continue;
    const host = nodes.get(hostId);
    if (!host) throw new Error(`host の参照が解けない: ${inode.id} → ${hostId}`);
    inode.host = host;
    push(hosts, hostId, inode);
  }

  const wires: IndexedWire[] = [];
  const wiresFrom = new Map<string, IndexedWire[]>();
  const wiresTo = new Map<string, IndexedWire[]>();
  /** 箱 id → 行きの線を引いてくる箱 / 戻りの線を引く先の箱（往復の相手はこの 2 つの共通部分） */
  const callers = new Map<string, Set<string>>();
  const replyTo = new Map<string, Set<string>>();
  graph.wires.forEach((w, i) => {
    const from = items.get(w.from);
    const to = items.get(w.to);
    if (!from || !to) throw new Error(`線の参照が解けない: ${w.from} → ${w.to}`);
    const iw: IndexedWire = {
      key: `w${i}`,
      index: i,
      wire: w,
      from,
      to,
      fromNode: from.node,
      toNode: to.node,
      reply: w.reply === true,
    };
    wires.push(iw);
    push(wiresFrom, w.from, iw);
    push(wiresTo, w.to, iw);
    if (iw.reply) addTo(replyTo, iw.fromNode.id, iw.toNode.id);
    else addTo(callers, iw.toNode.id, iw.fromNode.id);
  });
  const requesters = new Map<string, Set<string>>();
  const repliers = new Map<string, Set<string>>();
  for (const [x, cs] of callers) {
    const rs = replyTo.get(x);
    if (!rs) continue;
    const partners = [...cs].filter((c) => rs.has(c));
    if (!partners.length) continue;
    requesters.set(x, new Set(partners));
    repliers.set(x, new Set(partners));
  }

  const types = new Map<string, NamedType>();
  for (const t of graph.types ?? []) types.set(t.id, t);

  return {
    graph,
    nodes,
    items,
    wires,
    wiresFrom,
    wiresTo,
    requesters,
    repliers,
    hosts,
    types,
    byTypeRef,
  };
}
