// 配線図のレイアウトの公開の型（docs/15 §3.6、docs/18 §3.1）。結果は Map を除けば JSON にできる
import type { Runtime } from '@stack-atlas/schema';
import type { IndexedNode } from '../graph-index.js';

export interface Point {
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** レーン（runtime）の定義。左から利用者に近い順 */
export interface LaneDef {
  id: string;
  name: string;
  runtimes: Runtime[];
}

export const LANES: readonly LaneDef[] = [
  { id: 'user', name: '利用者・時刻', runtimes: ['user', 'time'] },
  { id: 'browser', name: 'ブラウザ', runtimes: ['browser'] },
  { id: 'edge', name: 'エッジ・配信', runtimes: ['edge'] },
  { id: 'build', name: 'ビルド', runtimes: ['build'] },
  { id: 'server', name: 'サーバー', runtimes: ['server'] },
  { id: 'data', name: 'データ', runtimes: ['data'] },
  { id: 'external', name: '外部', runtimes: ['external'] },
];

/** 通り道（列の間の縦の帯）。index i は列 i の左、最後はいちばん右の列の右 */
export interface Channel {
  x: number;
  w: number;
  /** 中央の x（レーンの境目なら背景の境目） */
  mid: number;
}

/** 列（docs/18 §3.1 の 4。レーンを呼び出しの深さの境目で割ったもの） */
export interface ColumnLayout {
  index: number;
  /** 属するレーン（LaneLayout.index） */
  lane: number;
  x: number;
  /** 列の中でいちばん幅の広い箱の幅 */
  w: number;
}

export interface LaneLayout {
  id: string;
  name: string;
  /** 箱がある レーンだけを左から数えた番号 */
  index: number;
  /** レーンの列の全体（最初の列の左端から最後の列の右端まで） */
  x: number;
  w: number;
  /** 背景の帯の左右（隣の通り道の中央まで） */
  x0: number;
  x1: number;
  /** レーンの列（ColumnLayout.index）。左から */
  columns: number[];
}

export interface Pin extends Point {
  /** in は箱の左辺、out は右辺 */
  side: 'in' | 'out';
}

export interface BoxLayout extends Rect {
  id: string;
  lane: number;
  /** 列（ColumnLayout.index） */
  col: number;
  /** 左辺（in の口）の項目の並び（ref）。null は口の区切り */
  ins: (string | null)[];
  /** 右辺（out の口）の項目の並び */
  outs: (string | null)[];
  /**
   * 画面の箱（kind screen）の中の画面の領域（docs/18 §3.3）。名前の帯の下で、ビューポート（screen.width × height、
   * 無ければ 1280×800）の比率。ビューアはここに画面の HTML を縮小して置く。画面の箱でなければ無い
   */
  screen?: Rect;
}

export interface HostLayout extends Rect {
  id: string;
  /** 枠の中の箱 */
  members: string[];
}

/**
 * 線の経路の計画。通り道 chans[i] の x が xs[i]、通過点 gaps[j] の y が ys[j]。
 * 経路は 出口 → (xs[0], 出口の y) → (xs[0], ys[0]) → (xs[1], ys[0]) → … → (xs[n], 入口の y) → 入口（n = ys.length）
 */
export interface RoutePlan {
  chans: number[];
  /** 通過点の名前（`<列>:<束>:<段>`） */
  gaps: string[];
  xs: number[];
  ys: number[];
}

export interface Route {
  /** 直交の折れ線（隣り合う 2 点は x か y が同じ） */
  points: Point[];
  length: number;
}

/** 切れている線（broken の 1 件）の経路。端は受ける側の箱の手前で切れる（参照は文字列。結果は JSON にできる） */
export interface BrokenRoute {
  /** `b<i>` */
  key: string;
  /** 線のキー（IndexedWire.key） */
  wire: string;
  /** 送る側の項目の ref（path が無い段で止めた項目） */
  from: string;
  /** 受ける側の項目の ref（同上） */
  to: string;
  path: string;
  level: 'error' | 'warn';
  reason: string;
  route: Route;
}

export interface WiringLayout {
  width: number;
  height: number;
  /** レーンの名前の y */
  titleY: number;
  lanes: LaneLayout[];
  columns: ColumnLayout[];
  channels: Channel[];
  /** 箱 id → 位置（host の枠になる箱は含まない） */
  boxes: Map<string, BoxLayout>;
  /** 項目の ref → ピン */
  pins: Map<string, Pin>;
  /** host の箱 id → 枠 */
  hosts: Map<string, HostLayout>;
  /** 線のキー（IndexedWire.key）→ 計画。broken は `b<i>` */
  plans: Map<string, RoutePlan>;
  /** 線のキー → 宣言どおりの端点での経路 */
  routes: Map<string, Route>;
  broken: BrokenRoute[];
}

export interface LayoutOptions {
  /** 箱の幅。既定 300 */
  boxWidth?: number;
  /** 箱ごとの幅。既定は画面（kind screen）が boxWidth の 2 倍、それ以外は boxWidth（docs/18 §3.1 の 8） */
  widthOf?: (node: IndexedNode, boxWidth: number) => number;
  /** 箱の中の行間。既定 18 */
  rowHeight?: number;
  /** 線の間隔。既定 8 */
  pitch?: number;
  /** 目標の縦横比（幅 / 高さ）。既定 1.6（16:10） */
  aspect?: number;
  /**
   * 画面の箱の高さを「ビューポートの比率の画面」と「項目の行」の大きい方にするか（docs/18 §3.3）。既定 true。
   * false は 8-3a の配置（項目の行だけ。テストで比べる用）
   */
  screens?: boolean;
  /**
   * 差分の幽霊の項目（diffOverlayV2 の ghost.items）。切れた線の端はここに降りず、今の graph の最も近い祖先で止まる
   * （`?prev=` が無いときと同じ所。docs/18 §10.6）
   */
  ghostItems?: ReadonlySet<string>;
}
