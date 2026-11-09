/**
 * 合流（docs/17 §3.4・§7 #1・#2・#5・#11、D49・D52・D59）: 言語をまたぐ線を引く段。アダプタは同じ言語の中の線だけを引き、
 * HTTP・SQL の線はここで引く（照合の規則を 1 か所に置く）。joinAll がクライアント側 → サーバー側 → table の順に回す。
 *
 * クライアント側（joinEndpoints。8-2a）:
 * - 呼び出しの項目（`out` の `call_n`）の `meta.http = { method, path }` を、endpoint（openapi の
 *   `endpoint:<METHOD path>`。`meta.api` か id から method と path）とパスの正規化（paths.ts）で照合する
 * - 子の `meta.http`（`path` / `query` / `body`）ごとに `call_n.<子> → endpoint#in/<役割>`（via http）を 1 本ずつ引く。
 *   合流点の線は役割ごとに必ず親 1 本（D52。D41 の「名前で全部写るなら親 1 本」は言語の中の線だけ。受ける側だけに
 *   ある必須の子が detectBroken で見つかるように）
 * - 受ける側の必須の役割（requestBody が required、必須のクエリがある）を呼び出しが丸ごと送っていないときは、親の
 *   `call_n` から `endpoint#in/<役割>` へ線を 1 本引き、`broken: [{ path: "", level: "error" }]` を付ける（D59。
 *   子の照合では出ないので writeBroken は照合し直さない。JoinReport.fixedBroken）
 * - 戻り: `endpoint#out/body`（body が無ければ `out/status`）→ 呼び出し元の `in/ret_n`（via http、reply。ラベルは
 *   箱の `meta.status` と body の型で `200 Today`）。ラッパー（fetcher）からの戻りと同じ ret_n に入る（fan-in。docs/16 §5）
 * - endpoint に合わない呼び出しは、ルートを持つ handler（OpenAPI の無いとき。§3.4 の route の行）と照合して直接結ぶ
 *   （`call_n.<path> → handler#in/<入口>`、`handler#out/<応答> → ret_n`。endpoint は合成しない。2026-11-09 8-2b の決定）。
 *   それも合わなければ警告（従来どおり overrides で補える）
 *
 * サーバー側（joinHandlers。8-2b）:
 * - handler は `meta.route`（`{ method, path }` か `"METHOD path"`）・`meta.routes`・`meta.apiRoutes`（v1 の api-link）を
 *   持つ箱。method の無いルートは ANY（どの method にも合う）。endpoint ごとに、合う handler のうち最も具体的なもの
 *   （paths.ts の pickMostSpecific）、それでも複数なら endpoint を受け持つインフラ（v1 の deploy。JoinOptions.endpointHosts）
 *   と host・`meta.hosts` が合うものを優先する（§7 #11）
 * - 線: 役割ごとに親 1 本（D52）`endpoint#req/<役割> → handler#in/<その役割の項目>`（via call。子はパスの引数などで、
 *   照合は名前で）。レシピの項目が無い handler は `endpoint#req/path → handler#in/r`（§7 #2）。応答は
 *   `handler#out/<meta.http: response> → endpoint#res/body`、`handler#out/status → endpoint#res/status`（via return、reply）
 * - 認証（§3.5・§7 #11）: handler の `meta.auth = "login"` → endpoint に分岐 `login`（ログイン済み、既定 true）と、
 *   `in → req` の links に `when: { login: true }`（未ログインなら handler に届かない）。手で組んだ例と同じ形: 分岐の
 *   持ち主は endpoint、when は endpoint の中の links（線には付けない）。`meta.auth` に middleware と見るヘッダ
 *
 * table（joinTables。8-2b）:
 * - 関数の項目の `meta.sql = { table, op, where, row?, … }`（go-types の SQL のレシピ）を、table の箱（sql 抽出器の
 *   `schema:<table>`、`meta.sql.table`）と名前で照合する（大文字小文字は区別しない。`schema.table` は最後の段でも引く）
 * - SELECT / DELETE: `query_n.<col> → table#key/<col>`（WHERE のカラムごと。via sql）。WHERE の無い SELECT は
 *   `query_n → table#key/_`（表の全体を読む。口の単位）。INSERT / UPDATE: `insert_n` / `update_n → table#write/row`
 *   （親 1 本）。UPDATE の WHERE は項目が無い（`meta.sql.where` だけ）ので線にしない。SELECT / RETURNING の 1 行:
 *   `table#read/row → fn#in/<meta.sql.row>`（via sql、reply。行の項目の `meta.sql.query` がその SQL の項目）
 * - JOIN した 2 つ目以降のテーブル（`meta.sql.tables`）は結ばない。そのテーブルのカラム（typeRef が `table:<その表>`）は
 *   最初のテーブルの key に結ばず、読む線の照合（broken-v2）でも比べない（8-2b レビュー C2）
 * - 1 つの endpoint・呼び出しに MAX_JOIN_MATCHES を超える相手が同じ具体性で合うときは結ばない（数だけ警告。S4）
 *
 * OpenAPI が無いときの endpoint の合成（§3.4 の route の行）と event の合流は後回し。
 */
import type {
  GraphV2,
  ItemV2,
  LinkV2,
  NodeV2,
  ValidationIssue,
  VariantV2,
  WireV2,
} from '@stack-atlas/schema';
import {
  isRoutePathTooLong,
  methodMatches,
  normalizeRoutePath,
  pathSegments,
  pickMostSpecific,
  routeSegments,
  routeSpecificity,
  segmentsMatch,
  MAX_ROUTE_PATH,
  type RouteSegments,
} from './paths.js';
import { isPlainObject } from './util.js';
import { UNDERSCORE, underscoreItem, wireKey } from './v2-parts.js';

