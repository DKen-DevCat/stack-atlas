// レーンを列に割る（docs/18 §3.1 の 2・4）。最初は 1 レーン = 1 列。図の縦横比が目標（16:10）より縦長なら、
// いちばん高い列を層の境目（層の高さの累積がほぼ半分になる所）で 1 つ割る。目標に近づかなくなるか、割れる境目が
// 無くなるまで繰り返す。host の塊はふつう列の中の 1 つの単位で、いちばん高い列の中の塊を割るほうが目標に近づくなら、
// 塊だけの列（中の層で割る）にする（外の箱は塊の列に入らないので、枠が外の箱に重ならない）
import {
  GAP_BOX,
  HOST_HEAD,
  HOST_PAD,
  MARGIN,
  MIN_CHANNEL,
  ML,
  TOP,
  BOTTOM_PAD,
  type Cfg,
  type LBox,
  type Model,
} from './model.js';

export interface ColSpec {
  lane: number;
  /** shared: レーンの層 lo〜hi の単位（塊だけの列にした host を除く）。host: その host の中の層 lo〜hi の箱 */
  kind: 'shared' | 'host';
  lo: number;
  hi: number;
  host: string | null;
}

/** 列の割り当ての材料 */
export interface ColInput {
  model: Model;
  cfg: Cfg;
  /** 単位の層（外の配置） */
  unitLayer: Map<string, number>;
  /** host の id → 中の層の数 */
  hostDepth: Map<string, number>;
  /** 線の両端の箱（線と切れている線）と、束の番号（同じ束になる線は同じ番号） */
  ends: { fb: LBox; tb: LBox; pair: number }[];
}

const specKey = (s: ColSpec, inp: ColInput): number[] => {
  if (s.kind === 'shared') return [s.lane, s.lo, 0, 0, 0];
  const u = inp.model.hostMembers.get(s.host!)![0]!.unit;
  return [s.lane, inp.unitLayer.get(u.id)!, 1, u.decl, s.lo];
};

export function sortSpecs(specs: ColSpec[], inp: ColInput): ColSpec[] {
  const keys = new Map(specs.map((s) => [s, specKey(s, inp)]));
  return [...specs].sort((a, b) => {
    const ka = keys.get(a)!;
    const kb = keys.get(b)!;
    for (let i = 0; i < ka.length; i++) if (ka[i] !== kb[i]) return ka[i]! - kb[i]!;
    return 0;
  });
}

/** 箱 → 列（specs の index） */
export type ColOf = Map<LBox, number>;

/**
 * 箱 → 列（specs の順の index）。列はレーンごと（shared）・host ごと（塊だけの列）に層の範囲が重ならないので、
 * 範囲の始まりの順に並べて二分探索する（列ごとに全部の箱を探すと 箱 × 列）
 */
export function assignColumns(specs: ColSpec[], inp: ColInput): ColOf {
  const byKey = new Map<string, number[]>();
  specs.forEach((s, i) => {
    const k = s.kind === 'host' ? `h:${s.host}` : `s:${s.lane}`;
    const list = byKey.get(k);
    if (list) list.push(i);
    else byKey.set(k, [i]);
  });
  for (const list of byKey.values()) list.sort((a, b) => specs[a]!.lo - specs[b]!.lo);
  const find = (list: number[] | undefined, l: number): number => {
    if (!list) return -1;
    // lo ≤ l の最後の列
    let lo = 0;
    let hi = list.length;
    while (lo < hi) {
      const m = (lo + hi) >> 1;
      if (specs[list[m]!]!.lo <= l) lo = m + 1;
      else hi = m;
    }
    const ci = lo > 0 ? list[lo - 1]! : -1;
    return ci >= 0 && l <= specs[ci]!.hi ? ci : -1;
  };
  const out: ColOf = new Map();
  for (const b of inp.model.boxes) {
    const own = b.host ? byKey.get(`h:${b.host}`) : undefined;
    const ci = own
      ? find(own, b.ilayer)
      : find(byKey.get(`s:${b.lane}`), inp.unitLayer.get(b.unit.id)!);
    if (ci < 0) throw new Error(`列が決まらない: ${b.id}`);
    out.set(b, ci);
  }
  return out;
}

