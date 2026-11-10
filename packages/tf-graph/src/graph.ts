/**
 * Terraform JSON → infra ノード・flow エッジ・cache（docs/12 §3.3）。fs は触らない純関数。
 * cdktf / terraform / cloudformation の 3 抽出器が共通で使う。
 */
import type { Cache, Edge } from '@stack-atlas/schema';
import type { PartialNode } from '@stack-atlas/core';
import { HOP_TYPES, makeNodeTypeFilter } from './allowlist.js';
import {
  addFunctionNote,
  associationCache,
  associations,
  distributionCache,
  type Association,
} from './cache.js';
import { humanName } from './names.js';
import { collectRefs, collectTokens, isObject } from './refs.js';
import type {
  ApiGatewayRoute,
  BuildInfraOptions,
  FunctionUrl,
  InfraGraph,
  InfraMeta,
  Json,
  JsonObject,
  Reference,
  TfDocument,
  TfJson,
  TfResource,
  Token,
} from './types.js';
import { literal, one, str } from './util.js';

/** 参照をたどるだけの中継リソース: 型 → 実体を指す属性 */
const HOP_ATTR: Record<string, string> = {
  aws_lambda_function_url: 'function_name',
  aws_lambda_alias: 'function_name',
  aws_rds_cluster_instance: 'cluster_identifier',
};

/** 2 つのノードをつなぐ配管: 型 → [元の属性, 先の属性（複数可）, ラベル] */
const CONNECTORS: Record<string, { from: string; to: string[]; label: (id: string) => string }> = {
  aws_apigatewayv2_integration: {
    from: 'api_id',
    to: ['integration_uri'],
    label: (id) => `integration ${id}`,
  },
  aws_api_gateway_integration: {
    from: 'rest_api_id',
    to: ['uri'],
    label: (id) => `integration ${id}`,
  },
  aws_lambda_event_source_mapping: {
    from: 'event_source_arn',
    to: ['function_name'],
    label: () => 'event source',
  },
  aws_cloudwatch_event_target: { from: 'rule', to: ['arn'], label: () => 'target' },
  aws_sns_topic_subscription: { from: 'topic_arn', to: ['endpoint'], label: () => 'subscription' },
  aws_s3_bucket_notification: {
    from: 'bucket',
    to: ['lambda_function', 'queue', 'topic'],
    label: () => 'notification',
  },
};

/** environment.variables.X → environment.X と短くする */
const shortLabel = (at: string) => at.replace(/^environment\.variables\./, 'environment.');

/** 既定の ID: `infra:<module>/<logicalId>`（root は `infra:<logicalId>`） */
export const defaultIdOf = (r: Pick<TfResource, 'module' | 'logicalId'>): string =>
  r.module ? `infra:${r.module}/${r.logicalId}` : `infra:${r.logicalId}`;

const asDoc = (d: TfJson | TfDocument): TfDocument =>
  'tf' in d && isObject((d as TfDocument).tf) && typeof (d as TfDocument).stack === 'string'
    ? (d as TfDocument)
    : { tf: d as TfJson, stack: 'main' };

/** TfDocument の resource を列挙する（ブロックが配列なら先頭を使う） */
export function listResources(docs: Array<TfJson | TfDocument>): TfResource[] {
  const out: TfResource[] = [];
  for (const raw of docs) {
    const doc = asDoc(raw);
    const res = doc.tf.resource;
    if (!isObject(res)) continue;
    for (const [type, byId] of Object.entries(res)) {
      if (!isObject(byId)) continue;
      for (const [logicalId, rawBody] of Object.entries(byId as Record<string, Json>)) {
        const body = one(rawBody);
        if (!body) continue;
        const meta = body['//'];
        const metaPath =
          isObject(meta) && isObject(meta['metadata']) ? str(meta['metadata']['path']) : undefined;
        const path = metaPath ?? doc.pathOf?.(type, logicalId, body) ?? `${doc.stack}/${logicalId}`;
        out.push({ type, logicalId, body, stack: doc.stack, module: doc.module ?? '', path });
      }
    }
  }
  return out;
}

const key = (stack: string, module: string, type: string, id: string) =>
  `${stack}\0${module}\0${type}\0${id}`;

