/**
 * @stack-atlas/tf-graph: IaC 共通の解析（docs/12 §3.3）。
 * Terraform JSON（cdk.tf.json の形）→ infra ノード・flow エッジ・cache・API Gateway のルート・Function URL。
 */
export * from './types.js';
export {
  DEFAULT_NODE_TYPES,
  PLUMBING_TYPES,
  HOP_TYPES,
  globToRegExp,
  matchesAny,
  isPlumbing,
  makeNodeTypeFilter,
} from './allowlist.js';
export {
  collectRefs,
  collectTokens,
  interpolations,
  isPureInterpolation,
  isObject,
  REF_RE,
  TOKEN_RE,
} from './refs.js';
export { buildInfraGraph, listResources, defaultIdOf, compactJson } from './graph.js';
export { MANAGED_CACHE_POLICIES } from './cache.js';
export { humanName } from './names.js';
export { normalizeHclJson } from './hcl.js';
