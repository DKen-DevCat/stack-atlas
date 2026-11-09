/**
 * core の公開型。抽出器（extractors/*）と CLI はここに依存する。
 * 設計は docs/09-design-phase2-5.md §3.2・§3.3。
 *
 * ★ この契約は core と各抽出器を並行して実装するための合意点。
 *    変更するときは両方を同時に直すこと。
 */
import type {
  Edge,
  Flow,
  GraphNode,
  Layer,
  NamedType,
  NodeV2,
  Runtime,
  WireV2,
} from '@stack-atlas/schema';

/** 抽出器が出す部分ノード。id と kind と name 以外は省略可（マージで補完される） */
export type PartialNode = Pick<GraphNode, 'id'> &
  Partial<Omit<GraphNode, 'id'>> & {
    /** 省略時は config.layers / kind→layer の既定で割り当てる */
    layer?: string;
  };

/**
 * 言語アダプタ（8-2）が出す v2 の箱。runtime はアダプタが決められないとき省略してよい
 * （マージで upgrade の箱 → 置き換える v1 の箱 → browser の順に補う。docs/17 §7 #4）
 */
export type PartialNodeV2 = Omit<NodeV2, 'runtime'> & { runtime?: Runtime };

/**
 * 言語アダプタの v2 の部分グラフ（docs/17 §3.1）。v1 の nodes / edges と同じ出力に並べてよい。
 * - nodes: 関数の単位の箱（口・項目・links）。同じ id の upgrade の箱とは mergeV2 で合わせる（口・項目・links・runtime は
 *   アダプタが勝ち、host・cache・screen は upgrade の値を残す）
 * - wires: 同じ言語の中の線（呼び出し・戻り・render）。言語をまたぐ線（HTTP・SQL）は合流の段（join.ts）が引く
 * - types: 項目の typeRef の宛先（同じ id が upgrade にあればそちらを残す）
 * - groups: 関数の箱 id → 置き換える v1 の箱 id。アダプタが「この v1 の箱は自分の関数の箱で置き換わる」と明示するもの。
 *   無くても mergeV2 が file と meta.go.pkg の被覆で判定する（D53）。明示したものは被覆に関係なく group にする
 * - refs: 箱 id → その箱（の宣言）が参照する箱・v1 の箱の id（呼び出し・描画・呼び出しでない参照。型の参照も）。
 *   graph.json には出さない。掃除で、group になった v1 の箱に残った箱の単位の線を、実際に参照している中の関数の箱へ
 *   だけ付け替えるのに使う（2026-11-09 レビュー C6）
 */
export interface PartialGraphV2 {
  nodes: PartialNodeV2[];
  wires: WireV2[];
  types?: NamedType[];
  groups?: Record<string, string>;
  refs?: Record<string, string[]>;
}

/**
 * build の問題（issues.json の 1 行）。validateGraph の ValidationIssue に `info` を足したもの。
 * `info` は数字の報告（画面のカバー率・消毒で落としたものの数。8-3b）で、終了コードにも「問題: 警告 n 件」にも数えない
 */
export interface BuildIssue {
  level: 'error' | 'warning' | 'info';
  /** `/nodes/3/layer`・`extractor:<name>`・`screens:<route>` など */
  path: string;
  message: string;
}

