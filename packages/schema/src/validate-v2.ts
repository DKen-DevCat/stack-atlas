// graph.json v2 の検証（docs/16 §9）。スキーマ検証 → 参照整合性 → 規約の警告
// eslint-disable-next-line @typescript-eslint/triple-slash-reference -- 他パッケージから src を直接読むときにも JSON の型宣言を効かせるため
/// <reference path="./schema-json.d.ts" />
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import schema from '../graph-v2.schema.json' with { type: 'json' };
import { checkBehaviors } from './behaviors.js';
import { formatAjvError, validateGraph, type ValidationIssue } from './validate.js';
import {
  parseItemRef,
  parseWhenKey,
  type GraphV2,
  type ItemV2,
  type NodeV2,
  type PortV2,
  type When,
} from './v2.js';

export interface ValidationResultV2 {
  /** エラーが 1 つもなければ true。警告だけなら true */
  ok: boolean;
  /** スキーマ検証を通ったときに返す（参照エラーがあっても返す） */
  graph?: GraphV2;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
}

/** graph-v2.schema.json の JSON */
export const graphSchemaV2: Record<string, unknown> = schema;

let compiled: ReturnType<Ajv2020['compile']> | undefined;
function getSchemaValidator() {
  if (!compiled) {
    const ajv = new Ajv2020({ allErrors: true, strict: false });
    addFormats(ajv);
    compiled = ajv.compile(schema);
  }
  return compiled;
}

/** 検証用の最小の索引（項目の参照 → 項目と口） */
interface ItemEntry {
  item: ItemV2;
  port: PortV2;
  node: NodeV2;
  path: string;
}

function indexItems(
  node: NodeV2,
  nodeIndex: number,
  error: (path: string, message: string) => void,
): Map<string, ItemEntry> {
  const byLocal = new Map<string, ItemEntry>();
  const portIds = new Set<string>();
  node.ports.forEach((port, pi) => {
    if (portIds.has(port.id))
      error(
        `/nodes/${nodeIndex}/ports/${pi}/id`,
        `箱 "${node.id}" の口 "${port.id}" が重複しています`,
      );
    portIds.add(port.id);
    const walk = (items: ItemV2[], prefix: string, jsonPath: string) => {
      const seen = new Set<string>();
      items.forEach((it, ii) => {
        const here = `${jsonPath}/${ii}`;
        if (seen.has(it.id)) {
          error(
            `${here}/id`,
            `箱 "${node.id}" の口 "${port.id}" で項目 "${prefix}${it.id}" が重複しています`,
          );
        }
        seen.add(it.id);
        const path = prefix + it.id;
        byLocal.set(`${port.id}/${path}`, { item: it, port, node, path });
        if (it.children) walk(it.children, `${path}.`, `${here}/children`);
      });
    };
    walk(port.items, '', `/nodes/${nodeIndex}/ports/${pi}/items`);
  });
  return byLocal;
}