/**
 * 1 つの endpoint・呼び出しに同じ具体性で合う相手（handler・endpoint）の上限。超えたら結ばず、数だけを 1 回警告する
 * （2026-11-09 8-2b レビュー S4・C9: `/{x}` の handler が N 個あると endpoint × handler の線と警告の文が N² になり、
 * N = 2000 でメモリが尽きた）
 */
export const MAX_JOIN_MATCHES = 8;

/** 警告の文に並べる数の上限 */
const MAX_LISTED = 20;

/** 並びを警告の文にする（MAX_LISTED を超える分は数だけ） */
export const listText = (xs: readonly string[], sep = ' / ') =>
  xs.length > MAX_LISTED
    ? `${xs.slice(0, MAX_LISTED).join(sep)} ほか ${xs.length - MAX_LISTED} 件`
    : xs.join(sep);

/** 相手が多すぎて結ばなかったものの警告（1 回だけ。数と最初の 3 つ） */
const crowdedIssue = (what: string, other: string, ids: string[]): ValidationIssue => ({
  level: 'warning',
  path: 'v2:join',
  message: `${other}が ${MAX_JOIN_MATCHES} を超えて同じ具体性で合う${what} ${ids.length} 件は結びません（${ids.slice(0, 3).join(', ')}${ids.length > 3 ? ' ほか' : ''}。ルートを具体的にするか、host・deploy で絞れます）`,
});

/** HTTP の役割（呼び出しの子の meta.http と endpoint の in の項目 id） */
export const HTTP_ROLES = ['path', 'query', 'body'] as const;
export type HttpRole = (typeof HTTP_ROLES)[number];

/** 認証の分岐（docs/17 §3.5。手で組んだ例と同じ id・名前） */
export const LOGIN_VARIANT: VariantV2 = { id: 'login', name: 'ログイン済み', default: true };

export interface JoinResult {
  /** 足した線（graph.wires にも足してある） */
  wires: WireV2[];
  /** 照合できた呼び出しの数 */
  matched: number;
  /** 照合できなかった呼び出し（`<箱> <METHOD path>`） */
  unmatched: string[];
  issues: ValidationIssue[];
  /** 必須の役割を送っていない呼び出しの線（D59。broken を書いてある） */
  missing: WireV2[];
  /** endpoint に合わなかった呼び出し（handler への直接の合流で使う） */
  unmatchedCalls: HttpCall[];
}

/** HTTP の呼び出しの項目 */
export interface HttpCall {
  node: NodeV2;
  portId: string;
  item: ItemV2;
  method: string;
  path: string;
  /** 正規化したパス */
  norm: string;
}

export interface JoinOptions {
  /** endpoint の id → それを受け持つインフラの箱（v1 の deploy のエッジ）。handler が複数合うときの優先 */
  endpointHosts?: ReadonlyMap<string, readonly string[]>;
  /** handler として見ない箱（group になる v1 の箱。掃除で消える） */
  skip?: ReadonlySet<string>;
}

/** 合流のまとめ（joinAll。build の要約に出す） */
export interface JoinReport {
  client: {
    /** endpoint と結んだ HTTP の呼び出し */
    matched: number;
    /** endpoint が無く、ルートを持つ handler と直接結んだ呼び出し */
    direct: number;
    /** どれとも結べない呼び出し（`<箱> <METHOD path>`） */
    unmatched: string[];
    /** 必須の役割を送っていない呼び出しの線（D59） */
    missing: number;
  };
  server: {
    /** 結んだ endpoint と handler の対 */
    matched: number;
    /** どの endpoint にも合わない handler のルート（`<箱> <METHOD path>`。OpenAPI に無い） */
    unmatched: string[];
    /** handler の無い endpoint（ルートを持つ handler が graph に 1 つでもあるときだけ数える） */
    withoutHandler: string[];
    /** login の分岐を付けた endpoint */
    login: number;
  };
  table: {
    /** table と結んだ SQL の項目 */
    matched: number;
    /**
     * 結べない SQL の項目（`<箱>#out/<項目> <テーブル>`）: テーブルが graph に無い（マイグレーションに無い）か、table の
     * 箱に口が無い（sql 抽出器の v2 が無く、8-1 の箱の単位のまま）
     */
    unmatched: string[];
  };
  /** 足した線（graph.wires にも足してある） */
  wires: WireV2[];
  /** broken を書いたまま照合し直さない線（D59）の wireKey */
  fixedBroken: Set<string>;
  /** 合流で結んだ箱の対（向き付き。`<from>\u0000<to>`。掃除で細かい線があるものとして数える） */
  pairs: Set<string>;
  issues: ValidationIssue[];
}

interface EndpointRef {
  node: NodeV2;
  routeKey: string;
  method: string;
  path: string;
  /** 正規化したパス（照合ごとに正規化し直さない） */
  norm: string;
  /** 分けたパス（照合ごとに split しない） */
  segs: RouteSegments;
}

