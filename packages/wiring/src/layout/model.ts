// レイアウトの内部の形: 箱（項目のピンの並びと高さ）、レーン、host の塊、線の向き（層を決める線か）
import type { Runtime } from '@stack-atlas/schema';
import type { GraphIndex, IndexedItem, IndexedNode, IndexedWire } from '../graph-index.js';
import { SCREEN_INSET, screenArea } from './screen.js';
import { LANES, type Rect } from './types.js';

// 定数（モックと同じ）
export const ML = 40;
export const MT = 40;
/** 箱の名前の帯 */
export const HEAD = 26;
export const PORT_GAP = 6;
export const HOST_PAD = 10;
/** 枠の頭は、枠の名前と中の箱の種類の文字の両方が入る高さ */
export const HOST_HEAD = 36;
/** 通り道の余白（線の数 × 間隔に足す） */
export const MARGIN = 24;
/** 通り道の最小の幅 */
export const MIN_CHANNEL = 40;
/** レーンの名前の y */
export const TITLE_Y = MT + 12;
/** 箱のいちばん上（種類の文字がレーンの名前に重ならない） */
export const TOP = MT + 30;
/** 通過点（線）のいちばん上。線はレーンの名前より下を通る */
export const DUMMY_TOP = TITLE_Y + 12;
/** 図の下端の余白（いちばん下の箱か線から） */
export const BOTTOM_PAD = 40;
/** 箱と箱の縦の隙間（そこを通る線が無いとき） */
export const GAP_BOX = 40;
/** 箱の下から通過点まで */
export const GAP_BOX_DUMMY = 16;
/** 通過点から下の箱まで（箱の種類の文字が箱の外の左上にあるので広め） */
export const GAP_DUMMY_BOX = 24;
/** 切れている線は受ける側の箱のこの手前で切る */
export const BROKEN_CUT = 16;

export interface Cfg {
  boxW: number;
  rowH: number;
  pitch: number;
  aspect: number;
  widthOf: (n: IndexedNode, boxW: number) => number;
  /** 画面の箱に画面の領域を取るか（docs/18 §3.3。layoutWiring の既定は true、無ければ取らない） */
  screens?: boolean;
}

/** 列の中に積むもの: 箱か、通過点の束 */
export type Elem = LBox | Bundle;

/** 内部で使う箱 */
export interface LBox {
  kind: 'box';
  id: string;
  n: IndexedNode;
  /** graph の nodes の順（宣言の順） */
  decl: number;
  lane: number;
  /** 枠になる host の id */
  host: string | null;
  /** 列の中で隣り合わせる単位（`group` か file のディレクトリ） */
  group: string;
  w: number;
  h: number;
  /** 画面の箱の中の画面の領域（箱の左上から。docs/18 §3.3）。画面でなければ null */
  scr: Rect | null;
  ins: (IndexedItem | null)[];
  outs: (IndexedItem | null)[];
  /** 項目の ref → 箱の上端からのピンの y */
  off: Map<string, number>;
  /** 外の配置での単位（host の塊か、箱そのもの） */
  unit: Unit;
  /** host の塊の中の層（塊でなければ 0） */
  ilayer: number;
  col: number;
  x: number;
  y: number;
  /** この箱に着く線の端（ピン） */
  ends: ChainEnd[];
  /** 隣の列の相手（Placer が作る） */
  tpl: Tpl[];
  /** 同じ列の中で閉じる線の相手の箱のピン（Placer が作る） */
  same: Tpl[];
  /** 列の中で隣り合わせる単位の鍵（host か group） */
  ukey: string;
  /** 並べ直しの作業用（重心・初めの順・並びの位置・上と下に付ける折り返し） */
  bary: number;
  rank: number;
  pos: number;
  above: Bundle[];
  below: Bundle[];
  /** 縦の位置の作業用（pass が stamp の回の解） */
  ty: number;
  stamp: number;
  /** 並べ方の悪さを測る作業用（列を上から詰めて積んだ y。Placer.score） */
  sy: number;
  /** 入れ替え（Placer.refine）の作業用: 列の中の箱の番号 */
  ri: number;
}

/** 要素の点（箱のピンか束の段）と、その線で隣り合う点（列は決まっているので先に作っておく） */
export interface Tpl {
  /** 自分の点（箱のピンか束の段） */
  self: ChainPoint;
  other: ChainPoint;
  col: number;
}

/** 外の配置で層を付ける単位: 箱 1 つか、host の塊 */
export interface Unit {
  id: string;
  lane: number;
  boxes: LBox[];
  host: string | null;
  decl: number;
  layer: number;
}

