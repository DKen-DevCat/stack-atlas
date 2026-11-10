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
export {
  projectMap,
  litOnMap,
  edgeKey,
  unitBase,
  stripRuntime,
  MAP_EDGE_PRIORITY,
  VIA_EDGE_KIND,
  PREFIX_KIND,
  V2_KIND_TO_V1,
  type MapProjection,
  type MapEdgeInfo,
  type MapEdgeKind,
  type MapLit,
  type ProjectMapOptions,
} from './project-map.js';
export {
  mapFlow,
  mapFlowAt,
  PULSE_MIN,
  type MapFlow,
  type MapBall,
  type MapPulse,
  type MapBallAt,
  type MapPulseAt,
} from './map-flow.js';
export {
  containmentOf,
  cleanContainment,
  DIR_MAX_SEGMENTS,
  type Container,
  type Containment,
} from './containment.js';
export { viewSelection, applyView, findView } from './views.js';
export {
  diffGraphsV2,
  isEmptyDiffV2,
  diffOverlayV2,
  type GraphDiffV2,
  type NodeChange,
  type WireRef,
  type WireChange,
  type DiffOverlayV2,
} from './diff.js';
export {
  schedule,
  drawnBalls,
  type Schedule,
  type ScheduleOptions,
  type Ball,
} from './schedule.js';
export {
  detectBroken,
  brokenOfWire,
  brokenEnds,
  type BrokenWire,
  type BrokenEnd,
} from './broken.js';
export {
  resolveRegionRef,
  resolveRegions,
  clipRegion,
  regionsOf,
  type RawRegion,
  type ScreenRegion,
  type RegionsOf,
} from './regions.js';
export {
  layoutWiring,
  routeBetween,
  innerRoute,
  routeLength,
  pointAt,
  segmentRoute,
  LANES,
  BROKEN_CUT,
  defaultWidthOf,
  screenArea,
  screenViewport,
  hasScreenHtml,
  DEFAULT_VIEWPORT,
  SCREEN_INSET,
  VIEWPORT_MAX,
  VIEWPORT_MIN,
  type LayoutOptions,
  type WiringLayout,
  type BoxLayout,
  type HostLayout,
  type LaneLayout,
  type LaneDef,
  type Channel,
  type ColumnLayout,
  type Pin,
  type Point,
  type Rect,
  type Route,
  type RoutePlan,
  type BrokenRoute,
} from './layout/index.js';
