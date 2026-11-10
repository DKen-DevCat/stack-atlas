/**
 * API Gateway 側: cdk.tf.json の aws_apigatewayv2_route → integration → Lambda を読む。
 * cdktf 抽出器と同じ規則で infra ID を作る（スタックが複数で config.cdktf.stack 未指定なら `<stack>/` を付ける）。
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { confineRepoPath, type RepoContext } from '@stack-atlas/core';

// パスの正規化と照合は core に移した（docs/17 §7 #5。合流 join.ts でも使う）。従来の import 先のまま使えるよう再 export する
export {
  apiPathMatches,
  methodMatches,
  normalizeRoutePath,
  pathMatches,
  pickMostSpecific,
  routeSpecificity,
} from '@stack-atlas/core';

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
  // repo の外（絶対パス・`..`・外へ出るリンク）は読まない（2026-11-10 8-4 のレビュー S2）
  const conf = confineRepoPath(ctx.root, ctx.config.cdktf?.out ?? 'infra/cdktf.out');
  const stacksDir = 'abs' in conf ? join(conf.abs, 'stacks') : '';
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
