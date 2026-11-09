// 配線図のレイアウト（docs/15 §3.6）。prototype/dataflow-mock.html 第 6 版の近似（レーン × 重心、線の数で決める隙間、
// 直交配線）を純 TS に移したもの。DOM 無し・決定的（同じ入力から同じ出力）。ELK 相当の配線器と build 時の埋め込み
// （nodes[].position・wires[].route）は後のフェーズ（docs/16 §10）
import type { Runtime } from '@stack-atlas/schema';
import { brokenEnds } from './broken.js';
import {
  isDescendantOf,
  type GraphIndex,
  type IndexedItem,
  type IndexedNode,
  type IndexedWire,
} from './graph-index.js';
import type { Segment } from './traverse.js';

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

/** 通り道（レーンの間の縦の帯）。index i はレーン i の左、最後はいちばん右のレーンの右 */
export interface Channel {
  x: number;
  w: number;
  /** 中央の x（レーンの背景の境目） */
  mid: number;
}

export interface LaneLayout {
  id: string;
  name: string;
  /** 箱がある レーンだけを左から数えた番号 */
  index: number;
  /** 箱の列の x と幅 */
  x: number;
  w: number;
  /** 背景の帯の左右（隣の通り道の中央まで） */
  x0: number;
  x1: number;
}

export interface Pin extends Point {
  /** in は箱の左辺、out は右辺 */
  side: 'in' | 'out';
}

export interface BoxLayout extends Rect {
  id: string;
  lane: number;
  /** 左辺（in の口）の項目の並び（ref）。null は口の区切り */
  ins: (string | null)[];
  /** 右辺（out の口）の項目の並び */
  outs: (string | null)[];
}

export interface HostLayout extends Rect {
  id: string;
  /** 枠の中の箱 */
  members: string[];
}

/** 線の経路の計画。通り道 chans[i] の x が xs[i]、隙間 gaps[j] の y が ys[j] */
export interface RoutePlan {
  chans: number[];
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
  /** 箱の中の行間。既定 18 */
  rowHeight?: number;
  /** 線の間隔。既定 8 */
  pitch?: number;
}

// 定数（モックと同じ）
const ML = 40;
const MT = 40;
const SLOT_H = 70;
const HEAD = 26;
const PORT_GAP = 6;
const HOST_PAD = 10;
/** 枠の頭は、枠の名前と中の箱の種類の文字の両方が入る高さ */
const HOST_HEAD = 36;
const MARGIN = 24;
const MIN_GAP = 40;
/** 切れている線は受ける側の箱のこの手前で切る */
export const BROKEN_CUT = 16;

/** 内部で使う箱 */
interface LBox {
  n: IndexedNode;
  id: string;
  lane: number;
  row: number;
  host: string | null;
  x: number;
  y: number;
  w: number;
  h: number;
  key: number;
  comp: string;
  ins: (IndexedItem | null)[];
  outs: (IndexedItem | null)[];
}

interface Routed {
  key: string;
  from: IndexedItem;
  to: IndexedItem;
}

interface Plan extends RoutePlan {
  key: string;
  fy: number;
  ty: number;
  x: Map<number, number>;
  y: Map<string, number>;
}

/** 直交の経路を、計画と両端のピンから作る（出口 → 右の通り道 →（隙間 → 左の通り道）→ 入口） */
export function routeBetween(plan: RoutePlan, a: Point, b: Point): Point[] {
  const pts: Point[] = [{ x: a.x, y: a.y }];
  const x0 = plan.xs[0];
  if (x0 === undefined) {
    pts.push({ x: b.x, y: a.y }, { x: b.x, y: b.y });
  } else if (plan.xs.length === 1 || plan.ys[0] === undefined) {
    pts.push({ x: x0, y: a.y }, { x: x0, y: b.y });
  } else {
    const x1 = plan.xs[1]!;
    const y0 = plan.ys[0];
    pts.push({ x: x0, y: a.y }, { x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: b.y });
  }
  pts.push({ x: b.x, y: b.y });
  return dedupe(pts);
}

