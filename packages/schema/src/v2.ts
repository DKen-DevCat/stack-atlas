/**
 * graph.json v2（箱・口・項目・線）の TypeScript 型（手書き）。
 * 正は ../graph-v2.schema.json。ずれは v2.test.ts で検出する。契約は docs/16-graph-v2-contract.md。
 */

/** 箱の kind。語彙は固定（docs/16 §4） */
export const NODE_KINDS_V2 = [
  'screen',
  'component',
  'hook',
  'helper',
  'fn',
  'endpoint',
  'table',
  'cache',
  'trigger',
  'actor',
  'external',
  'infra',
  'queue',
] as const;

/** どこで動くか。固定の 8 値（D39） */
export const RUNTIMES = [
  'user',
  'time',
  'browser',
  'edge',
  'build',
  'server',
  'data',
  'external',
] as const;

/** 線の種類（見た目と I/O 境界の判定） */
export const WIRE_VIAS = [
  'props',
  'call',
  'return',
  'http',
  'sql',
  'event',
  'render',
  'deliver',
] as const;

/** 線の上の形（OpenAPI の語彙 ＋ unknown）。合流点の照合に使う */
export const WIRE_TYPES = [
  'string',
  'integer',
  'number',
  'boolean',
  'datetime',
  'bytes',
  'object',
  'array',
  'unknown',
] as const;

export const PORT_DIRS = ['in', 'out'] as const;
export const CONFIDENCES = ['exact', 'crude', 'unknown'] as const;
export const BROKEN_LEVELS = ['error', 'warn'] as const;
export const SCREEN_SOURCES = [
  'next-export',
  'next-build',
  'dir',
  'wireframe',
  'screenshot',
] as const;

export type NodeKindV2 = (typeof NODE_KINDS_V2)[number];
export type Runtime = (typeof RUNTIMES)[number];
export type WireVia = (typeof WIRE_VIAS)[number];
export type WireType = (typeof WIRE_TYPES)[number];
export type PortDir = (typeof PORT_DIRS)[number];
export type Confidence = (typeof CONFIDENCES)[number];
export type BrokenLevel = (typeof BROKEN_LEVELS)[number];
export type ScreenSource = (typeof SCREEN_SOURCES)[number];

/** `<kind接頭辞>:<識別子>`。識別子に `#` は使えない */
export type NodeIdV2 = string;
/** `<nodeId>#<portId>/<itemId>(.<itemId>)*` */
export type ItemRef = string;
/** `<portId>/<itemId>(.<itemId>)*`（箱の中の参照） */
export type LocalRef = string;
/** `type:<名前>` か `table:<名前>` */
export type TypeId = string;

/** 分岐の条件。キーは `<variantId>` か `<nodeId>#<variantId>`。複数キーは AND */
export type When = Record<string, boolean>;

export interface ProjectV2 {
  name?: string;
  description?: string;
  repo?: string;
  commit?: string;
  /** ISO 8601 date-time */
  generatedAt?: string;
  sources?: string[];
  [key: string]: unknown;
}

export interface NamedType {
  id: TypeId;
  name: string;
  file?: string;
  line?: number;
  /** 出どころ（openapi / typescript / go / sql など） */
  source?: string;
  /** copies（他言語の写しの場所）や usedBy など */
  meta?: Record<string, unknown>;
}

export interface Point {
  x: number;
  y: number;
}

export interface ItemV2 {
  id: string;
  /** 表示名（言語どおり） */
  name: string;
  /** 表示用の、言語どおりの型の文字列 */
  type: string;
  wireType?: WireType;
  nullable?: boolean;
  optional?: boolean;
  /** 所属する名前付き型（types[].id） */
  typeRef?: TypeId;
  children?: ItemV2[];
  when?: When;
  confidence?: Confidence;
  meta?: Record<string, unknown>;
}

export interface PortV2 {
  id: string;
  dir: PortDir;
  name?: string;
  items: ItemV2[];
}

export interface LinkV2 {
  /** dir in の口の項目 */
  from: LocalRef;
  /** dir out の口の項目 */
  to: LocalRef;
  when?: When;
  confidence?: Confidence;
}

export interface VariantV2 {
  id: string;
  name: string;
  /** 省略時 false */
  default?: boolean;
}

export interface CacheRuleV2 {
  key: string;
  value: string;
}

/** v1 の Cache と同じ */
export interface CacheV2 {
  tone: 'ok' | 'warn' | 'off' | 'info';
  badge: string;
  rules?: CacheRuleV2[];
  note?: string;
}

