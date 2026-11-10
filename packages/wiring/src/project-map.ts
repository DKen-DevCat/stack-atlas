// 地図の射影（docs/20 §2.1・§5.1・§7。Phase 8-6）: graph.json v2 → 3D の地図の形（v1 の Graph）と、選択・球を写す対応表。
// 地図の 1 ノード = `group ?? 箱の id`（× runtime。少ない側の runtime は `<id>@<runtime>`）。host の箱はそのまま 1 ノードで、
// 中の箱の単位へ deploy の線。線は (from の単位, to の単位) ごとに束 1 本（kind は deploy ＞ http ＞ schema ＞ uses ＞ flow）。
// 往復の戻り（return・sql・http の reply）は向きを戻して行きの束に入れる（deliver はデータの向きのまま）。層は LANES の順。
// group のノードの名前・kind・file は v2 のトップの `groups`（group になった v1 の箱の元の値）。無ければ id から決める。
// 型の層とフローは出さない（型は配線図の型クリック、始点は views）。純関数・決定的（同じ v2 から同じ結果）
import {
  parseItemRef,
  RUNTIMES,
  type Edge,
  type Graph,
  type GraphNode,
  type GraphV2,
  type Layer,
  type NodeKindV2,
  type NodeV2,
  type Region,
  type Runtime,
  type Screen,
  type WireVia,
} from '@stack-atlas/schema';
import { LANES } from './layout/types.js';
import type { LitSelection } from './select.js';

/** 束の kind の優先順（先ほど強い） */
export const MAP_EDGE_PRIORITY = ['deploy', 'http', 'schema', 'uses', 'flow'] as const;
export type MapEdgeKind = (typeof MAP_EDGE_PRIORITY)[number];

/** 線の via → 地図の線の kind */
export const VIA_EDGE_KIND: Readonly<Record<WireVia, MapEdgeKind>> = {
  call: 'uses',
  return: 'uses',
  render: 'uses',
  props: 'uses',
  http: 'http',
  sql: 'schema',
  deliver: 'deploy',
  event: 'flow',
};

/** 向きを戻す戻りの via（往復の戻り。deliver の reply はデータの向きのままにする） */
const REVERSED_REPLY: ReadonlySet<WireVia> = new Set(['return', 'sql', 'http']);

/** 地図のノードの id の接頭辞 → v1 の kind（docs/20 §5.1 #3） */
export const PREFIX_KIND: Readonly<Record<string, string>> = {
  route: 'page',
  layout: 'layout',
  comp: 'component',
  hook: 'hook',
  lib: 'lib',
  handler: 'handler',
  schema: 'schema',
  infra: 'infra',
  endpoint: 'endpoint',
  actor: 'actor',
  trigger: 'cron',
  cron: 'cron',
  type: 'type',
  db: 'db',
  queue: 'queue',
  service: 'service',
};

/** 接頭辞が表に無いとき（`fn:` など）: 中の箱の v2 の kind の多数決をこの表で v1 の語彙にする */
export const V2_KIND_TO_V1: Readonly<Record<NodeKindV2, string>> = {
  screen: 'page',
  component: 'component',
  hook: 'hook',
  helper: 'lib',
  fn: 'lib',
  endpoint: 'endpoint',
  table: 'schema',
  cache: 'infra',
  trigger: 'cron',
  actor: 'actor',
  external: 'service',
  infra: 'infra',
  queue: 'queue',
};

export interface ProjectMapOptions {
  /** 層の色（LANES の id → `#rrggbb`）。無ければ層に色を付けない（ビューアの既定の色） */
  laneColors?: Readonly<Record<string, string>>;
}

/** 地図の 1 本の線（束）の対応 */
export interface MapEdgeInfo {
  edge: Edge;
  /** 束に入った線のキー（GraphIndex の `w<index>`）。host の deploy だけの束は空 */
  wires: string[];
}