export function buildInfraGraph(
  docs: Array<TfJson | TfDocument>,
  opts: BuildInfraOptions,
): InfraGraph {
  const resources = listResources(docs);
  const byKey = new Map(resources.map((r) => [key(r.stack, r.module, r.type, r.logicalId), r]));
  const baseIdOf = opts.idOf ?? defaultIdOf;
  const typeFilter = makeNodeTypeFilter(opts);

  const lookup = (from: TfResource, ref: Reference): TfResource | undefined =>
    byKey.get(key(from.stack, ref.module ?? from.module, ref.type, ref.logicalId));

  const isHop = (r: TfResource): boolean => {
    if (HOP_TYPES.includes(r.type)) return true;
    if (r.type === 'aws_rds_cluster_instance') {
      return collectRefs(r.body['cluster_identifier']).some(
        (x) => x.type === 'aws_rds_cluster' && lookup(r, x) !== undefined,
      );
    }
    return false;
  };
  const nodeSet = new Set(resources.filter((r) => typeFilter(r.type) && !isHop(r)));
  const isNode = (r: TfResource) => nodeSet.has(r);

  // ID の衝突（Terraform は型が違えば同じ名前を使える）: 衝突したものは末尾を `<type>.<name>` にする
  const idCount = new Map<string, number>();
  for (const r of nodeSet) {
    const id = baseIdOf(r);
    idCount.set(id, (idCount.get(id) ?? 0) + 1);
  }
  const idCache = new Map<TfResource, string>();
  const idOf = (r: TfResource): string => {
    let id = idCache.get(r);
    if (id === undefined) {
      id = baseIdOf(r);
      if ((idCount.get(id) ?? 0) > 1) {
        id = id.endsWith(r.logicalId)
          ? `${id.slice(0, id.length - r.logicalId.length)}${r.type}.${r.logicalId}`
          : `${id}.${r.type}`;
      }
      idCache.set(r, id);
    }
    return id;
  };

  /** 参照先をノードに解決する（中継リソースをまたぐ） */
  const resolveRef = (from: TfResource, ref: Reference, depth = 0): TfResource | undefined => {
    const target = lookup(from, ref);
    if (!target) return undefined;
    if (isNode(target)) return target;
    const hopAttr = HOP_ATTR[target.type];
    if (hopAttr && depth < 3) {
      const next = collectRefs(target.body[hopAttr])[0];
      return next ? resolveRef(target, next, depth + 1) : undefined;
    }
    return undefined;
  };
  const resolveAttr = (from: TfResource, v: Json | undefined): TfResource | undefined =>
    collectRefs(v)
      .map((x) => resolveRef(from, x))
      .find(Boolean);

  const policies = new Map(
    resources.filter((r) => r.type === 'aws_cloudfront_cache_policy').map((r) => [r.logicalId, r]),
  );

  // CloudFront の関連付け（Lambda@Edge / CloudFront Function）
  const assocKey = (dist: TfResource, a: Association) =>
    `${dist.stack}\0${a.module ?? dist.module}\0${a.target}`;
  const edgeAssocs = new Map<string, Association[]>();
  const fnAssocs = new Map<string, Association[]>();
  const fnByDist = new Map<TfResource, Association[]>();
  for (const r of resources) {
    if (r.type !== 'aws_cloudfront_distribution') continue;
    for (const a of associations(r, 'lambda_function_association')) {
      const k = assocKey(r, a);
      edgeAssocs.set(k, [...(edgeAssocs.get(k) ?? []), a]);
    }
    const fns = associations(r, 'function_association');
    fnByDist.set(r, fns);
    for (const a of fns) {
      const k = assocKey(r, a);
      fnAssocs.set(k, [...(fnAssocs.get(k) ?? []), a]);
    }
  }
  const selfKey = (r: TfResource) => `${r.stack}\0${r.module}\0${r.logicalId}`;

  // Function URL
  const functionUrls: FunctionUrl[] = [];
  const urlLambdas = new Set<TfResource>();
  for (const r of resources) {
    if (r.type !== 'aws_lambda_function_url') continue;
    const fn = resolveAttr(r, r.body['function_name']);
    if (fn && fn.type === 'aws_lambda_function') {
      functionUrls.push({ lambdaId: idOf(fn), urlResource: r.logicalId });
      urlLambdas.add(fn);
    }
  }

  const routes = apiRoutes(resources, { lookup, resolveAttr, isNode, idOf });
  const routesByApi = new Map<string, ApiGatewayRoute[]>();
  for (const rt of routes) routesByApi.set(rt.apiId, [...(routesByApi.get(rt.apiId) ?? []), rt]);

  const nodes: PartialNode[] = [];
  const unresolved: Token[] = [];
  for (const r of resources) {
    if (!isNode(r)) continue;
    const id = idOf(r);
    const assocs = edgeAssocs.get(selfKey(r)) ?? [];
    const provider = str(r.body['provider']) ?? '';
    const isEdge =
      r.type === 'aws_lambda_function' &&
      (assocs.length > 0 || (r.body['publish'] === true && /us[_-]east[_-]1/.test(provider)));
    const infra: InfraMeta = { type: r.type, logicalId: r.logicalId, path: r.path, stack: r.stack };
    if (r.module) infra.module = r.module;
    const found = opts.locate?.(r);
    const node: PartialNode = {
      id,
      kind: 'infra',
      name: humanName(r, isEdge, opts.labelOf?.(r)),
      code: found?.code ?? compactJson(r),
      meta: {
        extractors: [opts.extractor],
        cdktf: { type: r.type, logicalId: r.logicalId, path: r.path, stack: r.stack },
        infra,
      },
    };
    if (found?.file) node.file = found.file;
    if (found?.line) node.line = found.line;
    const meta = node.meta!;
    if (r.type === 'aws_lambda_function') {
      const filename = str(r.body['filename']) ?? str(r.body['s3_key']) ?? '';
      const handler = str(r.body['handler']);
      const image = `${str(r.body['image_uri']) ?? ''} ${str(r.body['function_name']) ?? ''}`;
      const isNext =
        opts.deploy?.[id]?.app === 'next' ||
        filename.includes('.next/standalone') ||
        handler === 'run.sh' ||
        /open-?next/i.test(image);
      if (isNext) meta['deployApp'] = 'next';
      if (isEdge) meta['edge'] = true;
      if (isEdge && assocs.length > 0) node.cache = associationCache(assocs, 'Edge');
      if (urlLambdas.has(r)) infra.functionUrl = true;
    }
    if (r.type === 'aws_cloudfront_function') {
      const fa = fnAssocs.get(selfKey(r)) ?? [];
      if (fa.length > 0) node.cache = associationCache(fa, 'CloudFront Function');
    }
    if (r.type === 'aws_cloudfront_distribution') {
      const cache = distributionCache(r, policies);
      const fns = fnByDist.get(r) ?? [];
      if (fns.length > 0) {
        addFunctionNote(cache, fns, (a) => {
          const f = byKey.get(
            key(r.stack, a.module ?? r.module, 'aws_cloudfront_function', a.target),
          );
          return (f && literal(f.body['name'])) ?? a.target;
        });
      }
      node.cache = cache;
    }
    if (
      r.type === 'aws_apigatewayv2_api' &&
      (str(r.body['protocol_type']) ?? 'HTTP') !== 'WEBSOCKET'
    ) {
      node.cache = {
        tone: 'off',
        badge: 'キャッシュなし',
        rules: [{ key: '種類', value: 'HTTP API（レスポンスキャッシュ機能なし）' }],
      };
    }
    if (r.type === 'aws_api_gateway_rest_api') node.cache = restApiCache(r, resources, lookup);
    const rts = routesByApi.get(id);
    if (rts?.length) {
      infra.apiRoutes = rts.map((x) =>
        x.lambdaId ? { routeKey: x.routeKey, lambdaId: x.lambdaId } : { routeKey: x.routeKey },
      );
    }
    unresolved.push(...collectTokens(r.body));
    nodes.push(node);
  }

  // エッジ
  const edges = new Map<string, Edge>();
  const addEdge = (from: string, to: string, label: string) => {
    if (from === to) return;
    const k = `${from}\0${to}`;
    const prev = edges.get(k);
    if (prev) {
      if (prev.label && !prev.label.split(', ').includes(label)) prev.label += `, ${label}`;
      return;
    }
    edges.set(k, { from, to, kind: 'flow', label });
  };

  for (const r of resources) {
    if (isNode(r)) {
      for (const ref of collectRefs(r.body)) {
        const target = resolveRef(r, ref);
        if (target) addEdge(idOf(r), idOf(target), shortLabel(ref.at));
      }
      continue;
    }
    const c = CONNECTORS[r.type];
    if (!c) continue;
    const src = resolveAttr(r, r.body[c.from]);
    if (!src) continue;
    for (const attr of c.to) {
      for (const ref of collectRefs(r.body[attr])) {
        const dst = resolveRef(r, ref);
        if (dst) addEdge(idOf(src), idOf(dst), c.label(r.logicalId));
      }
    }
  }

  opts.log?.debug(
    `tf-graph: ${resources.length} resources → ${nodes.length} nodes, ${edges.size} edges, ${routes.length} routes`,
  );
  return { nodes, edges: [...edges.values()], routes, functionUrls, unresolved, resources };
}