/** 通過点の束（docs/18 §3.1 の 5）。同じ列で同じ 2 つの箱の間を通る線の通過点は、間隔 pitch で隣り合わせる */
export interface Bundle {
  kind: 'bundle';
  key: string;
  /** 作った順（同点を崩す） */
  seq: number;
  col: number;
  slots: Slot[];
  /** (段の数 - 1) × pitch。束の高さはここだけで決める（段は作った後に増えない） */
  h: number;
  y: number;
  /** 隣の列の相手（Placer が作る） */
  tpl: Tpl[];
  /** 同じ列にあって、この束の線のピンを持つ箱（折り返し。空なら自由な束） */
  att: LBox[];
  /** 折り返しの相手のピン */
  attPins: Tpl[];
  /** 並べ直しの作業用（重心・初めの順） */
  bary: number;
  rank: number;
  /** 縦の位置の作業用（pass が stamp の回の解） */
  ty: number;
  stamp: number;
  /** 並べ方の悪さを測る作業用（Placer.score） */
  sy: number;
}

export interface Slot {
  chain: Chain;
  /** 線の通過点の何番目か */
  idx: number;
  bundle: Bundle;
  /** 束の中の段 */
  pos: number;
}

/** 線 1 本（か切れている線 1 件）の経路の骨組み: 出口のピン → 通過点 … → 入口のピン */
export interface Chain {
  key: string;
  seq: number;
  /** 切れている線（受ける側の箱の BROKEN_CUT 手前で切る。最後の通り道の右に切る所を空ける） */
  cut: boolean;
  wire: IndexedWire;
  from: IndexedItem;
  to: IndexedItem;
  fb: LBox;
  tb: LBox;
  /** 通過点（列の順） */
  slots: Slot[];
  /** 区間ごとの通り道（slots.length + 1 個） */
  chans: number[];
  /** 区間ごとの通り道の中の x（経路を作るときに決める） */
  xs: number[];
  /** pointOf が作る点の表 */
  points?: ChainPoint[];
}

export interface ChainEnd {
  chain: Chain;
  side: 'from' | 'to';
}

/** 線の点（ピンか通過点） */
/** 線の点。ピンの o は箱の上端からの y（項目を並べ替えたら refreshPins で更新する） */
export type ChainPoint =
  { kind: 'pin'; box: LBox; ref: string; o: number } | { kind: 'slot'; slot: Slot };

/** 線の i 番目の点（0 が出口のピン、slots.length + 1 が入口のピン）。点は線ごとに 1 回だけ作って使い回す */
export function pointOf(c: Chain, i: number): ChainPoint {
  if (!c.points) {
    const pin = (box: LBox, ref: string) => ({
      kind: 'pin' as const,
      box,
      ref,
      o: box.off.get(ref) ?? box.h / 2,
    });
    c.points = [
      pin(c.fb, c.from.ref),
      ...c.slots.map((slot) => ({ kind: 'slot' as const, slot })),
      pin(c.tb, c.to.ref),
    ];
  }
  return c.points[i]!;
}

/** 箱の項目を並べ替えた後、その箱のピンの点の y を更新する */
export function refreshPins(b: LBox) {
  for (const e of b.ends) {
    const c = e.chain;
    const p = pointOf(c, e.side === 'from' ? 0 : c.slots.length + 1);
    if (p.kind === 'pin') p.o = b.off.get(p.ref) ?? b.h / 2;
  }
}

export const pointCol = (p: ChainPoint): number =>
  p.kind === 'pin' ? p.box.col : p.slot.bundle.col;

/** 箱の中の項目の並び（子は親の直後、口が変わる所に null） */
export function columnOf(
  n: IndexedNode,
  dir: 'in' | 'out',
  order?: IndexedItem[],
): (IndexedItem | null)[] {
  const out: (IndexedItem | null)[] = [];
  const walk = (it: IndexedItem) => {
    out.push(it);
    for (const c of it.children) walk(c);
  };
  const tops = order ?? n.roots.filter((i) => i.dir === dir);
  let prevPort: string | null = null;
  for (const it of tops) {
    if (prevPort !== null && it.port.id !== prevPort) out.push(null); // 口の区切り
    walk(it);
    prevPort = it.port.id;
  }
  return out;
}

/**
 * 項目のピンの y（箱の上端から）と箱の高さ。画面の箱は「画面の領域の下端」と「項目の行の高さ」の大きい方
 * （docs/18 §3.3。項目のピンは箱の縁で、画面の上に重なる）
 */
export function measure(b: LBox, rowH: number) {
  b.off = new Map();
  const place = (col: (IndexedItem | null)[]) => {
    let y = HEAD + 8;
    for (const it of col) {
      if (it === null) {
        y += PORT_GAP;
        continue;
      }
      b.off.set(it.ref, y);
      y += rowH;
    }
    return y;
  };
  b.h = Math.max(
    place(b.ins),
    place(b.outs),
    HEAD + 8,
    b.scr ? b.scr.y + b.scr.h + SCREEN_INSET : 0,
  );
}

const dirOf = (file: string | undefined): string | null => {
  if (!file) return null;
  const i = file.lastIndexOf('/');
  return i < 0 ? '.' : file.slice(0, i);
};