export interface RegionV2 {
  ref: NodeIdV2;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** docs/14 §3.3 の画面（ビルド成果物の HTML か、スクリーンショット） */
export interface ScreenV2 {
  html?: string;
  source?: ScreenSource;
  screenshot?: string;
  width: number;
  height: number;
  regions?: RegionV2[];
}

export interface NodeV2 {
  id: NodeIdV2;
  kind: NodeKindV2;
  name: string;
  runtime: Runtime;
  file?: string;
  line?: number;
  code?: string;
  /** この箱を動かしているインフラの箱（kind infra）の id */
  host?: NodeIdV2;
  /** 折りたたみの単位 */
  group?: string;
  ports: PortV2[];
  /** 省略時は既定（全 in → 全 out。table は key → read、endpoint は恒等） */
  links?: LinkV2[];
  variants?: VariantV2[];
  cache?: CacheV2;
  screen?: ScreenV2;
  /** 配線図の位置（build 時に埋める任意フィールド） */
  position?: Point;
  meta?: Record<string, unknown>;
}

export interface BrokenV2 {
  /** from の項目からの相対パス。from そのものなら空文字 */
  path: string;
  level: BrokenLevel;
  reason: string;
}

export interface WireV2 {
  /** dir out の口の項目 */
  from: ItemRef;
  /** dir in の口の項目 */
  to: ItemRef;
  via: WireVia;
  /** 往復の戻り側 */
  reply?: boolean;
  when?: When;
  broken?: BrokenV2[];
  label?: string;
  /** 配線図の経路（build 時に埋める任意フィールド） */
  route?: Point[];
  meta?: Record<string, unknown>;
}

/** views[].start: 箱 id、項目の参照、または線 */
export type ViewStart = NodeIdV2 | ItemRef | { from: ItemRef; to: ItemRef };

export interface ViewV2 {
  id: string;
  name: string;
  description?: string;
  start: ViewStart;
  /** 分岐の組み合わせ。キーは `<nodeId>#<variantId>` */
  variants?: Record<string, boolean>;
}

export interface GraphV2 {
  $schema?: string;
  version: 2;
  project?: ProjectV2;
  types?: NamedType[];
  nodes: NodeV2[];
  wires: WireV2[];
  views?: ViewV2[];
}

/** 参照 `<nodeId>#<portId>/<a>.<b>` を切る。最初の `#` で箱、次の `/` で口、残りを `.` で項目（D36） */
export function parseItemRef(
  ref: string,
): { nodeId: string; portId: string; path: string[] } | null {
  const hash = ref.indexOf('#');
  if (hash < 0) return null;
  const nodeId = ref.slice(0, hash);
  const rest = ref.slice(hash + 1);
  const slash = rest.indexOf('/');
  if (slash < 0) return null;
  const portId = rest.slice(0, slash);
  const pathStr = rest.slice(slash + 1);
  if (!nodeId || !portId || !pathStr) return null;
  return { nodeId, portId, path: pathStr.split('.') };
}

/** 箱の中の参照 `<portId>/<a>.<b>` を切る */
export function parseLocalRef(ref: string): { portId: string; path: string[] } | null {
  const slash = ref.indexOf('/');
  if (slash < 0) return null;
  const portId = ref.slice(0, slash);
  const pathStr = ref.slice(slash + 1);
  if (!portId || !pathStr) return null;
  return { portId, path: pathStr.split('.') };
}

/** `when` のキー `<nodeId>#<variantId>` / `<variantId>` を切る */
export function parseWhenKey(key: string): { nodeId?: string; variantId: string } {
  const hash = key.lastIndexOf('#');
  if (hash < 0) return { variantId: key };
  return { nodeId: key.slice(0, hash), variantId: key.slice(hash + 1) };
}

/**
 * wireType の互換（包含）。送る側 a を受ける側 b が受け取れるか。
 * integer ⊂ number、datetime ⊂ string。unknown はどちら側でも照合しない（docs/15 §3.3）
 */
export function wireTypeCompatible(a: WireType, b: WireType): boolean {
  if (a === b || a === 'unknown' || b === 'unknown') return true;
  if (a === 'integer' && b === 'number') return true;
  if (a === 'datetime' && b === 'string') return true;
  return false;
}

/** wireType の照合の結果。ok = 切れない、warn = 黄（送る側が広い）、error = 赤 */
export type WireTypeMatch = 'ok' | 'warn' | 'error';

/**
 * 合流点の wireType の照合（D46）。包含（wireTypeCompatible）に加えて:
 * - number → integer は warn（送る側が広い。TS の number を OpenAPI の integer に送るなど）
 * - string → datetime は via が sql のときだけ ok（DB が変換する）。それ以外は error
 */
export function wireTypeMatch(a: WireType, b: WireType, via?: string): WireTypeMatch {
  if (wireTypeCompatible(a, b)) return 'ok';
  if (a === 'number' && b === 'integer') return 'warn';
  if (a === 'string' && b === 'datetime' && via === 'sql') return 'ok';
  return 'error';
}
