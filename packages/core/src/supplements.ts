/**
 * overrides の `v2:` の節（補い。docs/19 §3.1、D67・D73）を v2 の graph に当てる。
 *
 * 当てる段（pipeline）:
 * - 段 A（join の後・cleanupV2 の前）: `wires`（線を足す）・`remove`（線を消す）・`nodes`（箱のパッチ）。`retarget` は
 *   ここで確かめ、cleanupV2 が group の箱の単位の線を付け替えるときに使う（使われなければ解けない補い）。補った線は
 *   upgrade の線ではないので、cleanupV2 の「同じ箱の対に細かい線があれば箱の単位の線を消す」に入る
 * - 段 B（cleanupV2 の後）: `items`（不透明な項目の子）→ `variants` → `links` → `when` の順（links が足した子を、when が
 *   links と分岐を指せるように）。links は、links の無い箱なら既定の links（全 in → 全 out。table は key → read、endpoint は
 *   恒等）を先に書き出してから足す（`mode: replace` なら置き換え。1 本足すと既定が消えるため。docs/19 §7 #9）
 *
 * 参照（SupplementRef）: 文字列の参照に番号の項目（`call_1`・`ret_2`・`render_1`・`query_1` など）を含むなら `expect`
 * （指紋。番号の段の項目の name・type・http）が要り、合わなければ mismatch（前に呼び出しが 1 つ増えると番号がずれ、黙って
 * 別の項目を指すため）。意味の参照 `{ call: { in, to } }`・`{ call: { in, http } }`・`{ ret: { in, from } }` は、候補が
 * ちょうど 1 つのときだけ解ける（0 なら解けない、2 つ以上なら番号と expect で書く）。
 *
 * 既定: 補いで足した線・links・項目は `confidence: crude`（線は meta.confidence）、`meta.by: "overrides"` と reason。
 * reason は必須（無ければ警告。strict ではエラー）。結果は補いごとに applied / unresolved / mismatch（report の supplements）
 */
import {
  CONFIDENCES,
  NODE_KINDS_V2,
  RUNTIMES,
  WIRE_TYPES,
  WIRE_VIAS,
  parseItemRef,
  type Confidence,
  type GraphV2,
  type ItemV2,
  type LinkV2,
  type NodeV2,
  type PortV2,
  type WireV2,
  type When,
} from '@stack-atlas/schema';
import { httpCallOf } from './join.js';
import { apiPathMatches } from './paths.js';
import type { SupplementFingerprint, SupplementRef, SupplementsV2 } from './types.js';
import { clone, isPlainObject } from './util.js';
import { boxOf, mergeItemLists, wireKey } from './v2-parts.js';

/** 補いの種類（overrides の v2: のキーと、手書きの部分グラフ・views.yaml） */
export type SupplementKind =
  | 'nodes'
  | 'wires'
  | 'retarget'
  | 'remove'
  | 'links'
  | 'variants'
  | 'when'
  | 'items'
  | 'hand'
  | 'view';

/** applied: 効いた、unresolved: 解けない（参照が無い・形が違う・候補が複数）、mismatch: 指紋が合わない */
export type SupplementStatus = 'applied' | 'unresolved' | 'mismatch';

export interface SupplementResult {
  kind: SupplementKind;
  /** その種類の中の番号（overrides の v2.<kind>[index]。hand はファイルの順、view は views.yaml の順） */
  index: number;
  status: SupplementStatus;
  /** 何に当てたか（箱 id・参照・ファイル） */
  target?: string;
  /** 解けない理由・補足 */
  message?: string;
  reason?: string;
  /** reason が無い（警告。strict はエラー） */
  noReason?: boolean;
}

/** 番号の項目（前の呼び出し・SQL が増えると番号がずれる） */
const NUMBERED = /^(call|ret|render|query|insert|update)_\d+$/;
const ITEM_ID = /^[A-Za-z0-9_$-]+$/;
const VARIANT_ID = /^[a-z][a-z0-9_]*$/;
/** 1 つの items の補いで足せる子の数の上限 */
export const MAX_SUPPLEMENT_CHILDREN = 500;

interface Entry {
  node: NodeV2;
  port: PortV2;
  item: ItemV2;
  /** 口の中のパス（`a.b`） */
  path: string;
}

