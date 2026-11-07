/**
 * cdktf 抽出器: `cdktf synth` の出力（cdktf.out/stacks/<stack>/cdk.tf.json）→ infra ノードと flow エッジ。
 * CloudFront の cache behavior / API Gateway / Lambda@Edge の `cache` もここで作る。
 * 方法は docs/04-extractors.md §1・§5。
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { Edge, Cache, CacheRule } from '@stack-atlas/schema';
import type { Extractor, PartialGraph, PartialNode, RepoContext } from '@stack-atlas/core';

export const NAME = 'cdktf';

/** ノードにするリソース型。aws_lambda_function_url はノードにせず、参照の「中継」として扱う */
export const NODE_RESOURCE_TYPES = [
  'aws_cloudfront_distribution',
  'aws_lambda_function',
  'aws_apigatewayv2_api',
  'aws_dynamodb_table',
  'aws_s3_bucket',
  'aws_cognito_user_pool',
  'aws_sqs_queue',
  'aws_sns_topic',
  'aws_rds_cluster',
  'aws_elasticache_cluster',
  'aws_cloudfront_function',
] as const;

/** 参照をたどるだけの中継リソース: 型 → 実体を指す属性 */
const HOP_RESOURCES: Record<string, string> = {
  aws_lambda_function_url: 'function_name',
  aws_lambda_alias: 'function_name',
};

/** AWS 管理のキャッシュポリシー */
const MANAGED_CACHE_POLICIES: Record<string, string> = {
  '4135ea2d-6df8-44a3-9df3-4b5a84be39ad': 'CachingDisabled（素通し）',
  '658327ea-f89d-4fab-a63d-7f88639e58f6': 'CachingOptimized（TTL 既定 1日 / 最大 1年）',
  'b2884449-e4de-46a7-ac36-70bc7f1ddd6d': 'CachingOptimizedForUncompressedObjects',
  '08627262-05a9-4f76-9ded-b50ca2e3a84f': 'Elemental-MediaPackage',
};
const CACHING_DISABLED = '4135ea2d-6df8-44a3-9df3-4b5a84be39ad';

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
type JsonObject = { [k: string]: Json };

export interface Resource {
  stack: string;
  type: string;
  logicalId: string;
  body: JsonObject;
  /** construct path（`//`.metadata.path） */
  path: string;
}

export interface Reference {
  type: string;
  logicalId: string;
  attr: string;
  /** 参照が書かれていた属性のパス（配列の添字は省く）。例: origin.domain_name */
  at: string;
}

const isObject = (v: unknown): v is JsonObject =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** cdktf.out ディレクトリ（存在しなければ undefined） */
export function cdktfOutDir(ctx: RepoContext): string | undefined {
  const dir = ctx.resolve(ctx.config.cdktf?.out ?? 'infra/cdktf.out');
  return existsSync(join(dir, 'stacks')) ? dir : undefined;
}

/** stacks/<stack>/cdk.tf.json を列挙する。config.cdktf.stack があればそれだけ */
export function listStacks(ctx: RepoContext): Array<{ stack: string; file: string }> {
  const out = cdktfOutDir(ctx);
  if (!out) return [];
  const stacksDir = join(out, 'stacks');
  const wanted = ctx.config.cdktf?.stack;
  return readdirSync(stacksDir)
    .filter((s) => (wanted ? s === wanted : true))
    .map((stack) => ({ stack, file: join(stacksDir, stack, 'cdk.tf.json') }))
    .filter((s) => existsSync(s.file))
    .sort((a, b) => a.stack.localeCompare(b.stack));
}

export function loadResources(ctx: RepoContext): Resource[] {
  const resources: Resource[] = [];
  for (const { stack, file } of listStacks(ctx)) {
    let json: unknown;
    try {
      json = JSON.parse(readFileSync(file, 'utf8'));
    } catch (e) {
      ctx.log.warn(`cdktf: ${relative(ctx.root, file)} を JSON として読めません: ${String(e)}`);
      continue;
    }
    if (!isObject(json)) continue;
    const res = json['resource'];
    if (!isObject(res)) continue;
    for (const [type, byId] of Object.entries(res)) {
      if (!isObject(byId)) continue;
      for (const [logicalId, body] of Object.entries(byId)) {
        if (!isObject(body)) continue;
        const meta = body['//'];
        const path =
          isObject(meta) &&
          isObject(meta['metadata']) &&
          typeof meta['metadata']['path'] === 'string'
            ? meta['metadata']['path']
            : `${stack}/${logicalId}`;
        resources.push({ stack, type, logicalId, body, path });
      }
    }
  }
  return resources;
}

