/**
 * 言語アダプタの v2 を、upgradeGraph（8-1。箱の単位）の v2 に重ねる（docs/17 §3.1・§7 #4、D50・D53）。
 *
 * 流れ（パイプライン）: mergeV2 → join（合流。join.ts）→ cleanupV2（細かい方が勝つ掃除）→ detectBroken
 *
 * mergeV2:
 * - 同じ箱 id: 口・項目・links・runtime・kind はアダプタが勝ち、host・cache・screen は upgrade の値を残す。
 *   upgrade の置き場の項目 `_` は、掃除まで残す（箱の単位の線がまだ指している）
 * - v1 のファイル・パッケージの箱（`lib:` / `handler:` など）が関数の箱で置き換わるもの（被覆）を集める（D47・D53）:
 *   ① アダプタが `groups`（関数の箱 → v1 の箱）で明示したもの ② TS: v1 の箱の `meta.ts.exports` が全部、同じ file の
 *   アダプタの箱（`meta.ts.exportName`）になっている ③ `meta.sharedOf`（`@runtime` の複製）④ Go: 同じ `meta.go.pkg` の
 *   関数の箱がある。接頭辞では判定しない
 * - 置き換わる v1 の箱の host・runtime は中の関数の箱が受け継ぐ。関数の箱の group は v1 の箱 id（折りたたみの単位。
 *   その id に付いたメモは group に出す）
 *
 * cleanupV2（join の後）:
 * - upgrade の線（箱の単位）は、向き付きの同じ箱の対にアダプタか合流の線が 1 本でもあれば消す（D50）。
 *   group になった v1 の箱は、中の関数の箱の対として数える
 * - 残った upgrade の線: 画面の `in/_` に着くもの（配信）は `in/html` へ付け替える。group になった v1 の箱に付くものは、
 *   相手がアダプタの箱でなければ中の関数の箱へ付け替え、アダプタの箱なら消す（アダプタが関数の単位で引き直している）
 * - group になった v1 の箱を消す。アダプタの箱の `_` は、どの線にも指されていなければ消す
 * - 残った `_`（呼び出しでない参照・合流の相手がまだ箱の単位の所）には crude の links を足す。起動の項目 → `out/_`、
 *   `in/_` → 全部の out（links を 1 本でも持つ箱は既定の「全 in → 全 out」が効かず、`_` が行き止まりになるため）
 */
import type {
  GraphV2,
  ItemV2,
  LinkV2,
  NodeV2,
  PortV2,
  Runtime,
  ValidationIssue,
  WireV2,
} from '@stack-atlas/schema';
import type { PartialGraphV2, PartialNodeV2 } from './types.js';
import { clone, deepMerge, isPlainObject } from './util.js';
import {
  UNDERSCORE,
  boxOf,
  isUnderscoreRef,
  mergeLinkLists,
  underscoreItem,
  walkItems,
  wireKey,
} from './v2-parts.js';

export interface MergeV2Options {
  /** overrides の remove で消した箱 id（アダプタが出し直さない） */
  removed?: ReadonlySet<string>;
  /** v2 の印に足すアダプタ名（project.generator.adapters） */
  adapters?: string[];
}

/** mergeV2 の結果。join と cleanupV2 がこの状態を受け継ぐ */
export interface MergedV2 {
  graph: GraphV2;
  /** アダプタが出した（か、アダプタの口で置き換えた）箱 id */
  adapterIds: Set<string>;
  /** upgrade が引いた線（箱の単位。掃除の対象） */
  upgradeWires: Set<WireV2>;
  /** 置き換わる v1 の箱 id → 中の関数の箱 id */
  groups: Map<string, string[]>;
}

const ACTIVATION = ['call', 'props', 'html', 'r'];

/** 箱の id から箱を引く表 */
const indexNodes = (g: GraphV2) => new Map(g.nodes.map((n) => [n.id, n]));

/** 口ごとに upgrade の `_` を足す（掃除まで、箱の単位の線が指している） */
function withUnderscores(adapterPorts: PortV2[], upgradePorts: PortV2[]): PortV2[] {
  const out = adapterPorts.map((p) => clone(p));
  for (const up of upgradePorts) {
    const keepUnderscore = up.items.some((i) => i.id === UNDERSCORE);
    const named = up.items.filter((i) => i.id !== UNDERSCORE);
    const mine = out.find((p) => p.id === up.id);
    if (!mine) {
      out.push(clone(up));
      continue;
    }
    // upgrade が名前を付けた項目（cache の key / value、画面の html など）はアダプタに無ければ残す
    for (const it of named) if (!mine.items.some((x) => x.id === it.id)) mine.items.push(clone(it));
    if (keepUnderscore && !mine.items.some((x) => x.id === UNDERSCORE))
      mine.items.push(underscoreItem());
  }
  return out;
}

