/**
 * flows.yaml（データフロー定義、docs/09 §3.2）。
 * トップレベルは FlowDefinition の配列（`{ flows: [...] }` も受け付ける）。
 * steps は `[node, text]` か `{node, text}`。人が書くものなので、存在しないノード ID はエラーにする
 * （そのステップは捨てる。ステップが 1 つも残らないフローは捨てる）。
 */
import type { Flow, FlowStep, ValidationIssue } from '@stack-atlas/schema';
import { FLOW_TONES } from '@stack-atlas/schema';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { AtlasConfigError, readYamlFile } from './config.js';
import type { FlowDefinition, RepoContext } from './types.js';
import { isPlainObject, issue } from './util.js';

export const FLOWS_FILES = ['flows.yaml', 'flows.yml'] as const;

/** flows.yaml を読んで FlowDefinition[] にする（中身の検証は normalizeFlows）。無ければ [] */
export function loadFlowDefinitions(ctx: RepoContext): { file?: string; defs: unknown[] } {
  const file = FLOWS_FILES.map((f) => join(ctx.root, f)).find((p) => existsSync(p));
  if (!file) return { defs: [] };
  const raw = readYamlFile(file);
  if (raw === null || raw === undefined) return { file, defs: [] };
  if (Array.isArray(raw)) return { file, defs: raw };
  if (isPlainObject(raw) && Array.isArray(raw.flows)) return { file, defs: raw.flows };
  throw new AtlasConfigError(`${file} はフロー定義の配列にしてください`);
}

export interface NormalizeFlowsResult {
  flows: Flow[];
  issues: ValidationIssue[];
}

/**
 * FlowDefinition（steps がタプルでもよい）を Flow に正規化し、ノード ID を検査する。
 * @param nodeIds グラフに存在するノード ID。省略すると参照検査をしない
 */
export function normalizeFlows(
  defs: unknown[],
  nodeIds?: ReadonlySet<string>,
  file = 'flows.yaml',
): NormalizeFlowsResult {
  const issues: ValidationIssue[] = [];
  const err = (path: string, m: string) => issues.push(issue('error', `${file}#${path}`, m));
  const flows: Flow[] = [];
  const seen = new Set<string>();

  defs.forEach((d, i) => {
    if (!isPlainObject(d) || typeof d.id !== 'string' || !d.id) {
      err(`/${i}`, `${i} 番目のフローに id がありません`);
      return;
    }
    const def = d as unknown as FlowDefinition;
    if (seen.has(def.id)) {
      err(`/${i}/id`, `フロー ID "${def.id}" が重複しています`);
      return;
    }
    seen.add(def.id);
    if (!Array.isArray(def.steps)) {
      err(`/${i}/steps`, `フロー "${def.id}" に steps（配列）がありません`);
      return;
    }
    const steps: FlowStep[] = [];
    def.steps.forEach((s: unknown, j) => {
      let step: FlowStep | undefined;
      if (Array.isArray(s) && typeof s[0] === 'string')
        step = { node: s[0], text: String(s[1] ?? '') };
      else if (isPlainObject(s) && typeof s.node === 'string')
        step = { node: s.node, text: String(s.text ?? '') };
      if (!step) {
        err(
          `/${i}/steps/${j}`,
          `フロー "${def.id}" の ${j} 番目のステップは [node, text] か {node, text} にしてください`,
        );
        return;
      }
      if (nodeIds && !nodeIds.has(step.node)) {
        err(
          `/${i}/steps/${j}`,
          `フロー "${def.id}" の ${j} 番目のステップが参照するノード "${step.node}" がありません`,
        );
        return;
      }
      steps.push(step);
    });
    if (steps.length === 0) {
      err(`/${i}/steps`, `フロー "${def.id}" に有効なステップがありません（捨てます）`);
      return;
    }
    const flow: Flow = {
      id: def.id,
      name: typeof def.name === 'string' ? def.name : def.id,
      steps,
    };
    if (def.tone !== undefined) {
      if ((FLOW_TONES as readonly string[]).includes(def.tone)) flow.tone = def.tone;
      else
        issues.push(
          issue(
            'warning',
            `${file}#/${i}/tone`,
            `フロー "${def.id}" の tone "${String(def.tone)}" は未知です（無視します）`,
          ),
        );
    }
    flows.push(flow);
  });

  return { flows, issues };
}

/** flows.yaml を読み、graph のノード ID で検査した Flow[] を返す */
export function loadFlows(ctx: RepoContext, nodeIds?: ReadonlySet<string>): NormalizeFlowsResult {
  const { defs } = loadFlowDefinitions(ctx);
  return normalizeFlows(defs, nodeIds);
}
