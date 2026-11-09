export * from './types.js';
export * from './meta.js';
export * from './logger.js';
export {
  loadConfig,
  loadConfigFile,
  checkConfig,
  createRepoContext,
  findConfigFile,
  readYamlFile,
  AtlasConfigError,
  CONFIG_FILES,
  type LoadedConfig,
} from './config.js';
export {
  isMultiRepo,
  repoFile,
  splitRepoFile,
  fileInRepo,
  prefixRepoFiles,
  resolveRepos,
} from './repo.js';
export {
  applyClassify,
  classifyKind,
  findClassifyRule,
  matchGlob,
  repoOfNames,
  type RepoOf,
} from './classify.js';
export { mergePartialGraphs, mergeNodes, edgeKey } from './merge.js';
export { assignLayers, resolveLayers, resolveLayerOf, type AssignLayersResult } from './layers.js';
export { completeNodes, nameFromId, kindFromId, KIND_OF_PREFIX } from './nodes.js';
export { applyDeployConfig } from './deploy.js';
export {
  loadOverrides,
  checkOverrides,
  applyOverrides,
  OVERRIDES_FILE,
  OVERRIDES_SOURCE,
  type ApplyOverridesResult,
} from './overrides.js';
export {
  loadFlows,
  loadFlowDefinitions,
  normalizeFlows,
  FLOWS_FILES,
  type NormalizeFlowsResult,
} from './flows.js';
export * from './rules/index.js';
export {
  loadMemos,
  saveMemos,
  serializeMemos,
  orphanMemos,
  isMemos,
  memosFile,
  MEMOS_PATH,
  type Memos,
} from './memos.js';
export {
  diffGraphs,
  isEmptyDiff,
  diffGraphsV2,
  isEmptyDiffV2,
  type GraphDiff,
  type GraphDiffV2,
  type NodeChange,
  type WireRef,
  type WireChange,
} from './diff.js';
export { gitCommit, gitRemote } from './git.js';
// data-component の名前 → 箱 id（screenshots・screens 抽出器とビューアが同じ規則を使う。正本は wiring。docs/18 §3.3）
export { resolveRegionRef } from '@stack-atlas/wiring';
export {
  apiPathMatches,
  isRoutePathTooLong,
  MAX_ROUTE_PATH,
  methodMatches,
  normalizeRoutePath,
  rewriteRoutePath,
  pathMatches,
  pickMostSpecific,
  routeSpecificity,
  type RouteLike,
} from './paths.js';
export {
  deepMerge,
  globToRegExp,
  globBase,
  toArray,
  toPosix,
  type DeepMergeOptions,
} from './util.js';
export * from './next-routes.js';
export {
  buildGraph,
  type BuildGraphOptions,
  type BuildGraphResult,
  type ExtractorReport,
  type ExtractorStatus,
  type RepoExtractorReport,
  type V2AdapterReport,
} from './pipeline.js';
export {
  mergeV2,
  cleanupV2,
  coverageV2,
  removeOverrideWiresV2,
  type MergeV2Options,
  type MergedV2,
  type CleanupV2Options,
  type CleanupV2Result,
  type CoverageV2,
} from './merge-v2.js';
export {
  mergePartialV2,
  disambiguateV2,
  type RenamedBoxV2,
  mergeItemLists,
  mergePortLists,
  mergeLinkLists,
  mergePartialNodeV2,
  mergeVariants,
  mergeNamedTypes,
  pickNamedType,
  itemId,
  walkItems,
  itemAt,
  underscoreItem,
  boxOf,
  isUnderscoreRef,
  wireKey,
  UNDERSCORE,
} from './v2-parts.js';
export {
  joinAll,
  joinEndpoints,
  joinHandlers,
  joinTables,
  endpointRoute,
  handlerRoutes,
  httpCallOf,
  sqlOf,
  usesTable,
  HTTP_ROLES,
  LOGIN_VARIANT,
  MAX_JOIN_MATCHES,
  type HttpCall,
  type HttpRole,
  type JoinOptions,
  type JoinReport,
  type JoinResult,
} from './join.js';
export { writeBroken, isJoinWire, type WriteBrokenOptions } from './broken-v2.js';
export {
  upgradeGraph,
  infraProfileOf,
  infraType,
  V2_KIND_OF_V1,
  RUNTIME_OF_V1,
  UNKNOWN_KIND_BY_LAYER,
  INFRA_PROFILES,
  CACHE_PORTS,
  CACHE_LINKS,
  CACHE_VARIANTS,
  type UpgradeOptions,
  type InfraProfile,
} from './upgrade.js';
// ハーネス（Phase 8-4。docs/19）: 補い（overrides の v2:）・手書きの部分グラフ・views.yaml・報告と strict・安全な読み書き
export {
  applySupplementsA,
  applySupplementsB,
  finishRetarget,
  materializeDefaultLinks,
  countSupplements,
  supplementText,
  MAX_SUPPLEMENT_CHILDREN,
  type SupplementKind,
  type SupplementResult,
  type SupplementStatus,
  type StageAOptions,
  type StageAResult,
} from './supplements.js';
export {
  loadHandGraphs,
  HAND_ADAPTER,
  HAND_DIR,
  HAND_LIMITS,
  type HandGraphResult,
} from './hand-graph.js';
export { applyViewsYaml, VIEWS_FILES, VIEWS_LIMITS, type ViewsYamlResult } from './views-yaml.js';
export {
  computeHarnessReport,
  strictIssues,
  toGraphReport,
  REPORT_LIST_MAX,
  type CheckedEntry,
  type HarnessInput,
  type HarnessReport,
  type ScreenRouteReport,
  type StrictIssue,
  type StrictResult,
  type UnjoinedCall,
} from './strict.js';
export { type UndeterminedWire } from './merge-v2.js';
export { SUPPLEMENT_KEYS } from './overrides.js';
export {
  confineDir,
  within,
  findSiteFile,
  readNoFollow,
  readNoFollowResult,
  SafeOutput,
  type FindResult,
  type ReadResult,
} from './fsafe.js';
export {
  HARNESS_DIR,
  MAX_YAML_ALIASES,
  readLocalFile,
  listLocalDir,
  parseLocalYaml,
  whyText,
  type LocalReadResult,
} from './local-files.js';
export { clipRegion } from '@stack-atlas/wiring';