/** スキーマ検証を通った graph の参照整合性と規約をチェックする */
function checkGraph(g: GraphV2): { errors: ValidationIssue[]; warnings: ValidationIssue[] } {
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];
  const error = (path: string, message: string) => errors.push({ level: 'error', path, message });
  const warn = (path: string, message: string) =>
    warnings.push({ level: 'warning', path, message });

  // 型
  const typeIds = new Set<string>();
  g.types?.forEach((t, i) => {
    if (typeIds.has(t.id)) error(`/types/${i}/id`, `型 ID "${t.id}" が重複しています`);
    typeIds.add(t.id);
  });

  // 箱と項目
  const nodes = new Map<string, { node: NodeV2; index: number; items: Map<string, ItemEntry> }>();
  g.nodes.forEach((n, i) => {
    if (nodes.has(n.id)) {
      error(`/nodes/${i}/id`, `ノード ID "${n.id}" が重複しています`);
      return;
    }
    nodes.set(n.id, { node: n, index: i, items: indexItems(n, i, error) });
  });
  const declares = (nodeId: string, variantId: string) =>
    nodes.get(nodeId)?.node.variants?.some((v) => v.id === variantId) ?? false;

  /** when のキーを解決する。owners は無修飾のときの候補（線なら両端、links・項目ならその箱） */
  const checkWhen = (when: When | undefined, owners: string[], path: string) => {
    if (!when) return;
    for (const key of Object.keys(when)) {
      const { nodeId, variantId } = parseWhenKey(key);
      if (nodeId !== undefined) {
        if (!nodes.has(nodeId)) error(path, `when のキー "${key}" の箱 "${nodeId}" がありません`);
        else if (!declares(nodeId, variantId))
          error(
            path,
            `when のキー "${key}": 箱 "${nodeId}" は分岐 "${variantId}" を宣言していません`,
          );
        continue;
      }
      const found = [...new Set(owners)].filter((o) => declares(o, variantId));
      if (found.length === 0) {
        error(
          path,
          `when のキー "${key}" を宣言している箱がありません（候補: ${owners.join(', ')}）`,
        );
      } else if (found.length > 1) {
        error(
          path,
          `when のキー "${key}" は線の両端（${found.join(', ')}）が宣言しています。"<nodeId>#${variantId}" で修飾してください`,
        );
      }
    }
  };

  const resolveLocal = (nodeId: string, ref: string) => nodes.get(nodeId)?.items.get(ref);
  const resolveItem = (ref: string) => {
    const p = parseItemRef(ref);
    if (!p) return undefined;
    return resolveLocal(p.nodeId, `${p.portId}/${p.path.join('.')}`);
  };

  for (const { node: n, index: i, items } of nodes.values()) {
    const base = `/nodes/${i}`;
    if (n.host !== undefined) {
      const h = nodes.get(n.host);
      if (!h) error(`${base}/host`, `箱 "${n.id}" の host "${n.host}" がありません`);
      else if (h.node.kind !== 'infra')
        error(
          `${base}/host`,
          `箱 "${n.id}" の host "${n.host}" は kind infra ではありません（${h.node.kind}）`,
        );
    }
    if (n.kind === 'cache' && !declares(n.id, 'hit')) {
      error(`${base}/variants`, `kind cache の箱 "${n.id}" は分岐 "hit" を宣言する必要があります`);
    }
    const variantIds = new Set<string>();
    n.variants?.forEach((v, vi) => {
      if (variantIds.has(v.id))
        error(`${base}/variants/${vi}/id`, `箱 "${n.id}" の分岐 "${v.id}" が重複しています`);
      variantIds.add(v.id);
    });

    // 項目: when、wireType、typeRef、口の単位の線（`_`）
    let hasUnderscore = false;
    for (const [local, e] of items) {
      const p = `${base}/ports/${n.ports.indexOf(e.port)}/items(${local})`;
      checkWhen(e.item.when, [n.id], p);
      if (e.item.wireType === 'unknown')
        warn(p, `項目 "${n.id}#${local}" の wireType が unknown です`);
      if (e.item.typeRef !== undefined && !typeIds.has(e.item.typeRef)) {
        warn(p, `項目 "${n.id}#${local}" の typeRef "${e.item.typeRef}" が types にありません`);
      }
      if (e.item.id === '_' && e.path === '_') hasUnderscore = true;
    }
    if (hasUnderscore) {
      warn(
        `${base}/ports`,
        `箱 "${n.id}" は口の単位の項目（"_"）を持っています（項目まで下がっていません）`,
      );
    }

    // links
    if (n.links) {
      n.links.forEach((l, li) => {
        const lp = `${base}/links/${li}`;
        const from = resolveLocal(n.id, l.from);
        const to = resolveLocal(n.id, l.to);
        if (!from) error(`${lp}/from`, `箱 "${n.id}" の links の from "${l.from}" がありません`);
        else if (from.port.dir !== 'in')
          error(`${lp}/from`, `links の from "${l.from}" は dir in の口ではありません`);
        if (!to) error(`${lp}/to`, `箱 "${n.id}" の links の to "${l.to}" がありません`);
        else if (to.port.dir !== 'out')
          error(`${lp}/to`, `links の to "${l.to}" は dir out の口ではありません`);
        checkWhen(l.when, [n.id], `${lp}/when`);
      });
    } else if (n.kind !== 'table' && n.kind !== 'endpoint') {
      // 不透明な箱: in と out の両方に 2 つ以上の（最上位の）項目がある
      const roots = (dir: 'in' | 'out') =>
        n.ports.filter((p) => p.dir === dir).reduce((acc, p) => acc + p.items.length, 0);
      if (roots('in') >= 2 && roots('out') >= 2) {
        warn(
          `${base}/links`,
          `箱 "${n.id}" は links が無く in / out に 2 つ以上の項目があります（不透明な箱）`,
        );
      }
    }
  }

  // 線
  const seen = new Set<string>();
  g.wires.forEach((w, i) => {
    const base = `/wires/${i}`;
    const from = resolveItem(w.from);
    const to = resolveItem(w.to);
    if (!from) error(`${base}/from`, `線の始点 "${w.from}" がありません`);
    else if (from.port.dir !== 'out')
      error(`${base}/from`, `線の始点 "${w.from}" は dir out の口の項目ではありません`);
    if (!to) error(`${base}/to`, `線の終点 "${w.to}" がありません`);
    else if (to.port.dir !== 'in')
      error(`${base}/to`, `線の終点 "${w.to}" は dir in の口の項目ではありません`);
    const key = `${w.from}\u0000${w.to}`;
    if (seen.has(key)) error(base, `線 "${w.from}" → "${w.to}" が重複しています`);
    seen.add(key);
    if (from && to) {
      checkWhen(w.when, [from.node.id, to.node.id], `${base}/when`);
      if (from.item.id === '_' || to.item.id === '_') {
        warn(base, `線 "${w.from}" → "${w.to}" は口の単位です（項目まで下がっていません）`);
      }
    }
    // broken の path は from からの相対。受ける側だけにある項目（送る側に無い）は to 側で解ける
    w.broken?.forEach((b, bi) => {
      if (!from || !to || b.path === '') return;
      const onFrom = resolveLocal(from.node.id, `${from.port.id}/${from.path}.${b.path}`);
      const onTo = resolveLocal(to.node.id, `${to.port.id}/${to.path}.${b.path}`);
      if (!onFrom && !onTo) {
        error(
          `${base}/broken/${bi}/path`,
          `broken の path "${b.path}" が線のどちらの端にもありません`,
        );
      }
    });
  });

  // 部品と挙動（Phase 10。docs/26 §5）。誤りにした線は、挙動からは「無い線」として扱う
  const badWires = new Set<number>();
  for (const e of errors) {
    const m = /^\/wires\/(\d+)/.exec(e.path);
    if (m) badWires.add(Number(m[1]));
  }
  for (const issue of checkBehaviors(g, badWires))
    (issue.level === 'error' ? errors : warnings).push(issue);

  // views
  const viewIds = new Set<string>();
  g.views?.forEach((v, i) => {
    const base = `/views/${i}`;
    if (viewIds.has(v.id)) error(`${base}/id`, `view ID "${v.id}" が重複しています`);
    viewIds.add(v.id);
    if (typeof v.start === 'string') {
      const isNode = nodes.has(v.start);
      const isItem = !isNode && resolveItem(v.start) !== undefined;
      if (!isNode && !isItem)
        error(`${base}/start`, `view "${v.id}" の start "${v.start}" がありません`);
    } else {
      const start = v.start;
      const hit = g.wires.some((w) => w.from === start.from && w.to === start.to);
      if (!hit)
        error(
          `${base}/start`,
          `view "${v.id}" の start の線 "${start.from}" → "${start.to}" がありません`,
        );
    }
    for (const key of Object.keys(v.variants ?? {})) {
      const { nodeId, variantId } = parseWhenKey(key);
      if (nodeId === undefined || !nodes.has(nodeId))
        error(`${base}/variants`, `view "${v.id}" の分岐 "${key}" の箱がありません`);
      else if (!declares(nodeId, variantId))
        error(
          `${base}/variants`,
          `view "${v.id}" の分岐 "${key}": 箱 "${nodeId}" は "${variantId}" を宣言していません`,
        );
    }
  });

  // groups（Phase 8-6。group になった v1 の箱の元の名前・kind・file）: id の重複はエラー、どの箱の group でもない id と、
  // 箱と同じ id は警告（地図のノードの名前に使われないだけで、配線図は描ける）
  const groupValues = new Set(g.nodes.flatMap((n) => (n.group === undefined ? [] : [n.group])));
  const groupIds = new Set<string>();
  g.groups?.forEach((gr, i) => {
    const base = `/groups/${i}/id`;
    if (groupIds.has(gr.id)) error(base, `group "${gr.id}" が重複しています`);
    groupIds.add(gr.id);
    if (nodes.has(gr.id)) warn(base, `group "${gr.id}" と同じ id の箱があります`);
    else if (!groupValues.has(gr.id))
      warn(base, `group "${gr.id}" はどの箱の group でもありません`);
  });

  return { errors, warnings };
}