/** endpoint の method と path（meta.api、無ければ id の `endpoint:<METHOD> <path>`） */
export function endpointRoute(n: NodeV2): { method: string; path: string } | undefined {
  const api = n.meta?.api;
  if (isPlainObject(api) && typeof api.method === 'string' && typeof api.path === 'string')
    return { method: api.method.toUpperCase(), path: api.path };
  const m = /^endpoint:([A-Z]+) (\/\S*)$/.exec(n.id);
  return m ? { method: m[1]!, path: m[2]! } : undefined;
}

/** 項目の meta.http（呼び出しなら { method, path }、子なら役割） */
export function httpCallOf(it: ItemV2): { method: string; path: string } | undefined {
  const h = it.meta?.http;
  if (isPlainObject(h) && typeof h.method === 'string' && typeof h.path === 'string')
    return { method: h.method.toUpperCase(), path: h.path };
  return undefined;
}

/** ルートの値（`{ method, path }`・`"METHOD /path"`・`"/path"`）→ { method, path }。method の無いものは ANY */
function parseRoute(v: unknown): { method: string; path: string } | undefined {
  if (isPlainObject(v) && typeof v.path === 'string') {
    const method = typeof v.method === 'string' && v.method ? v.method.toUpperCase() : 'ANY';
    return { method, path: v.path };
  }
  if (typeof v !== 'string') return undefined;
  const m = /^(?:([A-Za-z]+)\s+)?(\/\S*)$/.exec(v.trim());
  return m ? { method: (m[1] ?? 'ANY').toUpperCase(), path: m[2]! } : undefined;
}

/**
 * handler のルート（`meta.route`・`meta.routes`・`meta.apiRoutes`。go-types は `{ method, path }`、8-1 の変換と
 * v1 の api-link は `"METHOD path"` と `apiRoutes`）。重複は 1 つ
 */
export function handlerRoutes(n: Pick<NodeV2, 'meta'>): Array<{ method: string; path: string }> {
  const meta = n.meta ?? {};
  const raw: unknown[] = [];
  if (meta.route !== undefined) raw.push(meta.route);
  for (const k of ['routes', 'apiRoutes'])
    if (Array.isArray(meta[k])) raw.push(...(meta[k] as unknown[]));
  const out: Array<{ method: string; path: string }> = [];
  const seen = new Set<string>();
  for (const v of raw) {
    const r = parseRoute(v);
    if (!r || seen.has(`${r.method} ${r.path}`)) continue;
    seen.add(`${r.method} ${r.path}`);
    out.push(r);
  }
  return out;
}

const roleOf = (it: ItemV2): HttpRole | undefined => {
  const h = it.meta?.http;
  return typeof h === 'string' && (HTTP_ROLES as readonly string[]).includes(h)
    ? (h as HttpRole)
    : undefined;
};

const topItem = (n: NodeV2, portId: string, id: string) =>
  n.ports.find((p) => p.id === portId)?.items.find((i) => i.id === id);

const portItems = (n: NodeV2, portId: string) => n.ports.find((p) => p.id === portId)?.items ?? [];

/** 戻りの線の元（body、無ければ status）とラベル（`200 Today`・`201 Created`） */
function replySource(ep: NodeV2): { id: string; label?: string } | undefined {
  const out = ep.ports.find((p) => p.id === 'out' && p.dir === 'out');
  const body = out?.items.find((i) => i.id === 'body');
  if (body) {
    const status = ep.meta?.status;
    return {
      id: 'body',
      label: status !== undefined ? `${String(status)} ${body.type}` : body.type,
    };
  }
  const status = out?.items.find((i) => i.id === 'status');
  if (status) return { id: 'status', label: status.type };
  return undefined;
}

/** 線を足す道具（重複を足さない。graph.wires と結果の両方へ） */
function wireAdder(graph: GraphV2, out: WireV2[]) {
  const seen = new Set(graph.wires.map(wireKey));
  return (w: WireV2): boolean => {
    if (seen.has(wireKey(w))) return false;
    seen.add(wireKey(w));
    graph.wires.push(w);
    out.push(w);
    return true;
  };
}

/** graph の endpoint（長すぎるパスは照合しない。tooLong に積む） */
function endpointRefs(graph: GraphV2, tooLong: string[]): EndpointRef[] {
  const endpoints: EndpointRef[] = [];
  for (const n of graph.nodes) {
    if (n.kind !== 'endpoint') continue;
    const r = endpointRoute(n);
    if (!r) continue;
    if (isRoutePathTooLong(r.path)) {
      tooLong.push(n.id.slice(0, 80));
      continue;
    }
    const norm = normalizeRoutePath(r.path);
    endpoints.push({
      node: n,
      routeKey: `${r.method} ${r.path}`,
      ...r,
      norm,
      segs: routeSegments(norm),
    });
  }
  return endpoints;
}

const tooLongIssue = (tooLong: string[], what: string): ValidationIssue => ({
  level: 'warning',
  path: 'v2:join',
  message: `パスが長すぎる（${MAX_ROUTE_PATH} 文字を超える）ので照合しなかった ${what} ${tooLong.length} 件: ${tooLong.slice(0, 5).join(' / ')}${tooLong.length > 5 ? ' ほか' : ''}`,
});

/**
 * 合流（endpoint のクライアント側）。graph.wires に線を足す。warnUnmatched（既定 true）が false なら、結べない呼び出しの
 * 警告は出さない（joinAll が handler への直接の合流の後に出す）
 */