export interface MapProjection {
  /** 地図の graph（v1。validateGraph を通る） */
  graph: Graph;
  /** 箱の id → 地図のノードの id（host の箱は自分） */
  unitOf: ReadonlyMap<string, string>;
  /** 地図のノードの id → 中の箱の id（v2 の順） */
  members: ReadonlyMap<string, readonly string[]>;
  /** 地図のノードの id → 選択の写し先（配線図の Selection の材料。docs/20 §5.1 #7） */
  unitKind: ReadonlyMap<string, 'box' | 'host' | 'group'>;
  /** edgeKey(from, to) → 束の中身 */
  edges: ReadonlyMap<string, MapEdgeInfo>;
}

/** 束のキー（地図のノードの id は改行を含まない） */
export const edgeKey = (from: string, to: string): string => `${from}\n${to}`;

const GROUP_ID = /^[a-z]+:/;

/** 箱の単位の元（`group ?? 箱の id`。group が `<接頭辞>:` で始まらなければ `group:` を前に付ける。docs/20 §5.1 #1） */
export function unitBase(n: Pick<NodeV2, 'id' | 'group'>): string {
  if (n.group === undefined || n.group === '') return n.id;
  return GROUP_ID.test(n.group) ? n.group : `group:${n.group}`;
}

/** `@<runtime>` を外した id（メモ・差分・`?sel=` はこれで引く。docs/20 §5.1 #2） */
export function stripRuntime(id: string): string {
  const at = id.lastIndexOf('@');
  if (at < 0) return id;
  return (RUNTIMES as readonly string[]).includes(id.slice(at + 1)) ? id.slice(0, at) : id;
}

const laneOf = (r: Runtime): string => LANES.find((l) => l.runtimes.includes(r))?.id ?? 'external';

function commonDir(files: string[]): string | undefined {
  if (files.length === 0) return undefined;
  if (files.every((f) => f === files[0])) return files[0];
  const parts = files.map((f) => f.split('/'));
  const out: string[] = [];
  for (let i = 0; ; i++) {
    const seg = parts[0]![i];
    // 最後の段（ファイル名）は比べない
    if (seg === undefined || parts.some((p) => p.length - 1 <= i || p[i] !== seg)) break;
    out.push(seg);
  }
  return out.length ? out.join('/') : undefined;
}

/** 多数決（同数は表の順で先のもの） */
function majority<T extends string>(values: T[], order: readonly string[]): T | undefined {
  const count = new Map<T, number>();
  for (const v of values) count.set(v, (count.get(v) ?? 0) + 1);
  let best: T | undefined;
  for (const [v, c] of count) {
    if (
      best === undefined ||
      c > count.get(best)! ||
      (c === count.get(best)! && order.indexOf(v) < order.indexOf(best))
    )
      best = v;
  }
  return best;
}

function kindOf(unitId: string, boxes: NodeV2[]): string {
  const prefix = unitId.slice(0, unitId.indexOf(':'));
  const own = boxes.length === 1 && boxes[0]!.id === unitId ? boxes[0]! : undefined;
  // id は infra: でも v2 で trigger / actor の箱（Scheduler など）は v2 の kind を優先する
  if (own && (own.kind === 'trigger' || own.kind === 'actor')) return V2_KIND_TO_V1[own.kind];
  const byPrefix = PREFIX_KIND[prefix];
  if (byPrefix) return byPrefix;
  const k = majority(
    boxes.map((b) => b.kind),
    Object.keys(V2_KIND_TO_V1),
  );
  return k ? V2_KIND_TO_V1[k] : 'lib';
}

/**
 * group の値の表示名の候補（短い順）: 接頭辞とファイルの拡張子を外し、最後の 2 段、3 段、…、全部（1 段しか無ければその 1 段）。
 * v1 の箱の名前（`cmd/api`・`internal/store`）に近い形。v2 の `groups` に元の名前があればそれを使い、この候補は
 * `groups` が無いときと、元の名前がほかの group と重なるとき（`days/request.ts` と `spend/request.ts` がどちらも `request`）だけ使う
 */