/** `${...}` 式の中の `<type>.<logicalId>.<attr>` 参照（`data.` は除く） */
const INTERP = /\$\{([^}]*)\}/g;
const REF = /(?<![\w.])(aws_[a-z0-9_]+)\.([A-Za-z_][\w-]*)\.([A-Za-z_][\w]*)/g;

export function collectRefs(value: Json, at = ''): Reference[] {
  const out: Reference[] = [];
  if (typeof value === 'string') {
    for (const m of value.matchAll(INTERP)) {
      const expr = m[1] ?? '';
      for (const r of expr.matchAll(REF)) {
        out.push({ type: r[1]!, logicalId: r[2]!, attr: r[3]!, at });
      }
    }
  } else if (Array.isArray(value)) {
    for (const v of value) out.push(...collectRefs(v, at));
  } else if (isObject(value)) {
    for (const [k, v] of Object.entries(value)) {
      if (k === '//') continue;
      out.push(...collectRefs(v, at ? `${at}.${k}` : k));
    }
  }
  return out;
}

/** environment.variables.X → environment.X と短くする */
const shortLabel = (at: string) => at.replace(/^environment\.variables\./, 'environment.');

const isNodeType = (type: string) => (NODE_RESOURCE_TYPES as readonly string[]).includes(type);

const str = (v: Json | undefined): string | undefined => (typeof v === 'string' ? v : undefined);
const num = (v: Json | undefined): number | undefined => (typeof v === 'number' ? v : undefined);
const arr = (v: Json | undefined): Json[] => (Array.isArray(v) ? v : isObject(v) ? [v] : []);

/** ソースの .ts から construct id の文字列リテラルを探す */
interface SourceIndex {
  files: Array<{ rel: string; lines: string[] }>;
}

function indexSources(ctx: RepoContext): SourceIndex {
  const dir = ctx.resolve(ctx.config.cdktf?.sourceDir ?? 'infra');
  const files: SourceIndex['files'] = [];
  const outDir = cdktfOutDir(ctx);
  const walk = (d: string) => {
    let entries: string[];
    try {
      entries = readdirSync(d);
    } catch {
      return;
    }
    for (const name of entries.sort()) {
      if (name === 'node_modules' || name === '.gen' || name.startsWith('.')) continue;
      const p = join(d, name);
      if (outDir && p === outDir) continue;
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else if (name.endsWith('.ts') && !name.endsWith('.d.ts')) {
        files.push({ rel: relative(ctx.root, p), lines: readFileSync(p, 'utf8').split('\n') });
      }
    }
  };
  if (existsSync(dir)) walk(dir);
  return { files };
}

function findConstruct(
  idx: SourceIndex,
  constructId: string,
): { file: string; line: number; code: string } | undefined {
  const esc = constructId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // 1) `new X(scope, "id"` の第 2 引数 2) ただの文字列リテラル
  const patterns = [new RegExp(`,\\s*(["'\`])${esc}\\1`), new RegExp(`(["'\`])${esc}\\1`)];
  for (const re of patterns) {
    for (const f of idx.files) {
      const i = f.lines.findIndex((l) => re.test(l));
      if (i >= 0) {
        const start = Math.max(0, i - 1);
        return {
          file: f.rel,
          line: i + 1,
          code: f.lines.slice(start, start + 12).join('\n'),
        };
      }
    }
  }
  return undefined;
}

/** リソースの主要属性をコンパクトな JSON にする（ソースが見つからなかったとき用） */
function compactJson(r: Resource): string {
  const keep: JsonObject = {};
  for (const [k, v] of Object.entries(r.body)) {
    if (k === '//') continue;
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') keep[k] = v;
  }
  return `${r.type}.${r.logicalId} ${JSON.stringify(keep, null, 2)}`;
}