/** v1 の箱 → 置き換える関数の箱（被覆。D53） */
function findGroups(
  graph: GraphV2,
  part: PartialGraphV2,
  adapterIds: ReadonlySet<string>,
): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  const add = (g: string, m: string) => {
    if (g === m || adapterIds.has(g)) return;
    const list = groups.get(g) ?? [];
    if (!list.includes(m)) list.push(m);
    groups.set(g, list);
  };
  const nodes = indexNodes(graph);
  // ① 明示（関数の箱 → v1 の箱）
  for (const [member, v1] of Object.entries(part.groups ?? {}))
    if (nodes.has(v1) && adapterIds.has(member)) add(v1, member);
  const adapterNodes = graph.nodes.filter((n) => adapterIds.has(n.id));
  const byFile = new Map<string, NodeV2[]>();
  const byPkg = new Map<string, NodeV2[]>();
  for (const n of adapterNodes) {
    if (n.file) byFile.set(n.file, [...(byFile.get(n.file) ?? []), n]);
    const pkg = goPkg(n);
    if (pkg) byPkg.set(pkg, [...(byPkg.get(pkg) ?? []), n]);
    // ③ @runtime の複製
    const shared = n.meta?.sharedOf;
    if (typeof shared === 'string' && nodes.has(shared)) add(shared, n.id);
  }
  for (const u of graph.nodes) {
    if (adapterIds.has(u.id) || groups.has(u.id)) continue;
    // ② TS のファイルの箱: export が全部アダプタの箱になっている
    const ts = u.meta?.ts;
    const exports = isPlainObject(ts) && Array.isArray(ts.exports) ? (ts.exports as unknown[]) : [];
    if (u.file && exports.length) {
      const here = byFile.get(u.file) ?? [];
      const names = new Set(
        here.map((n) => (isPlainObject(n.meta?.ts) ? n.meta.ts.exportName : undefined)),
      );
      if (exports.every((e) => typeof e === 'string' && names.has(e)))
        for (const m of here) add(u.id, m.id);
      continue;
    }
    // ④ Go のパッケージの箱（classify で schema / type になったものも）
    const pkg = goPkg(u);
    if (pkg) for (const m of byPkg.get(pkg) ?? []) add(u.id, m.id);
  }
  return groups;
}

const goPkg = (n: Pick<NodeV2, 'meta'>): string | undefined => {
  const go = n.meta?.go;
  return isPlainObject(go) && typeof go.pkg === 'string' ? go.pkg : undefined;
};

/**
 * upgrade の v2 にアダプタの部分グラフを重ねる（掃除はまだしない）。引数は変更しない
 */
export function mergeV2(
  upgraded: GraphV2,
  part: PartialGraphV2,
  opts: MergeV2Options = {},
): MergedV2 {
  const graph = clone(upgraded);
  const upgradeWires = new Set(graph.wires);
  const byId = indexNodes(graph);
  const adapterIds = new Set<string>();
  const removed = opts.removed ?? new Set<string>();

  for (const pn of part.nodes) {
    if (removed.has(pn.id)) continue;
    adapterIds.add(pn.id);
    const u = byId.get(pn.id);
    if (!u) {
      const n = clone(pn) as NodeV2;
      graph.nodes.push(n);
      byId.set(n.id, n);
      continue;
    }
    mergeInto(u, pn);
  }

  const seen = new Set(graph.wires.map(wireKey));
  for (const w of part.wires) {
    if (removed.has(boxOf(w.from)) || removed.has(boxOf(w.to))) continue;
    if (seen.has(wireKey(w))) continue;
    seen.add(wireKey(w));
    graph.wires.push(clone(w));
  }

  const typeIds = new Set((graph.types ?? []).map((t) => t.id));
  for (const t of part.types ?? []) {
    if (typeIds.has(t.id)) continue;
    typeIds.add(t.id);
    (graph.types ??= []).push(clone(t));
  }

  const groups = findGroups(graph, part, adapterIds);
  // 中の関数の箱は、置き換わる v1 の箱の host・runtime を受け継ぐ。group は v1 の箱 id
  for (const [g, members] of groups) {
    const gn = byId.get(g)!;
    for (const id of members) {
      const m = byId.get(id)!;
      if (m.host === undefined && gn.host !== undefined) m.host = gn.host;
      if ((m as Partial<NodeV2>).runtime === undefined) m.runtime = gn.runtime;
      if (m.group === undefined) m.group = g;
    }
  }
  for (const n of graph.nodes)
    if ((n as Partial<NodeV2>).runtime === undefined) n.runtime = 'browser';

  if (opts.adapters?.length && graph.project) {
    const gen = isPlainObject(graph.project.generator) ? graph.project.generator : {};
    graph.project.generator = { ...gen, adapters: [...opts.adapters] };
  }
  return { graph, adapterIds, upgradeWires, groups };
}