/** 抽出器 1 つの出力。マージで統合される */
export interface PartialGraph {
  layers?: Layer[];
  nodes: PartialNode[];
  edges: Edge[];
  flows?: Flow[];
  /** 追加 kind の表示定義（graph.json の kinds に出る。config.kinds が優先） */
  kinds?: Record<string, KindDefinition>;
  /** 言語アダプタ（ts-types など）と openapi の v2 の部分グラフ（docs/17 §3.1） */
  v2?: PartialGraphV2;
  /**
   * issues.json に足す報告（パイプラインが抽出器ごとに集める。マージはしない）。抽出器はビルドを止めないので error は出さない
   */
  issues?: Array<BuildIssue & { level: 'warning' | 'info' }>;
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
  /** kind → layer.id の割り当て。既定: infra,actor,queue,db,cron,service→infra / page,layout→routes / component,hook,lib→components / type,handler,schema,endpoint→types */
  layerOf?: Record<string, string>;
  /**
   * 複数リポジトリ（docs/12 §3.2）。名前 → config のディレクトリからの相対パス。
   * 省略時は config のディレクトリ 1 つ（名前はディレクトリ名）。2 つ以上なら file は `<name>/<path>` になる
   */
  repos?: Record<string, string>;
  cdktf?: RepoScoped<{ out?: string; sourceDir?: string; stack?: string }>;
  /** 素の Terraform（HCL）。root は module 呼び出しを持つルートモジュール */
  terraform?: RepoScoped<{ root?: string; sourceDir?: string }>;
  /** AWS CDK / SAM / CloudFormation のテンプレート */
  cloudformation?: RepoScoped<{ templates?: string[] }>;
  /** IaC 共通: ノードにするリソース型の調整（glob） */
  infra?: { include?: string[]; exclude?: string[]; all?: boolean };
  next?: RepoScoped<{ appDir?: string; pagesDir?: string; tsconfig?: string }>;
  ts?: RepoScoped<{ tsconfig?: string[] }>;
  /** Go（toolchain 不要）。entries は入口パッケージの glob（既定 cmd/*） */
  go?: RepoScoped<{ module?: string; entries?: string[] }>;
  /** OpenAPI の契約。文字列はどの repo でも探す */
  openapi?: { files?: Array<string | { repo?: string; path: string }> };
  /** SQL マイグレーションからテーブル（schema:）を作る。db はテーブルを持つ DB ノード */
  sql?: RepoScoped<{ migrations?: string[]; db?: string }>;
  /** インフラノード → 載っているもの（docs/12 §3.1） */
  deploy?: Record<string, DeployTarget>;
  api?: RepoScoped<{
    /** 従来: client 1 ファイル */
    client?: string;
    /** client の glob */
    clients?: string[];
    /** 第 1 引数がパスのラッパー関数名。省略時は fetch(`${X}${arg}`) をする関数を自動検出 */
    callers?: string[];
    /** client の呼び先（infra ノード ID）。省略時: API Gateway → Function URL を持つ Lambda が 1 つなら自動 */
    targets?: string[];
  }>;
  /** ts-imports / go の分類を glob で上書き（上から順、最初に合ったもの） */
  classify?: ClassifyRule[];
  /** パーサの無いものを glob でノードにする */
  files?: FileRule[];
  /** 追加 kind の表示定義。graph.json にそのまま出る */
  kinds?: Record<string, KindDefinition>;
  screenshots?: RepoScoped<{
    baseUrl?: string;
    viewport?: { width: number; height: number };
    routes?: Record<string, string[]>;
    storageState?: string;
    outDir?: string;
    timeout?: number;
  }>;
  /**
   * ビルド成果物の画面（screens 抽出器。docs/18 §3.3）。route ごとに HTML を写して消毒し、`<出力先>/screens/` に置く。
   * `from: next-export` は next.config の distDir（既定 out）、`dir` は `dir` の HTML を読む。`dir` は repo 相対
   */
  screens?: RepoScoped<{
    from?: 'next-export' | 'dir';
    /** HTML のディレクトリ（repo 相対）。next-export では next.config のディレクトリの distDir（既定 out） */
    dir?: string;
    /** 動的ルートのサンプル（`{ "/items/[id]": ["sample-1"] }`。最初の 1 件の HTML を使う） */
    routes?: Record<string, string[]>;
    /** 描画と regions の座標系（既定 1280×800） */
    viewport?: { width: number; height: number };
    /** `/` で始まる参照の 2 つ目の探し先（repo 相対）。next-export の既定は next.config のディレクトリの public */
    publicDir?: string;
    /**
     * 書き出し先（graph.json のディレクトリ）。CLI の build が入れる。設定ファイルには書けない
     * （checkConfig が外す。解析対象の repo の設定で repo の外に書かせないため）
     */
    outDir?: string;
  }>;
  /** 抽出器の有効・無効（既定は detect() に従う） */
  extractors?: Record<string, boolean>;
  /**
   * 言語アダプタ（ts-types など。docs/17 §3.2）の上限。depth は型の展開の深さ（既定 2）、
   * maxItems は 1 箱の項目の数（既定 200）。超えたら警告して打ち切る
   */
  adapters?: { depth?: number; maxItems?: number };
}

