// 配線図のレイアウト（docs/15 §3.6、docs/18 §3.1。Phase 8-3a で作り直した）。DOM 無し・決定的（同じ入力から同じ出力）。
// 配置は graph ごとに 1 回だけ決める: 入力は索引だけで、選択・分岐の状態は取らない（切り替えで箱が動かない）。
// 手順: レーン → host の塊 → 層（呼び出しの深さ）→ レーンを列に割る（16:10 に近づける）→ 通過点 → 列の中の順（重心）
// → 縦の位置（PAVA）→ 列と通り道の幅 → 直交配線。ELK は使わない（D60）
import { brokenEnds } from '../broken.js';
import type { GraphIndex, IndexedItem, IndexedWire } from '../graph-index.js';
import { splitColumns, type ColInput } from './columns.js';
import { routeBetween, toRoute } from './geometry.js';
import { assignLayers } from './layers.js';
import {
  BOTTOM_PAD,
  BROKEN_CUT,
  GAP_BOX,
  HOST_HEAD,
  HOST_PAD,
  TITLE_Y,
  TOP,
  buildModel,
  columnOf,
  isForward,
  measure,
  pointOf,
  refreshPins,
  type Bundle,
  type Cfg,
  type Chain,
  type ChainEnd,
  type ChainPoint,
  type Elem,
  type LBox,
  type Unit,
} from './model.js';
import { Placer } from './place.js';
import { placeX } from './route.js';
import {
  LANES,
  type BoxLayout,
  type BrokenRoute,
  type Channel,
  type ColumnLayout,
  type HostLayout,
  type LaneLayout,
  type LayoutOptions,
  type Pin,
  type Route,
  type RoutePlan,
  type WiringLayout,
} from './types.js';

export * from './types.js';
export { routeBetween, innerRoute, routeLength, pointAt, segmentRoute } from './geometry.js';
export { BROKEN_CUT } from './model.js';
export {
  screenArea,
  screenViewport,
  hasScreenHtml,
  DEFAULT_VIEWPORT,
  SCREEN_INSET,
  SCREEN_RATIO_MAX,
  SCREEN_RATIO_MIN,
  VIEWPORT_MAX,
  VIEWPORT_MIN,
} from './screen.js';

/** 線の重心で並べ直す往復の数（docs/18 §3.1 の 6） */
const SWEEPS = 8;
/** 順と縦の位置を決め直す回数（同 7） */
const ROUNDS = 3;
/** 交差が減らない往復がこの数だけ続いたら、8 往復を待たずに打ち切る（基準の graph・/today の例では 1〜3 で同じ結果） */
const STALE = 1;

/** 箱ごとの幅の既定: 画面は通常の 2 倍（docs/18 §3.1 の 8。8-3b で画面の HTML を中に出す） */
export const defaultWidthOf: NonNullable<LayoutOptions['widthOf']> = (n, w) =>
  n.node.kind === 'screen' ? w * 2 : w;

interface Routed {
  key: string;
  wire: IndexedWire;
  from: IndexedItem;
  to: IndexedItem;
}

/**
 * 配置の前半: 層・列・通過点・列の中の順と縦の位置（layoutWiring の手順 1〜5）。テストで並べ方の悪さを確かめるために
 * 分けてある（パッケージの index からは出さない）
 */
