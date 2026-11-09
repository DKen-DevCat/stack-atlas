/**
 * 一般化した結線（docs/12 §3.6）:
 * - client ファイル（api.client ＋ api.clients の glob）の呼び出し → 呼び出し元ノードの meta.apiCalls
 * - 照合（上から順）: API Gateway の route → `endpoint:`（OpenAPI）→ `meta.apiRoutes` を持つノード（Go / Next）
 *   → handler の `@route` コメント
 * - エッジ: 呼び出し元 → endpoint（http）、endpoint → ルートを持つ handler（http）。endpoint が無ければ呼び出し元 → handler
 * - api.targets（無ければ API Gateway、それも無ければ Function URL の Lambda が 1 つなら推定）→ endpoint に deploy
 */
import { existsSync, readFileSync } from 'node:fs';
import { relative } from 'node:path';
import type { PartialGraph, PartialNode, RepoContext, StackAtlasConfig } from '@stack-atlas/core';
import { globBase, globToRegExp, isRoutePathTooLong, MAX_ROUTE_PATH } from '@stack-atlas/core';
import { parseClientFiles, type ApiCall } from './client.js';
import {
  apiPathMatches,
  methodMatches,
  normalizeRoutePath,
  pathMatches,
  pickMostSpecific,
  type GatewayRoute,
} from './gateway.js';
import { fetchCache, infraType, libName, routeComments, toPosix, walk } from './util.js';

export const NAME = 'api-link';

type ApiSection = StackAtlasConfig['api'];
type AddEdge = (from: string, to: string, kind: string, label?: string) => void;

export interface GatewayHandler {
  id: string;
  lambdaId: string;
  routes: GatewayRoute[];
}

const CODE = /\.[cm]?[jt]sx?$/;

/** 上流ノードの file（`<repo>/<path>` 修飾でもよい）が repo 相対の rel と同じか */
export function sameFile(
  ctx: Pick<RepoContext, 'repoName'>,
  file: string | undefined,
  rel: string,
) {
  if (!file) return false;
  const f = toPosix(file);
  return f === rel || f === `${ctx.repoName}/${rel}`;
}