/** 参照 → 項目の索引（graph が変わったら作り直す） */
class RefIndex {
  readonly nodes: Map<string, NodeV2>;
  constructor(readonly graph: GraphV2) {
    this.nodes = new Map(graph.nodes.map((n) => [n.id, n]));
  }
  /** `<箱>#<口>/<a>.<b>` の項目と、パスの途中の項目（番号の段の指紋を見る） */
  resolve(ref: string): { entry: Entry; chain: ItemV2[] } | undefined {
    const p = parseItemRef(ref);
    if (!p) return undefined;
    const node = this.nodes.get(p.nodeId);
    const port = node?.ports.find((x) => x.id === p.portId);
    if (!node || !port) return undefined;
    const chain: ItemV2[] = [];
    let list: ItemV2[] | undefined = port.items;
    for (const seg of p.path) {
      const it: ItemV2 | undefined = list?.find((x) => x.id === seg);
      if (!it) return undefined;
      chain.push(it);
      list = it.children;
    }
    return { entry: { node, port, item: chain[chain.length - 1]!, path: p.path.join('.') }, chain };
  }
}

type Resolved =
  | { ok: true; ref: string; entry: Entry }
  | { ok: false; status: 'unresolved' | 'mismatch'; message: string };

const fail = (message: string, status: 'unresolved' | 'mismatch' = 'unresolved'): Resolved => ({
  ok: false,
  status,
  message,
});

/** `GET /x` → { method, path } */
function parseHttp(s: string): { method: string; path: string } | undefined {
  const m = /^([A-Za-z]+)\s+(\/\S*)$/.exec(s.trim());
  return m ? { method: m[1]!.toUpperCase(), path: m[2]! } : undefined;
}

const httpMatches = (want: { method: string; path: string }, it: ItemV2): boolean => {
  const c = httpCallOf(it);
  if (!c || c.method !== want.method) return false;
  return (
    c.path === want.path || apiPathMatches(want.path, c.path) || apiPathMatches(c.path, want.path)
  );
};

/** 指紋と項目の食い違い（無ければ空） */
function fingerprintDiff(it: ItemV2, fp: SupplementFingerprint): string[] {
  const out: string[] = [];
  if (fp.name !== undefined && it.name !== fp.name)
    out.push(`name が "${it.name}"（expect "${fp.name}"）`);
  if (fp.type !== undefined && it.type !== fp.type)
    out.push(`type が "${it.type}"（expect "${fp.type}"）`);
  if (fp.http !== undefined) {
    const want = parseHttp(fp.http);
    const c = httpCallOf(it);
    if (!want || !httpMatches(want, it))
      out.push(`http が ${c ? `"${c.method} ${c.path}"` : '無い'}（expect "${fp.http}"）`);
  }
  return out;
}

const asFingerprint = (v: unknown): SupplementFingerprint | undefined => {
  if (!isPlainObject(v)) return undefined;
  const fp: SupplementFingerprint = {};
  for (const k of ['name', 'type', 'http'] as const) if (typeof v[k] === 'string') fp[k] = v[k];
  return fp;
};

/** 箱 id が target を表すか（その箱・その @runtime の複製・その group の中の箱） */
const isBox = (graphNodes: Map<string, NodeV2>, id: string, target: string): boolean => {
  if (id === target) return true;
  const n = graphNodes.get(id);
  return n?.meta?.sharedOf === target || n?.group === target;
};

/**
 * 参照を解く。owner は箱の中の参照（links・when）の箱（文字列に `#` が無ければその箱の中、意味の参照の in の既定）。
 * outerExpect は補いの直下の expect（items の at の指紋）
 */
function resolveRef(
  idx: RefIndex,
  spec: unknown,
  owner?: string,
  outerExpect?: SupplementFingerprint,
): Resolved {
  if (typeof spec === 'string') return resolveDirect(idx, spec, owner, outerExpect);
  if (!isPlainObject(spec))
    return fail('参照は文字列か { ref } / { call } / { ret } で書いてください');
  const expect = asFingerprint(spec.expect) ?? outerExpect;
  if (typeof spec.ref === 'string') return resolveDirect(idx, spec.ref, owner, expect);
  const s = spec as Exclude<SupplementRef, string>;
  let base: Resolved;
  if ('call' in s && isPlainObject(s.call)) base = resolveCall(idx, s.call, owner);
  else if ('ret' in s && isPlainObject(s.ret)) base = resolveRet(idx, s.ret, owner);
  else return fail('参照は文字列か { ref } / { call } / { ret } で書いてください');
  if (!base.ok) return base;
  if (expect) {
    const diff = fingerprintDiff(base.entry.item, expect);
    if (diff.length) return fail(`${base.ref} の指紋が合いません: ${diff.join('、')}`, 'mismatch');
  }
  const path = (spec as { path?: unknown }).path;
  if (path === undefined) return base;
  if (typeof path !== 'string' || !path) return fail('path は文字列で書いてください');
  return resolveDirect(idx, `${base.ref}.${path}`, undefined, undefined, true);
}

