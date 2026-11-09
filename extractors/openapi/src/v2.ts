/**
 * OpenAPI の操作 → v2 の endpoint の 4 つの口と項目（docs/17 §3.4・§7 #5、docs/16 §5）。
 *
 * - `in`（クライアントから）と `req`（実装へ）に同じ項目: `path`（名前は `<METHOD> <path>`。パスのパラメータを子に）、
 *   `query`（クエリのパラメータを子に。あるときだけ）、`body`（requestBody の JSON の schema。あるときだけ）
 * - `res`（実装から）と `out`（クライアントへ）に同じ項目: 最初の 2xx の応答に JSON の schema があれば `body`、
 *   無ければ `status`（型は `201 Created` のように「コード 説明」、wireType integer）。応答のコードは箱の `meta.status`
 * - 項目の wireType は OpenAPI の語彙そのもの（`string` の format `date-time` / `date` は datetime、`byte` / `binary` は
 *   bytes）。`nullable: true`（3.0）か type の `null`（3.1）は nullable、required に無いプロパティは optional
 * - typeRef: 自分が名前付きの schema（`$ref`。配列なら要素）ならそれ、そうでなければ所属する schema（親の型）。
 *   最上位の項目は自分の型だけ（docs/16 §5 の例と同じ）
 * - 展開の深さは config の `adapters.depth`（既定 2）。`$ref` の循環は止める。`additionalProperties` だけの object・
 *   oneOf / anyOf は子を置かない（不透明。照合しない）
 * - links は書かない（既定で `in → req` / `res → out` の恒等）
 */
import type { ItemV2, NamedType, WireType } from '@stack-atlas/schema';
import type { PartialNodeV2 } from '@stack-atlas/core';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

const SCHEMA_REF = /^#\/(?:components\/schemas|definitions)\/(.+)$/;
const COMPONENT_REF = /^#\/components\/(responses|requestBodies|parameters|headers)\/(.+)$/;
const unescapePointer = (s: string) =>
  decodeURIComponent(s).replace(/~1/g, '/').replace(/~0/g, '~');

/** 項目 id の文字集合（docs/16 §3）。それ以外は _ に */
export const itemId = (name: string) => name.replace(/[^A-Za-z0-9_$-]/g, '_') || '_';

export interface OperationItems {
  /** in / req の項目 */
  request: ItemV2[];
  /** res / out の項目 */
  response: ItemV2[];
  /** 応答に使ったコード（最初の 2xx。合流の戻りの線のラベル `200 Today`） */
  status?: string;
}

interface Ctx {
  root: Obj;
  depth: number;
}

/** schema の `$ref` を解く（名前と中身）。components の responses などは 1 段 */
function deref(v: unknown, root: Obj): { name?: string; schema: Obj } {
  if (!isObj(v)) return { schema: {} };
  const ref = v['$ref'];
  if (typeof ref !== 'string') return { schema: v };
  const m = SCHEMA_REF.exec(ref);
  if (m) {
    const name = unescapePointer(m[1]!);
    const comps = isObj(root['components']) ? root['components'] : {};
    const group = isObj(comps['schemas'])
      ? comps['schemas']
      : isObj(root['definitions'])
        ? root['definitions']
        : {};
    const target = group[name];
    return { name, schema: isObj(target) ? target : {} };
  }
  return { schema: {} };
}

/** components の responses / requestBodies / parameters の `$ref` を 1 段たどる */
function derefComponent(v: unknown, root: Obj): Obj {
  if (!isObj(v) || typeof v['$ref'] !== 'string') return isObj(v) ? v : {};
  const m = COMPONENT_REF.exec(v['$ref']);
  if (!m) return {};
  const comps = isObj(root['components']) ? root['components'] : {};
  const group = comps[m[1]!];
  const target = isObj(group) ? group[unescapePointer(m[2]!)] : undefined;
  return isObj(target) ? target : {};
}

const typeOf = (s: Obj): string | undefined => {
  const t = s['type'];
  if (typeof t === 'string') return t;
  if (Array.isArray(t)) return t.find((x) => typeof x === 'string' && x !== 'null') as string;
  return undefined;
};

const isNullable = (s: Obj) =>
  s['nullable'] === true || (Array.isArray(s['type']) && s['type'].includes('null'));

