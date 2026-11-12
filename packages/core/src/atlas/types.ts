/**
 * `.stack-atlas/` に、利用者の手元のエージェントが書く図の形（docs/25 §3.1・§3.2、docs/26）。
 * 契約は v0。10-1 の試し（エージェントに書かせて正解表と比べる）のあとで固める。
 * 道具は、ここに書かれたものを確かめるだけで、対象のコードの意味は読まない（言語に依る処理を持たない。docs/24）
 */
import type { BehaviorV2, NamedType, NodeV2, PartV2, WireV2 } from '@stack-atlas/schema';
import { HARNESS_DIR } from '../local-files.js';
import type { EvidenceSummary, UnreadRepo } from './evidence.js';

/** 図の置き場（対象の repo の中か、複数の repo を束ねるディレクトリの下。docs/25 Q37） */
export const ATLAS_DIR = HARNESS_DIR;
/** 箱と線を書くファイルの置き場（`graph/*.yaml`。古い読みこみが読む `*.v2.yaml` は読まない） */
export const ATLAS_GRAPH_DIR = 'graph';
export const ATLAS_BEHAVIORS_FILE = 'behaviors.yaml';
export const ATLAS_PARTS_FILE = 'parts.yaml';
/** 図の置き場（`.stack-atlas/` の親）からの相対パス。指摘の `file` に出す名前は、ここだけで作る */
export const ATLAS_PATHS = {
  graph: `${ATLAS_DIR}/${ATLAS_GRAPH_DIR}`,
  parts: `${ATLAS_DIR}/${ATLAS_PARTS_FILE}`,
  behaviors: `${ATLAS_DIR}/${ATLAS_BEHAVIORS_FILE}`,
} as const;

/** 読む量の上限（エージェントが書くファイルなので、大きさを信用しない） */
export const ATLAS_LIMITS = {
  graphFiles: 64,
  bytes: 1024 * 1024,
  nodes: 2000,
  wires: 5000,
  behaviors: 500,
  parts: 2000,
  /** 1 つの挙動の段の数（並んだ列の中の段も数える） */
  steps: 64,
} as const;

// 挙動と部品の形は、graph.json の契約（@stack-atlas/schema）にある。ここでは、短い名前で使う
export { TRIGGER_ACTIONS } from '@stack-atlas/schema';
export type {
  TriggerAction,
  WireRef,
  BehaviorStepV2 as BehaviorStep,
  BehaviorParallelV2 as BehaviorParallel,
  BehaviorEntryV2 as BehaviorEntry,
  BehaviorV2 as Behavior,
  PartV2 as Part,
} from '@stack-atlas/schema';

/** form（形）・ref（参照）・behavior（挙動）・evidence（根拠）・unread（未読の申告。docs/28） */
export type AtlasCheckKind = 'form' | 'ref' | 'behavior' | 'evidence' | 'unread';

export interface AtlasIssue {
  level: 'error' | 'warning';
  /** どの検査か: form（形）・ref（参照）・behavior（挙動） */
  check: AtlasCheckKind;
  /** 図の置き場からの相対パス（どのファイルの話か） */
  file: string;
  /** ファイルの中の場所（分かるとき） */
  path?: string;
  message: string;
}

/** ファイルが、あって読めた・無い・あるが読めない（読めない理由は指摘に出す） */
export type AtlasFileStatus = 'ok' | 'missing' | 'unreadable';

/** 読みこんだ図。どの要素も、形の検査（契約のスキーマ）を通ったものだけ。参照は、まだ確かめていない */
export interface LoadedAtlas {
  /** 図の置き場（`.stack-atlas/` の親） */
  root: string;
  nodes: NodeV2[];
  wires: WireV2[];
  types: NamedType[];
  behaviors: BehaviorV2[];
  parts: PartV2[];
  /** 読んだファイル（root からの相対） */
  files: string[];
  /** nodes[i]・wires[i]・types[i] を書いたファイル（指摘にファイル名を出すため） */
  nodeFiles: string[];
  wireFiles: string[];
  typeFiles: string[];
  /** parts[i]・behaviors[i] が、ファイルの中で何番めか（0 から。形の違う要素を捨てると、並びの番号とずれるため） */
  partAt: number[];
  behaviorAt: number[];
  status: { parts: AtlasFileStatus; behaviors: AtlasFileStatus };
}

export interface AtlasReport {
  root: string;
  files: string[];
  counts: {
    nodes: number;
    wires: number;
    behaviors: number;
    parts: number;
    errors: number;
    warnings: number;
  };
  issues: AtlasIssue[];
  /** atlas.yaml で宣言した repo の、解いた場所（人が、思っていない場所を指していないか気づけるように出す） */
  repos?: Array<{ name?: string; dir: string }>;
  /** 根拠の数（check だけが見る。docs/28 D260・D261） */
  evidence?: EvidenceSummary;
  /** 未読の要約（知らせ。関門にしない。D204・D264） */
  unread?: UnreadRepo[];
}