function resolveDirect(
  idx: RefIndex,
  raw: string,
  owner: string | undefined,
  expect: SupplementFingerprint | undefined,
  numberedChecked = false,
): Resolved {
  const ref = owner && !raw.includes('#') ? `${owner}#${raw}` : raw;
  const r = idx.resolve(ref);
  if (!r) {
    const box = boxOf(ref) || ref;
    return fail(
      idx.nodes.has(box) ? `項目 ${ref} がありません` : `箱 ${box} がありません（参照 ${ref}）`,
    );
  }
  const k = numberedChecked ? -1 : r.chain.findIndex((it) => NUMBERED.test(it.id));
  if (k >= 0) {
    if (!expect)
      return fail(
        `番号の参照（${r.chain[k]!.id}）には expect（name・type。呼び出しなら http）を書いてください（前の呼び出しが増えると別の項目を指すため）。意味の参照 { call: { in, to } } でも書けます`,
      );
    const diff = fingerprintDiff(r.chain[k]!, expect);
    if (diff.length)
      return fail(`${ref} の ${r.chain[k]!.id} の指紋が合いません: ${diff.join('、')}`, 'mismatch');
  } else if (expect) {
    const diff = fingerprintDiff(r.entry.item, expect);
    if (diff.length) return fail(`${ref} の指紋が合いません: ${diff.join('、')}`, 'mismatch');
  }
  return { ok: true, ref, entry: r.entry };
}

const topItems = (n: NodeV2, dir: 'in' | 'out') =>
  n.ports
    .filter((p) => p.dir === dir)
    .flatMap((p) => p.items.map((it) => ({ port: p, item: it, ref: `${n.id}#${p.id}/${it.id}` })));

/** ref がその項目か、その子孫か */
const under = (ref: string, root: string) => ref === root || ref.startsWith(`${root}.`);

function pick(
  cands: Array<{ ref: string; port: PortV2; item: ItemV2 }>,
  node: NodeV2,
  what: string,
): Resolved {
  if (cands.length === 1) {
    const c = cands[0]!;
    return { ok: true, ref: c.ref, entry: { node, port: c.port, item: c.item, path: c.item.id } };
  }
  if (!cands.length) return fail(`${node.id} に ${what}がありません`);
  return fail(
    `${node.id} に ${what}が ${cands.length} つあります（${cands.map((c) => c.item.id).join(', ')}）。番号と expect で書いてください`,
  );
}

function resolveCall(
  idx: RefIndex,
  call: { in?: unknown; to?: unknown; http?: unknown },
  owner: string | undefined,
): Resolved {
  const inId = typeof call.in === 'string' ? call.in : owner;
  if (!inId) return fail('call の in（呼ぶ側の箱）を書いてください');
  const node = idx.nodes.get(inId);
  if (!node) return fail(`箱 ${inId} がありません`);
  const outs = topItems(node, 'out');
  if (typeof call.http === 'string') {
    const want = parseHttp(call.http);
    if (!want) return fail(`call の http は "METHOD /path" で書いてください（"${call.http}"）`);
    return pick(
      outs.filter((o) => httpMatches(want, o.item)),
      node,
      `${want.method} ${want.path} の呼び出し`,
    );
  }
  if (typeof call.to !== 'string')
    return fail('call には to（呼ばれる箱）か http を書いてください');
  const to = call.to;
  return pick(
    outs.filter((o) =>
      idx.graph.wires.some((w) => under(w.from, o.ref) && isBox(idx.nodes, boxOf(w.to), to)),
    ),
    node,
    `${to} への呼び出し`,
  );
}

function resolveRet(
  idx: RefIndex,
  ret: { in?: unknown; from?: unknown },
  owner: string | undefined,
): Resolved {
  const inId = typeof ret.in === 'string' ? ret.in : owner;
  if (!inId) return fail('ret の in（戻りを受ける箱）を書いてください');
  if (typeof ret.from !== 'string') return fail('ret の from（戻りを返す箱）を書いてください');
  const from = ret.from;
  const node = idx.nodes.get(inId);
  if (!node) return fail(`箱 ${inId} がありません`);
  const calls = new Map(topItems(node, 'out').map((o) => [o.item.id, o.ref]));
  const cands = topItems(node, 'in').filter((o) => {
    const n = /^ret_(\d+)$/.exec(o.item.id)?.[1];
    if (!n) return false;
    if (idx.graph.wires.some((w) => under(w.to, o.ref) && isBox(idx.nodes, boxOf(w.from), from)))
      return true;
    const call = calls.get(`call_${n}`);
    return (
      !!call &&
      idx.graph.wires.some((w) => under(w.from, call) && isBox(idx.nodes, boxOf(w.to), from))
    );
  });
  return pick(cands, node, `${from} からの戻り`);
}