/** 箱の中の対応（キャッシュの links）の経路。左右のピンの中央で折れる */
export function innerRoute(a: Point, b: Point): Point[] {
  const xm = (a.x + b.x) / 2;
  return dedupe([
    { x: a.x, y: a.y },
    { x: xm, y: a.y },
    { x: xm, y: b.y },
    { x: b.x, y: b.y },
  ]);
}

function dedupe(pts: Point[]): Point[] {
  const out: Point[] = [];
  for (const p of pts) {
    const last = out[out.length - 1];
    if (last && last.x === p.x && last.y === p.y) continue;
    out.push(p);
  }
  return out;
}

export function routeLength(points: readonly Point[]): number {
  let len = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!;
    const b = points[i]!;
    len += Math.abs(b.x - a.x) + Math.abs(b.y - a.y);
  }
  return len;
}

/** 折れ線の始点から距離 d の点（球の位置） */
export function pointAt(points: readonly Point[], d: number): Point {
  const first = points[0];
  if (!first) return { x: 0, y: 0 };
  let rest = Math.max(0, d);
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!;
    const b = points[i]!;
    const len = Math.abs(b.x - a.x) + Math.abs(b.y - a.y);
    if (rest <= len) {
      const f = len === 0 ? 0 : rest / len;
      return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f };
    }
    rest -= len;
  }
  const last = points[points.length - 1]!;
  return { x: last.x, y: last.y };
}

const toRoute = (points: Point[]): Route => ({ points, length: routeLength(points) });

/**
 * 光る区間（線か、箱の中の対応）の経路。親の単位の線を子からたどった区間は、線の計画を子のピンで使う。
 * ピンが無い（host の枠の箱の項目など）ときは null
 */
export function segmentRoute(layout: WiringLayout, seg: Segment): Route | null {
  const a = layout.pins.get(seg.from.ref);
  const b = layout.pins.get(seg.to.ref);
  if (!a || !b) return null;
  if (seg.kind === 'link') return toRoute(innerRoute(a, b));
  const plan = seg.wire ? layout.plans.get(seg.wire.key) : undefined;
  if (!plan) return null;
  return toRoute(routeBetween(plan, a, b));
}

/**
 * 配線図のレイアウト。箱は常に全部の項目を開く（子は親の直後）。分岐の状態には依らない
 * （切り替えで箱が動かないように。モックと同じ）。
 * 1. レーン = runtime（箱のあるレーンだけ）。host に指された箱は箱ではなく枠
 * 2. 箱の縦順は左のレーンの相手の重心。左に相手が無ければ同じレーンの上の相手の下、どこにもつながらなければ宣言順
 * 3. 箱の中の項目は口の中だけで、相手側のピンの y の重心で並べ替える（口の順は固定）
 * 4. 線ごとに通る通り道と隙間を決め、隙間と通り道の幅を線の数 × 間隔 ＋ 余白にして置き直す（3 回）
 * 5. 左に錨の無い成分は、隙間の規則を守る範囲で上に詰める
 */
