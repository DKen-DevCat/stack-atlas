/**
 * api-link 抽出器: フロント → API の結線（docs/04 §4、一般化は docs/12 §3.6）。
 *
 * - client（`api.client` ＋ `api.clients` の glob）の fetch / ラッパー / `api.callers` 呼び出し → 呼び出し元ノードの meta.apiCalls
 * - 照合（上から順）: API Gateway の route_key（cdk.tf.json を読み直す or `meta.infra.apiRoutes`）
 *   → `endpoint:`（OpenAPI）→ `meta.apiRoutes` を持つノード（Go / Next の route handler）→ handler の `@route` コメント
 * - config.deploy[<lambda>].handlers の glob → handler ノードへの deploy エッジ
 * - API Gateway の route ↔ ハンドラの対応（上から優先）:
 *     1. ハンドラファイル内の `// @route GET /races/{id}` コメント
 *     2. ハンドラの親ディレクトリにあるルーティング表（`"GET /races": getRaces` のようなプロパティ）
 *     3. 名前の規約: 動詞の接頭辞（get/list/fetch→GET, post/create/add→POST, put/update→PUT, patch→PATCH,
 *        delete/remove→DELETE）＋ 残りの名前（単数形にして）がパスの静的セグメントのどれかと一致
 *     4. Lambda に載っているハンドラが 1 つだけなら全 route をそれに
 * - エッジ: 呼び出し元 → endpoint、endpoint → handler（http）。endpoint が無ければ呼び出し元 → handler（label は route_key）
 * - `api.targets`（無ければ API Gateway、Function URL の Lambda が 1 つなら推定）→ endpoint に deploy
 * - Lambda が参照している DynamoDB テーブルが 1 つなら、そのハンドラが使う schema:* へ table → schema の `schema` エッジ
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, extname, join, relative } from 'node:path';
import type { Edge } from '@stack-atlas/schema';
import type { Extractor, PartialGraph, PartialNode, RepoContext } from '@stack-atlas/core';
import { clientFiles, linkClients, linkTargets, sameFile } from './link.js';
import { infraType, routeComments, toPosix, walk } from './util.js';
import { gatewayRoutesFromMeta, loadGateway, type GatewayRoute } from './gateway.js';
import {
  confineRepoPath,
  globBase,
  globInRepo,
  globToRegExp,
  sectionFor,
  toArray,
} from '@stack-atlas/core';

export {
  constResolverFor,
  detectWrappers,
  exprToPattern,
  httpCallInfo,
  parseClientCalls,
  parseClientFiles,
  passesParam,
  toPath,
  type ApiCall,
  type ConstResolver,
  type HttpCallInfo,
  type Wrapper,
} from './client.js';
export {
  apiPathMatches,
  gatewayRoutesFromMeta,
  normalizeRoutePath,
  pathMatches,
  pickMostSpecific,
  routeSpecificity,
} from './gateway.js';
export { clientFiles, collectRoutes, sameFile } from './link.js';

export const NAME = 'api-link';

const VERBS: Array<[RegExp, string[]]> = [
  [/^(get|list|fetch|find|read|load|query|search)/, ['GET', 'HEAD']],
  [/^(post|create|add|submit|insert)/, ['POST']],
  [/^(put|update|upsert|save|replace)/, ['PUT', 'PATCH', 'POST']],
  [/^patch/, ['PATCH']],
  [/^(delete|remove|del|destroy)/, ['DELETE']],
];

export function singular(w: string): string {
  const s = w.toLowerCase();
  if (s.endsWith('ies')) return s.slice(0, -3) + 'y';
  if (/(ses|xes|ches|shes)$/.test(s)) return s.slice(0, -2);
  if (s.endsWith('s') && !s.endsWith('ss')) return s.slice(0, -1);
  return s;
}

/** 名前の規約で handler 名と route が対応するか（getRaces ↔ GET /races, GET /races/{id}） */
export function nameMatchesRoute(handlerName: string, method: string, path: string): boolean {
  for (const [re, methods] of VERBS) {
    const m = re.exec(handlerName);
    if (!m) continue;
    if (method !== 'ANY' && !methods.includes(method)) return false;
    const rest = handlerName.slice(m[0].length);
    if (!rest) return false;
    const resource = singular(rest);
    const segs = path
      .split('/')
      .filter((s) => s && !s.startsWith('{'))
      .map((s) => singular(s.replace(/[-_]/g, '')));
    return segs.includes(resource);
  }
  return false;
}