function humanName(r: Resource, isEdge: boolean): string {
  const b = r.body;
  switch (r.type) {
    case 'aws_cloudfront_distribution':
      return 'CloudFront';
    case 'aws_lambda_function':
      return isEdge ? `Lambda@Edge: ${r.logicalId}` : `Lambda: ${r.logicalId}`;
    case 'aws_apigatewayv2_api': {
      const p = str(b['protocol_type']) ?? 'HTTP';
      return `API Gateway (${p === 'WEBSOCKET' ? 'WebSocket' : p})`;
    }
    case 'aws_dynamodb_table':
      return `DynamoDB ${str(b['name']) ?? r.logicalId}`;
    case 'aws_s3_bucket':
      return `S3 ${str(b['bucket']) ?? r.logicalId}`;
    case 'aws_cognito_user_pool':
      return `Cognito ${str(b['name']) ?? r.logicalId}`;
    case 'aws_sqs_queue':
      return `SQS ${str(b['name']) ?? r.logicalId}`;
    case 'aws_sns_topic':
      return `SNS ${str(b['name']) ?? r.logicalId}`;
    case 'aws_rds_cluster':
      return `RDS ${str(b['cluster_identifier']) ?? r.logicalId}`;
    case 'aws_elasticache_cluster':
      return `ElastiCache ${str(b['cluster_id']) ?? r.logicalId}`;
    case 'aws_cloudfront_function':
      return `CloudFront Function ${str(b['name']) ?? r.logicalId}`;
    default:
      return `${r.type}.${r.logicalId}`;
  }
}

function ttlSummary(policy: JsonObject): { value: string; cookies: boolean } {
  const min = num(policy['min_ttl']) ?? 0;
  const def = num(policy['default_ttl']);
  const max = num(policy['max_ttl']);
  const params = policy['parameters_in_cache_key_and_forwarded_to_origin'];
  let cookies = false;
  if (isObject(params) && isObject(params['cookies_config'])) {
    const cb = str(params['cookies_config']['cookie_behavior']);
    cookies = cb !== undefined && cb !== 'none';
  }
  if (min === 0 && (def ?? 0) === 0) return { value: 'オリジンの Cache-Control に従う', cookies };
  const parts = [`default=${def ?? '?'}s`, `max=${max ?? '?'}s`];
  if (min !== 0) parts.push(`min=${min}s`);
  return { value: `TTL ${parts.join(' ')}`, cookies };
}

/** cache behavior 1 つの要約 */
function behaviorSummary(
  beh: JsonObject,
  policies: Map<string, Resource>,
): { value: string; cookies: boolean; disabled: boolean } {
  const target = str(beh['target_origin_id']);
  const suffix = target ? ` → ${target}` : '';
  const pid = str(beh['cache_policy_id']);
  if (pid) {
    const managed = MANAGED_CACHE_POLICIES[pid];
    if (managed)
      return { value: managed + suffix, cookies: false, disabled: pid === CACHING_DISABLED };
    const ref = collectRefs(pid).find((r) => r.type === 'aws_cloudfront_cache_policy');
    const pol = ref ? policies.get(ref.logicalId) : undefined;
    if (pol) {
      const s = ttlSummary(pol.body);
      return {
        value: `${pol.logicalId}: ${s.value}${suffix}`,
        cookies: s.cookies,
        disabled: false,
      };
    }
    return { value: `cache policy ${pid}${suffix}`, cookies: false, disabled: false };
  }
  // 旧式の forwarded_values + TTL
  const fv = beh['forwarded_values'];
  let cookies = false;
  if (isObject(fv) && isObject(fv['cookies'])) {
    const fwd = str(fv['cookies']['forward']);
    cookies = fwd !== undefined && fwd !== 'none';
  }
  const s = ttlSummary(beh);
  return { value: `${s.value}${suffix}`, cookies, disabled: false };
}

