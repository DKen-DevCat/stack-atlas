import type { Graph } from '@stack-atlas/schema';
import { silentLogger } from '../logger.js';
import type { Logger } from '../types.js';
import { lambdaFsIsr } from './lambda-fs-isr.js';
import { twoTierStaleness } from './two-tier-staleness.js';
import type { Rule } from './types.js';

export type { Rule } from './types.js';
export { appendNote } from './util.js';
export {
  twoTierStaleness,
  routePath,
  concretePath,
  matchPathPattern,
  cdnSeconds,
  pickRule,
} from './two-tier-staleness.js';
export { lambdaFsIsr, LAMBDA_FS_ISR_NOTE } from './lambda-fs-isr.js';

/** 既定で走るルール（順番に適用） */
export const DEFAULT_RULES: Rule[] = [lambdaFsIsr, twoTierStaleness];

/** ルールを順に適用する（graph を書き換える）。ルールが例外を投げたら警告してスキップ */
export function runRules(
  graph: Graph,
  rules: Rule[] = DEFAULT_RULES,
  log: Logger = silentLogger,
): Graph {
  for (const rule of rules) {
    try {
      rule.apply(graph, log);
    } catch (e) {
      log.warn(`ルール ${rule.id} が失敗しました（スキップ）: ${(e as Error).message}`);
    }
  }
  return graph;
}