/** 補いの結果を集める */
class Collector {
  readonly results: SupplementResult[] = [];
  add(
    kind: SupplementKind,
    index: number,
    e: Record<string, unknown>,
    status: SupplementStatus,
    target?: string,
    message?: string,
  ) {
    const reason = typeof e.reason === 'string' && e.reason.trim() ? e.reason : undefined;
    const r: SupplementResult = { kind, index, status };
    if (target) r.target = target;
    if (message) r.message = message;
    if (reason) r.reason = reason;
    else r.noReason = true;
    this.results.push(r);
    return r;
  }
}

/** 補いが付ける meta（by と reason） */
const byMeta = (e: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  by: 'overrides',
  ...extra,
  ...(typeof e.reason === 'string' && e.reason.trim() ? { reason: e.reason } : {}),
});

const confidenceOf = (v: unknown): Confidence | undefined =>
  typeof v === 'string' && (CONFIDENCES as readonly string[]).includes(v)
    ? (v as Confidence)
    : undefined;

const isWhen = (v: unknown): v is When =>
  isPlainObject(v) && Object.values(v).every((x) => typeof x === 'boolean');

export interface StageAOptions {
  /** group（v1 の箱 id → 中の関数の箱 id）。retarget の確かめと、group の v1 の箱を指す参照を断るため */
  groups?: ReadonlyMap<string, string[]>;
}

export interface StageAResult {
  results: SupplementResult[];
  /** retarget（`<group>\u0000<peer>` → 付け替え先）。cleanupV2 に渡す */
  retarget: Map<string, string[]>;
  /** retarget のキー → results の要素（cleanupV2 が使わなかったものを解けない補いにする） */
  retargetResults: Map<string, SupplementResult>;
}

/**
 * 段 A（join の後・cleanupV2 の前）: wires・remove・nodes を graph に当て、retarget を確かめる。graph を書き換える
 */