function wireTypeOf(s: Obj): WireType {
  const t = typeOf(s);
  const f = typeof s['format'] === 'string' ? s['format'] : undefined;
  switch (t) {
    case 'string':
      if (f === 'date-time' || f === 'date') return 'datetime';
      if (f === 'byte' || f === 'binary') return 'bytes';
      return 'string';
    case 'integer':
      return 'integer';
    case 'number':
      return 'number';
    case 'boolean':
      return 'boolean';
    case 'array':
      return 'array';
    case 'object':
      return 'object';
    default:
      return isObj(s['properties']) || Array.isArray(s['allOf']) ? 'object' : 'unknown';
  }
}

/** allOf を 1 つの properties / required にまとめる（$ref を解く） */
function propertiesOf(s: Obj, root: Obj, seen: Set<string>): { props: Obj; required: Set<string> } {
  const props: Obj = {};
  const required = new Set<string>();
  const visit = (x: Obj) => {
    if (isObj(x['properties'])) Object.assign(props, x['properties']);
    if (Array.isArray(x['required']))
      for (const r of x['required']) if (typeof r === 'string') required.add(r);
    if (Array.isArray(x['allOf'])) {
      for (const part of x['allOf']) {
        const d = deref(part, root);
        if (d.name && seen.has(d.name)) continue;
        visit(d.schema);
      }
    }
  };
  visit(s);
  return { props, required };
}

/**
 * schema → 項目。ownerRef は所属する名前付き型（プロパティの項目のとき。最上位は undefined）
 */
function schemaItem(
  id: string,
  name: string,
  raw: unknown,
  ctx: Ctx,
  depth: number,
  ownerRef: string | undefined,
  seen: Set<string>,
): ItemV2 {
  const { name: refName, schema } = deref(raw, ctx.root);
  const wt = wireTypeOf(schema);
  const item: ItemV2 = {
    id: itemId(id),
    name,
    type: displayType(schema, refName, ctx.root),
    wireType: wt,
  };
  if (isNullable(schema) || (isObj(raw) && raw['nullable'] === true)) item.nullable = true;
  let own = refName ? `type:${refName}` : undefined;
  let elem: { name?: string; schema: Obj } | undefined;
  if (wt === 'array') {
    elem = deref(schema['items'], ctx.root);
    if (elem.name) own = `type:${elem.name}`;
  }
  const typeRef = own ?? ownerRef;
  if (typeRef) item.typeRef = typeRef;
  if (depth <= 0) return item;
  const target = elem ?? { name: refName, schema };
  if (target.name && seen.has(target.name)) return item;
  const next = new Set(seen);
  if (target.name) next.add(target.name);
  const objType = wireTypeOf(target.schema);
  if (
    objType !== 'object' ||
    Array.isArray(target.schema['oneOf']) ||
    Array.isArray(target.schema['anyOf'])
  )
    return item;
  const { props, required } = propertiesOf(target.schema, ctx.root, next);
  const children: ItemV2[] = [];
  const used = new Set<string>();
  for (const [pn, ps] of Object.entries(props)) {
    let cid = itemId(pn);
    for (let k = 2; used.has(cid); k++) cid = `${itemId(pn)}_${k}`;
    used.add(cid);
    const child = schemaItem(cid, pn, ps, ctx, depth - 1, typeRef, next);
    if (!required.has(pn)) child.optional = true;
    children.push(child);
  }
  if (children.length) item.children = children;
  return item;
}

/** 表示用の型（`integer (int64)`、`Entry[]`、`Today`、`string (date-time)`） */
function displayType(schema: Obj, refName: string | undefined, root: Obj): string {
  if (refName) return refName;
  const t = typeOf(schema);
  const f = typeof schema['format'] === 'string' ? ` (${schema['format']})` : '';
  if (t === 'array') {
    const e = deref(schema['items'], root);
    return `${e.name ?? displayType(e.schema, undefined, root)}[]`;
  }
  if (t) return `${t}${f}`;
  return isObj(schema['properties']) ? 'object' : 'unknown';
}

/** パラメータ（操作と path の共通。同じ in と name は操作のものが勝つ） */
function parametersOf(op: Obj, shared: unknown, root: Obj): Obj[] {
  const out = new Map<string, Obj>();
  const add = (list: unknown) => {
    if (!Array.isArray(list)) return;
    for (const p of list) {
      const x = derefComponent(p, root);
      if (typeof x['name'] !== 'string' || typeof x['in'] !== 'string') continue;
      out.set(`${x['in']}\u0000${x['name']}`, x);
    }
  };
  add(shared);
  add(op['parameters']);
  return [...out.values()];
}