export function joinEndpoints(graph: GraphV2, opts: { warnUnmatched?: boolean } = {}): JoinResult {
  const result: JoinResult = {
    wires: [],
    matched: 0,
    unmatched: [],
    issues: [],
    missing: [],
    unmatchedCalls: [],
  };
  /** 長すぎて照合しなかったパス（1 回だけ警告する） */
  const tooLong: string[] = [];
  /** endpoint が多すぎて結ばなかった呼び出し */
  const crowded: string[] = [];
  const endpoints = endpointRefs(graph, tooLong);
  const add = wireAdder(graph, result.wires);

  for (const n of graph.nodes) {
    if (n.kind === 'endpoint') continue;
    for (const port of n.ports) {
      if (port.dir !== 'out') continue;
      for (const it of port.items) {
        const call = httpCallOf(it);
        if (!call) continue;
        if (isRoutePathTooLong(call.path)) {
          tooLong.push(`${n.id}#${port.id}/${it.id}`);
          continue;
        }
        const norm = normalizeRoutePath(call.path);
        const client = pathSegments(norm);
        const eps = pickMostSpecific(
          endpoints.filter(
            (e) => methodMatches(e.method, call.method) && segmentsMatch(e.segs, client),
          ),
        );
        if (!eps.length) {
          result.unmatchedCalls.push({ node: n, portId: port.id, item: it, ...call, norm });
          continue;
        }
        if (eps.length > MAX_JOIN_MATCHES) {
          crowded.push(`${n.id}#${port.id}/${it.id}`);
          continue;
        }
        result.matched++;
        const k = /^call_(\d+)$/.exec(it.id)?.[1];
        const ret = k ? topItem(n, 'in', `ret_${k}`) : undefined;
        const sent = new Set<HttpRole>();
        for (const ep of eps) {
          for (const c of it.children ?? []) {
            const role = roleOf(c);
            if (!role) continue;
            sent.add(role);
            const target = topItem(ep.node, 'in', role);
            if (!target || target.id === UNDERSCORE) {
              result.issues.push({
                level: 'warning',
                path: `v2:join:${n.id}#${port.id}/${it.id}.${c.id}`,
                message: `${ep.node.id} は ${role} を受けません（OpenAPI に無い）。線を引きません`,
              });
              continue;
            }
            add({
              from: `${n.id}#${port.id}/${it.id}.${c.id}`,
              to: `${ep.node.id}#in/${role}`,
              via: 'http',
              ...(role === 'path' ? { label: ep.routeKey } : {}),
            });
          }
          // D59: 受ける側の必須の役割を丸ごと送っていない（path は URL そのものなので必ず送っている）
          for (const role of ['query', 'body'] as const) {
            if (sent.has(role)) continue;
            const target = topItem(ep.node, 'in', role);
            if (!target || target.optional) continue;
            if (role === 'query' && !(target.children ?? []).some((c) => !c.optional)) continue;
            const w: WireV2 = {
              from: `${n.id}#${port.id}/${it.id}`,
              to: `${ep.node.id}#in/${role}`,
              via: 'http',
              broken: [{ path: '', level: 'error', reason: `送る側に無い（必須の ${role}）` }],
            };
            if (add(w)) result.missing.push(w);
          }
          const src = replySource(ep.node);
          if (ret && src) {
            add({
              from: `${ep.node.id}#out/${src.id}`,
              to: `${n.id}#in/${ret.id}`,
              via: 'http',
              reply: true,
              ...(src.label ? { label: src.label } : {}),
            });
          }
        }
      }
    }
  }
  if (tooLong.length) result.issues.push(tooLongIssue(tooLong, 'endpoint・HTTP 呼び出し'));
  if (crowded.length) result.issues.push(crowdedIssue(' HTTP 呼び出し', 'endpoint ', crowded));
  result.unmatched = result.unmatchedCalls.map((c) => `${c.node.id} ${c.method} ${c.path}`);
  if (result.unmatched.length && opts.warnUnmatched !== false) {
    result.issues.push({
      level: 'warning',
      path: 'v2:join',
      message: `endpoint と結べない HTTP 呼び出し: ${listText(result.unmatched)}（overrides.yaml で補う）`,
    });
  }
  return result;
}

/** ルートを持つ handler（endpoint でない箱）。ルートは分けたパスと具体性を前もって持つ */
interface HandlerRef {
  node: NodeV2;
  routes: Array<{
    method: string;
    path: string;
    norm: string;
    segs: RouteSegments;
    spec: number[];
  }>;
}

/**
 * ルートを持つ handler。項目まで下がった箱（`_` 以外の項目を持つもの）だけ: アダプタの無い所の箱の単位の handler
 * （go が無いときの v1 のパッケージの箱）は 8-1 の箱の単位の線のまま残す
 */
function handlerRefs(graph: GraphV2, tooLong: string[], skip?: ReadonlySet<string>): HandlerRef[] {
  const out: HandlerRef[] = [];
  for (const n of graph.nodes) {
    if (n.kind === 'endpoint' || n.kind === 'table' || skip?.has(n.id)) continue;
    if (!n.ports.some((p) => p.items.some((i) => i.id !== UNDERSCORE))) continue;
    const routes = handlerRoutes(n).filter((r) => {
      if (!isRoutePathTooLong(r.path)) return true;
      tooLong.push(`${n.id} ${r.method}`);
      return false;
    });
    if (routes.length)
      out.push({
        node: n,
        routes: routes.map((r) => {
          const norm = normalizeRoutePath(r.path);
          return {
            ...r,
            norm,
            segs: routeSegments(norm),
            spec: routeSpecificity({
              routeKey: `${r.method} ${r.path}`,
              method: r.method,
              path: norm,
            }),
          };
        }),
      });
  }
  return out;
}