/** 同じ id の upgrade の箱にアダプタの箱を重ねる（u を書き換える） */
function mergeInto(u: NodeV2, pn: PartialNodeV2) {
  u.kind = pn.kind;
  if (pn.name) u.name = pn.name;
  if (pn.file) u.file = pn.file;
  if (pn.line) u.line = pn.line;
  if (!u.code && pn.code) u.code = pn.code;
  if (pn.runtime) u.runtime = pn.runtime as Runtime;
  if (u.host === undefined && pn.host !== undefined) u.host = pn.host;
  if (!u.cache && pn.cache) u.cache = clone(pn.cache);
  if (!u.screen && pn.screen) u.screen = clone(pn.screen);
  if (pn.group !== undefined) u.group = pn.group;
  u.ports = withUnderscores(pn.ports, u.ports);
  const links = pn.links ? mergeLinkLists(pn.links, u.links) : u.links;
  if (links) u.links = links;
  if (pn.variants?.length) {
    const vs = u.variants ? clone(u.variants) : [];
    for (const v of pn.variants) if (!vs.some((x) => x.id === v.id)) vs.push(clone(v));
    u.variants = vs;
  }
  if (pn.meta) u.meta = deepMerge(u.meta ?? {}, pn.meta, { prefer: 'target' });
}

export interface CleanupV2Result {
  graph: GraphV2;
  /** group にした v1 の箱の数 */
  groups: number;
  /** アダプタか合流の線があるので消した箱の単位の線 */
  replaced: number;
  /** 付け替えた箱の単位の線（画面の in/html、group の中の関数の箱） */
  retargeted: number;
  /** 消した線（group の相手がアダプタの箱のもの、参照が解けないもの） */
  dropped: number;
  issues: ValidationIssue[];
}