/** リソースの主要属性をコンパクトな JSON にする（ソースが見つからなかったとき用） */
export function compactJson(r: TfResource): string {
  const keep: JsonObject = {};
  for (const [k, v] of Object.entries(r.body)) {
    if (k === '//') continue;
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') keep[k] = v;
  }
  return `${r.type}.${r.logicalId} ${JSON.stringify(keep, null, 2)}`;
}

function restApiCache(
  api: TfResource,
  resources: TfResource[],
  lookup: (from: TfResource, ref: Reference) => TfResource | undefined,
): Cache {
  const cached = resources.some(
    (r) =>
      r.type === 'aws_api_gateway_stage' &&
      (r.body['cache_cluster_enabled'] === true || r.body['cache_cluster_enabled'] === 'true') &&
      collectRefs(r.body['rest_api_id']).some((x) => lookup(r, x) === api),
  );
  return cached
    ? {
        tone: 'ok',
        badge: 'ステージキャッシュ',
        rules: [{ key: '種類', value: 'REST API（ステージのキャッシュクラスタ有効）' }],
      }
    : {
        tone: 'off',
        badge: 'キャッシュなし',
        rules: [{ key: '種類', value: 'REST API（ステージのキャッシュ無効）' }],
      };
}

interface RouteCtx {
  lookup: (from: TfResource, ref: Reference) => TfResource | undefined;
  resolveAttr: (from: TfResource, v: Json | undefined) => TfResource | undefined;
  isNode: (r: TfResource) => boolean;
  idOf: (r: TfResource) => string;
}

