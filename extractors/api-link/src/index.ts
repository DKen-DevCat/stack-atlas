/**
 * api-link 抽出器: api client の呼び出し ⇔ URL パス ⇔ API Gateway の route_key ⇔ integration ⇔ Lambda ⇔ ハンドラ。
 * 方法は docs/04-extractors.md §4。
 *
 * - api client（config.api.client）の fetch / get / post / request の第 1 引数 → meta.apiCalls、fetch cache → cache
 * - config.deploy[<lambda>].handlers の glob → handler ノードへの deploy エッジ
 * - route ↔ ハンドラの対応（上から優先）:
 *     1. ハンドラファイル内の `// @route GET /races/{id}` コメント
 *     2. ハンドラの親ディレクトリにあるルーティング表（`"GET /races": getRaces` のようなプロパティ）
 *     3. 名前の規約: 動詞の接頭辞（get/list/fetch→GET, post/create/add→POST, put/update→PUT, patch→PATCH,
 *        delete/remove→DELETE）＋ 残りの名前（単数形にして）がパスの静的セグメントのどれかと一致
 *     4. Lambda に載っているハンドラが 1 つだけなら全 route をそれに
 * - client 呼び出しと route_key が合えば lib → handler に `http` エッジ（label は route_key）
 * - Lambda が参照している DynamoDB テーブルが 1 つなら、そのハンドラが使う schema:* へ table → schema の `schema` エッジ
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, extname, join, relative, sep } from 'node:path';
import type { Cache, Edge } from '@stack-atlas/schema';
import type { Extractor, PartialGraph, PartialNode, RepoContext } from '@stack-atlas/core';
import { parseClientCalls, type ApiCall } from './client.js';
import { loadGateway, methodMatches, pathMatches, type GatewayRoute } from './gateway.js';
import { globBase, globToRegExp, toArray } from './glob.js';

export { parseClientCalls, toPath } from './client.js';
export { pathMatches } from './gateway.js';

export const NAME = 'api-link';

const toPosix = (p: string) => p.split(sep).join('/');

/** ts-imports の libName と同じ規則（apiClient.ts → apiClient） */
function libName(relPath: string): string {
  let base = basename(relPath, extname(relPath));
  if (base === 'index') {
    const skip = new Set(['src', 'lib', 'app', 'dist', 'source']);
    const dirs = relPath.split('/').slice(0, -1).reverse();
    base = dirs.find((d) => d && !skip.has(d)) ?? 'index';
  }
  const parts = base.split(/[-_.\s]+/).filter(Boolean);
  return parts.map((p, i) => (i === 0 ? p : p[0]!.toUpperCase() + p.slice(1))).join('') || base;
}

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

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries.sort()) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

const ROUTE_KEY = /^(ANY|GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS) \/\S*$|^\$default$/;

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

function routeComments(src: string): string[] {
  return [...src.matchAll(/@route\s+([A-Z]+ \/\S*|\$default)/g)]
    .map((m) => m[1]!)
    .filter((k) => ROUTE_KEY.test(k));
}

function fetchCache(calls: ApiCall[]): Cache | undefined {
  const rules = calls
    .filter((c) => c.revalidate !== undefined || c.tags || c.cache)
    .map((c) => {
      const parts: string[] = [];
      if (c.cache) parts.push(c.cache);
      if (c.revalidate !== undefined)
        parts.push(c.revalidate === false ? 'revalidate false' : `revalidate ${c.revalidate}s`);
      if (c.tags && c.tags.length > 0) parts.push(`tags ${c.tags.join(', ')}`);
      return { key: `${c.method} ${c.path}`, value: parts.join(' / ') };
    });
  return rules.length > 0 ? { tone: 'info', badge: 'fetch cache', rules } : undefined;
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
    const client = ctx.config.api?.client;
    if (client && existsSync(ctx.resolve(client))) return true;
    const hasHandlers = Object.values(ctx.config.deploy ?? {}).some((d) => d.handlers);
    const out = ctx.resolve(ctx.config.cdktf?.out ?? 'infra/cdktf.out', 'stacks');
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
        const fromUp = upstream.nodes.filter((n) => n.kind === 'handler' && n.file === rel);
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

    // --- api client
    const clientRel = ctx.config.api?.client;
    if (clientRel && existsSync(ctx.resolve(clientRel))) {
      const rel = toPosix(clientRel);
      const clientId =
        upstream.nodes.find((n) => n.file === rel && n.kind === 'lib')?.id ?? `lib:${libName(rel)}`;
      const { calls, unreadable } = parseClientCalls(ctx.resolve(clientRel));
      for (const u of unreadable) ctx.log.debug(`api-link: パスを読めない呼び出し ${u}`);
      const seen = new Set<string>();
      const unique = calls.filter((c) => {
        const k = `${c.method} ${c.path}`;
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });
      const node: PartialNode = {
        id: clientId,
        meta: {
          extractors: [NAME],
          apiCalls: unique.map((c) => ({ method: c.method, path: c.path })),
        },
      };
      if (!up.has(clientId)) Object.assign(node, { kind: 'lib', name: libName(rel), file: rel });
      const cache = fetchCache(unique);
      if (cache) node.cache = cache;
      nodes.push(node);

      const unmatched: string[] = [];
      for (const c of unique) {
        const routes = gw.routes.filter(
          (r) => methodMatches(r.method, c.method) && pathMatches(r.path, c.path),
        );
        const targets = handlers.filter((h) => h.routes.some((r) => routes.includes(r)));
        if (targets.length === 0) {
          unmatched.push(
            `${c.method} ${c.path}${routes.length > 0 ? '（route はあるがハンドラ不明）' : ''}`,
          );
          continue;
        }
        for (const h of targets) {
          for (const r of h.routes.filter((x) => routes.includes(x)))
            addEdge(clientId, h.id, 'http', r.routeKey);
        }
      }
      if (unmatched.length > 0)
        ctx.log.warn(
          `api-link: API Gateway の route と結べない呼び出し: ${unmatched.join(' / ')}（overrides.yaml で補う）`,
        );
    }

    // --- DynamoDB テーブル → schema
    const tableOf = (lambdaId: string) => [
      ...new Set(
        upstream.edges
          .filter((e) => e.kind === 'flow' && e.from === lambdaId)
          .map((e) => e.to)
          .filter(
            (to) =>
              (up.get(to)?.meta?.['cdktf'] as { type?: string } | undefined)?.type ===
              'aws_dynamodb_table',
          ),
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