/** api.client ＋ api.clients の glob に合う repo 相対パス（ソート済み） */
export function clientFiles(ctx: Pick<RepoContext, 'root' | 'resolve'>, api: ApiSection): string[] {
  const out = new Set<string>();
  if (api?.client && existsSync(ctx.resolve(api.client)))
    out.add(toPosix(api.client).replace(/^\.\//, ''));
  for (const g of api?.clients ?? []) {
    const re = globToRegExp(g);
    for (const abs of walk(ctx.resolve(globBase(g) || '.'))) {
      const rel = toPosix(relative(ctx.root, abs));
      if (CODE.test(rel) && !/\.(test|spec|stories)\.[cm]?[jt]sx?$/.test(rel) && re.test(rel))
        out.add(rel);
    }
  }
  return [...out].sort();
}

/** パス照合に使うルート（endpoint / meta.apiRoutes / @route） */
interface RouteRef {
  nodeId: string;
  method: string;
  path: string;
  routeKey: string;
}

const isRoute = (v: unknown): v is { method: string; path: string } =>
  typeof v === 'object' &&
  v !== null &&
  typeof (v as { method?: unknown }).method === 'string' &&
  typeof (v as { path?: unknown }).path === 'string';

function routesOf(n: PartialNode): Array<{ method: string; path: string }> {
  const list = n.meta?.['apiRoutes'];
  if (Array.isArray(list)) return list.filter(isRoute);
  const one = n.meta?.['api'];
  return isRoute(one) ? [one] : [];
}

const refOf = (nodeId: string, r: { method: string; path: string }): RouteRef => ({
  nodeId,
  method: r.method.toUpperCase(),
  path: normalizeRoutePath(r.path),
  routeKey: `${r.method.toUpperCase()} ${r.path}`,
});

function matchRoutes(refs: RouteRef[], method: string, path: string): RouteRef[] {
  return pickMostSpecific(
    refs.filter((r) => methodMatches(r.method, method) && apiPathMatches(r.path, path)),
  );
}

/** 上流のエンドポイントとルートを持つノード（@route コメントの handler も） */
export function collectRoutes(ctx: RepoContext, upstream: Readonly<PartialGraph>) {
  const endpoints: RouteRef[] = [];
  const handlers: RouteRef[] = [];
  for (const n of upstream.nodes) {
    const isEndpoint = n.kind === 'endpoint' || n.id.startsWith('endpoint:');
    const rs = routesOf(n);
    if (isEndpoint) {
      endpoints.push(...rs.map((r) => refOf(n.id, r)));
      continue;
    }
    if (rs.length > 0) {
      handlers.push(...rs.map((r) => refOf(n.id, r)));
      continue;
    }
    // @route コメント（file が読めるときだけ）
    if (n.kind === 'handler' && n.file && CODE.test(n.file)) {
      const abs = [
        ctx.resolve(n.file),
        ...Object.values(ctx.repos).map((r) => `${r}/${n.file}`),
      ].find(existsSync);
      if (!abs) continue;
      for (const k of routeComments(readFileSync(abs, 'utf8'))) {
        const [method = 'ANY', path = k] = k === '$default' ? ['ANY', '/{proxy+}'] : k.split(' ');
        handlers.push(refOf(n.id, { method, path }));
      }
    }
  }
  return { endpoints, handlers };
}

const CALLER_KINDS = new Set(['component', 'hook', 'lib', 'page', 'layout', 'handler']);

/** 呼び出しを含むノード: 上流の file 一致（export 名が via / top のもの → lib → 先頭）、無ければ undefined */
function upstreamCaller(
  ctx: RepoContext,
  upstream: Readonly<PartialGraph>,
  rel: string,
  call: ApiCall,
) {
  const cands = upstream.nodes.filter(
    (n) => CALLER_KINDS.has(n.kind ?? '') && sameFile(ctx, n.file, rel),
  );
  if (cands.length === 0) return undefined;
  const exportsOf = (n: PartialNode) => {
    const ts = n.meta?.['ts'] as { exportName?: string; exports?: string[] } | undefined;
    return [ts?.exportName, ...(ts?.exports ?? [])];
  };
  for (const name of [call.via, call.top]) {
    if (!name) continue;
    const hit = cands.find((n) => exportsOf(n).includes(name));
    if (hit) return hit.id;
  }
  return (
    cands.find((n) => n.kind === 'lib') ??
    cands.find((n) => n.kind !== 'page' && n.kind !== 'layout') ??
    cands[0]!
  ).id;
}

export interface LinkClientsResult {
  calls: number;
  matched: number;
  unmatched: string[];
}

export function linkClients(
  ctx: RepoContext,
  api: ApiSection,
  upstream: Readonly<PartialGraph>,
  gwRoutes: GatewayRoute[],
  gwHandlers: GatewayHandler[],
  nodes: PartialNode[],
  addEdge: AddEdge,
): LinkClientsResult {
  const result: LinkClientsResult = { calls: 0, matched: 0, unmatched: [] };
  const { endpoints, handlers: routeHandlers } = collectRoutes(ctx, upstream);

  // endpoint → それを実装している handler
  for (const ep of endpoints) {
    for (const h of matchRoutes(routeHandlers, ep.method, ep.path))
      addEdge(ep.nodeId, h.nodeId, 'http');
    const gr = pickMostSpecific(
      gwRoutes.filter((r) => methodMatches(r.method, ep.method) && pathMatches(r.path, ep.path)),
    );
    for (const h of gwHandlers.filter((x) => x.routes.some((r) => gr.includes(r))))
      addEdge(ep.nodeId, h.id, 'http');
  }

  const files = clientFiles(ctx, api);
  if (files.length === 0) return result;
  const { calls, unreadable } = parseClientFiles(
    files.map((f) => ctx.resolve(f)),
    { callers: api?.callers ?? [], root: ctx.root },
  );
  for (const u of unreadable) ctx.log.debug(`api-link: パスを読めない呼び出し ${u}`);

  // 呼び出し元ノードごとにまとめる
  const upIds = new Set(upstream.nodes.map((n) => n.id));
  const newIds = new Map<string, string>(); // rel → 新しく作る lib の ID
  const newNames = new Map<string, string[]>();
  for (const f of files) {
    const n = libName(f);
    newNames.set(n, [...(newNames.get(n) ?? []), f]);
  }
  const byCaller = new Map<string, { rel: string; calls: ApiCall[] }>();
  for (const c of calls) {
    const rel = toPosix(relative(ctx.root, c.file!));
    let id = upstreamCaller(ctx, upstream, rel, c);
    if (!id) {
      id = newIds.get(rel);
      if (!id) {
        const n = libName(rel);
        id = (newNames.get(n)?.length ?? 0) > 1 ? `lib:${rel}` : `lib:${n}`;
        newIds.set(rel, id);
      }
    }
    const acc = byCaller.get(id) ?? { rel, calls: [] };
    acc.calls.push(c);
    byCaller.set(id, acc);
  }

  /** 長すぎて照合しないパスの呼び出し（1 回だけ警告する） */
  let tooLong = 0;
  for (const [callerId, { rel, calls: list }] of byCaller) {
    const seen = new Set<string>();
    const unique = list.filter((c) => {
      if (isRoutePathTooLong(c.path)) {
        tooLong++;
        return false;
      }
      const k = `${c.method} ${c.path}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    const node: PartialNode = {
      id: callerId,
      meta: {
        extractors: [NAME],
        apiCalls: unique.map((c) => ({ method: c.method, path: c.path })),
      },
    };
    if (!upIds.has(callerId))
      Object.assign(node, { kind: 'lib', name: libName(rel), file: rel, line: 1 });
    const cache = fetchCache(unique);
    if (cache) node.cache = cache;
    nodes.push(node);

    for (const c of unique) {
      result.calls++;
      // 1. API Gateway（合う route が複数あれば最も具体的なものだけ。$default は最後の手段）
      const routes = pickMostSpecific(
        gwRoutes.filter((r) => methodMatches(r.method, c.method) && pathMatches(r.path, c.path)),
      );
      const gwTargets = gwHandlers.filter((h) => h.routes.some((r) => routes.includes(r)));
      // 2. endpoint
      const eps = matchRoutes(endpoints, c.method, c.path);
      if (eps.length > 0) {
        for (const ep of eps) addEdge(callerId, ep.nodeId, 'http', ep.routeKey);
        result.matched++;
        continue;
      }
      if (gwTargets.length > 0) {
        for (const h of gwTargets)
          for (const r of h.routes.filter((x) => routes.includes(x)))
            addEdge(callerId, h.id, 'http', r.routeKey);
        result.matched++;
        continue;
      }
      // 3. meta.apiRoutes / @route
      const hs = matchRoutes(routeHandlers, c.method, c.path);
      if (hs.length > 0) {
        for (const h of hs) addEdge(callerId, h.nodeId, 'http', h.routeKey);
        result.matched++;
        continue;
      }
      result.unmatched.push(
        `${c.method} ${c.path}${routes.length > 0 ? '（route はあるがハンドラ不明）' : ''}`,
      );
    }
  }
  if (tooLong > 0)
    ctx.log.warn(
      `api-link: パスが長すぎる（${MAX_ROUTE_PATH} 文字を超える）呼び出し ${tooLong} 件は照合しません`,
    );
  if (result.unmatched.length > 0)
    ctx.log.warn(
      `api-link: route / endpoint と結べない呼び出し: ${result.unmatched.join(' / ')}（overrides.yaml で補う）`,
    );
  return result;
}

const GATEWAY_TYPES = new Set(['aws_apigatewayv2_api', 'aws_api_gateway_rest_api']);

/** start から deploy / uses（と config.deploy の go / nodes）を 4 段たどって着くノード */
function reachable(ctx: RepoContext, upstream: Readonly<PartialGraph>, start: string): Set<string> {
  const out = new Map<string, string[]>();
  for (const e of upstream.edges) {
    if (e.kind === 'deploy' || e.kind === 'uses')
      out.set(e.from, [...(out.get(e.from) ?? []), e.to]);
  }
  for (const [infraId, d] of Object.entries(ctx.config.deploy ?? {})) {
    const extra = [
      ...(d.nodes ?? []),
      ...upstream.nodes
        .filter((n) => d.go && (n.meta?.['go'] as { pkg?: string } | undefined)?.pkg === d.go)
        .map((n) => n.id),
    ];
    out.set(infraId, [...(out.get(infraId) ?? []), ...extra]);
  }
  const reach = new Set<string>([start]);
  let frontier = [start];
  for (let depth = 0; depth < 4 && frontier.length > 0; depth++) {
    frontier = frontier.flatMap((x) => out.get(x) ?? []).filter((x) => !reach.has(x));
    for (const x of frontier) reach.add(x);
  }
  return reach;
}

/** client の呼び先（api.targets、無ければ推定）→ その target が提供する endpoint に deploy */
export function linkTargets(
  ctx: RepoContext,
  api: ApiSection,
  upstream: Readonly<PartialGraph>,
  gwRoutes: GatewayRoute[],
  addEdge: AddEdge,
): string[] {
  const { endpoints, handlers: routeHandlers } = collectRoutes(ctx, upstream);
  if (endpoints.length === 0) return [];
  const upIds = new Set(upstream.nodes.map((n) => n.id));
  let targets = api?.targets ?? [];
  if (targets.length > 0) {
    targets = targets.filter((t) => {
      if (upIds.has(t)) return true;
      ctx.log.warn(`api-link: api.targets の ${t} がインフラ側に見つかりません`);
      return false;
    });
  } else {
    const gws = upstream.nodes.filter((n) => GATEWAY_TYPES.has(infraType(n) ?? ''));
    if (gws.length > 0) targets = gws.map((n) => n.id);
    else {
      const urls = upstream.nodes.filter(
        (n) =>
          infraType(n) === 'aws_lambda_function' &&
          (n.meta?.['infra'] as { functionUrl?: unknown } | undefined)?.functionUrl === true,
      );
      // 複数あれば、deploy / uses をたどって endpoint の実装に着くものだけ
      const serving =
        urls.length > 1
          ? urls.filter((u) => {
              const reach = reachable(ctx, upstream, u.id);
              return endpoints.some((ep) =>
                matchRoutes(routeHandlers, ep.method, ep.path).some((h) => reach.has(h.nodeId)),
              );
            })
          : urls;
      if (serving.length === 1) {
        targets = [serving[0]!.id];
        ctx.log.warn(
          `推定: client の呼び先 → ${serving[0]!.id}（Function URL。api.targets で明示できます）`,
        );
      } else if (serving.length > 1 || urls.length > 1)
        ctx.log.info(
          `api-link: Function URL の Lambda が ${serving.length || urls.length} 個あるので api.targets で指定してください`,
        );
    }
  }
  if (targets.length === 0) return [];
  const uniq = [...new Set(endpoints.map((e) => e.nodeId))];
  if (targets.length === 1) {
    for (const ep of uniq) addEdge(targets[0]!, ep, 'deploy');
    return targets;
  }
  // 複数: target から deploy / uses をたどって着く handler が実装している endpoint、または API Gateway の route
  for (const t of targets) {
    const reach = reachable(ctx, upstream, t);
    for (const ep of endpoints) {
      const byHandler = matchRoutes(routeHandlers, ep.method, ep.path).some((h) =>
        reach.has(h.nodeId),
      );
      const byGateway = gwRoutes.some(
        (r) => r.apiId === t && methodMatches(r.method, ep.method) && pathMatches(r.path, ep.path),
      );
      if (byHandler || byGateway) addEdge(t, ep.nodeId, 'deploy');
    }
  }
  return targets;
}