/** 箱が動くインフラの箱（host と、複数の入口から使う関数の meta.hosts） */
const hostsOf = (n: NodeV2): string[] => {
  const hs = n.meta?.hosts;
  return [
    ...(n.host ? [n.host] : []),
    ...(Array.isArray(hs) ? hs.filter((x): x is string => typeof x === 'string') : []),
  ];
};

const cmpSpec = (a: number[], b: number[]) => {
  for (let i = 0; i < a.length; i++) if (a[i]! !== b[i]!) return a[i]! - b[i]!;
  return 0;
};

/** 合う handler（最も具体的なもの。複数なら endpoint を受け持つインフラと host が合うものを優先） */
function matchHandlers(
  handlers: HandlerRef[],
  method: string,
  norm: string,
  hosts: readonly string[] | undefined,
): Array<{ h: HandlerRef; route: { method: string; path: string } }> {
  const client = pathSegments(norm);
  let best: Array<{ h: HandlerRef; route: HandlerRef['routes'][number] }> = [];
  for (const h of handlers)
    for (const r of h.routes) {
      if (!methodMatches(r.method, method) || !segmentsMatch(r.segs, client)) continue;
      const c = best.length ? cmpSpec(r.spec, best[0]!.route.spec) : 1;
      if (c > 0) best = [{ h, route: r }];
      else if (c === 0) best.push({ h, route: r });
    }
  // 同じ handler の複数のルートが合っても 1 つ
  const byNode = new Map<string, (typeof best)[number]>();
  for (const c of best) if (!byNode.has(c.h.node.id)) byNode.set(c.h.node.id, c);
  best = [...byNode.values()];
  if (best.length > 1 && hosts?.length) {
    const here = best.filter((c) => hostsOf(c.h.node).some((x) => hosts.includes(x)));
    if (here.length) best = here;
  }
  return best;
}

/**
 * handler の入口の項目（役割の項目で結べないとき。`r`、無ければ引数・起動の項目の最初。役割の項目（meta.http）・
 * 呼び出しの戻り・SELECT の 1 行は入口にしない: path を query の項目へ結ぶと型が食い違って誤った broken になる）
 */
function entryItem(h: NodeV2): ItemV2 | undefined {
  const ins = portItems(h, 'in');
  return (
    ins.find((i) => i.id === 'r') ??
    ins.find(
      (i) =>
        i.id !== UNDERSCORE && !roleOf(i) && !/^ret_\d+$/.test(i.id) && !/^row(_\d+)?$/.test(i.id),
    )
  );
}

/** handler の応答の項目（meta.http が response。無ければ値の戻り `return`） */
const responseItems = (h: NodeV2, fallback: boolean): ItemV2[] => {
  const outs = portItems(h, 'out');
  const res = outs.filter((i) => i.meta?.http === 'response');
  if (res.length || !fallback) return res;
  const ret = outs.find((i) => i.id === 'return');
  return ret ? [ret] : [];
};

const authText = (h: NodeV2): string | undefined => {
  const by = h.meta?.authBy;
  if (!isPlainObject(by)) return undefined;
  const fn = typeof by.fn === 'string' ? by.fn.replace(/^fn:/, '') : '認証の middleware';
  const header = typeof by.header === 'string' ? by.header : undefined;
  return header ? `${fn}（${header} ヘッダ）` : fn;
};

/** endpoint に login の分岐と、in → req の links の when を付ける（手で組んだ例と同じ形） */
function gateLogin(ep: NodeV2, h: NodeV2): boolean {
  if (ep.variants?.some((v) => v.id === LOGIN_VARIANT.id)) return false;
  ep.variants = [...(ep.variants ?? []), { ...LOGIN_VARIANT }];
  const text = authText(h);
  ep.meta = { ...(ep.meta ?? {}), auth: text ?? 'login' };
  // links を書くと既定（in → req / res → out の恒等）が効かなくなるので、恒等を書き出してから when を付ける
  if (!ep.links) {
    const links: LinkV2[] = [];
    const named = (portId: string) => portItems(ep, portId).filter((i) => i.id !== UNDERSCORE);
    for (const a of named('in'))
      if (named('req').some((b) => b.id === a.id))
        links.push({ from: `in/${a.id}`, to: `req/${a.id}` });
    for (const a of named('res'))
      if (named('out').some((b) => b.id === a.id))
        links.push({ from: `res/${a.id}`, to: `out/${a.id}` });
    ep.links = links;
  }
  for (const l of ep.links)
    if (l.from.startsWith('in/') && l.to.startsWith('req/'))
      l.when = { ...(l.when ?? {}), [LOGIN_VARIANT.id]: true };
  return true;
}

/**
 * endpoint ↔ handler の線（サーバー側の 1 対）。行きの線を引けたかを返す（引けなければ箱の単位の線を残すので、合流した
 * 箱の対に数えない）
 */