function distributionCache(r: Resource, policies: Map<string, Resource>): Cache {
  const behaviors: Array<{ key: string; beh: JsonObject }> = [];
  const def = r.body['default_cache_behavior'];
  if (isObject(def)) behaviors.push({ key: '既定（*）', beh: def });
  for (const b of arr(r.body['ordered_cache_behavior'])) {
    if (isObject(b)) behaviors.push({ key: str(b['path_pattern']) ?? '/', beh: b });
  }
  const rules: CacheRule[] = [];
  let cookies = false;
  let allDisabled = behaviors.length > 0;
  for (const { key, beh } of behaviors) {
    const s = behaviorSummary(beh, policies);
    rules.push({ key, value: s.value });
    cookies ||= s.cookies;
    allDisabled &&= s.disabled;
  }
  const cache: Cache = {
    tone: cookies ? 'warn' : allDisabled ? 'off' : 'ok',
    badge: `CDN ${behaviors.length} behaviors`,
    rules,
  };
  if (cookies) cache.note = 'キャッシュキーに Cookie を含めている（HIT 率に注意）';
  return cache;
}

interface EdgeAssociation {
  lambda: string;
  eventType: string;
  pathPattern: string;
}

function edgeAssociations(r: Resource): EdgeAssociation[] {
  const out: EdgeAssociation[] = [];
  const behaviors: Array<{ pattern: string; beh: JsonObject }> = [];
  const def = r.body['default_cache_behavior'];
  if (isObject(def)) behaviors.push({ pattern: '*', beh: def });
  for (const b of arr(r.body['ordered_cache_behavior'])) {
    if (isObject(b)) behaviors.push({ pattern: str(b['path_pattern']) ?? '/', beh: b });
  }
  for (const { pattern, beh } of behaviors) {
    for (const a of arr(beh['lambda_function_association'])) {
      if (!isObject(a)) continue;
      const ref = collectRefs(a['lambda_arn'] ?? null).find(
        (x) => x.type === 'aws_lambda_function',
      );
      if (ref)
        out.push({
          lambda: ref.logicalId,
          eventType: str(a['event_type']) ?? '?',
          pathPattern: pattern,
        });
    }
  }
  return out;
}

function edgeLambdaCache(assocs: EdgeAssociation[]): Cache {
  const events = [...new Set(assocs.map((a) => a.eventType))];
  const patterns = [...new Set(assocs.map((a) => a.pathPattern))];
  const beforeCache = events.some((e) => e.startsWith('viewer-'));
  const trigger = events
    .map((e) =>
      e === 'viewer-request'
        ? 'viewer-request（HIT/MISS 判定より前に毎回実行）'
        : e === 'origin-request'
          ? 'origin-request（MISS のときだけ実行）'
          : e,
    )
    .join(', ');
  const cache: Cache = {
    tone: 'info',
    badge: beforeCache ? 'キャッシュ判定の前' : 'MISS 時のみ',
    rules: [
      { key: 'トリガー', value: trigger },
      { key: '範囲', value: `${patterns.join(', ')} に関連付け` },
    ],
  };
  if (beforeCache && patterns.includes('*'))
    cache.note = '全パスに付いているので、HIT するリクエストでも毎回 Edge が起動する';
  return cache;
}

export function infraIdFor(r: { stack: string; logicalId: string }, multiStack: boolean): string {
  return multiStack ? `infra:${r.stack}/${r.logicalId}` : `infra:${r.logicalId}`;
}