export function arrange(index: GraphIndex, options: LayoutOptions = {}) {
  const cfg: Cfg = {
    boxW: options.boxWidth ?? 300,
    rowH: options.rowHeight ?? 18,
    pitch: options.pitch ?? 8,
    aspect: options.aspect ?? 1.6,
    widthOf: options.widthOf ?? defaultWidthOf,
    screens: options.screens ?? true,
  };
  const m = buildModel(index, cfg);
  const { boxes, boxOf } = m;

  const ends = brokenEnds(index, options.ghostItems).filter(
    (e) => boxOf.has(e.from.node.id) && boxOf.has(e.to.node.id),
  );
  const routed: Routed[] = [
    ...m.wires.map((w) => ({ key: w.key, wire: w, from: w.from, to: w.to })),
    ...ends.map((e) => ({ key: e.key, wire: e.wire, from: e.from, to: e.to })),
  ];

  // --- 層 ---
  const forwardOf = options.forward ?? isForward;
  // 線は 1 回だけ見て、レーンごと・host ごとに分ける（レーン・host ごとに全部の線を見ると (L + H) × W になる）
  interface Layered<T> {
    edges: [T, T][];
    weak: [T, T][];
  }
  const laneWires = Array.from({ length: m.used.length }, (): Layered<Unit> => ({
    edges: [],
    weak: [],
  }));
  const hostWires = new Map<string, Layered<LBox>>();
  for (const w of m.wires) {
    const fb = boxOf.get(w.fromNode.id)!;
    const tb = boxOf.get(w.toNode.id)!;
    const fwd = forwardOf(w);
    if (fb.lane === tb.lane && fb.unit !== tb.unit) {
      const l = laneWires[fb.lane]!;
      if (fwd) l.edges.push([fb.unit, tb.unit]);
      else l.weak.push(w.reply ? [tb.unit, fb.unit] : [fb.unit, tb.unit]);
    }
    if (fb.host && fb.host === tb.host && fb !== tb) {
      let h = hostWires.get(fb.host);
      if (!h) hostWires.set(fb.host, (h = { edges: [], weak: [] }));
      if (fwd) h.edges.push([fb, tb]);
      else h.weak.push(w.reply ? [tb, fb] : [fb, tb]);
    }
  }
  const laneUnits = Array.from({ length: m.used.length }, (): Unit[] => []);
  for (const u of m.units) laneUnits[u.lane]!.push(u);
  const unitLayer = new Map<string, number>();
  for (let lane = 0; lane < m.used.length; lane++) {
    const { edges, weak } = laneWires[lane]!;
    for (const [u, l] of assignLayers(laneUnits[lane]!, edges, weak, (u) => u.decl))
      unitLayer.set(u.id, l);
  }
  for (const u of m.units) u.layer = unitLayer.get(u.id)!;
  const hostDepth = new Map<string, number>();
  for (const [host, members] of m.hostMembers) {
    const { edges, weak } = hostWires.get(host) ?? { edges: [], weak: [] };
    let depth = 1;
    for (const [b, l] of assignLayers(members, edges, weak, (b) => b.decl)) {
      b.ilayer = l;
      depth = Math.max(depth, l + 1);
    }
    hostDepth.set(host, depth);
  }

  // 束: 往復する 2 箱の間の線（呼び出しと戻り）は 2 箱の組で、それ以外は送る側の項目で束ねる
  // （戻りは呼び出しの隣を逆向きに通る。1 つの出口から広がる線は分かれるまで並んで走る）
  const dirs = new Set<string>();
  for (const r of routed) dirs.add(`${r.from.node.id}\u0000${r.to.node.id}`);
  const bundleKey = routed.map((r) => {
    const a = r.from.node.id;
    const b = r.to.node.id;
    // 自分を呼ぶ線は箱ごとに 1 つの束
    if (a !== b && !dirs.has(`${b}\u0000${a}`)) return `src:${r.wire.from.ref}`;
    return a < b ? `${a}|${b}` : `${b}|${a}`;
  });
  const keyIds = new Map<string, number>();
  const bundleId = bundleKey.map((k) => {
    let id = keyIds.get(k);
    if (id === undefined) keyIds.set(k, (id = keyIds.size));
    return id;
  });

  // --- 列 ---
  const inp: ColInput = {
    model: m,
    cfg,
    unitLayer,
    hostDepth,
    ends: routed.map((r, i) => ({
      fb: boxOf.get(r.from.node.id)!,
      tb: boxOf.get(r.to.node.id)!,
      pair: bundleId[i]!,
    })),
  };
  const { specs, colOf } = boxes.length
    ? splitColumns(inp)
    : { specs: [], colOf: new Map<LBox, number>() };
  for (const [b, c] of colOf) b.col = c;
  const C = specs.length;

  // --- 通過点 ---
  const bundles = new Map<string, Bundle>();
  const chains: Chain[] = routed.map((r, seq) => {
    const fb = boxOf.get(r.from.node.id)!;
    const tb = boxOf.get(r.to.node.id)!;
    const ca = fb.col;
    const cb = tb.col;
    const c: Chain = {
      key: r.key,
      seq,
      cut: seq >= m.wires.length,
      wire: r.wire,
      from: r.from,
      to: r.to,
      fb,
      tb,
      slots: [],
      chans: [],
      xs: [],
    };
    const pair = bundleKey[seq]!;
    // 右へ: 間の列（ca+1〜cb-1）を左から。戻る（同じ列も）: 送る側の列から受ける側の列まで（ca〜cb）を右から
    const dcols: number[] = [];
    if (cb > ca) for (let k = ca + 1; k < cb; k++) dcols.push(k);
    else for (let k = ca; k >= cb; k--) dcols.push(k);
    for (const [i, k] of dcols.entries()) {
      const key = `${k}|${pair}`;
      let b = bundles.get(key);
      if (!b) {
        b = {
          kind: 'bundle',
          key,
          seq: bundles.size,
          col: k,
          slots: [],
          h: 0,
          y: 0,
          tpl: [],
          att: [],
          attPins: [],
          bary: 0,
          rank: 0,
          ty: 0,
          stamp: -1,
          sy: 0,
        };
        bundles.set(key, b);
      }
      const slot = { chain: c, idx: i, bundle: b, pos: b.slots.length };
      b.slots.push(slot);
      c.slots.push(slot);
    }
    // 区間ごとの通り道。右へ: 出口の右（ca+1）から入口の左（cb）まで。戻る: 出口の右（ca+1）、通過点の列 k の左（k）を順に
    if (cb > ca) for (let k = ca + 1; k <= cb; k++) c.chans.push(k);
    else c.chans = [ca + 1, ...dcols];
    fb.ends.push({ chain: c, side: 'from' });
    tb.ends.push({ chain: c, side: 'to' });
    return c;
  });
  for (const b of bundles.values()) b.h = (b.slots.length - 1) * cfg.pitch;

  // --- 列の中の順と縦の位置 ---
  const cols: Elem[][] = Array.from({ length: C }, () => []);
  for (const b of boxes) cols[b.col]!.push(b);
  // 初めは宣言の順に積む（通過点の初めの y を決めるためだけ）
  for (const col of cols) {
    let y = TOP;
    for (const b of col as LBox[]) {
      b.y = y + (b.host ? HOST_HEAD + HOST_PAD : 0);
      y = b.y + b.h + GAP_BOX;
    }
  }
  // 通過点の初めの y は、線の両端のピンの y を列の数で割った位置
  const pinY = (b: LBox, ref: string) => b.y + (b.off.get(ref) ?? b.h / 2);
  for (const b of bundles.values()) {
    let sum = 0;
    for (const s of b.slots) {
      const c = s.chain;
      const y0 = pinY(c.fb, c.from.ref);
      const y1 = pinY(c.tb, c.to.ref);
      sum += y0 + ((y1 - y0) * (s.idx + 1)) / (c.slots.length + 1);
    }
    b.y = sum / b.slots.length;
    cols[b.col]!.push(b);
  }
  const placer = new Placer(cols, cfg);
  for (const b of bundles.values()) b.rank = boxes.length + b.seq;
  for (let k = 0; k < C; k++) {
    placer.initOrder(k);
    placer.stack(k);
  }

  const endsAt = new Map<string, ChainEnd[]>();
  for (const b of boxes)
    for (const e of b.ends) {
      const ref = e.side === 'from' ? e.chain.from.ref : e.chain.to.ref;
      const list = endsAt.get(ref);
      if (list) list.push(e);
      else endsAt.set(ref, [e]);
    }
  /** 箱の中の項目: 相手の点の y の重心で、口の中だけ親の順を入れ替える（子は親の直後、口の順は固定） */
  const itemPlan = boxes.map((b) => {
    const portOrder = new Map(b.n.node.ports.map((p, i) => [p.id, i]));
    return (['in', 'out'] as const).map((dir) => ({
      dir,
      roots: b.n.roots
        .filter((i) => i.dir === dir)
        .map((it, i) => {
          const near: ChainPoint[] = [];
          for (const d of [it, ...it.descendants])
            for (const e of endsAt.get(d.ref) ?? []) {
              const c = e.chain;
              near.push(pointOf(c, e.side === 'from' ? 1 : c.slots.length));
            }
          return { it, i, port: portOrder.get(it.port.id) ?? 0, near, key: 0 };
        }),
    }));
  });
  const reorderItems = () => {
    boxes.forEach((b, bi) => {
      for (const side of itemPlan[bi]!) {
        for (const r of side.roots) {
          let sum = 0;
          for (const p of r.near) sum += placer.yOf(p);
          r.key = r.near.length ? sum / r.near.length : b.y + (b.off.get(r.it.ref) ?? 0);
        }
        const sorted = [...side.roots].sort(
          (a, c) => a.port - c.port || a.key - c.key || a.i - c.i,
        );
        const col = columnOf(
          b.n,
          side.dir,
          sorted.map((k) => k.it),
        );
        if (side.dir === 'in') b.ins = col;
        else b.outs = col;
      }
      measure(b, cfg.rowH);
      refreshPins(b);
    });
  };

  for (let round = 0; round < ROUNDS; round++) {
    // 往復ごとに隣り合う列の間の交差を数え、いちばん少なかった並びを残す
    let best = placer.snapshot();
    let bestX = placer.score();
    let stale = 0;
    for (let s = 0; s < SWEEPS; s++) {
      for (let k = 1; k < C; k++) {
        placer.reorder(k, 'L');
        placer.stack(k);
      }
      for (let k = C - 2; k >= 0; k--) {
        placer.reorder(k, 'R');
        placer.stack(k);
      }
      const x = placer.score();
      if (x < bestX) {
        bestX = x;
        best = placer.snapshot();
        stale = 0;
      } else if (++stale >= STALE) break; // 良くならない往復が続いたら打ち切る（収束）
    }
    placer.restore(best);
    // 往復で届かない並び（同じ列の中の線が近づく入れ替え・束の上下）を、塊を割らずに探す（最後の回だけ。速さのため）
    if (round === ROUNDS - 1) placer.refine();
    for (const b of bundles.values()) placer.sortSlots(b);
    reorderItems();
    placer.position();
    for (const b of bundles.values()) placer.sortSlots(b);
  }
  return { cfg, m, ends, specs, chains, cols, placer };
}

