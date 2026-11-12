/**
 * ライブ（docs/27）の、道具（見張り）と、ライブの画面の間の約束。
 * 出来事は、アプリ → 道具 → ライブの画面の一方向に流れる（D230）。道具は、通信の値を伏せた形にしてから渡す（D233）。
 * ここにあるのは形だけ。どれも、文字として出す前提の値（HTML として組みこまない）。
 *
 * 道具の側が守ること（操作への区切り（operations.ts）が、これを前提にする）:
 * - 出来事は、時刻（`at`）の順に渡す。枠の中からの知らせと、外から見た通信は、別の道で届くので、道具が短い間ためて、並べ直す
 * - 通信の id は、1 回の起動の中で重ならない
 * - 操作に区切るのは、ライブの画面の側だけ（道具の側では区切らない。同じ出来事の列でも、時間の進め方で、区切りが変わりうるため）。
 *   道具が通信を名指しするときは、通信の id を使う
 * - `value` と `raw`（伏せていない値）を付けるのは、道具だけ。アプリの枠からの知らせ（sanitize.ts）には、付かない
 */
import type { TriggerAction } from '@stack-atlas/schema';

export const LIVE_PROTOCOL = 1;

/** 画面の中の場所（アプリの枠の左上からの、見えている範囲の座標） */
export interface LiveRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 部品への操作の種類（挙動の始まりの操作から、「開く」を除いたもの） */
export type LiveAction = Exclude<TriggerAction, 'open'>;
export const LIVE_ACTIONS = [
  'click',
  'submit',
  'input',
  'change',
] as const satisfies readonly LiveAction[];

/** 値を伏せた、中身の形: キーの名前と、値の型だけ */
export type LiveShape =
  | { t: 'string' | 'number' | 'boolean' | 'null' }
  | { t: 'array'; length: number; item?: LiveShape }
  | { t: 'object'; keys: Array<[string, LiveShape]>; more?: number };

/**
 * 通信の中身。既定では、形だけ（D233）。`value` は、「値を見る」を入れているあいだだけ付く（上限つきの文字）
 * - tree: キーと値の形のもの
 * - form: フォームの形のもの（欄の名前）
 * - other: そのほか（種類と大きさだけ）
 */
export type MaskedBody =
  | { kind: 'tree'; shape: LiveShape; value?: string }
  | { kind: 'form'; keys: string[]; value?: string }
  | { kind: 'other'; type: string; bytes: number; value?: string };

/** アプリの画面が開いた（枠の移動を、道具の側から見たもの） */
export interface LiveOpenEvent {
  t: 'open';
  at: number;
  /** 開いたアドレスのパス（値に見える部分は伏せてある） */
  path: string;
  /** 図の、どの画面の箱か（道具が決められたとき） */
  screen?: string;
}

/** 部品への操作。parts は、出来事の起きた要素に当たる部品の id を、内側から順に並べたもの（D243） */
export interface LivePartEvent {
  t: 'part';
  at: number;
  how: LiveAction;
  parts: string[];
  rect?: LiveRect;
}

/** ブラウザから出た通信（アプリのスクリプトが出したものと、フォームの送信） */
export interface LiveRequestEvent {
  t: 'request';
  at: number;
  id: string;
  method: string;
  /** 見せるパス。図の通信の段と合ったときは図の書き方、合わないときは、値に見える部分を伏せた形 */
  path: string;
  /** 図の受け口と合ったときの、その受け口の書き方（`<メソッド> <パス>`）。図との照合は、これで比べる */
  route?: string;
  /** 問い合わせの文字列の、キーの名前 */
  query: string[];
  kind: 'script' | 'form';
  /** 手元ではない宛先か（つながらない。D231） */
  outside?: boolean;
  body?: MaskedBody;
  /** 「値を見る」のあいだだけ: 伏せていないパスと、問い合わせの文字列 */
  raw?: string;
}

export interface LiveResponseEvent {
  t: 'response';
  at: number;
  id: string;
  status: number;
  /** 返事を差し替える仕組みが、ブラウザの中で返事を作った */
  inBrowser: boolean;
  body?: MaskedBody;
}

/** 返事が無かった通信: held = 「止めて見る」が止めた、outside = 手元の外なので、つながらない、error = そのほかの失敗 */
export interface LiveFailedEvent {
  t: 'failed';
  at: number;
  id: string;
  why: 'held' | 'outside' | 'error';
}

/** 画面の変化の 1 つ。text は、見えている文字（長さに上限）。kind が text のときは、before が変わる前 */
export interface LiveChange {
  kind: 'added' | 'removed' | 'text';
  text: string;
  before?: string;
  rect?: LiveRect;
}

export interface LiveDomEvent {
  t: 'dom';
  at: number;
  changes: LiveChange[];
}

/**
 * 部品の場所（一覧から挙動を選んだとき、始まりの部品を囲むのに使う）。画面に無い部品は、入らない。
 * 部品の id と場所の組の列（id をキーにした入れ物にしない。アプリが選べる文字を、キーに使わないため）
 */
export interface LivePartsEvent {
  t: 'parts';
  at: number;
  rects: Array<[string, LiveRect]>;
}

export type LiveEvent =
  | LiveOpenEvent
  | LivePartEvent
  | LiveRequestEvent
  | LiveResponseEvent
  | LiveFailedEvent
  | LiveDomEvent
  | LivePartsEvent;

/** アプリの枠の中のスクリプトが、道具に知らせる出来事（アプリは、にせの知らせも送れる。道具は、形を確かめてから使う） */
export type LiveReport = LivePartEvent | LiveDomEvent | LivePartsEvent;

/** 道具が、ライブの画面に渡す、いまの状態 */
export interface LiveStatus {
  protocol: typeof LIVE_PROTOCOL;
  /** アプリの URL（左の枠に入れる。別の窓のときは、入れない） */
  app: string;
  /** アプリの置き方: frame = 左の枠、window = 別の窓（D235） */
  mode: 'frame' | 'window';
  /** 「値を見る」が入っているか */
  reveal: boolean;
  /** 「止めて見る」が入っているか。locked は、起動のときの引数で入れたので、画面から外せない（D242） */
  hold: boolean;
  holdLocked: boolean;
}