/** 箱の項目が言語アダプタで細かくなっているか（`_` 以外の項目を持つ） */
const refined = (n: IndexedNode) => n.items.some((i) => i.id !== '_');

/**
 * 呼び出しでない参照の `_` の線（定数の import・コールバック渡し。docs/17 D53）: 項目の単位になった箱の `out/_` から出る線
 * （mergeV2 が言語アダプタの項目の横に残した置き場）。箱の単位のまま（Go・利用者）の `_` の線と、endpoint の `req/_`
 * （合流の相手が箱の単位）は呼び出し。受ける側の `in/_` は見ない（利用者 → endpoint の `in/_` は呼び出し）
 */
export function isReference(w: IndexedWire): boolean {
  return w.from.id === '_' && w.from.port.id === 'out' && refined(w.fromNode);
}

/** 層（呼び出しの深さ）を決める線: 呼び出し・props・render・http などの向きの線（戻りと参照を除く。docs/18 §3.1 の 3） */
export function isForward(w: IndexedWire): boolean {
  return !w.reply && w.wire.via !== 'return' && w.wire.via !== 'deliver' && !isReference(w);
}

export interface Model {
  boxes: LBox[];
  boxOf: Map<string, LBox>;
  /** 箱のあるレーン（LANES の index）。左から */
  used: number[];
  units: Unit[];
  hostIds: string[];
  /** host の id → 中の箱 */
  hostMembers: Map<string, LBox[]>;
  /** 両端が箱の線 */
  wires: IndexedWire[];
}

export function buildModel(index: GraphIndex, cfg: Cfg): Model {
  const hostSet = new Set<string>();
  for (const n of index.nodes.values()) if (n.host) hostSet.add(n.host.id);
  const all = [...index.nodes.values()].filter((n) => !hostSet.has(n.id));
  const laneDefOf = (r: Runtime) =>
    Math.max(
      0,
      LANES.findIndex((l) => l.runtimes.includes(r)),
    );

  const boxes: LBox[] = all.map((n, decl) => {
    const b: LBox = {
      kind: 'box',
      id: n.id,
      n,
      decl,
      lane: laneDefOf(n.node.runtime),
      host: n.host ? n.host.id : null,
      group: n.node.group ?? dirOf(n.node.file) ?? `#${n.id}`,
      w: cfg.widthOf(n, cfg.boxW),
      h: 0,
      scr: null,
      ins: columnOf(n, 'in'),
      outs: columnOf(n, 'out'),
      off: new Map(),
      unit: null as unknown as Unit,
      ilayer: 0,
      col: 0,
      x: 0,
      y: 0,
      ends: [],
      tpl: [],
      same: [],
      ukey: '',
      bary: 0,
      rank: decl,
      pos: 0,
      above: [],
      below: [],
      ty: 0,
      stamp: -1,
      sy: 0,
      ri: -1,
    };
    b.ukey = b.host ? `h:${b.host}` : `g:${b.group}`;
    b.scr = cfg.screens ? screenArea(n, b.w, HEAD) : null;
    measure(b, cfg.rowH);
    return b;
  });
  const boxOf = new Map(boxes.map((b) => [b.id, b]));

  // host の塊は 1 つのレーンに置く（中の箱のレーンの多数決。同数なら先に宣言された箱のレーン）
  const hostMembers = new Map<string, LBox[]>();
  for (const b of boxes) {
    if (!b.host) continue;
    const g = hostMembers.get(b.host);
    if (g) g.push(b);
    else hostMembers.set(b.host, [b]);
  }
  const hostIds = [...hostMembers.keys()];
  for (const members of hostMembers.values()) {
    const count = new Map<number, number>();
    for (const b of members) count.set(b.lane, (count.get(b.lane) ?? 0) + 1);
    let lane = members[0]!.lane;
    for (const b of members) if (count.get(b.lane)! > count.get(lane)!) lane = b.lane;
    for (const b of members) b.lane = lane;
  }

  const used = [...new Set(boxes.map((b) => b.lane))].sort((a, b) => a - b);
  const laneOfDef = new Map(used.map((d, i) => [d, i]));
  for (const b of boxes) b.lane = laneOfDef.get(b.lane)!;

  const units: Unit[] = [];
  const hostUnit = new Map<string, Unit>();
  for (const b of boxes) {
    if (b.host) {
      let u = hostUnit.get(b.host);
      if (!u) {
        u = { id: b.host, lane: b.lane, boxes: [], host: b.host, decl: b.decl, layer: 0 };
        hostUnit.set(b.host, u);
        units.push(u);
      }
      u.boxes.push(b);
      b.unit = u;
    } else {
      const u: Unit = { id: b.id, lane: b.lane, boxes: [b], host: null, decl: b.decl, layer: 0 };
      units.push(u);
      b.unit = u;
    }
  }

  const wires = index.wires.filter((w) => boxOf.has(w.fromNode.id) && boxOf.has(w.toNode.id));
  return { boxes, boxOf, used, units, hostIds, hostMembers, wires };
}