export const extractor: Extractor = {
  name: NAME,
  async detect(ctx) {
    return listStacks(ctx).length > 0;
  },
  async extract(ctx): Promise<PartialGraph> {
    const stacks = listStacks(ctx);
    const multiStack = !ctx.config.cdktf?.stack && stacks.length > 1;
    const resources = loadResources(ctx);
    const key = (stack: string, type: string, id: string) => `${stack}\0${type}\0${id}`;
    const byKey = new Map(resources.map((r) => [key(r.stack, r.type, r.logicalId), r]));
    const idOf = (r: Resource) => infraIdFor(r, multiStack);

    const policies = new Map(
      resources
        .filter((r) => r.type === 'aws_cloudfront_cache_policy')
        .map((r) => [r.logicalId, r]),
    );

    // Lambda@Edge の関連付け（logicalId → association）
    const assocByLambda = new Map<string, EdgeAssociation[]>();
    for (const r of resources) {
      if (r.type !== 'aws_cloudfront_distribution') continue;
      for (const a of edgeAssociations(r)) {
        const k = `${r.stack}\0${a.lambda}`;
        assocByLambda.set(k, [...(assocByLambda.get(k) ?? []), a]);
      }
    }

    const src = indexSources(ctx);
    const nodes: PartialNode[] = [];
    for (const r of resources) {
      if (!isNodeType(r.type)) continue;
      const id = idOf(r);
      const assocs = assocByLambda.get(`${r.stack}\0${r.logicalId}`) ?? [];
      const provider = str(r.body['provider']) ?? '';
      const isEdge =
        r.type === 'aws_lambda_function' &&
        (assocs.length > 0 || (r.body['publish'] === true && /us[_-]east[_-]1/.test(provider)));
      const constructId = r.path.split('/').pop() || r.logicalId;
      const found = findConstruct(src, constructId);
      const node: PartialNode = {
        id,
        kind: 'infra',
        name: humanName(r, isEdge),
        code: found?.code ?? compactJson(r),
        meta: {
          extractors: [NAME],
          cdktf: { type: r.type, logicalId: r.logicalId, path: r.path, stack: r.stack },
        },
      };
      if (found) {
        node.file = found.file;
        node.line = found.line;
      }
      if (r.type === 'aws_lambda_function') {
        const filename = str(r.body['filename']) ?? str(r.body['s3_key']) ?? '';
        const handler = str(r.body['handler']);
        const isNext =
          ctx.config.deploy?.[id]?.app === 'next' ||
          filename.includes('.next/standalone') ||
          handler === 'run.sh';
        if (isNext) node.meta!['deployApp'] = 'next';
        if (isEdge) node.meta!['edge'] = true;
        if (isEdge && assocs.length > 0) node.cache = edgeLambdaCache(assocs);
      }
      if (r.type === 'aws_cloudfront_distribution') node.cache = distributionCache(r, policies);
      if (
        r.type === 'aws_apigatewayv2_api' &&
        (str(r.body['protocol_type']) ?? 'HTTP') === 'HTTP'
      ) {
        node.cache = {
          tone: 'off',
          badge: 'キャッシュなし',
          rules: [{ key: '種類', value: 'HTTP API（レスポンスキャッシュ機能なし）' }],
        };
      }
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

    /** 参照先をノードに解決する（中継リソースを 1 段またぐ） */
    const resolveRef = (stack: string, ref: Reference, depth = 0): Resource | undefined => {
      const target = byKey.get(key(stack, ref.type, ref.logicalId));
      if (!target) return undefined;
      if (isNodeType(target.type)) return target;
      const hopAttr = HOP_RESOURCES[target.type];
      if (hopAttr && depth < 3) {
        const next = collectRefs(target.body[hopAttr] ?? null)[0];
        return next ? resolveRef(stack, next, depth + 1) : undefined;
      }
      return undefined;
    };

    for (const r of resources) {
      if (isNodeType(r.type)) {
        for (const ref of collectRefs(r.body)) {
          const target = resolveRef(r.stack, ref);
          if (target) addEdge(idOf(r), idOf(target), shortLabel(ref.at));
        }
      } else if (r.type === 'aws_apigatewayv2_integration') {
        // API Gateway → integration → Lambda: api ノードから Lambda へ
        const api = collectRefs(r.body['api_id'] ?? null)
          .map((x) => resolveRef(r.stack, x))
          .find(Boolean);
        const fn = collectRefs(r.body['integration_uri'] ?? null)
          .map((x) => resolveRef(r.stack, x))
          .find(Boolean);
        if (api && fn) addEdge(idOf(api), idOf(fn), `integration ${r.logicalId}`);
      }
    }

    ctx.log.info(`cdktf: ${stacks.length} stack(s), ${nodes.length} nodes, ${edges.size} edges`);
    return { nodes, edges: [...edges.values()] };
  },
};

export default extractor;