/** 掃除（D50・D53）。join の後に呼ぶ。state.graph を書き換えて返す */
export function cleanupV2(state: MergedV2): CleanupV2Result {
  const { graph, adapterIds, upgradeWires, groups } = state;
  const issues: ValidationIssue[] = [];
  const byId = indexNodes(graph);
  /** 関数の箱 → 置き換わる v1 の箱（対の照合で同じ箱として数える） */
  const groupOf = new Map<string, string>();
  for (const [g, ms] of groups) for (const m of ms) groupOf.set(m, g);
  const reps = (id: string) => {
    const g = groupOf.get(id);
    return g ? [id, g] : [id];
  };

  // 1. 細かい方が勝つ: アダプタ・合流の線の箱の対（向き付き）
  const finePairs = new Set<string>();
  for (const w of graph.wires) {
    if (upgradeWires.has(w)) continue;
    for (const a of reps(boxOf(w.from)))
      for (const b of reps(boxOf(w.to))) finePairs.add(`${a}\u0000${b}`);
  }
  let replaced = 0;
  let retargeted = 0;
  let dropped = 0;
  const kept: WireV2[] = [];
  for (const w of graph.wires) {
    if (upgradeWires.has(w) && finePairs.has(`${boxOf(w.from)}\u0000${boxOf(w.to)}`)) {
      replaced++;
      continue;
    }
    kept.push(w);
  }

  // 2. 残った upgrade の線の付け替え
  const out: WireV2[] = [];
  const seen = new Set<string>();
  const push = (w: WireV2) => {
    if (seen.has(wireKey(w))) return;
    seen.add(wireKey(w));
    out.push(w);
  };
  const ensureUnderscore = (n: NodeV2, portId: string, dir: 'in' | 'out') => {
    let p = n.ports.find((x) => x.id === portId);
    if (!p) {
      p = { id: portId, dir, items: [] };
      n.ports.push(p);
    }
    if (!p.items.some((i) => i.id === UNDERSCORE)) p.items.push(underscoreItem());
  };
  for (const w of kept) {
    if (!upgradeWires.has(w)) {
      push(w);
      continue;
    }
    const a = boxOf(w.from);
    const b = boxOf(w.to);
    const ga = groups.get(a);
    const gb = groups.get(b);
    if (ga || gb) {
      // group になる v1 の箱に付いた線。相手がアダプタの箱なら、アダプタが関数の単位で引き直しているので消す
      const other = ga ? b : a;
      if (adapterIds.has(other) || (ga && gb)) {
        dropped++;
        continue;
      }
      for (const m of (ga ?? gb)!) {
        const mn = byId.get(m)!;
        const portOf = (ref: string) => {
          const hash = ref.indexOf('#');
          return ref.slice(hash + 1, ref.indexOf('/', hash));
        };
        const nw = clone(w);
        if (ga) {
          const port = portOf(w.from);
          ensureUnderscore(mn, port, 'out');
          nw.from = `${m}#${port}/${UNDERSCORE}`;
        } else {
          const port = portOf(w.to);
          ensureUnderscore(mn, port, 'in');
          nw.to = `${m}#${port}/${UNDERSCORE}`;
        }
        push(nw);
        retargeted++;
      }
      continue;
    }
    // 画面の入口: 配信の線は in/html に着く（docs/17 §7 #2）
    const to = byId.get(b);
    if (
      to &&
      adapterIds.has(b) &&
      to.kind === 'screen' &&
      w.to === `${b}#in/${UNDERSCORE}` &&
      to.ports.some((p) => p.id === 'in' && p.items.some((i) => i.id === 'html'))
    ) {
      push({ ...w, to: `${b}#in/html` });
      retargeted++;
      continue;
    }
    push(w);
  }

  // 3. group になった v1 の箱を消す（view の始点は中の最初の関数の箱へ）
  for (const g of groups.keys()) byId.delete(g);
  graph.nodes = graph.nodes.filter((n) => !groups.has(n.id));
  for (const v of graph.views ?? []) {
    if (typeof v.start === 'string' && groups.has(boxOf(v.start) || v.start)) {
      v.start = groups.get(boxOf(v.start) || v.start)![0]!;
    }
  }

  // 4. 参照が解けない線を落とす（アダプタが upgrade に無い箱・項目を指したもの）
  const itemRefs = new Set<string>();
  for (const n of graph.nodes)
    for (const p of n.ports)
      walkItems(p.items, (_, path) => itemRefs.add(`${n.id}#${p.id}/${path}`));
  graph.wires = out.filter((w) => {
    if (itemRefs.has(w.from) && itemRefs.has(w.to)) return true;
    dropped++;
    issues.push({
      level: 'warning',
      path: `v2:wire:${w.from}->${w.to}`,
      message: `線 "${w.from}" → "${w.to}" の端が graph にありません（アダプタの線を落とします）`,
    });
    return false;
  });

  // 5. アダプタの箱の `_` は、指されていなければ消す。残った `_` には crude の links を足す
  const used = new Set<string>();
  for (const w of graph.wires) {
    used.add(w.from);
    used.add(w.to);
  }
  for (const id of adapterIds) {
    const n = byId.get(id);
    if (!n) continue;
    for (const p of n.ports)
      p.items = p.items.filter((i) => i.id !== UNDERSCORE || used.has(`${n.id}#${p.id}/${i.id}`));
    // `_` だけだった口は消す（部品の out など。endpoint の 4 口は形なので残す）
    if (n.kind !== 'endpoint') n.ports = n.ports.filter((p) => p.items.length > 0);
    linkUnderscores(n);
  }
  return { graph, groups: groups.size, replaced, retargeted, dropped, issues };
}

const roots = (n: NodeV2, dir: 'in' | 'out', portId?: string) =>
  n.ports
    .filter((p) => p.dir === dir && (portId === undefined || p.id === portId))
    .flatMap((p) => p.items.map((i) => ({ port: p.id, item: i })));

/**
 * 残った `_` に crude の links を足す。links を持たない箱は、先に既定（wiring の defaultLinks と同じ）を書き出す
 * （links を 1 本でも書くと既定が効かなくなるため）
 */
