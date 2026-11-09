/**
 * graph.json の TypeScript 型（手書き）。
 * 正は ../graph.schema.json。ずれは types.test.ts で検出する（docs/08 D6）。
 */

/** 既知のノード kind。schema の node.kind の enum と一致させる */
export const KNOWN_NODE_KINDS = [
  'actor',
  'infra',
  'layout',
  'page',
  'component',
  'hook',
  'lib',
  'type',
  'schema',
  'handler',
  'endpoint',
  'queue',
  'db',
  'cron',
  'service',
] as const;

/** 既知のエッジ kind。schema の edge.kind の enum と一致させる */
export const KNOWN_EDGE_KINDS = ['flow', 'deploy', 'uses', 'http', 'schema'] as const;

export const CACHE_TONES = ['ok', 'warn', 'off', 'info'] as const;
export const FLOW_TONES = ['default', 'cache-hit'] as const;

export type KnownNodeKind = (typeof KNOWN_NODE_KINDS)[number];
export type KnownEdgeKind = (typeof KNOWN_EDGE_KINDS)[number];

/** 未知の kind も許す（前方互換）。`string & {}` で既知 kind の補完を残す */
export type NodeKind = KnownNodeKind | (string & {});
export type EdgeKind = KnownEdgeKind | (string & {});

export type CacheTone = (typeof CACHE_TONES)[number];
export type FlowTone = (typeof FLOW_TONES)[number];

/** `<kind接頭辞>:<識別子>` */
export type NodeId = string;

export interface Project {
  name?: string;
  description?: string;
  /** リポジトリURLやパス */
  repo?: string;
  /** 抽出時のコミットSHA */
  commit?: string;
  /** ISO 8601 date-time */
  generatedAt?: string;
  sources?: string[];
  [key: string]: unknown;
}

export interface Layer {
  id: string;
  name: string;
  /** この層の出どころ（表示用） */
  source?: string;
  /** `#rrggbb` */
  color?: string;
}

export interface Position {
  x: number;
  z: number;
}

export interface CacheRule {
  key: string;
  value: string;
}

export interface Cache {
  tone: CacheTone;
  badge: string;
  rules?: CacheRule[];
  note?: string;
}

export interface Region {
  /** この領域を描画しているノード */
  ref: NodeId;
  x: number;
  y: number;
  w: number;
  h: number;
  /** 出どころ。省略時は screenshot。yaml は regions.yaml で補った値（docs/19 §3.7） */
  source?: RegionSource;
}

/** 領域の出どころ（v1・v2 で同じ。schema の regions[].source の enum と一致させる） */
export const REGION_SOURCES = ['screenshot', 'yaml'] as const;
export type RegionSource = (typeof REGION_SOURCES)[number];

/** screen.html の出どころ。v2 の ScreenSource と同じ語彙（schema の screen.source の enum と一致させる） */
export const SCREEN_SOURCES_V1 = [
  'next-export',
  'next-build',
  'dir',
  'wireframe',
  'screenshot',
] as const;
export type ScreenSourceV1 = (typeof SCREEN_SOURCES_V1)[number];

export interface Screen {
  /**
   * graph.json からの相対パス。消毒したビルド成果物の HTML（script 無し。screens 抽出器。docs/18 §3.3）。
   * screenshot と両方あれば html を優先して描く
   */
  html?: string;
  /** html の出どころ */
  source?: ScreenSourceV1;
  /** graph.json からの相対パス */
  screenshot?: string;
  /** regions の座標系の幅（スクショの px 幅。html のときはビューポート） */
  width: number;
  height: number;
  regions?: Region[];
}

export interface GraphNode {
  id: NodeId;
  /** layers[].id */
  layer: string;
  kind: NodeKind;
  name: string;
  file?: string;
  line?: number;
  code?: string;
  position?: Position;
  cache?: Cache;
  screen?: Screen;
  meta?: Record<string, unknown>;
}

/** GraphNode の別名（docs/08 の表記に合わせたもの。DOM の Node と紛らわしいので GraphNode 推奨） */
export type Node = GraphNode;

export interface Edge {
  from: NodeId;
  to: NodeId;
  kind: EdgeKind;
  label?: string;
}

export interface FlowStep {
  node: NodeId;
  text: string;
}

export interface Flow {
  id: string;
  name: string;
  tone?: FlowTone;
  steps: FlowStep[];
}

/** graph.kinds の 1 要素（kind の表示定義） */
export interface KindDefinition {
  /** 表示名（日本語） */
  name?: string;
  /** `#rrggbb` */
  color?: string;
  /** ボックスの大きさ [x, y, z] */
  size?: [number, number, number];
  /** この kind の既定の層（layers[].id） */
  layer?: string;
}

export interface Graph {
  $schema?: string;
  version: 1;
  project?: Project;
  layers: Layer[];
  nodes: GraphNode[];
  edges: Edge[];
  flows?: Flow[];
  /** kind → 表示定義（任意。ビューアの既定に上書き・追加） */
  kinds?: Record<string, KindDefinition>;
}