export function applySupplementsA(
  graph: GraphV2,
  sup: SupplementsV2 | undefined,
  opts: StageAOptions = {},
): StageAResult {
  const col = new Collector();
  const retarget = new Map<string, string[]>();
  const retargetResults = new Map<string, SupplementResult>();
  if (!sup) return { results: col.results, retarget, retargetResults };
  const groups = opts.groups ?? new Map<string, string[]>();
  let idx = new RefIndex(graph);
  const notGroup = (r: Resolved): Resolved => {
    if (!r.ok) return r;
    const g = groups.get(r.entry.node.id);
    return g
      ? fail(
          `${r.entry.node.id} は group（${g.join(', ')}）になって掃除で消えます。中の関数の箱を指してください`,
        )
      : r;
  };

  // nodes（箱のパッチ）。線の参照より先（host・kind は参照に影響しない）
  (sup.nodes ?? []).forEach((e, i) => {
    const id = e.id;
    if (typeof id !== 'string')
      return col.add('nodes', i, e, 'unresolved', undefined, 'id がありません');
    const n = idx.nodes.get(id);
    if (!n) return col.add('nodes', i, e, 'unresolved', id, `箱 ${id} がありません`);
    if (groups.has(id))
      return col.add('nodes', i, e, 'unresolved', id, `${id} は group になって掃除で消えます`);
    const problems: string[] = [];
    let changed = 0;
    const set = (k: keyof NodeV2, ok: boolean, why: string) => {
      if (e[k] === undefined) return;
      if (!ok) problems.push(`${k}: ${why}`);
      else {
        (n as unknown as Record<string, unknown>)[k] = clone(e[k]);
        changed++;
      }
    };
    set(
      'runtime',
      (RUNTIMES as readonly unknown[]).includes(e.runtime),
      `${RUNTIMES.join(' / ')} のどれか`,
    );
    set('kind', (NODE_KINDS_V2 as readonly unknown[]).includes(e.kind), '語彙に無い kind');
    set(
      'host',
      typeof e.host === 'string' && idx.nodes.get(e.host)?.kind === 'infra',
      'kind infra の箱 id',
    );
    set('group', typeof e.group === 'string', '文字列');
    set('name', typeof e.name === 'string', '文字列');
    set('file', typeof e.file === 'string', '文字列');
    set('line', Number.isInteger(e.line), '整数');
    set('code', typeof e.code === 'string', '文字列');
    set('cache', isPlainObject(e.cache), 'オブジェクト');
    set('screen', isPlainObject(e.screen), 'オブジェクト');
    const unknownKeys = Object.keys(e).filter(
      (k) =>
        ![
          'id',
          'reason',
          'runtime',
          'kind',
          'host',
          'group',
          'name',
          'file',
          'line',
          'code',
          'cache',
          'screen',
        ].includes(k),
    );
    if (unknownKeys.length) problems.push(`未知のキー ${unknownKeys.join(', ')}`);
    if (problems.length || !changed)
      return col.add(
        'nodes',
        i,
        e,
        'unresolved',
        id,
        problems.length ? problems.join('、') : '変えるフィールドがありません',
      );
    col.add('nodes', i, e, 'applied', id);
  });

  // wires（足す）
  const keys = new Set(graph.wires.map(wireKey));
  (sup.wires ?? []).forEach((e, i) => {
    const via = e.via;
    if (typeof via !== 'string' || !(WIRE_VIAS as readonly string[]).includes(via))
      return col.add(
        'wires',
        i,
        e,
        'unresolved',
        undefined,
        `via（${WIRE_VIAS.join(' / ')}）が要ります`,
      );
    const from = notGroup(resolveRef(idx, e.from));
    const to = notGroup(resolveRef(idx, e.to));
    const bad = [from, to].find((r): r is Extract<Resolved, { ok: false }> => !r.ok);
    if (bad) return col.add('wires', i, e, bad.status, undefined, bad.message);
    const f = from as Extract<Resolved, { ok: true }>;
    const t = to as Extract<Resolved, { ok: true }>;
    const target = `${f.ref} → ${t.ref}`;
    if (f.entry.port.dir !== 'out')
      return col.add(
        'wires',
        i,
        e,
        'unresolved',
        target,
        `from ${f.ref} は dir out の口の項目ではありません`,
      );
    if (t.entry.port.dir !== 'in')
      return col.add(
        'wires',
        i,
        e,
        'unresolved',
        target,
        `to ${t.ref} は dir in の口の項目ではありません`,
      );
    if (e.when !== undefined && !isWhen(e.when))
      return col.add(
        'wires',
        i,
        e,
        'unresolved',
        target,
        'when は { <分岐>: true|false } で書いてください',
      );
    const w: WireV2 = { from: f.ref, to: t.ref, via: via as WireV2['via'] };
    if (e.reply === true) w.reply = true;
    if (typeof e.label === 'string') w.label = e.label;
    if (e.when !== undefined) w.when = { ...(e.when as When) };
    w.meta = byMeta(e, { confidence: confidenceOf(e.confidence) ?? 'crude' });
    if (keys.has(wireKey(w)))
      return col.add('wires', i, e, 'applied', target, '同じ線が既にあります');
    keys.add(wireKey(w));
    graph.wires.push(w);
    col.add('wires', i, e, 'applied', target);
  });

  // remove（線を消す。箱 id どうしなら、その向きの線を全部）
  (sup.remove ?? []).forEach((e, i) => {
    const spec = isPlainObject(e.wire) ? e.wire : undefined;
    if (!spec)
      return col.add(
        'remove',
        i,
        e,
        'unresolved',
        undefined,
        'wire: { from, to } で書いてください',
      );
    const isBoxId = (v: unknown): v is string => typeof v === 'string' && !v.includes('#');
    let hit: (w: WireV2) => boolean;
    let target: string;
    if (isBoxId(spec.from) && isBoxId(spec.to)) {
      const a = spec.from;
      const b = spec.to;
      target = `${a} → ${b}`;
      hit = (w) => boxOf(w.from) === a && boxOf(w.to) === b;
    } else {
      const from = resolveRef(idx, spec.from);
      const to = resolveRef(idx, spec.to);
      const bad = [from, to].find((r): r is Extract<Resolved, { ok: false }> => !r.ok);
      if (bad) return col.add('remove', i, e, bad.status, undefined, bad.message);
      const f = (from as Extract<Resolved, { ok: true }>).ref;
      const t = (to as Extract<Resolved, { ok: true }>).ref;
      target = `${f} → ${t}`;
      hit = (w) => w.from === f && w.to === t;
    }
    const before = graph.wires.length;
    graph.wires = graph.wires.filter((w) => !hit(w));
    if (graph.wires.length === before)
      return col.add('remove', i, e, 'unresolved', target, '消す線がありません');
    keys.clear();
    for (const w of graph.wires) keys.add(wireKey(w));
    col.add('remove', i, e, 'applied', target, `${before - graph.wires.length} 本`);
  });
  idx = new RefIndex(graph);

  // retarget（cleanupV2 が使う）
  (sup.retarget ?? []).forEach((e, i) => {
    const g = e.group;
    const peer = e.peer;
    const to = e.to;
    if (typeof g !== 'string' || typeof peer !== 'string')
      return col.add('retarget', i, e, 'unresolved', undefined, 'group と peer（箱 id）が要ります');
    const target = `${g} ↔ ${peer}`;
    const members = groups.get(g);
    if (!members)
      return col.add(
        'retarget',
        i,
        e,
        'unresolved',
        target,
        `${g} は group（関数の箱で置き換わる v1 の箱）ではありません`,
      );
    const list = typeof to === 'string' ? [to] : to;
    if (!Array.isArray(list) || !list.length || !list.every((x) => typeof x === 'string'))
      return col.add(
        'retarget',
        i,
        e,
        'unresolved',
        target,
        'to は中の関数の箱 id の配列で書いてください',
      );
    const outside = list.filter((x) => !members.includes(x as string));
    if (outside.length)
      return col.add(
        'retarget',
        i,
        e,
        'unresolved',
        target,
        `${outside.join(', ')} は ${g} の中にありません（中: ${members.join(', ')}）`,
      );
    const key = `${g}\u0000${peer}`;
    retarget.set(key, list as string[]);
    // 使われたかは cleanupV2 の後で決める（finishRetarget）
    retargetResults.set(key, col.add('retarget', i, e, 'applied', target));
  });
  return { results: col.results, retarget, retargetResults };
}

