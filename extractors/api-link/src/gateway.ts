/**
 * API Gateway 側: cdk.tf.json の aws_apigatewayv2_route → integration → Lambda を読む。
 * cdktf 抽出器と同じ規則で infra ID を作る（スタックが複数で config.cdktf.stack 未指定なら `<stack>/` を付ける）。
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RepoContext } from '@stack-atlas/core';

export interface GatewayRoute {
  /** `GET /races/{id}` */
  routeKey: string;
  method: string;
  path: string;
  logicalId: string;
  stack: string;
  /** API Gateway の infra ID */
  apiId?: string;
  /** 統合先 Lambda の infra ID */
  lambdaId?: string;
}

export interface GatewayInfo {
  routes: GatewayRoute[];
  /** Lambda の infra ID */
  lambdas: Set<string>;
  /** stack/type/logicalId → infra ID */
  infraId(stack: string, type: string, logicalId: string): string;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const REF = /(aws_[a-z0-9_]+)\.([A-Za-z_][\w-]*)\.[A-Za-z_]\w*/;
const refOf = (v: unknown) => {
  if (typeof v !== 'string') return undefined;
  const m = REF.exec(v);
  return m ? { type: m[1]!, logicalId: m[2]! } : undefined;
};

export interface UpstreamLookup {
  /** meta.cdktf を持つ上流ノードから ID を引く */
  find(stack: string, type: string, logicalId: string): string | undefined;
}

export function loadGateway(ctx: RepoContext, upstream: UpstreamLookup): GatewayInfo {
  const out = ctx.resolve(ctx.config.cdktf?.out ?? 'infra/cdktf.out');
  const stacksDir = join(out, 'stacks');
  const wanted = ctx.config.cdktf?.stack;
  const stacks = existsSync(stacksDir)
    ? readdirSync(stacksDir)
        .filter((s) => (wanted ? s === wanted : true))
        .filter((s) => existsSync(join(stacksDir, s, 'cdk.tf.json')))
    : [];
  const multi = !wanted && stacks.length > 1;
  const infraId = (stack: string, type: string, logicalId: string) =>
    upstream.find(stack, type, logicalId) ??
    (multi ? `infra:${stack}/${logicalId}` : `infra:${logicalId}`);

  const routes: GatewayRoute[] = [];
  const lambdas = new Set<string>();
  for (const stack of stacks) {
    let json: unknown;
    try {
      json = JSON.parse(readFileSync(join(stacksDir, stack, 'cdk.tf.json'), 'utf8'));
    } catch (e) {
      ctx.log.warn(`api-link: stacks/${stack}/cdk.tf.json を読めません: ${String(e)}`);
      continue;
    }
    const res = isObj(json) && isObj(json['resource']) ? json['resource'] : {};
    const group = (t: string): Obj => (isObj(res[t]) ? (res[t] as Obj) : {});
    for (const id of Object.keys(group('aws_lambda_function')))
      lambdas.add(infraId(stack, 'aws_lambda_function', id));
    const integrations = group('aws_apigatewayv2_integration');
    for (const [logicalId, body] of Object.entries(group('aws_apigatewayv2_route'))) {
      if (!isObj(body) || typeof body['route_key'] !== 'string') continue;
      const routeKey = body['route_key'];
      const [method = 'ANY', path = routeKey] =
        routeKey === '$default' ? ['ANY', '/{proxy+}'] : routeKey.split(' ');
      const r: GatewayRoute = { routeKey, method, path, logicalId, stack };
      const api = refOf(body['api_id']);
      if (api) r.apiId = infraId(stack, api.type, api.logicalId);
      const target = refOf(body['target']);
      const integ = target ? integrations[target.logicalId] : undefined;
      if (isObj(integ)) {
        const fn = refOf(integ['integration_uri']);
        if (fn && fn.type === 'aws_lambda_function')
          r.lambdaId = infraId(stack, fn.type, fn.logicalId);
      }
      routes.push(r);
    }
  }
  return { routes, lambdas, infraId };
}

const GREEDY = /^\{.+\+\}$/;
const PARAM = /^\{.*\}$/;

/**
 * route のパス（`/races/{id}`、`/{proxy+}`）とクライアントのパス（`/races/{id}`）が合うか。
 * API Gateway と同じく greedy（`{proxy+}`）は 1 セグメント以上に当たる（`/races/{proxy+}` は `/races` に当たらない）
 */
export function pathMatches(routePath: string, clientPath: string): boolean {
  const rs = routePath.split('/').filter(Boolean);
  const cs = clientPath.split('/').filter(Boolean);
  for (let i = 0; i < rs.length; i++) {
    const r = rs[i]!;
    if (GREEDY.test(r)) return cs.length > i;
    const c = cs[i];
    if (c === undefined) return false;
    if (PARAM.test(r)) continue;
    if (r !== c) return false;
  }
  return rs.length === cs.length;
}

export function methodMatches(routeMethod: string, clientMethod: string): boolean {
  return routeMethod === 'ANY' || routeMethod === clientMethod;
}

/**
 * route の具体性。API Gateway は「リテラル → パラメータ → greedy → $default」の順で 1 本だけ選ぶので、
 * 同じ呼び出しに複数の route が合うときはこの値が最大のものだけを使う。
 * [$default でない, greedy でない, リテラルの数, メソッドが ANY でない] を辞書順に比べる
 */
export function routeSpecificity(r: Pick<GatewayRoute, 'routeKey' | 'path' | 'method'>): number[] {
  const segs = r.path.split('/').filter(Boolean);
  return [
    r.routeKey === '$default' ? 0 : 1,
    segs.some((s) => GREEDY.test(s)) ? 0 : 1,
    segs.filter((s) => !PARAM.test(s)).length,
    r.method === 'ANY' ? 0 : 1,
  ];
}

/** 合った route のうち最も具体的なもの（同点なら全部） */
export function pickMostSpecific<T extends Pick<GatewayRoute, 'routeKey' | 'path' | 'method'>>(
  routes: T[],
): T[] {
  if (routes.length <= 1) return routes;
  const cmp = (a: number[], b: number[]) => {
    for (let i = 0; i < a.length; i++) if (a[i]! !== b[i]!) return a[i]! - b[i]!;
    return 0;
  };
  let best: number[] | undefined;
  for (const r of routes) {
    const s = routeSpecificity(r);
    if (!best || cmp(s, best) > 0) best = s;
  }
  return routes.filter((r) => cmp(routeSpecificity(r), best!) === 0);
}

/** `meta.infra.apiRoutes: [{ routeKey, lambdaId }]`（tf-graph が API Gateway ノードに付ける）を route にする */
export function gatewayRoutesFromMeta(
  nodes: ReadonlyArray<{ id: string; meta?: Record<string, unknown> }>,
): GatewayRoute[] {
  const out: GatewayRoute[] = [];
  for (const n of nodes) {
    const infra = n.meta?.['infra'];
    const list = isObj(infra) && Array.isArray(infra['apiRoutes']) ? infra['apiRoutes'] : [];
    for (const r of list) {
      if (!isObj(r) || typeof r['routeKey'] !== 'string') continue;
      const routeKey = r['routeKey'];
      const [method = 'ANY', path = routeKey] =
        routeKey === '$default' ? ['ANY', '/{proxy+}'] : routeKey.split(' ');
      const g: GatewayRoute = {
        routeKey,
        method,
        path,
        logicalId: routeKey,
        stack: '',
        apiId: n.id,
      };
      if (typeof r['lambdaId'] === 'string') g.lambdaId = r['lambdaId'];
      out.push(g);
    }
  }
  return out;
}

/** 末尾の / をそろえ、Go の `{rest...}` / Express の `:id` / `*` を API Gateway 形式にする */
export function normalizeRoutePath(p: string): string {
  let s = p
    .replace(/\{([^}]*?)\.\.\.\}/g, '{$1+}')
    .replace(/\/:(\w+)/g, '/{$1}')
    .replace(/\/\*$/, '/{proxy+}');
  if (s.length > 1) s = s.replace(/\/+$/, '');
  return s || '/';
}

/** endpoint / meta.apiRoutes 用: 末尾スラッシュの違いと Go / Express 形式のパラメータを許す */
export function apiPathMatches(routePath: string, clientPath: string): boolean {
  return pathMatches(normalizeRoutePath(routePath), normalizeRoutePath(clientPath));
}