/** 設定セクションに `repo` を付けると、その repo でだけ有効になる（core の sectionFor で判定） */
export type RepoScoped<T> = T & { repo?: string };

export interface DeployTarget {
  /** Next アプリ全体（route / layout）が載る。S3 でも Lambda でも可 */
  app?: 'next';
  /** TS のハンドラファイルの glob */
  handlers?: string | string[];
  /** Go の入口パッケージ（module 相対パス。例 cmd/api） */
  go?: string;
  /** 任意のノード ID を直接載せる */
  nodes?: string[];
}

export interface ClassifyRule {
  /** repo 相対パスの glob */
  glob: string;
  /** 合ったファイルの宣言に付ける kind。省略時は既定の分類 */
  kind?: string;
  /** 合ったノードの層 */
  layer?: string;
  /** 対象 repo（省略時は全部） */
  repo?: string;
}

export interface FileRule {
  glob: string;
  kind: string;
  /** `{basename}` `{dir}` `{path}` `{stem}` を置換。既定 `{stem}` */
  name?: string;
  /** ID の識別子。既定 `{path}` */
  id?: string;
  layer?: string;
  repo?: string;
}

export interface KindDefinition {
  /** 表示名（日本語） */
  name?: string;
  /** `#rrggbb` */
  color?: string;
  /** ボックスの大きさ [x, y, z] */
  size?: [number, number, number];
  /** 既定の層 */
  layer?: string;
}

export interface RepoContext {
  /** 解析対象リポジトリの絶対パス（単一 repo なら config のあるディレクトリ） */
  root: string;
  /** repos で付けた名前。単一 repo ならディレクトリ名 */
  repoName: string;
  /** すべての repo（名前 → 絶対パス） */
  repos: Record<string, string>;
  /** config のあるディレクトリ（絶対パス） */
  configDir: string;
  config: StackAtlasConfig;
  log: Logger;
  /** root からの相対パスを絶対パスにする */
  resolve(...segments: string[]): string;
}

export interface Extractor {
  /** "cdktf" など。meta.extractors に記録される */
  name: string;
  /**
   * v2 の部分グラフ（PartialGraph.v2）を出す抽出器の役割（docs/17 §2）。省略時は language。
   * - language: 言語アダプタ（ts-types・go-types）。関数の単位の箱と、同じ言語の中の線
   * - contract: 契約（openapi・sql）。合流点の箱（endpoint・table）と項目
   * build の要約と `project.generator.adapters` / `contracts` を分けるのに使う
   */
  v2Role?: 'language' | 'contract';
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

/** screens 抽出器の書き出し先（`<出力先>/screens/`）と、build が前回の分を消してよいことを示す印のファイル */
export const SCREENS_DIR = 'screens';
export const SCREENS_MARKER = '.stack-atlas-screens';

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
  endpoint: 'types',
  queue: 'infra',
  db: 'infra',
  cron: 'infra',
  service: 'infra',
};

/**
 * 設定セクションがこの ctx の repo に適用されるなら返す（docs/12 §3.2）。
 * `repo` が無いセクションはすべての repo に適用される。
 */
export function sectionFor<T extends { repo?: string }>(
  ctx: Pick<RepoContext, 'repoName'>,
  section: T | undefined,
): T | undefined {
  if (!section) return undefined;
  if (section.repo && section.repo !== ctx.repoName) return undefined;
  return section;
}