export function layoutWiring(index: GraphIndex, options: LayoutOptions = {}): WiringLayout {
  const BOX_W = options.boxWidth ?? 300;
  const ROW_H = options.rowHeight ?? 18;
  const PITCH = options.pitch ?? 8;
  const TOP = MT + 30;

  // --- 箱・枠・レーン ---
  const hostIds = new Set<string>();
  for (const n of index.nodes.values()) if (n.host) hostIds.add(n.host.id);
  const all = [...index.nodes.values()].filter((n) => !hostIds.has(n.id));
  const laneDefOf = (r: Runtime) => LANES.findIndex((l) => l.runtimes.includes(r));
  const used = LANES.map((_, i) => i).filter((i) =>
    all.some((n) => laneDefOf(n.node.runtime) === i),
  );
  const laneOfDef = new Map(used.map((d, i) => [d, i]));
  const L = used.length;

  const boxes: LBox[] = all.map((n, row) => ({
    n,
    id: n.id,
    lane: laneOfDef.get(laneDefOf(n.node.runtime)) ?? 0,
    row,
    host: n.host ? n.host.id : null,
    x: 0,
    y: 0,
    w: BOX_W,
    h: 0,
    key: 0,
    comp: n.id,
    ins: [],
    outs: [],
  }));
  const boxOf = new Map(boxes.map((b) => [b.id, b]));
  const pins = new Map<string, Pin>();

  // 両端が箱の線だけを置く（枠の箱の項目にはピンが無い）
  const wires: IndexedWire[] = index.wires.filter(
    (w) => boxOf.has(w.fromNode.id) && boxOf.has(w.toNode.id),
  );
  const neighbors = new Map<string, Set<LBox>>();
  const addNb = (a: LBox, b: LBox) => {
    const s = neighbors.get(a.id);
    if (s) s.add(b);
    else neighbors.set(a.id, new Set([b]));
  };
  for (const w of wires) {
    const a = boxOf.get(w.fromNode.id)!;
    const b = boxOf.get(w.toNode.id)!;
    addNb(a, b);
    addNb(b, a);
  }

  // --- 箱の中の項目 ---
  const columnOf = (b: LBox, dir: 'in' | 'out', order?: IndexedItem[]) => {
    const out: (IndexedItem | null)[] = [];
    const walk = (it: IndexedItem) => {
      out.push(it);
      for (const c of it.children) walk(c);
    };
    const tops = order ?? b.n.roots.filter((i) => i.dir === dir);
    let prevPort: string | null = null;
    for (const it of tops) {
      if (prevPort !== null && it.port.id !== prevPort) out.push(null); // 口の区切り
      walk(it);
      prevPort = it.port.id;
    }
    return out;
  };
  const placeColumn = (b: LBox, col: (IndexedItem | null)[], x: number, side: 'in' | 'out') => {
    let y = b.y + HEAD + 8;
    for (const it of col) {
      if (it === null) {
        y += PORT_GAP;
        continue;
      }
      pins.set(it.ref, { x, y, side });
      y += ROW_H;
    }
    return y - b.y;
  };
  const setPins = (b: LBox) => {
    const hIn = placeColumn(b, b.ins, b.x, 'in');
    const hOut = placeColumn(b, b.outs, b.x + b.w, 'out');
    b.h = Math.max(hIn, hOut, HEAD + 8);
  };
  const centerY = (b: LBox) => b.y + b.h / 2;
  const pinY = (it: IndexedItem) => {
    const p = pins.get(it.ref);
    if (p) return p.y;
    const b = boxOf.get(it.node.id);
    return b ? centerY(b) : null;
  };
  // 項目につながる相手側のピンの y の重心（子孫の線も含む）
  const counterpartY = (it: IndexedItem) => {
    const ys: number[] = [];
    const take = (x: IndexedItem) => {
      const y = pinY(x);
      if (y !== null) ys.push(y);
    };
    for (const d of [it, ...it.node.items.filter((x) => isDescendantOf(x, it))]) {
      for (const w of index.wiresFrom.get(d.ref) ?? []) if (boxOf.has(w.toNode.id)) take(w.to);
      for (const w of index.wiresTo.get(d.ref) ?? []) if (boxOf.has(w.fromNode.id)) take(w.from);
    }
    return ys.length ? ys.reduce((a, b) => a + b, 0) / ys.length : null;
  };

  // --- 縦の配置 ---
  const laneOrder: LBox[][] = [];
  const gapSize = new Map<string, number>();
  /** 隙間 k（レーン li の k 番目の箱の上）に要る高さ。枠の境目を跨ぐなら枠の頭と余白の分を足す */
  const gapNeeded = (li: number, k: number, b: LBox, prevHost: string | null) => {
    let gap = gapSize.get(`${li}:${k}`) ?? MIN_GAP;
    if (b.host !== prevHost) {
      if (prevHost) gap += HOST_PAD;
      if (b.host) gap += HOST_HEAD + HOST_PAD;
    }
    return gap;
  };
  const hostIdList = [...hostIds];
  const placeLanes = (rowScale: number) => {
    for (let li = 0; li < L; li++) {
      const inLane = boxes.filter((b) => b.lane === li).sort((a, b) => a.row - b.row);
      const placed: LBox[] = [];
      for (const b of inLane) {
        const nb = neighbors.get(b.id) ?? new Set<LBox>();
        const left = [...nb].filter((m) => m.lane < li);
        const prev = placed[placed.length - 1];
        const slot = TOP + b.row * rowScale + b.h / 2;
        if (left.length) {
          b.key = left.reduce((a, m) => a + centerY(m), 0) / left.length;
          b.comp = left[0]!.comp;
        } else if (prev && placed.some((p) => nb.has(p))) {
          // 同じレーンの上の箱とつながっていれば、その箱（つながっている中で最も下）のすぐ下（docs/15 §8 #13）。
          // モックは直前に置いた箱の下に置いていたが、間に別の成分の箱があると枠ごと下へずれた
          const m = placed.filter((p) => nb.has(p)).reduce((a, p) => (p.key > a.key ? p : a));
          b.key = m.key + m.h / 2 + MIN_GAP + b.h / 2;
          b.comp = m.comp;
        } else {
          b.key = prev ? Math.max(slot, prev.key + 1) : slot;
          b.comp = b.id;
        }
        placed.push(b);
      }
      // 同じ host の箱は key を揃えて隣り合わせる
      for (const h of hostIdList) {
        const g = inLane.filter((b) => b.host === h);
        if (g.length > 1) {
          const k = g.reduce((a, b) => a + b.key, 0) / g.length;
          g.forEach((b, i) => (b.key = k + i * 0.01));
        }
      }
      inLane.sort((a, b) => a.key - b.key || a.row - b.row);
      laneOrder[li] = inLane;
      let bottom = TOP - MIN_GAP;
      let prevHost: string | null = null;
      inLane.forEach((b, k) => {
        b.y = Math.max(b.key - b.h / 2, bottom + gapNeeded(li, k, b, prevHost));
        bottom = b.y + b.h;
        prevHost = b.host;
        setPins(b);
      });
    }
    compact();
  };
  // 左に錨の無い成分は row の位置に置かれるので、隙間の規則を守る範囲で上に寄せる
  const compact = () => {
    const comps = [...new Set(boxes.map((b) => b.comp))];
    for (let iter = 0; iter < 3; iter++) {
      for (const c of comps) {
        const members = boxes.filter((b) => b.comp === c);
        let shift = Infinity;
        for (const b of members) {
          const order = laneOrder[b.lane]!;
          const k = order.indexOf(b);
          const above = k > 0 ? order[k - 1]! : null;
          if (above && above.comp === c) continue;
          const minY = above
            ? above.y + above.h + gapNeeded(b.lane, k, b, above.host)
            : TOP + (b.host ? HOST_HEAD + HOST_PAD : 0);
          shift = Math.min(shift, b.y - minY);
        }
        if (shift > 0 && Number.isFinite(shift)) {
          for (const b of members) {
            b.y -= shift;
            setPins(b);
          }
        }
      }
    }
  };
  // 箱の中の項目: 相手側の項目の並び（y の重心）に合わせて親の順を入れ替える。子は親の直後のまま、口の順は保つ
  const reorderItems = () => {
    for (let pass = 0; pass < 2; pass++) {
      for (const b of boxes) {
        const portOrder = b.n.node.ports.map((p) => p.id);
        for (const dir of ['in', 'out'] as const) {
          const keyed = b.n.roots
            .filter((i) => i.dir === dir)
            .map((it) => ({ it, key: counterpartY(it) ?? pins.get(it.ref)?.y ?? 0 }));
          keyed.sort(
            (a, c) =>
              portOrder.indexOf(a.it.port.id) - portOrder.indexOf(c.it.port.id) || a.key - c.key,
          );
          const col = columnOf(
            b,
            dir,
            keyed.map((k) => k.it),
          );
          if (dir === 'in') b.ins = col;
          else b.outs = col;
        }
        setPins(b);
      }
    }
  };

  // --- 配線の計画（どの通り道・どの隙間を使うか。x / y はまだ決めない） ---
  const ends = brokenEnds(index).filter(
    (e) => boxOf.has(e.from.node.id) && boxOf.has(e.to.node.id),
  );
  const routed: Routed[] = [
    ...wires.map((w) => ({ key: w.key, from: w.from, to: w.to })),
    ...ends.map((e) => ({ key: e.key, from: e.from, to: e.to })),
  ];
  let plans = new Map<string, Plan>();
  let chanUse: Plan[][] = [];
  let gapUse = new Map<string, Plan[]>();
  const gapKey = (b: LBox, side: 'above' | 'below') =>
    `${b.lane}:${laneOrder[b.lane]!.indexOf(b) + (side === 'below' ? 1 : 0)}`;
  const planRoutes = () => {
    plans = new Map();
    chanUse = Array.from({ length: L + 1 }, () => []);
    gapUse = new Map();
    for (const r of routed) {
      const fb = boxOf.get(r.from.node.id)!;
      const tb = boxOf.get(r.to.node.id)!;
      const fl = fb.lane;
      const tl = tb.lane;
      const ty = pins.get(r.to.ref)?.y ?? centerY(tb);
      const plan: Plan = {
        key: r.key,
        chans: [],
        gaps: [],
        xs: [],
        ys: [],
        fy: pins.get(r.from.ref)?.y ?? centerY(fb),
        ty,
        x: new Map(),
        y: new Map(),
      };
      if (tl > fl) {
        // 途中のレーンに箱があって ty の高さを横切れないときは、その箱の上の隙間を通して相手の手前で下りる
        const block = boxes.find(
          (b) => b.lane > fl && b.lane < tl && b.y - 8 < ty && ty < b.y + b.h + 8,
        );
        if (block) {
          plan.chans = [fl + 1, tl];
          plan.gaps = [gapKey(block, 'above')];
        } else plan.chans = [fl + 1];
      } else {
        plan.chans = [fl + 1, tl];
        if (fb === tb) plan.gaps = [gapKey(tb, 'above')];
        else if (tl === fl) plan.gaps = [tb.y > fb.y ? gapKey(tb, 'above') : gapKey(tb, 'below')];
        else plan.gaps = [gapKey(fb, 'below')];
      }
      plans.set(r.key, plan);
      for (const c of plan.chans) chanUse[c]!.push(plan);
      for (const g of plan.gaps) {
        const list = gapUse.get(g);
        if (list) list.push(plan);
        else gapUse.set(g, [plan]);
      }
    }
    gapSize.clear();
    for (const [g, list] of gapUse) gapSize.set(g, Math.max(MIN_GAP, list.length * PITCH + MARGIN));
  };

  // --- 通り道の割り当て: 同じ隙間・通り道を通る線は等間隔で重ならない ---
  let chanW: number[] = [];
  const chanLeft = (ci: number) => ML + chanW.slice(0, ci).reduce((a, b) => a + b, 0) + ci * BOX_W;
  const assignSlots = () => {
    chanW = chanUse.map((list) => Math.max(MIN_GAP, list.length * PITCH + MARGIN));
    for (const b of boxes) {
      b.x = chanLeft(b.lane + 1) - BOX_W;
      setPins(b);
    }
    chanUse.forEach((list, ci) => {
      list.sort((a, b) => Math.min(a.fy, a.ty) - Math.min(b.fy, b.ty));
      const x0 = chanLeft(ci) + (chanW[ci]! - list.length * PITCH) / 2 + PITCH / 2;
      list.forEach((p, i) => p.x.set(ci, x0 + i * PITCH));
    });
    for (const [g, list] of gapUse) {
      const [li, k] = g.split(':').map(Number) as [number, number];
      const order = laneOrder[li]!;
      const above = order[k - 1];
      const below = order[k];
      // 枠の境目を跨ぐ隙間は、枠の頭と余白の分を除いた所を通る（同じ枠の中どうしなら除かない）
      const top = above
        ? above.y + above.h + (above.host && above.host !== below?.host ? HOST_PAD : 0)
        : TOP - MIN_GAP;
      const bottom = below
        ? below.y - (below.host && below.host !== above?.host ? HOST_HEAD + HOST_PAD : 0)
        : top + (gapSize.get(g) ?? MIN_GAP);
      list.sort((a, b) => a.fy - b.fy);
      const y0 = top + (bottom - top - list.length * PITCH) / 2 + PITCH / 2;
      list.forEach((p, i) => p.y.set(g, y0 + i * PITCH));
    }
    for (const p of plans.values()) {
      p.xs = p.chans.map((c) => p.x.get(c)!);
      p.ys = p.gaps.map((g) => p.y.get(g)!);
    }
  };

  // --- 置く → 線を数える → 隙間を広げて置き直す、を繰り返す（迂回の有無が位置で変わるので 3 回） ---
  for (const b of boxes) {
    b.ins = columnOf(b, 'in');
    b.outs = columnOf(b, 'out');
    b.y = TOP + b.row * SLOT_H;
    setPins(b);
  }
  const maxRow = Math.max(0, ...boxes.map((b) => b.row));
  const stackH = Math.max(
    0,
    ...Array.from({ length: L }, (_, li) =>
      boxes.filter((b) => b.lane === li).reduce((a, b) => a + b.h + MIN_GAP, 0),
    ),
  );
  placeLanes(Math.max(SLOT_H, stackH / (maxRow + 1)));
  reorderItems();
  for (let i = 0; i < 3; i++) {
    planRoutes();
    placeLanes(
      Math.max(SLOT_H, (Math.max(0, ...boxes.map((b) => b.y + b.h)) * 1.1) / (maxRow + 1)),
    );
    reorderItems();
  }
  planRoutes();
  assignSlots();

  // --- 結果 ---
  const channels: Channel[] = chanW.map((w, ci) => {
    const x = chanLeft(ci);
    return { x, w, mid: x + w / 2 };
  });
  const width = chanLeft(L) + (chanW[L] ?? MIN_GAP) + ML;
  const maxBottom = Math.max(TOP, ...boxes.map((b) => b.y + b.h));
  const height = maxBottom + 40;
  const lanes: LaneLayout[] = used.map((d, i) => {
    const def = LANES[d]!;
    const x = chanLeft(i + 1) - BOX_W;
    return {
      id: def.id,
      name: def.name,
      index: i,
      x,
      w: BOX_W,
      x0: i === 0 ? 0 : channels[i]!.mid,
      x1: i === L - 1 ? width : channels[i + 1]!.mid,
    };
  });

  const hosts = new Map<string, HostLayout>();
  for (const id of hostIdList) {
    const g = (index.hosts.get(id) ?? []).map((n) => boxOf.get(n.id)).filter((b) => !!b);
    if (!g.length) continue;
    const x = Math.min(...g.map((b) => b.x)) - HOST_PAD;
    const y = Math.min(...g.map((b) => b.y)) - HOST_HEAD;
    hosts.set(id, {
      id,
      members: g.map((b) => b.id),
      x,
      y,
      w: Math.max(...g.map((b) => b.x + b.w)) - x + HOST_PAD,
      h: Math.max(...g.map((b) => b.y + b.h)) - y + HOST_PAD,
    });
  }

  const outBoxes = new Map<string, BoxLayout>();
  for (const b of boxes) {
    outBoxes.set(b.id, {
      id: b.id,
      lane: b.lane,
      x: b.x,
      y: b.y,
      w: b.w,
      h: b.h,
      ins: b.ins.map((i) => (i ? i.ref : null)),
      outs: b.outs.map((i) => (i ? i.ref : null)),
    });
  }

  const outPlans = new Map<string, RoutePlan>();
  for (const [k, p] of plans) outPlans.set(k, { chans: p.chans, gaps: p.gaps, xs: p.xs, ys: p.ys });
  const routes = new Map<string, Route>();
  for (const w of wires) {
    routes.set(
      w.key,
      toRoute(routeBetween(outPlans.get(w.key)!, pins.get(w.from.ref)!, pins.get(w.to.ref)!)),
    );
  }
  const broken: BrokenRoute[] = ends.map((e) => {
    const a = pins.get(e.from.ref)!;
    const t = pins.get(e.to.ref)!;
    const tb = boxOf.get(e.to.node.id)!;
    const end = { x: tb.x - BROKEN_CUT, y: t.y };
    return {
      key: e.key,
      wire: e.wire.key,
      from: e.from.ref,
      to: e.to.ref,
      path: e.broken.path,
      level: e.broken.level,
      reason: e.broken.reason,
      route: toRoute(routeBetween(outPlans.get(e.key)!, a, end)),
    };
  });

  return {
    width,
    height,
    titleY: MT + 12,
    lanes,
    channels,
    boxes: outBoxes,
    pins,
    hosts,
    plans: outPlans,
    routes,
    broken,
  };
}