/** `"GET /races": getRaces` のようなルーティング表を探す（文字列キー → 識別子） */
function routingTables(files: string[]): Array<{ routeKey: string; name: string }> {
  const out: Array<{ routeKey: string; name: string }> = [];
  const re =
    /["'`]((?:ANY|GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS) \/[^"'`\s]*|\$default)["'`]\s*:\s*([A-Za-z_$][\w$]*)/g;
  for (const f of files) {
    if (!/\.(ts|tsx|js|mjs|cjs)$/.test(f)) continue;
    const src = readFileSync(f, 'utf8');
    for (const m of src.matchAll(re)) out.push({ routeKey: m[1]!, name: m[2]! });
  }
  return out;
}

interface HandlerInfo {
  id: string;
  name: string;
  rel: string;
  lambdaId: string;
  routes: GatewayRoute[];
  known: boolean;
}

export const extractor: Extractor = {
  name: NAME,
  async detect(ctx) {
    const api = ctx.config.api;
    if (api?.repo && !sectionFor(ctx, api)) return false;
    if (clientFiles(ctx, api).length > 0) return true;
    if ((api?.targets?.length ?? 0) > 0) return true;
    const hasHandlers = Object.values(ctx.config.deploy ?? {}).some((d) => d.handlers);
    const conf = confineRepoPath(ctx.root, ctx.config.cdktf?.out ?? 'infra/cdktf.out');
    if (!('abs' in conf)) return false;
    const out = join(conf.abs, 'stacks');
    if (!hasHandlers || !existsSync(out)) return false;
    return readdirSync(out).some((s) => {
      try {
        return readFileSync(join(out, s, 'cdk.tf.json'), 'utf8').includes(
          '"aws_apigatewayv2_route"',
        );
      } catch {
        return false;
      }
    });
  },

  async extract(ctx: RepoContext, upstream): Promise<PartialGraph> {
    const nodes: PartialNode[] = [];
    const edges = new Map<string, Edge>();
    const addEdge = (from: string, to: string, kind: string, label?: string) => {
      const k = `${from}\0${to}\0${kind}`;
      const prev = edges.get(k);
      if (prev) {
        if (label && prev.label && !prev.label.split(', ').includes(label))
          prev.label += `, ${label}`;
        return;
      }
      edges.set(k, label ? { from, to, kind, label } : { from, to, kind });
    };
    const up = new Map(upstream.nodes.map((n) => [n.id, n]));
    const api = sectionFor(ctx, ctx.config.api);

    // --- API Gateway
    const gw = loadGateway(ctx, {
      find(stack, type, logicalId) {
        return upstream.nodes.find((n) => {
          const c = n.meta?.['cdktf'] as
            { type?: string; logicalId?: string; stack?: string } | undefined;
          return c?.type === type && c.logicalId === logicalId && c.stack === stack;
        })?.id;
      },
    });
    // tf-graph の meta.infra.apiRoutes（cdk.tf.json を読み直したものと重複すれば除く）
    const known = new Set(gw.routes.map((r) => `${r.apiId ?? ''} ${r.routeKey}`));
    for (const r of gatewayRoutesFromMeta(upstream.nodes)) {
      if (!known.has(`${r.apiId ?? ''} ${r.routeKey}`)) gw.routes.push(r);
    }
    for (const n of upstream.nodes)
      if (infraType(n) === 'aws_lambda_function') gw.lambdas.add(n.id);

    // --- Lambda → ハンドラ
    const handlers: HandlerInfo[] = [];
    for (const [lambdaId, d] of Object.entries(ctx.config.deploy ?? {})) {
      const globs = toArray(d.handlers);
      if (globs.length === 0) continue;
      if (!gw.lambdas.has(lambdaId) && !up.has(lambdaId)) {
        ctx.log.warn(`api-link: config.deploy の ${lambdaId} がインフラ側に見つかりません`);
        continue;
      }
      const lambdaRoutes = gw.routes.filter((r) => r.lambdaId === lambdaId);
      const files = new Set<string>();
      const tableDirs = new Set<string>();
      for (const g of globs) {
        // repo の外（絶対パス・`..`・外へ出るリンク）は読まない（2026-11-10 8-4 のレビュー S2）
        if (!globInRepo(ctx.root, g)) {
          ctx.log.warn(
            `api-link: config.deploy の ${lambdaId} の handlers "${g}" は repo の外を指すので読みません`,
          );
          continue;
        }
        const re = globToRegExp(g);
        const base = globBase(g);
        for (const abs of walk(ctx.resolve(base))) {
          const rel = toPosix(relative(ctx.root, abs));
          if (re.test(rel)) files.add(abs);
        }
        tableDirs.add(ctx.resolve(base.split('/').slice(0, -1).join('/') || '.'));
      }
      const mine: HandlerInfo[] = [];
      for (const abs of [...files].sort()) {
        const rel = toPosix(relative(ctx.root, abs));
        const fromUp = upstream.nodes.filter(
          (n) => n.kind === 'handler' && sameFile(ctx, n.file, rel),
        );
        const list =
          fromUp.length > 0 ? fromUp : [{ id: `handler:${basename(rel, extname(rel))}`, meta: {} }];
        for (const n of list) {
          const exportName =
            (n.meta?.['ts'] as { exportName?: string } | undefined)?.exportName ??
            n.id.replace(/^handler:/, '').replace(/^.*#/, '');
          mine.push({
            id: n.id,
            name: exportName,
            rel,
            lambdaId,
            routes: [],
            known: fromUp.length > 0,
          });
        }
      }
      // route ↔ ハンドラ
      const tableFiles = [...tableDirs].flatMap((dir) => walk(dir)).filter((f) => !files.has(f));
      const tables = routingTables(tableFiles);
      for (const r of lambdaRoutes) {
        let match = mine.filter((h) =>
          routeComments(readFileSync(ctx.resolve(h.rel), 'utf8')).includes(r.routeKey),
        );
        if (match.length === 0) {
          const names = tables.filter((t) => t.routeKey === r.routeKey).map((t) => t.name);
          match = mine.filter((h) => names.includes(h.name));
        }
        if (match.length === 0)
          match = mine.filter((h) => nameMatchesRoute(h.name, r.method, r.path));
        if (match.length === 0 && mine.length === 1) match = mine;
        if (match.length === 0)
          ctx.log.warn(`api-link: ${r.routeKey}（${lambdaId}）に対応するハンドラが見つかりません`);
        for (const h of match) h.routes.push(r);
      }
      for (const h of mine) {
        addEdge(lambdaId, h.id, 'deploy');
        const meta: Record<string, unknown> = { extractors: [NAME] };
        const first = h.routes[0];
        if (first) {
          meta['api'] = { method: first.method, path: first.path };
          meta['apiRoutes'] = h.routes.map((r) => ({ method: r.method, path: r.path }));
        }
        const node: PartialNode = { id: h.id, meta };
        if (!h.known) Object.assign(node, { kind: 'handler', name: h.name, file: h.rel, line: 1 });
        nodes.push(node);
      }
      handlers.push(...mine);
    }

    // --- api client（clients glob ＋ ラッパー検出）→ endpoint / route handler
    linkClients(ctx, api, upstream, gw.routes, handlers, nodes, addEdge);

    // --- target（Lambda / API Gateway）→ endpoint
    linkTargets(ctx, api, upstream, gw.routes, addEdge);

    // --- DynamoDB テーブル → schema
    const tableOf = (lambdaId: string) => [
      ...new Set(
        upstream.edges
          .filter((e) => e.kind === 'flow' && e.from === lambdaId)
          .map((e) => e.to)
          .filter((to) => infraType(up.get(to) ?? {}) === 'aws_dynamodb_table'),
      ),
    ];
    for (const lambdaId of new Set(handlers.map((h) => h.lambdaId))) {
      const tables = tableOf(lambdaId);
      if (tables.length !== 1) {
        if (tables.length > 1)
          ctx.log.debug(`api-link: ${lambdaId} はテーブルが複数なので schema エッジを張りません`);
        continue;
      }
      const hs = new Set(handlers.filter((h) => h.lambdaId === lambdaId).map((h) => h.id));
      for (const e of upstream.edges) {
        if (e.kind === 'uses' && hs.has(e.from) && up.get(e.to)?.kind === 'schema')
          addEdge(tables[0]!, e.to, 'schema');
      }
    }

    ctx.log.info(
      `api-link: ${gw.routes.length} routes, ${handlers.length} handlers, ${edges.size} edges`,
    );
    return { nodes, edges: [...edges.values()] };
  },
};

export default extractor;
