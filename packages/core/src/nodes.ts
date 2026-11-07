/** ノードの欠けた必須フィールド（kind / name）を ID から補う */
import type { ValidationIssue } from '@stack-atlas/schema';
import type { PartialGraph } from './types.js';
import { issue } from './util.js';

/** ID 接頭辞 → kind（docs/03 の ID 規約） */
export const KIND_OF_PREFIX: Record<string, string> = {
  actor: 'actor',
  infra: 'infra',
  route: 'page',
  layout: 'layout',
  comp: 'component',
  hook: 'hook',
  lib: 'lib',
  type: 'type',
  handler: 'handler',
  schema: 'schema',
  endpoint: 'endpoint',
  queue: 'queue',
  db: 'db',
  cron: 'cron',
  service: 'service',
};

/** `comp:Header` → `Header`。接頭辞が無ければ ID そのまま */
export function nameFromId(id: string): string {
  const i = id.indexOf(':');
  return i >= 0 && i < id.length - 1 ? id.slice(i + 1) : id;
}

export function kindFromId(id: string): string | undefined {
  const i = id.indexOf(':');
  return i > 0 ? KIND_OF_PREFIX[id.slice(0, i)] : undefined;
}

/** kind が無ければ ID 接頭辞から、name が無ければ ID の後半から補う。graph を書き換える */
export function completeNodes(graph: PartialGraph): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  graph.nodes.forEach((n, i) => {
    if (!n.kind) {
      const k = kindFromId(n.id);
      if (k) n.kind = k;
      else {
        n.kind = 'unknown';
        issues.push(
          issue(
            'warning',
            `/nodes/${i}/kind`,
            `ノード "${n.id}" に kind がなく、ID からも推定できません`,
          ),
        );
      }
    }
    if (!n.name) n.name = nameFromId(n.id);
  });
  return issues;
}