function nameCandidates(base: string): string[] {
  const label = base.slice(base.indexOf(':') + 1).replace(/\.[A-Za-z0-9]+$/, '');
  const segs = label.split('/').filter(Boolean);
  const out: string[] = [];
  for (let k = Math.min(2, segs.length); k <= segs.length; k++) out.push(segs.slice(-k).join('/'));
  if (!out.includes(label)) out.push(label);
  return out;
}

/**
 * graph.json v2 を地図の graph（v1）に写す（docs/20 §2.1・§5.1）。参照の解けない線・host は飛ばす
 */
export function projectMap(g: GraphV2, opts: ProjectMapOptions = {}): MapProjection {
  const byId = new Map(g.nodes.map((n) => [n.id, n]));
  const hostIds = new Set(g.nodes.flatMap((n) => (n.host && byId.has(n.host) ? [n.host] : [])));

  // 1. 単位: base × runtime。中の箱がいちばん多い runtime が base の id を持つ（同数は RUNTIMES の順）
  const perBase = new Map<string, Map<Runtime, NodeV2[]>>();
  for (const n of g.nodes) {
    const base = hostIds.has(n.id) ? n.id : unitBase(n);
    let m = perBase.get(base);
    if (!m) perBase.set(base, (m = new Map()));
    const arr = m.get(n.runtime);
    if (arr) arr.push(n);
    else m.set(n.runtime, [n]);
  }
  const unitOf = new Map<string, string>();
  const units = new Map<string, { base: string; runtime: Runtime; boxes: NodeV2[] }>();
  // 単位の順は中の最初の箱の順（v2 の nodes の順）
  for (const n of g.nodes) {
    const base = hostIds.has(n.id) ? n.id : unitBase(n);
    const byRt = perBase.get(base)!;
    const primary = [...byRt.entries()].sort(
      (a, b) => b[1].length - a[1].length || RUNTIMES.indexOf(a[0]) - RUNTIMES.indexOf(b[0]),
    )[0]![0];
    const id = n.runtime === primary ? base : `${base}@${n.runtime}`;
    unitOf.set(n.id, id);
    const u = units.get(id);
    if (u) u.boxes.push(n);
    else units.set(id, { base, runtime: n.runtime, boxes: [n] });
  }

  // 2. 表示名: 箱そのもの（単位の id が箱の id）は箱の名前、group は v2 の groups の元の名前（無ければ最後の段）。
  // 元の名前がほかの group と重なるとき・groups が無いときは、ほかの group と重ならない最も短い段
  const groupInfo = new Map((g.groups ?? []).map((x) => [x.id, x]));
  const groupUnits = [...units.entries()].filter(
    ([id, u]) => !(u.boxes.length === 1 && u.boxes[0]!.id === id),
  );
  const taken = new Map<string, number>();
  const cands = new Map(groupUnits.map(([id, u]) => [id, nameCandidates(u.base)]));
  for (const [id, c] of cands)
    if (id === units.get(id)!.base) for (const s of c) taken.set(s, (taken.get(s) ?? 0) + 1);
  /** 元の名前ごとの group の数（@runtime の写しは数えない） */
  const infoNames = new Map<string, number>();
  for (const [id, u] of groupUnits) {
    const n = id === u.base ? groupInfo.get(u.base)?.name : undefined;
    if (n !== undefined) infoNames.set(n, (infoNames.get(n) ?? 0) + 1);
  }
  const nameOf = (id: string, u: { base: string; runtime: Runtime; boxes: NodeV2[] }) => {
    if (u.boxes.length === 1 && u.boxes[0]!.id === id) return u.boxes[0]!.name;
    const info = groupInfo.get(u.base)?.name;
    const c = cands.get(id)!;
    const name =
      info !== undefined && infoNames.get(info) === 1
        ? info
        : (c.find((s) => (taken.get(s) ?? 0) <= 1) ?? c[c.length - 1]!);
    return id === u.base ? name : `${name}@${u.runtime}`;
  };

  // 3. 層（LANES の順で、存在するものだけ）
  const lanesUsed = new Set([...units.values()].map((u) => laneOf(u.runtime)));
  const layers: Layer[] = LANES.filter((l) => lanesUsed.has(l.id)).map((l) => {
    const color = opts.laneColors?.[l.id];
    return { id: l.id, name: l.name, ...(color ? { color } : {}) };
  });

  // 4. ノード
  const members = new Map<string, string[]>();
  const unitKind = new Map<string, 'box' | 'host' | 'group'>();
  const nodes: GraphNode[] = [];
  for (const [id, u] of units) {
    const own = u.boxes.length === 1 && u.boxes[0]!.id === id ? u.boxes[0]! : undefined;
    const one = u.boxes.length === 1 ? u.boxes[0]! : undefined;
    members.set(
      id,
      u.boxes.map((b) => b.id),
    );
    unitKind.set(id, own ? (hostIds.has(own.id) ? 'host' : 'box') : 'group');
    const info = own ? undefined : groupInfo.get(u.base);
    // 行とコードは箱そのもの（と、元の値の無い 1 箱の group）だけ。group の元の値があれば file はそれ
    const lineOf = info ? undefined : one;
    const file =
      info?.file ?? one?.file ?? commonDir(u.boxes.flatMap((b) => (b.file ? [b.file] : [])));
    const cache = u.boxes.find((b) => b.cache)?.cache;
    const scr = u.boxes.find((b) => b.screen)?.screen;
    const node: GraphNode = {
      id,
      layer: laneOf(u.runtime),
      kind: info?.kind ?? kindOf(id, u.boxes),
      name: nameOf(id, u),
      ...(file ? { file } : {}),
      ...(lineOf?.line !== undefined ? { line: lineOf.line } : {}),
      ...(lineOf?.code !== undefined ? { code: lineOf.code } : {}),
      ...(cache ? { cache } : {}),
      meta: { members: u.boxes.map((b) => b.id), runtime: u.runtime },
    };
    if (scr) {
      // 地図では HTML を使わない（スクショがあればそれ、無ければプレースホルダ。docs/20 §2.3）。regions の ref は単位に付け替える
      const regions: Region[] = [];
      for (const r of scr.regions ?? []) {
        const ref = unitOf.get(r.ref);
        if (ref) regions.push({ ref, x: r.x, y: r.y, w: r.w, h: r.h });
      }
      const screen: Screen = {
        width: scr.width,
        height: scr.height,
        ...(scr.screenshot ? { screenshot: scr.screenshot } : {}),
        regions,
      };
      node.screen = screen;
    }
    nodes.push(node);
  }

  // 5. 線: host → 中の箱の単位（deploy）、箱をまたぐ線を単位の対で束ねる
  const bundles = new Map<
    string,
    { from: string; to: string; kinds: Set<MapEdgeKind>; wires: string[] }
  >();
  const add = (from: string, to: string, kind: MapEdgeKind, wire?: string) => {
    if (from === to) return;
    const k = edgeKey(from, to);
    let b = bundles.get(k);
    if (!b) bundles.set(k, (b = { from, to, kinds: new Set(), wires: [] }));
    b.kinds.add(kind);
    if (wire) b.wires.push(wire);
  };
  for (const n of g.nodes) {
    if (!n.host || !hostIds.has(n.host)) continue;
    add(unitOf.get(n.host)!, unitOf.get(n.id)!, 'deploy');
  }
  g.wires.forEach((w, i) => {
    const a = parseItemRef(w.from)?.nodeId;
    const b = parseItemRef(w.to)?.nodeId;
    const fu = a === undefined ? undefined : unitOf.get(a);
    const tu = b === undefined ? undefined : unitOf.get(b);
    if (fu === undefined || tu === undefined) return;
    const kind = VIA_EDGE_KIND[w.via];
    const reverse = !!w.reply && REVERSED_REPLY.has(w.via);
    add(reverse ? tu : fu, reverse ? fu : tu, kind, `w${i}`);
  });
  const edges = new Map<string, MapEdgeInfo>();
  const graphEdges: Edge[] = [];
  for (const [k, b] of bundles) {
    const kind = MAP_EDGE_PRIORITY.find((p) => b.kinds.has(p))!;
    const edge: Edge = { from: b.from, to: b.to, kind };
    graphEdges.push(edge);
    edges.set(k, { edge, wires: b.wires });
  }

  const p = g.project;
  const project = p
    ? Object.fromEntries(
        (['name', 'description', 'repo', 'commit', 'generatedAt', 'sources'] as const).flatMap(
          (key) => (p[key] !== undefined ? [[key, p[key]]] : []),
        ),
      )
    : undefined;
  const graph: Graph = {
    version: 1,
    ...(project && Object.keys(project).length ? { project } : {}),
    layers,
    nodes,
    edges: graphEdges,
  };
  return { graph, unitOf, members, unitKind, edges };
}