/** API Gateway v2 の route と v1 の method → ルート一覧 */
function apiRoutes(resources: TfResource[], c: RouteCtx): ApiGatewayRoute[] {
  const out: ApiGatewayRoute[] = [];
  const firstRef = (from: TfResource, v: Json | undefined, type: string) => {
    const ref = collectRefs(v).find((x) => x.type === type);
    return ref ? c.lookup(from, ref) : undefined;
  };
  const lambdaOf = (from: TfResource, v: Json | undefined) => {
    const fn = c.resolveAttr(from, v);
    return fn && fn.type === 'aws_lambda_function' ? c.idOf(fn) : undefined;
  };

  // v2
  for (const r of resources) {
    if (r.type !== 'aws_apigatewayv2_route') continue;
    const routeKey = literal(r.body['route_key']);
    // SAM の Api イベント（cloudformation 抽出器が合成）は REST API を指すこともある
    const api =
      firstRef(r, r.body['api_id'], 'aws_apigatewayv2_api') ??
      firstRef(r, r.body['api_id'], 'aws_api_gateway_rest_api');
    if (!routeKey || !api || !c.isNode(api)) continue;
    const integ = firstRef(r, r.body['target'], 'aws_apigatewayv2_integration');
    const rt: ApiGatewayRoute = {
      apiId: c.idOf(api),
      routeKey,
      version: api.type === 'aws_api_gateway_rest_api' ? 'v1' : 'v2',
    };
    const lambdaId = integ ? lambdaOf(integ, integ.body['integration_uri']) : undefined;
    if (lambdaId) rt.lambdaId = lambdaId;
    out.push(rt);
  }

  // v1: resource の path_part を親までたどる
  const pathOf = (from: TfResource, v: Json | undefined, depth = 0): string | undefined => {
    const ref = collectRefs(v)[0];
    if (!ref || depth > 20) return undefined;
    if (ref.type === 'aws_api_gateway_rest_api') return '';
    const res = c.lookup(from, ref);
    if (!res || res.type !== 'aws_api_gateway_resource') return undefined;
    const parent = pathOf(res, res.body['parent_id'], depth + 1);
    const part = literal(res.body['path_part']);
    return parent === undefined || part === undefined ? undefined : `${parent}/${part}`;
  };
  const integrations = resources.filter((r) => r.type === 'aws_api_gateway_integration');
  for (const m of resources) {
    if (m.type !== 'aws_api_gateway_method') continue;
    const method = literal(m.body['http_method']);
    const api = firstRef(m, m.body['rest_api_id'], 'aws_api_gateway_rest_api');
    const path = pathOf(m, m.body['resource_id']);
    if (!method || !api || !c.isNode(api) || path === undefined) continue;
    const resKey = JSON.stringify(m.body['resource_id']);
    const integ = integrations.find((i) => {
      const hm = i.body['http_method'];
      const sameMethod =
        literal(hm) === method ||
        collectRefs(hm).some((x) => x.type === 'aws_api_gateway_method' && c.lookup(i, x) === m);
      return sameMethod && JSON.stringify(i.body['resource_id']) === resKey;
    });
    const rt: ApiGatewayRoute = {
      apiId: c.idOf(api),
      routeKey: `${method.toUpperCase()} ${path || '/'}`,
      version: 'v1',
    };
    const lambdaId = integ ? lambdaOf(integ, integ.body['uri']) : undefined;
    if (lambdaId) rt.lambdaId = lambdaId;
    out.push(rt);
  }
  return out;
}
