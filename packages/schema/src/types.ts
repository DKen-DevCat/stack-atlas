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
}

export interface Screen {
  /** graph.json からの相対パス */
  screenshot?: string;
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

export interface Graph {
  $schema?: string;
  version: 1;
  project?: Project;
  layers: Layer[];
  nodes: GraphNode[];
  edges: Edge[];
  flows?: Flow[];
}
