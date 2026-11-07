// @stack-atlas/wiring — 配線図の規則（純 TS、DOM 無し。@stack-atlas/schema にだけ依存する。D44）
export {
  indexGraph,
  resolveRef,
  resolveLocal,
  isDescendantOf,
  ancestorsOf,
  type GraphIndex,
  type IndexedNode,
  type IndexedItem,
  type IndexedWire,
} from './graph-index.js';
export {
  defaultState,
  withVariants,
  variantKey,
  variantValue,
  resolveWhen,
  isActive,
  itemActive,
  type VariantState,
  type ResolvedWhen,
} from './variants.js';
export { linksOf, defaultLinks, wireActive, type ResolvedLink } from './links.js';
export {
  traverse,
  edgesAt,
  mapAcross,
  emptyLit,
  mergeLit,
  type Lit,
  type Segment,
  type TraverseOptions,
} from './traverse.js';
export { select, type Selection, type LitSelection } from './select.js';
export { schedule, type Schedule, type ScheduleOptions, type Ball } from './schedule.js';
export { detectBroken, brokenOfWire, type BrokenWire } from './broken.js';