/** 地図で光らせるもの（配線図の LitSelection を対応表で写したもの。docs/20 §5.1 #6） */
export interface MapLit {
  /** 光る地図のノード（光る箱の単位と、その箱を載せている host） */
  nodes: Set<string>;
  /** 光る束（edgeKey） */
  edges: Set<string>;
  /** 始点（白い輪）のノード */
  starts: Set<string>;
}

/**
 * 配線図の選択（LitSelection）を地図に写す。光る箱の単位と host、光る線を含む束、host から光る箱への deploy の束。
 * 始点は始点の箱・項目の箱の単位（型の横断面は始点なし、線の選択は送る側、host の枠はその host、地図の group は中の箱の単位）
 */
export function litOnMap(
  p: MapProjection,
  g: GraphV2,
  lit: Pick<LitSelection, 'boxes' | 'segs' | 'startBoxes' | 'startItems' | 'selection'>,
): MapLit {
  const byId = new Map(g.nodes.map((n) => [n.id, n]));
  const nodes = new Set<string>();
  const edges = new Set<string>();
  const starts = new Set<string>();
  const unit = (id: string) => p.unitOf.get(id);
  for (const b of lit.boxes) {
    const u = unit(b);
    if (u === undefined) continue;
    nodes.add(u);
    const host = byId.get(b)?.host;
    const hu = host === undefined ? undefined : unit(host);
    if (hu !== undefined && hu !== u) {
      nodes.add(hu);
      if (p.edges.has(edgeKey(hu, u))) edges.add(edgeKey(hu, u));
    }
  }
  const wireKeys = new Set<string>();
  for (const s of lit.segs) if (s.kind === 'wire' && s.wire) wireKeys.add(s.wire.key);
  for (const [k, info] of p.edges) if (info.wires.some((w) => wireKeys.has(w))) edges.add(k);

  const sel = lit.selection;
  if (sel.kind === 'host') {
    const u = unit(sel.id);
    if (u !== undefined) {
      starts.add(u);
      nodes.add(u);
    }
  } else if (sel.kind === 'group') {
    // 始点は中の箱の単位（id はメモのキーで @runtime を外してあるので、写しを選んだときも中の箱から引く）
    for (const m of sel.members) {
      const u = unit(m);
      if (u !== undefined) starts.add(u);
    }
  } else if (sel.kind === 'wire') {
    const a = parseItemRef(sel.from)?.nodeId;
    const u = a === undefined ? undefined : unit(a);
    if (u !== undefined) starts.add(u);
  } else if (sel.kind !== 'type') {
    for (const b of lit.startBoxes) {
      const u = unit(b);
      if (u !== undefined) starts.add(u);
    }
    for (const ref of lit.startItems) {
      const a = parseItemRef(ref)?.nodeId;
      const u = a === undefined ? undefined : unit(a);
      if (u !== undefined) starts.add(u);
    }
  }
  return { nodes, edges, starts };
}