/**
 * 配線図のレイアウト。箱は常に全部の項目を開く（子は親の直後）。分岐の状態・選択には依らない。
 * 1. レーン = runtime（箱のあるレーンだけ）。host に指された箱は箱ではなく枠（中の箱の塊は 1 つのレーン）
 * 2. 層: 同じレーンの単位（箱か host の塊）どうしの、呼び出しの向きの線の最長経路
 * 3. 列: 1 レーン = 1 列から、いちばん高い列を層の境目で割って 16:10 に近づける
 * 4. 2 つ以上の列をまたぐ線・戻る線には、間の列ごとに高さ 0 の通過点（同じ 2 箱の間の線の通過点は束にする）
 * 5. 列の中の順は重心（8 往復。初めの順も host・group の塊を割らない）と、最後の回の入れ替え（悪さが減るものを残す）。
 *    縦の位置は PAVA（左右の平均）。項目は相手の並びに合わせて並べ替える。3 回
 * 6. 列の幅はいちばん広い箱、通り道の幅は縦の区間のトラックの数 × 間隔 ＋ 余白。経路は通過点の y を順に通る
 */
export function layoutWiring(index: GraphIndex, options: LayoutOptions = {}): WiringLayout {
  const { cfg, m, ends, specs, chains, cols, placer } = arrange(index, options);
  const { boxes, boxOf } = m;

  // --- 列と通り道の x、経路 ---
  const cx = placeX(cols, chains, cfg, (c, i) => placer.yOf(pointOf(c, i)));
  for (const b of boxes) b.x = cx.colX[b.col]!;

  const pins = new Map<string, Pin>();
  for (const b of boxes)
    for (const it of b.n.items) {
      const o = b.off.get(it.ref);
      if (o === undefined) continue;
      pins.set(it.ref, { x: it.dir === 'in' ? b.x : b.x + b.w, y: b.y + o, side: it.dir });
    }

  const plans = new Map<string, RoutePlan>();
  for (const c of chains) {
    plans.set(c.key, {
      chans: [...c.chans],
      gaps: c.slots.map((s) => `${s.bundle.col}:${s.bundle.seq}:${s.pos}`),
      xs: [...c.xs],
      ys: c.slots.map((s) => s.bundle.y + s.pos * cfg.pitch),
    });
  }
  const routes = new Map<string, Route>();
  for (const w of m.wires)
    routes.set(
      w.key,
      toRoute(routeBetween(plans.get(w.key)!, pins.get(w.from.ref)!, pins.get(w.to.ref)!)),
    );
  const broken: BrokenRoute[] = ends.map((e) => {
    const a = pins.get(e.from.ref)!;
    const t = pins.get(e.to.ref)!;
    const tb = boxOf.get(e.to.node.id)!;
    return {
      key: e.key,
      wire: e.wire.key,
      from: e.from.ref,
      to: e.to.ref,
      path: e.broken.path,
      level: e.broken.level,
      reason: e.broken.reason,
      route: toRoute(routeBetween(plans.get(e.key)!, a, { x: tb.x - BROKEN_CUT, y: t.y })),
    };
  });

  // --- 結果 ---
  const channels: Channel[] = cx.chW.map((w, i) => ({ x: cx.chX[i]!, w, mid: cx.chX[i]! + w / 2 }));
  const columns: ColumnLayout[] = specs.map((s, i) => ({
    index: i,
    lane: s.lane,
    x: cx.colX[i]!,
    w: cx.colW[i]!,
  }));
  const width = cx.width;
  const lanes: LaneLayout[] = m.used.map((d, i) => {
    const def = LANES[d]!;
    const cs = columns.filter((c) => c.lane === i).map((c) => c.index);
    const first = cs[0]!;
    const last = cs[cs.length - 1]!;
    const x = cx.colX[first]!;
    return {
      id: def.id,
      name: def.name,
      index: i,
      x,
      w: cx.colX[last]! + cx.colW[last]! - x,
      x0: i === 0 ? 0 : channels[first]!.mid,
      x1: i === m.used.length - 1 ? width : channels[last + 1]!.mid,
      columns: cs,
    };
  });

  const hosts = new Map<string, HostLayout>();
  for (const id of m.hostIds) {
    const g = m.hostMembers.get(id)!;
    // 引数の展開は使わない（中の箱が 10 万を超えると RangeError）
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const b of g) {
      x0 = Math.min(x0, b.x);
      y0 = Math.min(y0, b.y);
      x1 = Math.max(x1, b.x + b.w);
      y1 = Math.max(y1, b.y + b.h);
    }
    const x = x0 - HOST_PAD;
    const y = y0 - HOST_HEAD;
    hosts.set(id, {
      id,
      members: g.map((b) => b.id),
      x,
      y,
      w: x1 - x + HOST_PAD,
      h: y1 - y + HOST_PAD,
    });
  }

  const outBoxes = new Map<string, BoxLayout>();
  for (const b of boxes) {
    outBoxes.set(b.id, {
      id: b.id,
      lane: b.lane,
      col: b.col,
      x: b.x,
      y: b.y,
      w: b.w,
      h: b.h,
      ...(b.scr ? { screen: { x: b.x + b.scr.x, y: b.y + b.scr.y, w: b.scr.w, h: b.scr.h } } : {}),
      ins: b.ins.map((i) => (i ? i.ref : null)),
      outs: b.outs.map((i) => (i ? i.ref : null)),
    });
  }

  // 高さは箱・枠・全部の経路を覆う
  let maxBottom = TOP;
  for (const b of boxes) maxBottom = Math.max(maxBottom, b.y + b.h);
  for (const h of hosts.values()) maxBottom = Math.max(maxBottom, h.y + h.h);
  for (const r of routes.values()) for (const p of r.points) maxBottom = Math.max(maxBottom, p.y);
  for (const br of broken) for (const p of br.route.points) maxBottom = Math.max(maxBottom, p.y);

  return {
    width,
    height: maxBottom + BOTTOM_PAD,
    titleY: TITLE_Y,
    lanes,
    columns,
    channels,
    boxes: outBoxes,
    pins,
    hosts,
    plans,
    routes,
    broken,
  };
}
