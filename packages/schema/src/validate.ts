// eslint-disable-next-line @typescript-eslint/triple-slash-reference -- 他パッケージから src を直接読むときにも JSON の型宣言を効かせるため
/// <reference path="./schema-json.d.ts" />
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import type { ErrorObject } from 'ajv';
import schema from '../graph.schema.json' with { type: 'json' };
import { KNOWN_EDGE_KINDS, KNOWN_NODE_KINDS, type Graph } from './types.js';

export interface ValidationIssue {
  level: 'error' | 'warning';
  /** JSON Pointer 風のパス。例 `/nodes/3/layer` */
  path: string;
  message: string;
}

export interface ValidationResult {
  /** エラー（level: error）が 1 つもなければ true。警告だけなら true */
  ok: boolean;
  /** スキーマ検証を通ったときに返す。参照エラーがあっても返す（描画を続けるため。docs/08 D7） */
  graph?: Graph;
  errors: ValidationIssue[];
}

/** graph.schema.json の JSON（ビューアやツールから参照する用） */
export const graphSchema: Record<string, unknown> = schema;

let compiled: ReturnType<Ajv2020['compile']> | undefined;
function getSchemaValidator() {
  if (!compiled) {
    const ajv = new Ajv2020({ allErrors: true, strict: false });
    addFormats(ajv);
    compiled = ajv.compile(schema);
  }
  return compiled;
}

export function formatAjvError(e: ErrorObject): ValidationIssue {
  const path = e.instancePath || '/';
  let message: string;
  switch (e.keyword) {
    case 'required':
      message = `必須フィールド "${String(e.params.missingProperty)}" がありません`;
      break;
    case 'additionalProperties':
      message = `未定義のフィールド "${String(e.params.additionalProperty)}" があります`;
      break;
    case 'type':
      message = `型が違います（期待: ${String(e.params.type)}）`;
      break;
    case 'const':
      message = `値が違います（期待: ${JSON.stringify(e.params.allowedValue)}）`;
      break;
    case 'enum':
      message = `許可されていない値です（候補: ${(e.params.allowedValues as unknown[]).map((v) => JSON.stringify(v)).join(', ')}）`;
      break;
    case 'pattern':
      message = `形式が違います（パターン: ${String(e.params.pattern)}）`;
      break;
    case 'format':
      message = `形式が違います（${String(e.params.format)}）`;
      break;
    case 'minItems':
      message = `要素が ${String(e.params.limit)} 個以上必要です`;
      break;
    case 'minimum':
      message = `${String(e.params.limit)} 以上である必要があります`;
      break;
    default:
      message = `スキーマ違反（${e.keyword}）: ${e.message ?? ''}`;
  }
  return { level: 'error', path, message };
}

/** スキーマ検証を通った graph の参照整合性をチェックする */
function checkReferences(g: Graph): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const error = (path: string, message: string) => issues.push({ level: 'error', path, message });
  const warn = (path: string, message: string) => issues.push({ level: 'warning', path, message });

  const layerIds = new Set<string>();
  g.layers.forEach((l, i) => {
    if (layerIds.has(l.id)) error(`/layers/${i}/id`, `層 ID "${l.id}" が重複しています`);
    layerIds.add(l.id);
  });

  const nodeIds = new Set<string>();
  // graph.kinds で表示定義を持つ kind は既知として扱う
  const knownNodeKinds = new Set<string>([...KNOWN_NODE_KINDS, ...Object.keys(g.kinds ?? {})]);
  g.nodes.forEach((n, i) => {
    if (nodeIds.has(n.id)) error(`/nodes/${i}/id`, `ノード ID "${n.id}" が重複しています`);
    nodeIds.add(n.id);
    if (!layerIds.has(n.layer)) {
      error(`/nodes/${i}/layer`, `ノード "${n.id}" の層 "${n.layer}" が layers にありません`);
    }
    if (!knownNodeKinds.has(n.kind)) {
      warn(
        `/nodes/${i}/kind`,
        `ノード "${n.id}" の kind "${n.kind}" は未知です（汎用ボックスで描きます）`,
      );
    }
  });

  g.nodes.forEach((n, i) => {
    n.screen?.regions?.forEach((r, j) => {
      if (!nodeIds.has(r.ref)) {
        error(
          `/nodes/${i}/screen/regions/${j}/ref`,
          `画面 "${n.id}" の領域が参照するノード "${r.ref}" がありません`,
        );
      }
    });
  });

  const knownEdgeKinds = new Set<string>(KNOWN_EDGE_KINDS);
  g.edges.forEach((e, i) => {
    if (!nodeIds.has(e.from)) error(`/edges/${i}/from`, `エッジの始点 "${e.from}" がありません`);
    if (!nodeIds.has(e.to)) error(`/edges/${i}/to`, `エッジの終点 "${e.to}" がありません`);
    if (e.from === e.to) warn(`/edges/${i}`, `エッジ "${e.from}" が自分自身を指しています`);
    if (!knownEdgeKinds.has(e.kind)) {
      warn(`/edges/${i}/kind`, `エッジ "${e.from}" → "${e.to}" の kind "${e.kind}" は未知です`);
    }
  });

  g.flows?.forEach((f, i) => {
    f.steps.forEach((s, j) => {
      if (!nodeIds.has(s.node)) {
        error(
          `/flows/${i}/steps/${j}/node`,
          `フロー "${f.id}" のステップが参照するノード "${s.node}" がありません`,
        );
      }
    });
  });

  return issues;
}

/**
 * graph.json をスキーマ検証＋参照整合性チェックする。
 * - スキーマ違反: ok=false、graph なし
 * - 参照エラー: ok=false、graph あり（ビューアは描画を続ける）
 * - 警告のみ: ok=true
 */
export function validateGraph(json: unknown): ValidationResult {
  const validate = getSchemaValidator();
  if (!validate(json)) {
    return { ok: false, errors: (validate.errors ?? []).map(formatAjvError) };
  }
  const graph = json as Graph;
  const errors = checkReferences(graph);
  return { ok: !errors.some((e) => e.level === 'error'), graph, errors };
}
