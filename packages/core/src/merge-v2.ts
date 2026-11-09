/**
 * 言語アダプタの v2 を、upgradeGraph（8-1。箱の単位）の v2 に重ねる（docs/17 §3.1・§7 #4、D50・D53）。
 *
 * 流れ（パイプライン）: mergeV2 → join（合流。join.ts）→ removeOverrideWiresV2（overrides の線の削除）
 * → cleanupV2（細かい方が勝つ掃除）→ detectBroken
 *
 * mergeV2:
 * - 同じ箱 id: 口・項目・links・runtime・kind はアダプタが勝ち、host・cache・screen は upgrade の値を残す。
 *   upgrade の置き場の項目 `_` は、掃除まで残す（箱の単位の線がまだ指している）
 * - v1 のファイル・パッケージの箱（`lib:` / `handler:` など）が関数の箱で置き換わるもの（被覆）を集める（D47・D53）:
 *   ① アダプタが `groups`（関数の箱 → v1 の箱）で明示したもの ② TS: v1 の箱の `meta.ts.exports` が全部、同じ file の
 *   アダプタの箱（`meta.ts.exportName`）になっている。中に入れるのはその export の箱（と複製）だけ ③ `meta.sharedOf`
 *   （`@runtime` の複製）④ Go: 同じ `meta.go.pkg` の関数の箱がある。接頭辞では判定しない
 * - 置き換わる v1 の箱の host・runtime は中の関数の箱が受け継ぐ。関数の箱の group は v1 の箱 id（折りたたみの単位。
 *   その id に付いたメモは group に出す）
 * - 複数の入口から使う関数（`meta.hosts`）は group の host を受け継がない（8-2b）。型は同じ id なら契約（openapi・sql）が
 *   言語アダプタに勝つ（D65。v2-parts の mergeNamedTypes）
 * - overrides.yaml（2026-11-09 レビュー C2）: `remove` の箱 id はアダプタからも出さない。その `@runtime` の複製と、
 *   消した v1 の箱が group になるはずだった中の関数の箱も消す（消す前の file・meta で被覆を判定する）。`nodes` の
 *   上書き（kind・name・file・line・code・cache・screen）はアダプタの値に勝つ（upgrade の箱の値を戻す。複製にも）
 *
 * removeOverrideWiresV2（join の後）: overrides の `remove` の `{from, to, kind}`（v1 のエッジ）に当たる線を消す。
 * 端は複製と group の中の箱にも広げ、その戻り（reply の逆向き）も消す
 *
 * cleanupV2（join の後）:
 * - upgrade の線（箱の単位）は、向き付きの同じ箱の対にアダプタか合流の線が 1 本でもあれば消す（D50）。
 *   group になった v1 の箱は、中の関数の箱の対として数える
 * - 残った upgrade の線: 画面の `in/_` に着くもの（配信）は `in/html` へ付け替える。group になった v1 の箱に付くものは、
 *   相手がアダプタの箱でも消さず（細かい線が無い = 合流できなかった・overrides で足した線）、中の関数の箱のうち
 *   **実際に参照しているもの**へ付け替える（2026-11-09 レビュー C1・C6）。参照の手がかりは、アダプタの refs（箱ごとの
 *   参照先）と、HTTP の線なら呼び出しの項目の `meta.http`（endpoint に合うもの、無ければ合流できなかった呼び出し）。
 *   テーブルへの線（via sql）は、そのテーブルを SQL（`meta.sql`）で使う中の関数の箱（8-2b）。
 *   決められなければ中の全部へ付け替え、その数を `undetermined` に数える（サマリに出す）。合流で結んだ箱の対
 *   （JoinReport.pairs）は細かい線があるものとして数える
 * - group になった v1 の箱を消す。アダプタの箱の `_` は、どの線にも指されていなければ消す
 * - 残った `_`（呼び出しでない参照・合流の相手がまだ箱の単位の所）には crude の links を足す。起動の項目 → `out/_`、
 *   `in/_` → 全部の out（links を 1 本でも持つ箱は既定の「全 in → 全 out」が効かず、`_` が行き止まりになるため）
 */