export interface Estimate {
  width: number;
  height: number;
  colH: number[];
}

/** 配置せずに見積もる幅と高さ（箱の高さ・隙間・通過点の数・通り道を通る線の数から）。colOf は specs の割り当て */
export function estimate(
  specs: ColSpec[],
  inp: ColInput,
  colOf: ColOf = assignColumns(specs, inp),
): Estimate {
  const { cfg } = inp;
  const C = specs.length;
  const colH = new Array<number>(C).fill(0);
  const colW = new Array<number>(C).fill(cfg.boxW);
  const count = new Array<number>(C).fill(0);
  const hostsIn = Array.from({ length: C }, () => new Set<string>());
  for (const [b, c] of colOf) {
    colH[c]! += b.h;
    count[c]!++;
    colW[c] = Math.max(colW[c]!, b.w);
    if (b.host) hostsIn[c]!.add(b.host);
  }
  const slots = new Array<number>(C).fill(0);
  const bundles = Array.from({ length: C }, () => new Set<number>());
  const links = new Array<number>(C + 1).fill(0);
  for (const { fb, tb, pair } of inp.ends) {
    const ca = colOf.get(fb)!;
    const cb = colOf.get(tb)!;
    const [d0, d1, c0, c1] = cb > ca ? [ca + 1, cb - 1, ca + 1, cb] : [cb, ca, cb, ca + 1];
    for (let c = d0; c <= d1; c++) {
      slots[c]!++;
      bundles[c]!.add(pair);
    }
    for (let c = c0; c <= c1; c++) links[c]!++;
  }
  let H = 0;
  for (let c = 0; c < C; c++) {
    const h =
      colH[c]! +
      Math.max(0, count[c]! - 1) * GAP_BOX +
      hostsIn[c]!.size * (HOST_HEAD + 2 * HOST_PAD) +
      slots[c]! * cfg.pitch +
      bundles[c]!.size * cfg.pitch;
    colH[c] = h;
    H = Math.max(H, h);
  }
  let W = 2 * ML;
  for (let c = 0; c < C; c++) W += colW[c]!;
  // 通り道の線は重ならない区間を同じトラックに詰めるので、線の数の半分ほどのトラックになる
  for (let c = 0; c <= C; c++) W += Math.max(MIN_CHANNEL, links[c]! * cfg.pitch * 0.5 + MARGIN);
  return { width: W, height: TOP + H + BOTTOM_PAD, colH };
}

/** 層ごとの高さ（列の中の単位の箱の高さと隙間） */
function layerHeights(spec: ColSpec, inp: ColInput, colBoxes: LBox[]): Map<number, number> {
  const out = new Map<number, number>();
  for (const b of colBoxes) {
    const l = spec.kind === 'host' ? b.ilayer : inp.unitLayer.get(b.unit.id)!;
    out.set(l, (out.get(l) ?? 0) + b.h + GAP_BOX);
  }
  return out;
}

/** 層の高さの累積がほぼ半分になる境目 b（lo〜b と b+1〜hi に割る） */
function halfBoundary(spec: ColSpec, heights: Map<number, number>): number | null {
  if (spec.lo >= spec.hi) return null;
  let total = 0;
  for (let l = spec.lo; l <= spec.hi; l++) total += heights.get(l) ?? 0;
  let best: number | null = null;
  let bestD = Infinity;
  let cum = 0;
  for (let l = spec.lo; l < spec.hi; l++) {
    cum += heights.get(l) ?? 0;
    const d = Math.abs(cum - total / 2);
    if (d < bestD) {
      bestD = d;
      best = l;
    }
  }
  return best;
}

const off = (a: number, target: number) => Math.abs(Math.log(a / target));

/**
 * 箱の無い列を落とす（塊を抜いた後の shared の列など。見積もりに空の列の幅を数えない）。
 * 箱 → 列の割り当ても返す（見積もりと次の回で使い回す。割り当ては 1 つの割り方に 1 回だけ）
 */
