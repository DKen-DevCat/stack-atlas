/**
 * `.stack-atlas/` に、利用者の手元のエージェントが書く図の形（docs/25 §3.1・§3.2、docs/26）。
 * 契約は v0。10-1 の試し（エージェントに書かせて正解表と比べる）のあとで固める。
 * 道具は、ここに書かれたものを確かめるだけで、対象のコードの意味は読まない（言語に依る処理を持たない。docs/24）
 */
import type { NamedType, NodeV2, WireV2 } from '@stack-atlas/schema';
import { HARNESS_DIR } from '../local-files.js';

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

/** 挙動の始まりの操作。ブラウザの出来事の名前で、対象の作り方に依らない */
export const TRIGGER_ACTIONS = ['open', 'click', 'submit', 'input', 'change'] as const;
export type TriggerAction = (typeof TRIGGER_ACTIONS)[number];

/** 線の名指し。線に id は無いので、両端の組で指す（graph/ にある線と同じ参照） */
export interface WireRef {
  from: string;
  to: string;
}

/** 挙動の 1 段: 送る線の列と、返る線の列。1 回の呼び出しが引数ごとに線に分かれるので、どちらも列 */
export interface BehaviorStep {
  send: WireRef[];
  back?: WireRef[];
  /** 任意の補足の文 */
  say?: string;
  /** この段が通るときの分岐。キーは `<箱 id>#<分岐 id>` */
  when?: Record<string, boolean>;
}

/** 同時に呼ぶ所: 並んだ列（列ごとに段の列） */
export interface BehaviorParallel {
  parallel: BehaviorStep[][];
}

export type BehaviorEntry = BehaviorStep | BehaviorParallel;

export interface BehaviorTrigger {
  action: TriggerAction;
  /** 画面の部品の id（parts.yaml）。action が open のときは書かない */
  part?: string;
}

/** 挙動: 「どの画面の、どの部品を、どうすると」「どの線を順に通って」「何が返り、画面がどう変わるか」 */
export interface Behavior {
  id: string;
  name: string;
  /** 画面の箱 id */
  screen: string;
  trigger: BehaviorTrigger;
  steps: BehaviorEntry[];
  result?: { say?: string; part?: string };
  /** この挙動が起こせるときの分岐（例: ログインしているとき）。キーは `<箱 id>#<分岐 id>` */
  when?: Record<string, boolean>;
}

/** 画面の部品: 画面の中の要素（セレクタ）を、図の箱に結ぶ */
export interface Part {
  id: string;
  name?: string;
  /** この部品を表す箱 id */
  box: string;
  /** この部品が出る画面の箱 id */
  screen: string;
  /** 画面の中で、この部品に当たる要素のセレクタ */
  selector: string;
}

export type AtlasCheckKind = 'form' | 'ref' | 'behavior';

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
  behaviors: Behavior[];
  parts: Part[];
  /** 読んだファイル（root からの相対） */
  files: string[];
  /** nodes[i]・wires[i]・types[i] を書いたファイル（指摘にファイル名を出すため） */
  nodeFiles: string[];
  wireFiles: string[];
  typeFiles: string[];
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
}