function wireServer(
  ep: NodeV2,
  h: NodeV2,
  add: (w: WireV2) => boolean,
  issues: ValidationIssue[],
): boolean {
  let wired = false;
  for (const role of HTTP_ROLES) {
    const items = portItems(h, 'in').filter((i) => i.meta?.http === role);
    for (const it of items) {
      if (!topItem(ep, 'req', role)) {
        issues.push({
          level: 'warning',
          path: `v2:join:${h.id}#in/${it.id}`,
          message: `${ep.id} は ${role} を渡しません（OpenAPI に無い）。${h.id} の in/${it.id} への線を引きません`,
        });
        continue;
      }
      add({ from: `${ep.id}#req/${role}`, to: `${h.id}#in/${it.id}`, via: 'call' });
      wired = true;
    }
  }
  if (!wired) {
    const entry = entryItem(h);
    const src = topItem(ep, 'req', 'path') ?? portItems(ep, 'req').find((i) => i.id !== UNDERSCORE);
    if (entry && src) {
      add({ from: `${ep.id}#req/${src.id}`, to: `${h.id}#in/${entry.id}`, via: 'call' });
      wired = true;
    } else
      issues.push({
        level: 'warning',
        path: `v2:join:${h.id}`,
        message: `${h.id} に入口の項目が無いので ${ep.id} からの線を引きません`,
      });
  }
  const resBody = topItem(ep, 'res', 'body');
  const resStatus = topItem(ep, 'res', 'status');
  for (const it of responseItems(h, false)) {
    if (!resBody) {
      issues.push({
        level: 'warning',
        path: `v2:join:${h.id}#out/${it.id}`,
        message: `${ep.id} は応答の body を返しません（OpenAPI に無い）。${h.id} の out/${it.id} からの線を引きません`,
      });
      continue;
    }
    add({ from: `${h.id}#out/${it.id}`, to: `${ep.id}#res/body`, via: 'return', reply: true });
  }
  const status = portItems(h, 'out').find((i) => i.meta?.http === 'status');
  if (status && resStatus)
    add({
      from: `${h.id}#out/${status.id}`,
      to: `${ep.id}#res/status`,
      via: 'return',
      reply: true,
    });
  return wired;
}

/** 合流（endpoint のサーバー側）。graph を書き換える */
export function joinHandlers(
  graph: GraphV2,
  opts: JoinOptions = {},
): Pick<JoinReport, 'server' | 'wires' | 'pairs' | 'issues'> {
  const out: Pick<JoinReport, 'server' | 'wires' | 'pairs' | 'issues'> = {
    server: { matched: 0, unmatched: [], withoutHandler: [], login: 0 },
    wires: [],
    pairs: new Set(),
    issues: [],
  };
  const tooLong: string[] = [];
  const endpoints = endpointRefs(graph, tooLong);
  const handlers = handlerRefs(graph, tooLong, opts.skip);
  const add = wireAdder(graph, out.wires);
  /** 結んだ handler のルート（`<箱> <METHOD path>`） */
  const usedRoutes = new Set<string>();
  /** handler が多すぎて結ばなかった endpoint */
  const crowded: string[] = [];
  for (const ep of endpoints) {
    const hits = matchHandlers(handlers, ep.method, ep.norm, opts.endpointHosts?.get(ep.node.id));
    if (!hits.length) {
      if (handlers.length) out.server.withoutHandler.push(ep.node.id);
      continue;
    }
    if (hits.length > MAX_JOIN_MATCHES) {
      // 結ばない（数だけ警告）。ルートは OpenAPI に無いものとしては数えない
      crowded.push(ep.node.id);
      for (const { h, route } of hits) usedRoutes.add(`${h.node.id} ${route.method} ${route.path}`);
      continue;
    }
    if (hits.length > 1) out.issues.push(ambiguousIssue(ep.node.id, hits));
    for (const { h, route } of hits) {
      usedRoutes.add(`${h.node.id} ${route.method} ${route.path}`);
      out.server.matched++;
      // 行きの線を引けたら、戻りも合流した対に数える（応答の項目の無い handler でも、箱の単位の戻りの線を group の
      // 中の全部へ付け替えない）
      if (wireServer(ep.node, h.node, add, out.issues)) {
        out.pairs.add(`${ep.node.id}\u0000${h.node.id}`);
        out.pairs.add(`${h.node.id}\u0000${ep.node.id}`);
      }
      if (h.node.meta?.auth === 'login' && gateLogin(ep.node, h.node)) out.server.login++;
    }
  }
  if (endpoints.length) {
    for (const h of handlers)
      for (const r of h.routes) {
        const key = `${h.node.id} ${r.method} ${r.path}`;
        if (!usedRoutes.has(key)) out.server.unmatched.push(key);
      }
  }
  // endpoint の長すぎるパスはクライアント側（joinEndpoints）で警告済み。ここは handler のルートだけ
  const routesTooLong = tooLong.filter((x) => !x.startsWith('endpoint:'));
  if (routesTooLong.length) out.issues.push(tooLongIssue(routesTooLong, 'handler のルート'));
  if (crowded.length) out.issues.push(crowdedIssue(' endpoint', 'handler ', crowded));
  if (out.server.unmatched.length)
    out.issues.push({
      level: 'warning',
      path: 'v2:join',
      message: `endpoint（OpenAPI）に無い handler のルート: ${listText(out.server.unmatched)}`,
    });
  return out;
}

/** 合う handler が複数（上限以下）: 全部と結んで警告する（joinHandlers と joinDirect で同じ文） */
function ambiguousIssue(from: string, hits: ReadonlyArray<{ h: HandlerRef }>): ValidationIssue {
  return {
    level: 'warning',
    path: `v2:join:${from}`,
    message: `${from} に合う handler が ${hits.length} つあります（${hits.map((x) => x.h.node.id).join(', ')}）。全部と結びます（host か deploy で絞れます）`,
  };
}