/**
 * graph.json v2 をスキーマ検証＋参照整合性チェックする。
 * - スキーマ違反: ok=false、graph なし
 * - 参照エラー: ok=false、graph あり
 * - 警告のみ: ok=true
 */
export function validateGraphV2(json: unknown): ValidationResultV2 {
  const validate = getSchemaValidator();
  if (!validate(json)) {
    return { ok: false, errors: (validate.errors ?? []).map(formatAjvError), warnings: [] };
  }
  const graph = json as GraphV2;
  const { errors, warnings } = checkGraph(graph);
  return { ok: errors.length === 0, graph, errors, warnings };
}

/** JSON の version を見て v1 / v2 のどちらか判定する（1 でも 2 でもなければ null） */
export function detectGraphVersion(json: unknown): 1 | 2 | null {
  if (typeof json !== 'object' || json === null) return null;
  const v = (json as { version?: unknown }).version;
  return v === 1 ? 1 : v === 2 ? 2 : null;
}

/**
 * version を見て v1 / v2 の検証を呼び分ける（CLI 用）。issues は errors と warnings を 1 列にしたもの
 */
export function validateAnyGraph(json: unknown): {
  ok: boolean;
  version: 1 | 2 | null;
  issues: ValidationIssue[];
} {
  const version = detectGraphVersion(json);
  if (version === 2) {
    const r = validateGraphV2(json);
    return { ok: r.ok, version, issues: [...r.errors, ...r.warnings] };
  }
  const r = validateGraph(json);
  return { ok: r.ok, version, issues: r.errors };
}