import type {
  Edge,
  GraphV2,
  ItemV2,
  LinkV2,
  NodeV2,
  PortV2,
  Runtime,
  ValidationIssue,
  WireV2,
  WireVia,
} from '@stack-atlas/schema';
import type { Overrides, PartialGraphV2, PartialNode, PartialNodeV2 } from './types.js';
import { clone, deepMerge, isPlainObject } from './util.js';
import { endpointRoute, httpCallOf, usesTable } from './join.js';
import { apiPathMatches, methodMatches } from './paths.js';
import {
  UNDERSCORE,
  boxOf,
  isUnderscoreRef,
  mergeLinkLists,
  mergeNamedTypes,
  mergeVariants,
  underscoreItem,
  walkItems,
  wireKey,
} from './v2-parts.js';

export interface MergeV2Options {
  /**
   * overrides.yaml（v1 の書き方。docs/09 §3.2）。`remove` の箱 id と `nodes` の上書きを v2 にも当てる。
   * `remove` の `{from, to}` は join の後に removeOverrideWiresV2 で当てる
   */
  overrides?: Overrides;
  /** overrides の remove で v1 から消した箱の、消す前の file・meta（group になるはずだった中の関数の箱を消すため） */
  removedNodes?: ReadonlyArray<Pick<PartialNode, 'id' | 'file' | 'meta'>>;
  /** overrides の remove で消した箱 id（overrides.remove の文字列と同じ扱い） */
  removed?: ReadonlySet<string>;
  /** v2 の印に足す言語アダプタ名（project.generator.adapters） */
  adapters?: string[];
  /** v2 の印に足す契約の抽出器名（project.generator.contracts。openapi・sql） */
  contracts?: string[];
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
  /** 箱 id → その箱が参照する箱・v1 の箱の id（アダプタの refs。付け替え先を決める手がかり） */
  refs: Map<string, Set<string>>;
  /** overrides で消した箱（指定した id、その複製、group になるはずだった中の関数の箱） */
  removed: Set<string>;
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

/** group にするか判定する v1 の箱（upgrade の箱か、overrides で消す前の v1 の箱） */
interface GroupCandidate {
  id: string;
  file?: string;
  meta?: Record<string, unknown>;
}

const exportNameOf = (n: Pick<NodeV2, 'meta'>): string | undefined => {
  const ts = n.meta?.ts;
  return isPlainObject(ts) && typeof ts.exportName === 'string' ? ts.exportName : undefined;
};

/** v1 の箱 → 置き換える関数の箱（被覆。D53） */
function findGroups(
  candidates: ReadonlyMap<string, GroupCandidate>,
  adapterNodes: readonly NodeV2[],
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
  // ① 明示（関数の箱 → v1 の箱）
  for (const [member, v1] of Object.entries(part.groups ?? {}))
    if (candidates.has(v1) && adapterIds.has(member)) add(v1, member);
  const byFile = new Map<string, NodeV2[]>();
  const byPkg = new Map<string, NodeV2[]>();
  for (const n of adapterNodes) {
    if (n.file) byFile.set(n.file, [...(byFile.get(n.file) ?? []), n]);
    const pkg = goPkg(n);
    if (pkg) byPkg.set(pkg, [...(byPkg.get(pkg) ?? []), n]);
    // ③ @runtime の複製
    const shared = n.meta?.sharedOf;
    if (typeof shared === 'string' && candidates.has(shared)) add(shared, n.id);
  }
  for (const u of candidates.values()) {
    if (adapterIds.has(u.id) || groups.has(u.id)) continue;
    // ② TS のファイルの箱: export が全部アダプタの箱になっている。中に入れるのはその export の箱（と @runtime の複製）
    // だけ。同じ file の部品・hook は ts-imports の別の v1 の箱（2026-11-09 レビュー C5）
    const ts = u.meta?.ts;
    const exports = isPlainObject(ts) && Array.isArray(ts.exports) ? (ts.exports as unknown[]) : [];
    if (u.file && exports.length) {
      const here = (byFile.get(u.file) ?? []).filter((n) => {
        const name = exportNameOf(n);
        return name !== undefined && exports.includes(name);
      });
      const names = new Set(here.map(exportNameOf));
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

/** overrides の remove の箱 id */
const removedIdsOf = (o: Overrides | undefined) =>
  (o?.remove ?? []).filter((r): r is string => typeof r === 'string');

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
  const removed = new Set<string>([...(opts.removed ?? []), ...removedIdsOf(opts.overrides)]);
  // 消した箱の @runtime の複製（sharedOf）も出さない
  for (const pn of part.nodes) {
    const shared = pn.meta?.sharedOf;
    if (typeof shared === 'string' && removed.has(shared)) removed.add(pn.id);
  }

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
    if (seen.has(wireKey(w))) continue;
    seen.add(wireKey(w));
    graph.wires.push(clone(w));
  }

  // 型（D65）: 同じ id は契約（source が openapi・sql）が言語アダプタに勝つ。upgrade の型（v1 の type: の箱）は先に
  // あるもの（v1 のマージで OpenAPI の型が正になっていれば source は openapi）。負けた側の宣言の場所は勝った側の meta.copies に足す
  graph.types = mergeNamedTypes(graph.types ?? [], part.types ?? []);
  if (!graph.types.length) delete graph.types;

  // 被覆（group）。overrides で消した v1 の箱も、消す前の file・meta で判定し、中の関数の箱を消す
  const candidates = new Map<string, GroupCandidate>(graph.nodes.map((n) => [n.id, n]));
  for (const n of opts.removedNodes ?? [])
    if (removed.has(n.id) && !candidates.has(n.id)) candidates.set(n.id, n);
  const found = findGroups(
    candidates,
    graph.nodes.filter((n) => adapterIds.has(n.id)),
    part,
    adapterIds,
  );
  const groups = new Map<string, string[]>();
  for (const [g, ms] of found) {
    if (removed.has(g)) for (const m of ms) removed.add(m);
    else groups.set(g, ms);
  }
  if (removed.size) {
    for (const id of removed) {
      adapterIds.delete(id);
      byId.delete(id);
    }
    graph.nodes = graph.nodes.filter((n) => !removed.has(n.id));
    graph.wires = graph.wires.filter(
      (w) => !removed.has(boxOf(w.from)) && !removed.has(boxOf(w.to)),
    );
    for (const [g, ms] of groups) {
      const left = ms.filter((m) => !removed.has(m));
      if (left.length) groups.set(g, left);
      else groups.delete(g);
    }
  }

  // 中の関数の箱は、置き換わる v1 の箱の host・runtime を受け継ぐ。group は v1 の箱 id。
  // 複数の入口から使う関数（アダプタが host を空にして meta.hosts に並べたもの。§7 #11）は host を受け継がない
  // （2026-11-09 8-2b の決定。パッケージの箱の host は 8-1 の uses の閉包で、関数の単位より粗い）
  for (const [g, members] of groups) {
    const gn = byId.get(g)!;
    for (const id of members) {
      const m = byId.get(id)!;
      if (m.host === undefined && gn.host !== undefined && !Array.isArray(m.meta?.hosts))
        m.host = gn.host;
      if ((m as Partial<NodeV2>).runtime === undefined) m.runtime = gn.runtime;
      if (m.group === undefined) m.group = g;
    }
  }
  for (const n of graph.nodes)
    if ((n as Partial<NodeV2>).runtime === undefined) n.runtime = 'browser';

  applyNodePatches(graph, upgraded, opts.overrides?.nodes ?? [], adapterIds);

  if (graph.project && (opts.adapters?.length || opts.contracts?.length)) {
    const gen = isPlainObject(graph.project.generator) ? graph.project.generator : {};
    graph.project.generator = {
      ...gen,
      ...(opts.adapters?.length ? { adapters: [...opts.adapters] } : {}),
      ...(opts.contracts?.length ? { contracts: [...opts.contracts] } : {}),
    };
  }
  const refs = new Map<string, Set<string>>();
  for (const [k, list] of Object.entries(part.refs ?? {}))
    if (!removed.has(k)) refs.set(k, new Set(list));
  return { graph, adapterIds, upgradeWires, groups, refs, removed };
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
  if (pn.variants?.length) u.variants = mergeVariants(u.variants, pn.variants)!;
  if (pn.meta) u.meta = deepMerge(u.meta ?? {}, pn.meta, { prefer: 'target' });
}

/** overrides の nodes で上書きできる箱のフィールド（meta は mergeInto で upgrade の値が勝つ） */
const PATCHABLE = ['kind', 'name', 'file', 'line', 'code', 'cache', 'screen'] as const;

/**
 * overrides の nodes（上書き）をアダプタの箱に当て直す（2026-11-09 レビュー C2）。upgrade の箱は overrides を当てた v1 から
 * 作ったので、上書きしたフィールドは upgrade の箱の値（kind は v2 の語彙に直したもの）を戻す。@runtime の複製にも当てる
 */
function applyNodePatches(
  graph: GraphV2,
  upgraded: GraphV2,
  patches: readonly PartialNode[],
  adapterIds: ReadonlySet<string>,
) {
  if (!patches.length) return;
  const up = indexNodes(upgraded);
  const byId = indexNodes(graph);
  const copies = new Map<string, NodeV2[]>();
  for (const n of graph.nodes) {
    const s = n.meta?.sharedOf;
    if (typeof s === 'string') copies.set(s, [...(copies.get(s) ?? []), n]);
  }
  for (const p of patches) {
    const src = up.get(p.id) as unknown as Record<string, unknown> | undefined;
    if (!src) continue;
    const keys = PATCHABLE.filter(
      (k) => (p as Record<string, unknown>)[k] !== undefined && src[k] !== undefined,
    );
    if (!keys.length) continue;
    for (const n of [byId.get(p.id), ...(copies.get(p.id) ?? [])]) {
      if (!n || !adapterIds.has(n.id)) continue;
      for (const k of keys) (n as unknown as Record<string, unknown>)[k] = clone(src[k]);
    }
  }
}

/** v1 のエッジの kind → それを表す v2 の線の via（overrides の remove の `{from, to, kind}` を v2 の線に当てる） */
const VIA_OF_KIND: Record<string, readonly WireVia[]> = {
  uses: ['call', 'return', 'render', 'props', 'sql'],
  http: ['http', 'call', 'return'],
  schema: ['sql'],
  deploy: ['deliver', 'http'],
  flow: ['http', 'event', 'deliver'],
};

/**
 * overrides の remove の `{from, to, kind}`（v1 のエッジ）に当たる v2 の線を消す（join の後、cleanupV2 の前に呼ぶ。
 * 2026-11-09 レビュー C2）。端は @runtime の複製と group の中の関数の箱にも広げ、戻り（reply の逆向き）も消す。
 * 消した線の数を返す
 */
export function removeOverrideWiresV2(state: MergedV2, overrides: Overrides | undefined): number {
  const edges = (overrides?.remove ?? []).filter((r): r is Edge => typeof r !== 'string');
  if (!edges.length) return 0;
  const { graph, groups } = state;
  const copies = new Map<string, string[]>();
  for (const n of graph.nodes) {
    const s = n.meta?.sharedOf;
    if (typeof s === 'string') copies.set(s, [...(copies.get(s) ?? []), n.id]);
  }
  const expand = (id: string) => {
    const out = new Set([id, ...(groups.get(id) ?? [])]);
    for (const x of [...out]) for (const c of copies.get(x) ?? []) out.add(c);
    return out;
  };
  let count = 0;
  for (const r of edges) {
    const from = expand(r.from);
    const to = expand(r.to);
    const vias = r.kind === undefined ? undefined : VIA_OF_KIND[r.kind];
    graph.wires = graph.wires.filter((w) => {
      if (vias && !vias.includes(w.via)) return true;
      const a = boxOf(w.from);
      const b = boxOf(w.to);
      const hit = (from.has(a) && to.has(b)) || (!!w.reply && from.has(b) && to.has(a));
      if (hit) count++;
      return !hit;
    });
  }
  return count;
}

export interface CleanupV2Result {
  graph: GraphV2;
  /** group にした v1 の箱の数 */
  groups: number;
  /** アダプタか合流の線があるので消した箱の単位の線 */
  replaced: number;
  /** 付け替えた箱の単位の線（画面の in/html、group の中の関数の箱） */
  retargeted: number;
  /**
   * group になった v1 の箱に残った線のうち、付け替え先（実際に参照している中の関数の箱）を決められず、
   * 中の全部へ付け替えたもの（元の線の数）
   */
  undetermined: number;
  /** 消した線（参照が解けないもの） */
  dropped: number;
  issues: ValidationIssue[];
}

export interface CleanupV2Options {
  /**
   * 合流で結んだ箱の対（向き付き。`<from>\u0000<to>`。JoinReport.pairs）。細かい線があるものとして数える
   * （応答の項目の無い handler など、片方の向きに線が無くても箱の単位の線を残さない）
   */
  pairs?: ReadonlySet<string>;
}

/** 掃除（D50・D53）。join の後に呼ぶ。state.graph を書き換えて返す */
export function cleanupV2(state: MergedV2, opts: CleanupV2Options = {}): CleanupV2Result {
  const { graph, upgradeWires, groups, refs } = state;
  const adapterIds = state.adapterIds;
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
  /** 合流の線が出ている呼び出しの項目（`<箱>#out/call_n`） */
  const joinedCalls = new Set<string>();
  const addPair = (x: string, y: string) => {
    for (const a of reps(x)) for (const b of reps(y)) finePairs.add(`${a}\u0000${b}`);
  };
  for (const w of graph.wires) {
    if (upgradeWires.has(w)) continue;
    addPair(boxOf(w.from), boxOf(w.to));
    // アダプタは http の線を引かない（D49）ので、upgrade でない http の行きの線は合流の線（endpoint・handler へ）
    if (w.via === 'http' && !w.reply) {
      const m = /^[^#]*#[^/]*\/[^.]*/.exec(w.from);
      if (m) joinedCalls.add(m[0]);
    }
  }
  for (const p of opts.pairs ?? []) {
    const i = p.indexOf('\u0000');
    addPair(p.slice(0, i), p.slice(i + 1));
  }
  let replaced = 0;
  let retargeted = 0;
  let undetermined = 0;
  let dropped = 0;
  const kept: WireV2[] = [];
  for (const w of graph.wires) {
    if (upgradeWires.has(w) && finePairs.has(`${boxOf(w.from)}\u0000${boxOf(w.to)}`)) {
      replaced++;
      continue;
    }
    kept.push(w);
  }

  /** 箱 id が target（箱。複製・group の中の箱・group の v1 の箱としても）を参照しているか（アダプタの refs） */
  const references = (id: string, target: string): boolean => {
    const r = refs.get(id);
    if (!r) return false;
    if (r.has(target)) return true;
    const shared = byId.get(target)?.meta?.sharedOf;
    if (typeof shared === 'string' && r.has(shared)) return true;
    const g = groupOf.get(target);
    if (g && r.has(g)) return true;
    return (groups.get(target) ?? []).some((m) => r.has(m));
  };
  /** HTTP の線の呼ぶ側: 呼び出しの項目の meta.http が endpoint に合う箱。無ければ合流できなかった呼び出しを持つ箱 */
  const httpCallers = (members: string[], endpointId: string): string[] => {
    const ep = byId.get(endpointId);
    const route = ep?.kind === 'endpoint' ? endpointRoute(ep) : undefined;
    if (!route) return [];
    const calls = (m: string) =>
      (byId.get(m)?.ports ?? [])
        .filter((p) => p.dir === 'out')
        .flatMap((p) =>
          p.items.map((it) => ({ ref: `${m}#${p.id}/${it.id}`, call: httpCallOf(it) })),
        )
        .filter((x) => x.call);
    const exact = members.filter((m) =>
      calls(m).some(
        (x) =>
          methodMatches(route.method, x.call!.method) && apiPathMatches(route.path, x.call!.path),
      ),
    );
    if (exact.length) return exact;
    return members.filter((m) => calls(m).some((x) => !joinedCalls.has(x.ref)));
  };
  /**
   * 線の group の端（v1 の箱）を、実際に参照している中の関数の箱にする。決められなければ undefined。
   * caller: その端が呼ぶ側（reply でない線の from、reply の線の to）か
   */
  const referrers = (
    members: string[],
    other: string,
    caller: boolean,
    w: WireV2,
  ): string[] | undefined => {
    let hit: string[];
    if (caller) {
      hit = members.filter((m) => references(m, other));
      if (!hit.length && w.via === 'http') hit = httpCallers(members, other);
      // テーブルへの線（overrides の uses・8-1 の schema）は、そのテーブルを SQL で使う中の関数の箱（meta.sql。8-2b）
      const table = byId.get(other);
      if (!hit.length && w.via === 'sql' && table?.kind === 'table')
        hit = members.filter((m) => {
          const n = byId.get(m);
          return !!n && usesTable(n, table);
        });
    } else {
      const callers = groups.get(other) ?? [other];
      hit = members.filter((m) => callers.some((c) => references(c, m)));
    }
    return hit.length ? hit : undefined;
  };

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
  const portOf = (ref: string) => {
    const hash = ref.indexOf('#');
    return ref.slice(hash + 1, ref.indexOf('/', hash));
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
      // group になる v1 の箱に付いた線。細かい線が無い（合流できなかった・overrides で足した）ので消さず、
      // 実際に参照している中の関数の箱へ付け替える（2026-11-09 レビュー C1・C6）
      const callerBox = w.reply ? b : a;
      const ends = (box: string, members: string[] | undefined, other: string) => {
        if (!members) return { list: [box], determined: true };
        const hit = referrers(members, other, box === callerBox, w);
        return hit ? { list: hit, determined: true } : { list: members, determined: false };
      };
      const fe = ends(a, ga, b);
      const te = ends(b, gb, a);
      if (!fe.determined || !te.determined) undetermined++;
      for (const f of fe.list)
        for (const t of te.list) {
          const nw = clone(w);
          if (ga) {
            const port = portOf(w.from);
            ensureUnderscore(byId.get(f)!, port, 'out');
            nw.from = `${f}#${port}/${UNDERSCORE}`;
          }
          if (gb) {
            const port = portOf(w.to);
            ensureUnderscore(byId.get(t)!, port, 'in');
            nw.to = `${t}#${port}/${UNDERSCORE}`;
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
  return { graph, groups: groups.size, replaced, retargeted, undetermined, dropped, issues };
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
    // in → req に分岐（認証の login。合流の段が書く）があれば、`_` の in → req にも同じ when を付ける
    const gate = n.links?.find(
      (l) => l.when && l.from.startsWith('in/') && l.to.startsWith('req/'),
    )?.when;
    const pairs: Array<[string, string]> = [
      ['in', 'req'],
      ['res', 'out'],
    ];
    for (const [src, dst] of pairs) {
      const srcs = roots(n, 'in', src);
      const dsts = roots(n, 'out', dst);
      for (const a of srcs)
        for (const b of dsts)
          if (a.item.id === UNDERSCORE || b.item.id === UNDERSCORE) {
            add(ref(a), ref(b));
            if (gate && src === 'in') links[links.length - 1]!.when = { ...gate };
          }
    }
  } else if (n.kind === 'table') {
    // table の既定は key → read（write は read へ流れない。wiring の defaultLinks と同じ）
    if (!n.links)
      for (const a of named('in', 'key'))
        for (const b of named('out', 'read')) links.push({ from: ref(a), to: ref(b) });
    const keys = roots(n, 'in', 'key');
    const reads = roots(n, 'out', 'read');
    for (const a of keys)
      for (const b of reads)
        if (a.item.id === UNDERSCORE || b.item.id === UNDERSCORE) add(ref(a), ref(b));
  } else {
    if (!n.links) {
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