/**
 * endpoint に合わない呼び出しを、ルートを持つ handler と直接結ぶ（OpenAPI の無いとき。§3.4 の route の行。endpoint は
 * 合成しない）。役割の子 → handler の同じ役割の項目（無ければ入口の項目へ path の子から 1 本）、handler の応答
 * （無ければ `return`）→ 呼び出し元の `ret_n`。結べなかった呼び出しを返す
 */
function joinDirect(
  graph: GraphV2,
  calls: HttpCall[],
  add: (w: WireV2) => boolean,
  pairs: Set<string>,
  skip?: ReadonlySet<string>,
): { left: HttpCall[]; issues: ValidationIssue[] } {
  const issues: ValidationIssue[] = [];
  if (!calls.length) return { left: calls, issues };
  const handlers = handlerRefs(graph, [], skip);
  const left: HttpCall[] = [];
  /** handler が多すぎて結ばなかった呼び出し */
  const crowded: string[] = [];
  for (const c of calls) {
    const hits = matchHandlers(handlers, c.method, c.norm, undefined);
    if (!hits.length) {
      left.push(c);
      continue;
    }
    const from = `${c.node.id}#${c.portId}/${c.item.id}`;
    if (hits.length > MAX_JOIN_MATCHES) {
      crowded.push(from);
      left.push(c);
      continue;
    }
    // 複数の handler と結ぶときは joinHandlers と同じ警告（8-2b レビュー C9）
    if (hits.length > 1) issues.push(ambiguousIssue(from, hits));
    const k = /^call_(\d+)$/.exec(c.item.id)?.[1];
    const ret = k ? topItem(c.node, 'in', `ret_${k}`) : undefined;
    let any = false;
    for (const { h } of hits) {
      let wired = false;
      const children = c.item.children ?? [];
      for (const ch of children) {
        const role = roleOf(ch);
        if (!role) continue;
        const target = portItems(h.node, 'in').find((i) => i.meta?.http === role);
        if (!target) continue;
        add({ from: `${from}.${ch.id}`, to: `${h.node.id}#in/${target.id}`, via: 'http' });
        wired = true;
      }
      if (!wired) {
        const entry = entryItem(h.node);
        const pathChild = children.find((ch) => roleOf(ch) === 'path');
        if (entry) {
          add({
            from: pathChild ? `${from}.${pathChild.id}` : from,
            to: `${h.node.id}#in/${entry.id}`,
            via: 'http',
            label: `${c.method} ${c.path}`,
          });
          wired = true;
        }
      }
      // 行きの線を引けなければ結ばない（箱の単位の線を残す）
      if (!wired) continue;
      any = true;
      pairs.add(`${c.node.id}\u0000${h.node.id}`);
      pairs.add(`${h.node.id}\u0000${c.node.id}`);
      if (ret)
        for (const r of responseItems(h.node, true))
          add({
            from: `${h.node.id}#out/${r.id}`,
            to: `${c.node.id}#in/${ret.id}`,
            via: 'http',
            reply: true,
          });
    }
    if (!any) left.push(c);
  }
  if (crowded.length) issues.push(crowdedIssue(' HTTP 呼び出し', 'handler ', crowded));
  return { left, issues };
}

/** table の箱（`meta.sql.table` か id の `schema:<名前>`）を名前で引く表（小文字） */
function tableIndex(graph: GraphV2): Map<string, NodeV2> {
  const out = new Map<string, NodeV2>();
  for (const n of graph.nodes) {
    if (n.kind !== 'table') continue;
    const sql = n.meta?.sql;
    const name =
      isPlainObject(sql) && typeof sql.table === 'string'
        ? sql.table
        : n.id.startsWith('schema:')
          ? n.id.slice('schema:'.length)
          : undefined;
    if (name && !out.has(name.toLowerCase())) out.set(name.toLowerCase(), n);
  }
  return out;
}