/** cleanupV2 が使わなかった retarget を解けない補いにする */
export function finishRetarget(stage: StageAResult, used: ReadonlySet<string>) {
  for (const [key, r] of stage.retargetResults)
    if (!used.has(key)) {
      r.status = 'unresolved';
      r.message = 'group と peer の間に付け替える箱の単位の線がありません';
    }
}

/** links の無い箱の既定の links（wiring の defaultLinks と同じ規則）を書き出す */
export function materializeDefaultLinks(n: NodeV2): LinkV2[] {
  const roots = (dir: 'in' | 'out', portId?: string) =>
    n.ports
      .filter((p) => p.dir === dir && (portId === undefined || p.id === portId))
      .flatMap((p) => p.items.map((it) => ({ port: p.id, id: it.id })));
  const ref = (r: { port: string; id: string }) => `${r.port}/${r.id}`;
  const product = (ins: ReturnType<typeof roots>, outs: ReturnType<typeof roots>, crude: boolean) =>
    ins.flatMap((a) =>
      outs.map((b): LinkV2 => ({
        from: ref(a),
        to: ref(b),
        ...(crude ? { confidence: 'crude' } : {}),
      })),
    );
  if (n.kind === 'table') return product(roots('in', 'key'), roots('out', 'read'), false);
  if (n.kind === 'endpoint' && n.ports.some((p) => p.id === 'req' || p.id === 'res')) {
    const identity = (from: string, to: string) => {
      const outs = roots('out', to);
      return roots('in', from)
        .filter((a) => outs.some((b) => b.id === a.id))
        .map((a): LinkV2 => ({ from: ref(a), to: `${to}/${a.id}` }));
    };
    return [...identity('in', 'req'), ...identity('res', 'out')];
  }
  return product(roots('in'), roots('out'), true);
}

const linkKey = (l: Pick<LinkV2, 'from' | 'to' | 'when'>) =>
  `${l.from}\u0000${l.to}\u0000${JSON.stringify(l.when ?? {})}`;

/** 子の項目の形を確かめて、補いの印を付ける（crude と by）。問題があれば文 */
function checkChildren(
  raw: unknown,
  e: Record<string, unknown>,
  count: { n: number },
  at: string,
): { items: ItemV2[] } | { error: string } {
  if (!Array.isArray(raw) || !raw.length)
    return { error: `${at}: children は項目の配列で書いてください` };
  const out: ItemV2[] = [];
  const seen = new Set<string>();
  for (const c of raw) {
    if (++count.n > MAX_SUPPLEMENT_CHILDREN)
      return { error: `子が上限（${MAX_SUPPLEMENT_CHILDREN}）を超えました` };
    if (!isPlainObject(c) || typeof c.id !== 'string' || !ITEM_ID.test(c.id))
      return {
        error: `${at}: 子の id は [A-Za-z0-9_$-]+ で書いてください（${JSON.stringify(isPlainObject(c) ? c.id : c)}）`,
      };
    if (seen.has(c.id)) return { error: `${at}: 子の id ${c.id} が重複しています` };
    seen.add(c.id);
    if (c.wireType !== undefined && !(WIRE_TYPES as readonly unknown[]).includes(c.wireType))
      return { error: `${at}.${c.id}: wireType は ${WIRE_TYPES.join(' / ')} のどれか` };
    const it: ItemV2 = {
      id: c.id,
      name: typeof c.name === 'string' ? c.name : c.id,
      type: typeof c.type === 'string' ? c.type : 'unknown',
    };
    if (c.wireType !== undefined) it.wireType = c.wireType as ItemV2['wireType'];
    for (const k of ['nullable', 'optional'] as const) if (c[k] === true) it[k] = true;
    if (typeof c.typeRef === 'string') it.typeRef = c.typeRef;
    it.confidence = confidenceOf(c.confidence) ?? 'crude';
    it.meta = { ...(isPlainObject(c.meta) ? c.meta : {}), ...byMeta(e) };
    if (c.children !== undefined) {
      const sub = checkChildren(c.children, e, count, `${at}.${c.id}`);
      if ('error' in sub) return sub;
      it.children = sub.items;
    }
    out.push(it);
  }
  return { items: out };
}