/** content の JSON の schema（application/json、無ければ +json、無ければ最初のもの） */
function jsonSchema(content: unknown): unknown {
  if (!isObj(content)) return undefined;
  const keys = Object.keys(content);
  const key =
    keys.find((k) => k === 'application/json') ?? keys.find((k) => /json/.test(k)) ?? keys[0];
  const media = key ? content[key] : undefined;
  return isObj(media) ? media['schema'] : undefined;
}

/** 操作の request / response の項目 */
export function operationItems(
  method: string,
  path: string,
  op: Obj,
  shared: unknown,
  root: Obj,
  depth = 2,
): OperationItems {
  const ctx: Ctx = { root, depth };
  const params = parametersOf(op, shared, root);
  const paramItem = (p: Obj, required: boolean) => {
    const it = schemaItem(
      String(p['name']),
      String(p['name']),
      p['schema'] ?? {},
      ctx,
      depth - 1,
      undefined,
      new Set(),
    );
    if (!required) it.optional = true;
    return it;
  };
  const pathItem: ItemV2 = {
    id: 'path',
    name: `${method} ${path}`,
    type: 'string',
    wireType: 'string',
  };
  const pathParams = params.filter((p) => p['in'] === 'path').map((p) => paramItem(p, true));
  if (pathParams.length) pathItem.children = pathParams;
  const request: ItemV2[] = [pathItem];
  const query = params
    .filter((p) => p['in'] === 'query')
    .map((p) => paramItem(p, p['required'] === true));
  if (query.length)
    request.push({
      id: 'query',
      name: 'query',
      type: 'object',
      wireType: 'object',
      children: query,
    });
  // Swagger 2 の body パラメータ
  const bodyParam = params.find((p) => p['in'] === 'body');
  const rb = derefComponent(op['requestBody'], root);
  const bodySchema = jsonSchema(rb['content']) ?? bodyParam?.['schema'];
  if (bodySchema !== undefined) {
    const body = schemaItem('body', 'body', bodySchema, ctx, depth, undefined, new Set());
    const required = bodyParam ? bodyParam['required'] === true : rb['required'] === true;
    if (!required) body.optional = true;
    request.push(body);
  }

  const responses = isObj(op['responses']) ? op['responses'] : {};
  const codes = Object.keys(responses);
  const code =
    codes.filter((c) => /^2\d\d$/.test(c)).sort()[0] ??
    codes.find((c) => /^2XX$/i.test(c)) ??
    codes.find((c) => c === 'default');
  const response: ItemV2[] = [];
  if (code !== undefined) {
    const r = derefComponent(responses[code], root);
    const schema = jsonSchema(r['content']) ?? r['schema'];
    if (schema !== undefined) {
      response.push(schemaItem('body', 'body', schema, ctx, depth, undefined, new Set()));
    } else {
      const desc = typeof r['description'] === 'string' ? r['description'] : '';
      response.push({
        id: 'status',
        name: 'status',
        type: `${code}${desc ? ` ${desc}` : ''}`,
        wireType: 'integer',
      });
    }
  }
  return { request, response, ...(code !== undefined ? { status: code } : {}) };
}

/** endpoint の v2 の箱（4 つの口） */
export function endpointNodeV2(
  id: string,
  method: string,
  path: string,
  items: OperationItems,
  file: string,
  line: number,
  operationId?: string,
): PartialNodeV2 {
  const copy = (xs: ItemV2[]) => structuredClone(xs);
  return {
    id,
    kind: 'endpoint',
    name: `${method} ${path}`,
    runtime: 'server',
    file,
    line,
    ports: [
      { id: 'in', dir: 'in', items: copy(items.request) },
      { id: 'req', dir: 'out', items: copy(items.request) },
      { id: 'res', dir: 'in', items: copy(items.response) },
      { id: 'out', dir: 'out', items: copy(items.response) },
    ],
    ...(operationId || items.status
      ? {
          meta: {
            ...(operationId ? { operationId } : {}),
            ...(items.status ? { status: items.status } : {}),
          },
        }
      : {}),
  };
}

/** components.schemas → types[] */
export function namedTypeOf(name: string, file: string, line: number): NamedType {
  return { id: `type:${name}`, name, file, line, source: 'openapi' };
}
