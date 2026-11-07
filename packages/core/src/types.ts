/**
 * core の公開型。抽出器（extractors/*）と CLI はここに依存する。
 * 設計は docs/09-design-phase2-5.md §3.2・§3.3。
 *
 * ★ この契約は core と各抽出器を並行して実装するための合意点。
 *    変更するときは両方を同時に直すこと。
 */
import type { Edge, Flow, GraphNode, Layer } from '@stack-atlas/schema';

/** 抽出器が出す部分ノード。id と kind と name 以外は省略可（マージで補完される） */
export type PartialNode = Pick<GraphNode, 'id'> &
  Partial<Omit<GraphNode, 'id'>> & {
    /** 省略時は config.layers / kind→layer の既定で割り当てる */
    layer?: string;
  };

/** 抽出器 1 つの出力。マージで統合される */
export interface PartialGraph {
  layers?: Layer[];
  nodes: PartialNode[];
  edges: Edge[];
  flows?: Flow[];
}

export interface Logger {
  debug(msg: string): void;
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

/** stack-atlas.config.yaml（docs/09 §3.3）。すべて省略可。パスは config のあるディレクトリ基準 */
export interface StackAtlasConfig {
  project?: { name?: string; description?: string; repo?: string };
  /** 省略時は既定の 4 層（infra / routes / components / types） */
  layers?: Layer[];
  /** kind → layer.id の割り当て。既定: infra,actor→infra / page,layout→routes / component,hook,lib→components / type,handler,schema→types */
  layerOf?: Record<string, string>;
  cdktf?: { out?: string; sourceDir?: string; stack?: string };
  next?: { appDir?: string; tsconfig?: string };
  ts?: { tsconfig?: string[] };
  /** Lambda などのインフラノード → 載っているもの */
  deploy?: Record<string, { app?: 'next'; handlers?: string | string[] }>;
  api?: { client?: string };
  screenshots?: {
    baseUrl?: string;
    viewport?: { width: number; height: number };
    routes?: Record<string, string[]>;
    storageState?: string;
    outDir?: string;
  };
  /** 抽出器の有効・無効（既定は detect() に従う） */
  extractors?: Record<string, boolean>;
}

export interface RepoContext {
  /** 解析対象リポジトリの絶対パス（config のあるディレクトリ） */
  root: string;
  config: StackAtlasConfig;
  log: Logger;
  /** root からの相対パスを絶対パスにする */
  resolve(...segments: string[]): string;
}

export interface Extractor {
  /** "cdktf" など。meta.extractors に記録される */
  name: string;
  detect(ctx: RepoContext): Promise<boolean>;
  /**
   * @param upstream 先行する抽出器の結果をマージしたもの（読み取り専用）。
   *   例: api-link は cdktf と nextjs-app のノードを参照する
   */
  extract(ctx: RepoContext, upstream: Readonly<PartialGraph>): Promise<PartialGraph>;
}

/** stack-atlas.overrides.yaml */
export interface Overrides {
  nodes?: PartialNode[];
  edges?: Edge[];
  /** 削除するノード ID、または {from,to,kind} のエッジ */
  remove?: Array<string | Edge>;
  /** インフラノード ID → 載っているノード ID の配列（deploy エッジを張る） */
  deploy?: Record<string, string[]>;
}

/** flows.yaml の 1 要素。steps は [node, text] か {node, text} */
export interface FlowDefinition {
  id: string;
  name: string;
  tone?: Flow['tone'];
  steps: Array<[string, string] | { node: string; text: string }>;
}

/** 既定の層 */
export const DEFAULT_LAYERS: Layer[] = [
  { id: 'infra', name: 'インフラ', color: '#ff9f43' },
  { id: 'routes', name: '画面・ルート', color: '#4f8cff' },
  { id: 'components', name: 'コンポーネント・hooks', color: '#a78bfa' },
  { id: 'types', name: '型・APIハンドラ', color: '#4ade80' },
];

/** 既定の kind → layer */
export const DEFAULT_LAYER_OF: Record<string, string> = {
  actor: 'infra',
  infra: 'infra',
  page: 'routes',
  layout: 'routes',
  component: 'components',
  hook: 'components',
  lib: 'components',
  type: 'types',
  handler: 'types',
  schema: 'types',
};