/**
 * 段 B（cleanupV2 の後）: items → variants → links → when を graph に当てる。graph を書き換える
 */
export function applySupplementsB(
  graph: GraphV2,
  sup: SupplementsV2 | undefined,
): SupplementResult[] {
  const col = new Collector();
  if (!sup) return col.results;
  let idx = new RefIndex(graph);

  // items（不透明な項目に子を足す。アダプタの子がある項目には足せない）
  (sup.items ?? []).forEach((e, i) => {
    const r = resolveRef(idx, e.at, undefined, asFingerprint(e.expect));
    if (!r.ok)
      return col.add(
        'items',
        i,
        e,
        r.status,
        typeof e.at === 'string' ? e.at : undefined,
        r.message,
      );
    const it = r.entry.item;
    if (it.children?.length && it.wireType !== 'unknown')
      return col.add(
        'items',
        i,
        e,
        'unresolved',
        r.ref,
        `${r.ref} にはアダプタの子があります（子の無い項目か wireType unknown の項目だけに足せます）`,
      );
    const kids = checkChildren(e.children, e, { n: 0 }, r.ref);
    if ('error' in kids) return col.add('items', i, e, 'unresolved', r.ref, kids.error);
    it.children = mergeItemLists(it.children ?? [], kids.items);
    col.add('items', i, e, 'applied', r.ref);
  });
  idx = new RefIndex(graph);

  // variants（id で upsert）
  (sup.variants ?? []).forEach((e, i) => {
    const n = typeof e.node === 'string' ? idx.nodes.get(e.node) : undefined;
    if (!n)
      return col.add(
        'variants',
        i,
        e,
        'unresolved',
        String(e.node ?? ''),
        `箱 ${String(e.node)} がありません`,
      );
    if (typeof e.id !== 'string' || !VARIANT_ID.test(e.id))
      return col.add(
        'variants',
        i,
        e,
        'unresolved',
        n.id,
        '分岐の id は [a-z][a-z0-9_]* で書いてください',
      );
    const v = {
      id: e.id,
      name: typeof e.name === 'string' ? e.name : e.id,
      ...(e.default === true ? { default: true } : {}),
    };
    const list = (n.variants ??= []);
    const at = list.findIndex((x) => x.id === v.id);
    if (at >= 0) list[at] = v;
    else list.push(v);
    col.add('variants', i, e, 'applied', `${n.id}#${v.id}`);
  });

  // links（既定を書き出してから足す。mode: replace は置き換え）
  const planned = new Map<
    NodeV2,
    Array<{
      link: LinkV2;
      replace: boolean;
      explicit: Confidence | undefined;
      i: number;
      e: Record<string, unknown>;
    }>
  >();
  (sup.links ?? []).forEach((e, i) => {
    const n = typeof e.node === 'string' ? idx.nodes.get(e.node) : undefined;
    if (!n)
      return col.add(
        'links',
        i,
        e,
        'unresolved',
        String(e.node ?? ''),
        `箱 ${String(e.node)} がありません`,
      );
    const from = resolveRef(idx, e.from, n.id);
    const to = resolveRef(idx, e.to, n.id);
    const bad = [from, to].find((r): r is Extract<Resolved, { ok: false }> => !r.ok);
    if (bad) return col.add('links', i, e, bad.status, n.id, bad.message);
    const f = from as Extract<Resolved, { ok: true }>;
    const t = to as Extract<Resolved, { ok: true }>;
    if (f.entry.node !== n || t.entry.node !== n)
      return col.add(
        'links',
        i,
        e,
        'unresolved',
        n.id,
        'links の from / to は同じ箱の中の項目にしてください',
      );
    if (f.entry.port.dir !== 'in' || t.entry.port.dir !== 'out')
      return col.add(
        'links',
        i,
        e,
        'unresolved',
        n.id,
        'links の from は dir in、to は dir out の口の項目にしてください',
      );
    if (e.when !== undefined && !isWhen(e.when))
      return col.add(
        'links',
        i,
        e,
        'unresolved',
        n.id,
        'when は { <分岐>: true|false } で書いてください',
      );
    const link: LinkV2 = {
      from: `${f.entry.port.id}/${f.entry.path}`,
      to: `${t.entry.port.id}/${t.entry.path}`,
      ...(e.when !== undefined ? { when: { ...(e.when as When) } } : {}),
      confidence: confidenceOf(e.confidence) ?? 'crude',
      meta: byMeta(e),
    };
    const list = planned.get(n) ?? [];
    list.push({ link, replace: e.mode === 'replace', explicit: confidenceOf(e.confidence), i, e });
    planned.set(n, list);
  });
  for (const [n, list] of planned) {
    const base = list.some((x) => x.replace) ? [] : (n.links ?? materializeDefaultLinks(n));
    for (const x of list) {
      const target = `${n.id} ${x.link.from} → ${x.link.to}`;
      const same = base.find((l) => linkKey(l) === linkKey(x.link));
      if (!same) {
        base.push(x.link);
        col.add('links', x.i, x.e, 'applied', target);
        continue;
      }
      // 同じ links が既にある（アダプタ・掃除・既定）: 補いの印を付け、confidence を書いたときだけ置き換える
      same.meta = { ...(same.meta ?? {}), ...x.link.meta };
      if (x.explicit) same.confidence = x.explicit;
      col.add(
        'links',
        x.i,
        x.e,
        'applied',
        target,
        '同じ links が既にあるので、印（と confidence）だけ付けました',
      );
    }
    n.links = base;
  }

  // when（links か線に条件を付ける）
  (sup.when ?? []).forEach((e, i) => {
    if (!isWhen(e.when))
      return col.add(
        'when',
        i,
        e,
        'unresolved',
        undefined,
        'when は { <分岐>: true|false } で書いてください',
      );
    const when = e.when;
    if (isPlainObject(e.link)) {
      const n = typeof e.node === 'string' ? idx.nodes.get(e.node) : undefined;
      if (!n)
        return col.add(
          'when',
          i,
          e,
          'unresolved',
          String(e.node ?? ''),
          `箱 ${String(e.node)} がありません`,
        );
      const from = resolveRef(idx, e.link.from, n.id);
      const to = resolveRef(idx, e.link.to, n.id);
      const bad = [from, to].find((r): r is Extract<Resolved, { ok: false }> => !r.ok);
      if (bad) return col.add('when', i, e, bad.status, n.id, bad.message);
      const lf = `${(from as Extract<Resolved, { ok: true }>).entry.port.id}/${(from as Extract<Resolved, { ok: true }>).entry.path}`;
      const lt = `${(to as Extract<Resolved, { ok: true }>).entry.port.id}/${(to as Extract<Resolved, { ok: true }>).entry.path}`;
      const links = n.links ?? materializeDefaultLinks(n);
      const hits = links.filter((l) => l.from === lf && l.to === lt);
      if (!hits.length)
        return col.add(
          'when',
          i,
          e,
          'unresolved',
          `${n.id} ${lf} → ${lt}`,
          'その links がありません（links で足してください）',
        );
      for (const l of hits) l.when = { ...when };
      n.links = links;
      return col.add('when', i, e, 'applied', `${n.id} ${lf} → ${lt}`);
    }
    if (isPlainObject(e.wire)) {
      const from = resolveRef(idx, e.wire.from);
      const to = resolveRef(idx, e.wire.to);
      const bad = [from, to].find((r): r is Extract<Resolved, { ok: false }> => !r.ok);
      if (bad) return col.add('when', i, e, bad.status, undefined, bad.message);
      const f = (from as Extract<Resolved, { ok: true }>).ref;
      const t = (to as Extract<Resolved, { ok: true }>).ref;
      const w = graph.wires.find((x) => x.from === f && x.to === t);
      if (!w) return col.add('when', i, e, 'unresolved', `${f} → ${t}`, 'その線がありません');
      w.when = { ...when };
      return col.add('when', i, e, 'applied', `${f} → ${t}`);
    }
    col.add(
      'when',
      i,
      e,
      'unresolved',
      undefined,
      'node と link: { from, to }、か wire: { from, to } で書いてください',
    );
  });
  return col.results;
}

/** 補いの結果の数（applied / unresolved / mismatch） */
export function countSupplements(results: readonly SupplementResult[]) {
  const c = { applied: 0, unresolved: 0, mismatch: 0, noReason: 0 };
  for (const r of results) {
    c[r.status]++;
    if (r.noReason) c.noReason++;
  }
  return c;
}

/** 補いの結果を 1 行の文に（CLI の要約・strict の文） */
export function supplementText(r: SupplementResult): string {
  const where =
    r.kind === 'hand' || r.kind === 'view' ? `${r.kind}[${r.index}]` : `v2.${r.kind}[${r.index}]`;
  const status = { applied: '効いた', unresolved: '解けない', mismatch: '指紋が合わない' }[
    r.status
  ];
  return `${where}${r.target ? `（${r.target}）` : ''}: ${status}${r.message ? `。${r.message}` : ''}`;
}
