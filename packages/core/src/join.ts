/**
 * 合流（docs/17 §3.4・§7 #1・#5、D49・D52）: 言語をまたぐ線を引く段。アダプタは同じ言語の中の線だけを引き、
 * HTTP・SQL の線はここで引く（照合の規則を 1 か所に置く）。
 *
 * 8-2a は endpoint のクライアント側だけ:
 * - 呼び出しの項目（`out` の `call_n`）の `meta.http = { method, path }` を、endpoint（openapi の
 *   `endpoint:<METHOD path>`。`meta.api` か id から method と path）とパスの正規化（paths.ts）で照合する
 * - 子の `meta.http`（`path` / `query` / `body`）ごとに `call_n.<子> → endpoint#in/<役割>`（via http）を 1 本ずつ引く。
 *   合流点の線は役割ごとに必ず親 1 本（D52。D41 の「名前で全部写るなら親 1 本」は言語の中の線だけ。受ける側だけに
 *   ある必須の子が detectBroken で見つかるように）
 * - 戻り: `endpoint#out/body`（body が無ければ `out/status`）→ 呼び出し元の `in/ret_n`（via http、reply。ラベルは
 *   箱の `meta.status` と body の型で `200 Today`）。
 *   ラッパー（fetcher）からの戻りと同じ ret_n に入る（fan-in。docs/16 §5）
 * - 照合できない呼び出しは警告（従来どおり overrides で補える）
 *
 * サーバー側（`meta.route` の handler）と table、OpenAPI の無いときの route の合流は 8-2b。
 */
import type { GraphV2, ItemV2, NodeV2, ValidationIssue, WireV2 } from '@stack-atlas/schema';
import { apiPathMatches, methodMatches, pickMostSpecific } from './paths.js';
import { isPlainObject } from './util.js';
import { UNDERSCORE, wireKey } from './v2-parts.js';

/** HTTP の役割（呼び出しの子の meta.http と endpoint の in の項目 id） */
export const HTTP_ROLES = ['path', 'query', 'body'] as const;
export type HttpRole = (typeof HTTP_ROLES)[number];

export interface JoinResult {
  /** 足した線（graph.wires にも足してある） */
  wires: WireV2[];
  /** 照合できた呼び出しの数 */
  matched: number;
  /** 照合できなかった呼び出し（`<箱> <METHOD path>`） */
  unmatched: string[];
  issues: ValidationIssue[];
}

interface EndpointRef {
  node: NodeV2;
  routeKey: string;
  method: string;
  path: string;
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

const roleOf = (it: ItemV2): HttpRole | undefined => {
  const h = it.meta?.http;
  return typeof h === 'string' && (HTTP_ROLES as readonly string[]).includes(h)
    ? (h as HttpRole)
    : undefined;
};

const topItem = (n: NodeV2, portId: string, id: string) =>
  n.ports.find((p) => p.id === portId)?.items.find((i) => i.id === id);

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

/** 合流（endpoint のクライアント側）。graph.wires に線を足す */
export function joinEndpoints(graph: GraphV2): JoinResult {
  const result: JoinResult = { wires: [], matched: 0, unmatched: [], issues: [] };
  const endpoints: EndpointRef[] = [];
  for (const n of graph.nodes) {
    if (n.kind !== 'endpoint') continue;
    const r = endpointRoute(n);
    if (r) endpoints.push({ node: n, routeKey: `${r.method} ${r.path}`, ...r });
  }
  const seen = new Set(graph.wires.map(wireKey));
  const add = (w: WireV2) => {
    if (seen.has(wireKey(w))) return;
    seen.add(wireKey(w));
    graph.wires.push(w);
    result.wires.push(w);
  };

  for (const n of graph.nodes) {
    if (n.kind === 'endpoint') continue;
    for (const port of n.ports) {
      if (port.dir !== 'out') continue;
      for (const it of port.items) {
        const call = httpCallOf(it);
        if (!call) continue;
        const eps = pickMostSpecific(
          endpoints.filter(
            (e) => methodMatches(e.method, call.method) && apiPathMatches(e.path, call.path),
          ),
        );
        if (!eps.length) {
          result.unmatched.push(`${n.id} ${call.method} ${call.path}`);
          continue;
        }
        result.matched++;
        const k = /^call_(\d+)$/.exec(it.id)?.[1];
        const ret = k ? topItem(n, 'in', `ret_${k}`) : undefined;
        for (const ep of eps) {
          for (const c of it.children ?? []) {
            const role = roleOf(c);
            if (!role) continue;
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
  if (result.unmatched.length) {
    result.issues.push({
      level: 'warning',
      path: 'v2:join',
      message: `endpoint と結べない HTTP 呼び出し: ${result.unmatched.join(' / ')}（overrides.yaml で補う）`,
    });
  }
  return result;
}
