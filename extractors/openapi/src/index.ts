/**
 * openapi 抽出器（docs/12 §3.5）: OpenAPI 3 / Swagger 2 の契約をノードにする。
 *
 * - `paths.<path>.<method>` → `endpoint:<METHOD> <path>`（kind `endpoint`、layer `types`、
 *   `meta.api: { method, path, operationId }`、`meta.apiRoutes`）
 * - `components.schemas.X`（Swagger 2 は `definitions.X`）→ `type:X`（`meta.ts.symbolKind: 'openapi'`）
 * - endpoint → `uses` → requestBody / responses / parameters が `$ref` する schema
 *   （`#/components/{responses,requestBodies,parameters}/…` は 1 段たどる）。schema → schema も `uses`
 * - Cache-Control ヘッダか `x-cache` を宣言している操作だけ `cache`
 * - 同じ契約の写しが複数 repo にあれば、path + method で重複を除いて最初の repo のものを残す
 * - v2（docs/17 §7 #5、8-2a）: `PartialGraph.v2` に endpoint の 4 つの口（in / req / res / out）と、request（path /
 *   query / body）・response（body か status）の schema の項目を出す（v2.ts）。schema は types[] にも
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isMap, isScalar, LineCounter, parseDocument, type Node as YamlNode } from 'yaml';
import type { Cache, Edge } from '@stack-atlas/schema';
import type {
  Extractor,
  PartialGraph,
  PartialNode,
  PartialNodeV2,
  RepoContext,
} from '@stack-atlas/core';
import { confineRepoPath } from '@stack-atlas/core';
import type { NamedType } from '@stack-atlas/schema';
import {
  DEFAULT_MAX_ITEMS,
  endpointNodeV2,
  namedTypeOf,
  operationItems,
  type OperationItems,
  type PropertiesMemo,
} from './v2.js';

export {
  endpointNodeV2,
  itemId,
  operationItems,
  DEFAULT_MAX_ITEMS,
  type OperationItems,
  type OperationItemsOptions,
} from './v2.js';

export const NAME = 'openapi';

const METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'trace'];
const DEFAULT_DIRS = ['openapi', 'api', 'spec', 'docs'];
const DEFAULT_FILES = [
  'openapi.yaml',
  'openapi.yml',
  'openapi.json',
  'swagger.yaml',
  'swagger.yml',
  'swagger.json',
];

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

/** この repo で読む OpenAPI ファイル（repo 相対）。config.openapi.files が無ければ既定の場所 */
export function openapiFiles(ctx: Pick<RepoContext, 'root' | 'repoName' | 'config'>): string[] {
  const configured = ctx.config.openapi?.files;
  const exists = (rel: string) => existsSync(join(ctx.root, rel));
  if (configured && configured.length > 0) {
    const out: string[] = [];
    for (const f of configured) {
      const spec = typeof f === 'string' ? { path: f } : f;
      if (spec.repo && spec.repo !== ctx.repoName) continue;
      // repo の外（絶対パス・`..`・外へ出るリンク）は読まない（2026-11-10 8-4 のレビュー S2）
      if (typeof spec.path !== 'string' || !('abs' in confineRepoPath(ctx.root, spec.path)))
        continue;
      if (exists(spec.path)) out.push(spec.path.replace(/^\.\//, ''));
    }
    return out;
  }
  const out: string[] = DEFAULT_FILES.filter(exists);
  // openapi/*.{yaml,yml,json}（api/ spec/ docs/ は openapi: か swagger: を含むものだけ）
  for (const dir of DEFAULT_DIRS) {
    let names: string[];
    try {
      names = readdirSync(join(ctx.root, dir)).sort();
    } catch {
      continue;
    }
    for (const n of names) {
      if (!/\.(ya?ml|json)$/.test(n)) continue;
      const rel = `${dir}/${n}`;
      if (dir !== 'openapi') {
        try {
          if (
            !/^\s*["']?(openapi|swagger)["']?\s*:/m.test(readFileSync(join(ctx.root, rel), 'utf8'))
          )
            continue;
        } catch {
          continue;
        }
      }
      out.push(rel);
    }
  }
  return out;
}

export interface OpenApiOperation {
  method: string;
  path: string;
  operationId?: string;
  summary?: string;
  line: number;
  code: string;
  /** 参照している schema 名 */
  schemas: string[];
  cache?: Cache;
  /** v2 の endpoint の項目（request / response） */
  items: OperationItems;
}

export interface OpenApiSchema {
  name: string;
  line: number;
  code: string;
  /** この schema が参照する schema 名 */
  refs: string[];
}

export interface OpenApiSpec {
  operations: OpenApiOperation[];
  schemas: OpenApiSchema[];
}

const SCHEMA_REF = /^#\/(?:components\/schemas|definitions)\/(.+)$/;
const COMPONENT_REF = /^#\/components\/(responses|requestBodies|parameters|headers)\/(.+)$/;

const unescapePointer = (s: string) =>
  decodeURIComponent(s).replace(/~1/g, '/').replace(/~0/g, '~');

/** 値の中の `$ref` を集める */
function collectRefs(v: unknown, out: string[] = []): string[] {
  if (Array.isArray(v)) for (const x of v) collectRefs(x, out);
  else if (isObj(v)) {
    for (const [k, x] of Object.entries(v)) {
      if (k === '$ref' && typeof x === 'string') out.push(x);
      else collectRefs(x, out);
    }
  }
  return out;
}

/** `$ref` を schema 名にする。components の responses 等は 1 段たどる */
function schemaRefs(v: unknown, components: Obj): string[] {
  const out = new Set<string>();
  const visit = (ref: string, depth: number) => {
    const s = SCHEMA_REF.exec(ref);
    if (s) {
      out.add(unescapePointer(s[1]!));
      return;
    }
    const c = COMPONENT_REF.exec(ref);
    if (c && depth === 0) {
      const group = components[c[1]!];
      const target = isObj(group) ? group[unescapePointer(c[2]!)] : undefined;
      for (const r of collectRefs(target)) visit(r, depth + 1);
    }
  };
  for (const r of collectRefs(v)) visit(r, 0);
  return [...out];
}

function operationCache(op: Obj): Cache | undefined {
  const rules: Array<{ key: string; value: string }> = [];
  const x = op['x-cache'];
  if (x !== undefined) {
    if (isObj(x))
      for (const [k, v] of Object.entries(x)) rules.push({ key: `x-cache.${k}`, value: String(v) });
    else rules.push({ key: 'x-cache', value: String(x) });
  }
  const responses = isObj(op['responses']) ? op['responses'] : {};
  for (const [status, r] of Object.entries(responses)) {
    const headers = isObj(r) && isObj(r['headers']) ? r['headers'] : {};
    for (const [h, def] of Object.entries(headers)) {
      if (h.toLowerCase() !== 'cache-control') continue;
      const d = isObj(def) ? def : {};
      const schema = isObj(d['schema']) ? d['schema'] : {};
      const value =
        d['example'] ??
        schema['example'] ??
        schema['default'] ??
        (Array.isArray(schema['enum']) ? schema['enum'].join(' | ') : undefined) ??
        d['description'] ??
        '宣言あり';
      rules.push({ key: `${status} Cache-Control`, value: String(value) });
    }
  }
  return rules.length > 0 ? { tone: 'info', badge: 'Cache-Control', rules } : undefined;
}

const MAX_CODE_LINES = 25;

function truncateLines(text: string): string {
  const lines = text.split('\n');
  return lines.length > MAX_CODE_LINES
    ? [...lines.slice(0, MAX_CODE_LINES), '# …'].join('\n')
    : text;
}

function excerpt(src: string, lc: LineCounter, start: number, end: number) {
  // キーの行頭から
  const lineStart = src.lastIndexOf('\n', start - 1) + 1;
  return {
    line: lc.linePos(start).line,
    code: truncateLines(src.slice(lineStart, end).replace(/\s+$/, '')),
  };
}

/**
 * OpenAPI / Swagger の文字列を読む（YAML / JSON どちらも。行番号は yaml の LineCounter）。
 * depth は v2 の項目の展開の深さ（config の adapters.depth。既定 2）
 */
export function parseOpenApi(
  src: string,
  opts: { depth?: number; maxItems?: number } = {},
): OpenApiSpec {
  const lc = new LineCounter();
  const doc = parseDocument(src, { lineCounter: lc, uniqueKeys: false });
  // 別名（&a / *a）の展開は yaml の既定の上限（100）で止める。-1（無制限）だと別名を倍々に重ねた YAML で
  // 展開と collectRefs が指数時間になる（2026-11-09 のレビューで判明。上限を超えると例外 → 呼び出し元が警告して飛ばす）
  const json = doc.toJS({ maxAliasCount: 100 }) as unknown;
  const root = isObj(json) ? json : {};
  const components = isObj(root['components']) ? root['components'] : {};
  const out: OpenApiSpec = { operations: [], schemas: [] };
  const srcLines = src.split('\n');

  const pairsOf = (n: unknown) =>
    isMap(n)
      ? n.items.map((p) => ({
          key: isScalar(p.key) ? String(p.key.value) : String(p.key),
          keyNode: p.key as YamlNode | null,
          value: p.value as YamlNode | null,
        }))
      : [];
  const rangeOf = (k: YamlNode | null, v: YamlNode | null) => {
    const start = k?.range?.[0] ?? v?.range?.[0] ?? 0;
    const end = v?.range?.[1] ?? k?.range?.[1] ?? start;
    return [start, end] as const;
  };

  const paths = isObj(root['paths']) ? root['paths'] : {};
  const pathsNode = doc.get('paths', true);
  /** allOf のまとめ（操作どうしで共有する） */
  const memo: PropertiesMemo = new Map();
  for (const p of pairsOf(pathsNode)) {
    const item = paths[p.key];
    if (!isObj(item)) continue;
    const shared = item['parameters'];
    for (const m of pairsOf(p.value)) {
      if (!METHODS.includes(m.key.toLowerCase())) continue;
      const op = item[m.key];
      if (!isObj(op)) continue;
      const [start, end] = rangeOf(m.keyNode, m.value);
      const pathLine = lc.linePos(p.keyNode?.range?.[0] ?? start).line;
      const { line: opLine, code } = excerpt(src, lc, start, end);
      const head = pathLine < opLine ? `${srcLines[pathLine - 1]!.replace(/\s+$/, '')}\n` : '';
      const o: OpenApiOperation = {
        method: m.key.toUpperCase(),
        path: p.key,
        line: pathLine,
        code: truncateLines(head + code),
        schemas: schemaRefs(
          {
            requestBody: op['requestBody'],
            responses: op['responses'],
            parameters: [op['parameters'], shared],
          },
          components,
        ),
        items: operationItems(m.key.toUpperCase(), p.key, op, shared, root, {
          ...opts,
          memo,
        }),
      };
      if (typeof op['operationId'] === 'string') o.operationId = op['operationId'];
      if (typeof op['summary'] === 'string') o.summary = op['summary'];
      const cache = operationCache(op);
      if (cache) o.cache = cache;
      out.operations.push(o);
    }
  }

  const schemaNodes = [
    ...pairsOf(doc.getIn(['components', 'schemas'], true)).map((x) => ({
      ...x,
      group: (components['schemas'] ?? {}) as Obj,
    })),
    ...pairsOf(doc.get('definitions', true)).map((x) => ({
      ...x,
      group: (root['definitions'] ?? {}) as Obj,
    })),
  ];
  for (const s of schemaNodes) {
    const [start, end] = rangeOf(s.keyNode, s.value);
    const { line, code } = excerpt(src, lc, start, end);
    out.schemas.push({
      name: s.key,
      line,
      code,
      refs: schemaRefs(s.group[s.key], components).filter((r) => r !== s.key),
    });
  }
  return out;
}

const endpointId = (method: string, path: string) => `endpoint:${method} ${path}`;

export const extractor: Extractor = {
  name: NAME,
  /** v2 の endpoint は契約（合流点。言語アダプタではない。docs/17 §2） */
  v2Role: 'contract',
  async detect(ctx) {
    return openapiFiles(ctx).length > 0;
  },
  async extract(ctx, upstream): Promise<PartialGraph> {
    const nodes = new Map<string, PartialNode>();
    const edges = new Map<string, Edge>();
    const addEdge = (from: string, to: string, kind: string) => {
      if (from !== to) edges.set(`${from}\0${to}\0${kind}`, { from, to, kind });
    };
    // 他の repo の写しで既に出ている endpoint / type
    const fromOpenapi = new Set(
      upstream.nodes
        .filter((n) => (n.meta?.['extractors'] as string[] | undefined)?.includes(NAME))
        .map((n) => n.id),
    );
    // v2: 他の repo の写しで既に出ている endpoint は出さない
    const fromOpenapiV2 = new Set(
      (upstream.v2?.nodes ?? []).filter((n) => n.kind === 'endpoint').map((n) => n.id),
    );
    const nodesV2: PartialNodeV2[] = [];
    const typesV2: NamedType[] = [];
    const depth = ctx.config.adapters?.depth ?? 2;
    const maxItems = ctx.config.adapters?.maxItems ?? DEFAULT_MAX_ITEMS;
    let dup = 0;
    for (const rel of openapiFiles(ctx)) {
      let spec: OpenApiSpec;
      try {
        spec = parseOpenApi(readFileSync(join(ctx.root, rel), 'utf8'), { depth, maxItems });
      } catch (e) {
        ctx.log.warn(`openapi: ${rel} を読めません: ${String(e)}`);
        continue;
      }
      for (const s of spec.schemas) {
        const id = `type:${s.name}`;
        if (fromOpenapi.has(id) || nodes.has(id)) continue;
        nodes.set(id, {
          id,
          kind: 'type',
          name: s.name,
          file: rel,
          line: s.line,
          code: s.code,
          meta: {
            extractors: [NAME],
            ts: { exportName: s.name, symbolKind: 'openapi' },
            openapi: { file: rel },
          },
        });
        for (const r of s.refs) addEdge(id, `type:${r}`, 'uses');
        typesV2.push(namedTypeOf(s.name, rel, s.line));
      }
      for (const o of spec.operations) {
        const id = endpointId(o.method, o.path);
        if (fromOpenapi.has(id) || nodes.has(id)) {
          dup++;
          continue;
        }
        const api: Record<string, string> = { method: o.method, path: o.path };
        if (o.operationId) api['operationId'] = o.operationId;
        const openapi: Record<string, string> = { file: rel };
        if (o.summary) openapi['summary'] = o.summary;
        const node: PartialNode = {
          id,
          kind: 'endpoint',
          layer: 'types',
          name: `${o.method} ${o.path}`,
          file: rel,
          line: o.line,
          code: o.code,
          meta: {
            extractors: [NAME],
            api,
            apiRoutes: [{ method: o.method, path: o.path }],
            openapi,
          },
        };
        if (o.cache) node.cache = o.cache;
        nodes.set(id, node);
        if (!fromOpenapiV2.has(id)) {
          nodesV2.push(endpointNodeV2(id, o.method, o.path, o.items, rel, o.line, o.operationId));
          if (o.items.truncated)
            ctx.log.warn(
              `openapi: ${id}（${rel}）の項目が上限（${maxItems}）を超えたので、schema の子の展開を打ち切りました（config の adapters.maxItems）`,
            );
        }
        for (const s of o.schemas) addEdge(id, `type:${s}`, 'uses');
      }
    }
    if (dup > 0)
      ctx.log.info(
        `openapi: ${ctx.repoName} の写しの ${dup} 操作は既出なので最初の repo のものを使います`,
      );
    // 参照先の schema が無いエッジは落とす
    const known = new Set([...nodes.keys(), ...fromOpenapi]);
    const out = [...edges.values()].filter((e) => known.has(e.to));
    const eps = [...nodes.values()].filter((n) => n.kind === 'endpoint').length;
    ctx.log.info(`openapi: ${eps} endpoints, ${nodes.size - eps} schemas, ${out.length} edges`);
    const part: PartialGraph = { nodes: [...nodes.values()], edges: out };
    if (nodesV2.length || typesV2.length) part.v2 = { nodes: nodesV2, wires: [], types: typesV2 };
    return part;
  },
};

export default extractor;