function linkUnderscores(n: NodeV2) {
  const hasUnderscore = n.ports.some((p) => p.items.some((i) => i.id === UNDERSCORE));
  if (!hasUnderscore) return;
  const named = (dir: 'in' | 'out', portId?: string) =>
    roots(n, dir, portId).filter((r) => r.item.id !== UNDERSCORE);
  const unders = (dir: 'in' | 'out') => roots(n, dir).filter((r) => r.item.id === UNDERSCORE);
  const ref = (r: { port: string; item: ItemV2 }) => `${r.port}/${r.item.id}`;
  const links: LinkV2[] = [];
  const add = (from: string, to: string) => links.push({ from, to, confidence: 'crude' });

  if (n.kind === 'endpoint') {
    if (!n.links) {
      // 既定（恒等）を書き出す
      for (const a of named('in', 'in'))
        if (named('out', 'req').some((b) => b.item.id === a.item.id))
          links.push({ from: ref(a), to: `req/${a.item.id}` });
      for (const a of named('in', 'res'))
        if (named('out', 'out').some((b) => b.item.id === a.item.id))
          links.push({ from: ref(a), to: `out/${a.item.id}` });
    }
    const pairs: Array<[string, string]> = [
      ['in', 'req'],
      ['res', 'out'],
    ];
    for (const [src, dst] of pairs) {
      const srcs = roots(n, 'in', src);
      const dsts = roots(n, 'out', dst);
      for (const a of srcs)
        for (const b of dsts)
          if (a.item.id === UNDERSCORE || b.item.id === UNDERSCORE) add(ref(a), ref(b));
    }
  } else {
    if (!n.links && n.kind !== 'table') {
      for (const a of named('in')) for (const b of named('out')) add(ref(a), ref(b));
    }
    const activation = named('in').filter((r) => ACTIVATION.includes(r.item.id));
    const starts = activation.length
      ? activation
      : named('in').filter((r) => !/^ret_\d+$/.test(r.item.id));
    // 起動の項目（無ければ引数）と in/_ → out/_（箱の単位の入口から出口へ。upgrade の既定「全 in → 全 out」と同じ）
    for (const u of unders('out'))
      for (const a of [...starts, ...unders('in')]) add(ref(a), ref(u));
    for (const u of unders('in')) for (const b of named('out')) add(ref(u), ref(b));
  }
  const merged = mergeLinkLists(n.links, links);
  if (merged?.length) n.links = merged;
}

/** 自動率のサマリ（docs/17 §4。CLI の build の要約に出す） */
export interface CoverageV2 {
  items: number;
  /** wireType が unknown の項目 */
  unknownItems: number;
  wires: number;
  /** 両端が項目まで下がっている線 */
  itemWires: number;
  /** どちらかの端が `_`（箱の単位）の線 */
  boxWires: number;
  /**
   * 箱の単位の線のうち、両端がコードの箱で、どちらかが項目まで下がっている（型のある項目を持つ）もの。
   * 言語アダプタが関数の単位にした後も残った、呼び出しでない参照（定数の import・コールバック渡し。D53）
   */
  refWires: number;
  links: number;
  exactLinks: number;
  crudeLinks: number;
  /** links を書いていない箱のうち in と out の両方に項目がある箱（既定の「全 in → 全 out」で通す） */
  opaqueBoxes: number;
}

const CODE_KINDS = new Set(['screen', 'component', 'hook', 'helper', 'fn']);

export function coverageV2(g: GraphV2): CoverageV2 {
  const c: CoverageV2 = {
    items: 0,
    unknownItems: 0,
    wires: g.wires.length,
    itemWires: 0,
    boxWires: 0,
    refWires: 0,
    links: 0,
    exactLinks: 0,
    crudeLinks: 0,
    opaqueBoxes: 0,
  };
  const kindOf = new Map(g.nodes.map((n) => [n.id, n.kind]));
  /** 項目まで下がった箱（upgrade の置き場の項目は type が unknown） */
  const lowered = new Set(
    g.nodes
      .filter((n) => n.ports.some((p) => p.items.some((i) => i.type !== 'unknown')))
      .map((n) => n.id),
  );
  for (const n of g.nodes) {
    for (const p of n.ports)
      walkItems(p.items, (it) => {
        c.items++;
        if (it.wireType === 'unknown') c.unknownItems++;
      });
    for (const l of n.links ?? []) {
      c.links++;
      if (l.confidence === 'exact') c.exactLinks++;
      else if (l.confidence === 'crude') c.crudeLinks++;
    }
    if (!n.links && n.kind !== 'table' && n.kind !== 'endpoint') {
      const has = (dir: 'in' | 'out') => n.ports.some((p) => p.dir === dir && p.items.length > 0);
      if (has('in') && has('out')) c.opaqueBoxes++;
    }
  }
  for (const w of g.wires) {
    if (isUnderscoreRef(w.from) || isUnderscoreRef(w.to)) {
      c.boxWires++;
      const a = boxOf(w.from);
      const b = boxOf(w.to);
      if (
        CODE_KINDS.has(kindOf.get(a) ?? '') &&
        CODE_KINDS.has(kindOf.get(b) ?? '') &&
        (lowered.has(a) || lowered.has(b))
      )
        c.refWires++;
    } else c.itemWires++;
  }
  return c;
}