function prune(
  specs: ColSpec[],
  inp: ColInput,
  colOf: ColOf = assignColumns(specs, inp),
): { specs: ColSpec[]; colOf: ColOf } {
  const used = new Set(colOf.values());
  if (used.size === specs.length) return { specs, colOf };
  const index = new Array<number>(specs.length).fill(-1);
  const kept: ColSpec[] = [];
  specs.forEach((s, i) => {
    if (!used.has(i)) return;
    index[i] = kept.length;
    kept.push(s);
  });
  for (const [b, c] of colOf) colOf.set(b, index[c]!);
  return { specs: kept, colOf };
}

/** 列の割り方を決める（列と、箱 → 列の割り当て） */
export function splitColumns(inp: ColInput): { specs: ColSpec[]; colOf: ColOf } {
  const { model, cfg } = inp;
  const maxLayer = new Map<number, number>();
  for (const u of model.units)
    maxLayer.set(u.lane, Math.max(maxLayer.get(u.lane) ?? 0, inp.unitLayer.get(u.id)!));
  let specs: ColSpec[] = sortSpecs(
    model.used.map((_, lane) => ({
      lane,
      kind: 'shared' as const,
      lo: 0,
      hi: maxLayer.get(lane) ?? 0,
      host: null,
    })),
    inp,
  );
  let colOf = assignColumns(specs, inp);
  let est = estimate(specs, inp, colOf);
  for (let iter = 0; iter < model.boxes.length * 2 + 4; iter++) {
    const aspect = est.width / est.height;
    if (aspect >= cfg.aspect) break;
    // いちばん高い列（同じなら左）
    let t = 0;
    est.colH.forEach((h, c) => {
      if (h > est.colH[t]!) t = c;
    });
    const spec = specs[t]!;
    const colBoxes = [...colOf].filter(([, c]) => c === t).map(([b]) => b);
    const candidates: ColSpec[][] = [];
    const b = halfBoundary(spec, layerHeights(spec, inp, colBoxes));
    if (b !== null) {
      const rest = specs.filter((s) => s !== spec);
      candidates.push(sortSpecs([...rest, { ...spec, hi: b }, { ...spec, lo: b + 1 }], inp));
    }
    if (spec.kind === 'shared') {
      // 列の中の塊のうち、中の層が 2 つ以上でいちばん高いものを塊だけの列にする
      const hostH = new Map<string, number>();
      for (const x of colBoxes)
        if (x.host && (inp.hostDepth.get(x.host) ?? 1) > 1)
          hostH.set(x.host, (hostH.get(x.host) ?? 0) + x.h + GAP_BOX);
      let host: string | null = null;
      for (const [h, v] of hostH) if (host === null || v > hostH.get(host)!) host = h;
      if (host !== null) {
        const members = model.hostMembers.get(host)!;
        const hl = inp.unitLayer.get(members[0]!.unit.id)!;
        const hs: ColSpec = {
          lane: spec.lane,
          kind: 'host',
          lo: 0,
          hi: inp.hostDepth.get(host)! - 1,
          host,
        };
        const hb = halfBoundary(hs, layerHeights(hs, inp, members))!;
        const rest = specs.filter((s) => s !== spec);
        const parts: ColSpec[] = [{ ...spec, hi: hl }];
        if (hl < spec.hi) parts.push({ ...spec, lo: hl + 1 });
        // 塊を抜いた後の shared の列が空になることがある（見積もりの前に落とす）
        candidates.push(
          sortSpecs([...rest, ...parts, { ...hs, hi: hb }, { ...hs, lo: hb + 1 }], inp),
        );
      }
    }
    if (!candidates.length) break;
    let best: { specs: ColSpec[]; colOf: ColOf; est: Estimate } | null = null;
    for (const raw of candidates) {
      const c = prune(raw, inp);
      const e = estimate(c.specs, inp, c.colOf);
      if (
        !best ||
        off(e.width / e.height, cfg.aspect) < off(best.est.width / best.est.height, cfg.aspect)
      )
        best = { ...c, est: e };
    }
    if (!best || off(best.est.width / best.est.height, cfg.aspect) >= off(aspect, cfg.aspect))
      break;
    specs = best.specs;
    colOf = best.colOf;
    est = best.est;
  }
  return prune(specs, inp, colOf);
}