const unquote = (s: string) => s.replace(/["`[\]]/g, '');

/** SQL のテーブル名 → table の箱（`schema.table` は全体、無ければ最後の段） */
function tableOf(tables: Map<string, NodeV2>, name: string): NodeV2 | undefined {
  const n = unquote(name).toLowerCase();
  return tables.get(n) ?? tables.get(n.split('.').pop() ?? n);
}

/** 項目の meta.sql（SQL の項目なら { table, op, row? }） */
export function sqlOf(
  it: ItemV2,
): { table: string; op: string; row?: string; item?: string } | undefined {
  const s = it.meta?.sql;
  if (!isPlainObject(s) || typeof s.table !== 'string' || typeof s.op !== 'string')
    return undefined;
  return {
    table: s.table,
    op: s.op.toLowerCase(),
    ...(typeof s.row === 'string' ? { row: s.row } : {}),
    ...(typeof s.item === 'string' ? { item: s.item } : {}),
  };
}

/** 箱の中の SQL がそのテーブルを使っているか（掃除で、テーブルへの線の付け替え先を決める手がかり） */
export function usesTable(n: NodeV2, table: NodeV2): boolean {
  const tables = new Map([[(tableName(table) ?? '').toLowerCase(), table]]);
  return n.ports.some((p) =>
    p.items.some((it) => {
      const s = sqlOf(it);
      return !!s && tableOf(tables, s.table) === table;
    }),
  );
}

const tableName = (t: NodeV2): string | undefined => {
  const sql = t.meta?.sql;
  if (isPlainObject(sql) && typeof sql.table === 'string') return sql.table;
  return t.id.startsWith('schema:') ? t.id.slice('schema:'.length) : undefined;
};

const ensureUnderscore = (n: NodeV2, portId: string) => {
  const p = n.ports.find((x) => x.id === portId);
  if (p && !p.items.some((i) => i.id === UNDERSCORE)) p.items.push(underscoreItem());
};

/** 合流（table）。graph を書き換える */
export function joinTables(
  graph: GraphV2,
): Pick<JoinReport, 'table' | 'wires' | 'pairs' | 'issues'> {
  const out: Pick<JoinReport, 'table' | 'wires' | 'pairs' | 'issues'> = {
    table: { matched: 0, unmatched: [] },
    wires: [],
    pairs: new Set(),
    issues: [],
  };
  const tables = tableIndex(graph);
  const add = wireAdder(graph, out.wires);
  for (const n of graph.nodes) {
    if (n.kind === 'table' || n.kind === 'endpoint') continue;
    const outPort = n.ports.find((p) => p.id === 'out' && p.dir === 'out');
    for (const it of outPort?.items ?? []) {
      const s = sqlOf(it);
      if (!s) continue;
      const t = tableOf(tables, s.table);
      const ref = `${n.id}#out/${it.id}`;
      if (!t) {
        out.table.unmatched.push(`${ref} ${s.table}`);
        continue;
      }
      /** 行きの線を引けたか（引けなければ箱の単位の線を残すので、数えず対にもしない） */
      let wired = false;
      if (s.op === 'insert' || s.op === 'update') {
        if (topItem(t, 'write', 'row')) {
          add({ from: ref, to: `${t.id}#write/row`, via: 'sql' });
          wired = true;
        }
      } else {
        const keys = (it.children ?? []).filter((c) => c.id !== UNDERSCORE);
        const keyPort = portItems(t, 'key');
        let any = false;
        const own = (tableName(t) ?? '').toLowerCase();
        for (const c of keys) {
          // JOIN した別のテーブルのカラム（typeRef がそのテーブル）は、このテーブルの key に結ばない（8-2b レビュー C2）
          if (c.typeRef?.startsWith('table:') && c.typeRef.slice(6).toLowerCase() !== own) continue;
          const k =
            keyPort.find((x) => x.id === c.id) ??
            keyPort.find((x) => x.name.toLowerCase() === c.name.toLowerCase());
          if (!k) {
            out.issues.push({
              level: 'warning',
              path: `v2:join:${ref}.${c.id}`,
              message: `${t.id} にカラム ${c.name} がありません（WHERE の線を引きません）`,
            });
            continue;
          }
          add({ from: `${ref}.${c.id}`, to: `${t.id}#key/${k.id}`, via: 'sql' });
          any = true;
        }
        if (!any && t.ports.some((p) => p.id === 'key')) {
          // WHERE の無い SELECT（表の全体）・カラムを引けなかったもの: 口の単位で 1 本
          ensureUnderscore(t, 'key');
          add({ from: ref, to: `${t.id}#key/${UNDERSCORE}`, via: 'sql' });
          any = true;
        }
        wired = any;
      }
      if (!wired) {
        out.table.unmatched.push(`${ref} ${s.table}`);
        continue;
      }
      out.table.matched++;
      out.pairs.add(`${n.id}\u0000${t.id}`);
      if (s.row) {
        const row = portItems(n, 'in').find((x) => x.id === s.row);
        if (row && topItem(t, 'read', 'row')) {
          out.pairs.add(`${t.id}\u0000${n.id}`);
          add({ from: `${t.id}#read/row`, to: `${n.id}#in/${row.id}`, via: 'sql', reply: true });
        }
      }
    }
  }
  if (out.table.unmatched.length)
    out.issues.push({
      level: 'warning',
      path: 'v2:join',
      message: `table と結べない SQL（テーブルがマイグレーションに無いか、table の箱に口が無い）: ${listText(out.table.unmatched)}`,
    });
  return out;
}

/**
 * 合流の全部（クライアント側 → endpoint の無い呼び出しの handler への直接 → サーバー側 → table）。graph を書き換える
 */
export function joinAll(graph: GraphV2, opts: JoinOptions = {}): JoinReport {
  const client = joinEndpoints(graph, { warnUnmatched: false });
  const pairs = new Set<string>();
  const directWires: WireV2[] = [];
  const direct = joinDirect(
    graph,
    client.unmatchedCalls,
    wireAdder(graph, directWires),
    pairs,
    opts.skip,
  );
  const left = direct.left;
  const server = joinHandlers(graph, opts);
  const table = joinTables(graph);
  const issues = [...client.issues, ...direct.issues, ...server.issues, ...table.issues];
  const unmatched = left.map((c) => `${c.node.id} ${c.method} ${c.path}`);
  if (unmatched.length)
    issues.push({
      level: 'warning',
      path: 'v2:join',
      message: `endpoint・handler と結べない HTTP 呼び出し: ${listText(unmatched)}（overrides.yaml で補う）`,
    });
  for (const p of [...server.pairs, ...table.pairs]) pairs.add(p);
  return {
    client: {
      matched: client.matched,
      direct: client.unmatchedCalls.length - left.length,
      unmatched,
      missing: client.missing.length,
    },
    server: server.server,
    table: table.table,
    wires: [...client.wires, ...directWires, ...server.wires, ...table.wires],
    fixedBroken: new Set(client.missing.map(wireKey)),
    pairs,
    issues,
  };
}
