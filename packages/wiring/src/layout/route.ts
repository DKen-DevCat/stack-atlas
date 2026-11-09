// 列の幅・通り道の幅と、線の縦の区間のトラック（docs/18 §3.1 の 8・9）。
// 縦の区間は通り道の中のトラックに左詰めで割り当てる（区間が重なるものは同じトラックに置かない）。
// 交差が減る順に詰める: 両端が左の列にある区間（C の字）を短い順 → 左から右へ下りる区間を左端の y が下の順 →
// 上る区間を左端の y が上の順 → 両端が右の列にある区間（逆 C の字）を長い順
// （C の字は内側ほど左、逆 C の字は内側ほど右、下りる Z は左端が下のものほど左にすると、横の区間が縦の区間を横切らない）
// 切れている線の最後の通り道は、いちばん右のトラックと受ける側の箱の間に 2 × BROKEN_CUT を空ける
// （切る印は箱の BROKEN_CUT 手前。線は印の手前で BROKEN_CUT 以上の横の区間で終わり、印は縦の区間に重ならない）
import {
  BROKEN_CUT,
  MARGIN,
  MIN_CHANNEL,
  ML,
  pointCol,
  pointOf,
  type Cfg,
  type Chain,
  type Elem,
} from './model.js';

export interface VSeg {
  chain: Chain;
  /** 区間の番号（chain.chans の index） */
  j: number;
  lo: number;
  hi: number;
  /** 両端がどちら側の列にあるか */
  shape: 'LL' | 'RR' | 'LR';
  /** 左側の端の y（LR のみ） */
  yl: number;
  yr: number;
  track: number;
}

export interface Columns {
  colX: number[];
  colW: number[];
  chX: number[];
  chW: number[];
  width: number;
}

/** 列と通り道の x を決め、線の区間ごとの x（chain.xs）を埋める */
export function placeX(
  cols: Elem[][],
  chains: Chain[],
  cfg: Cfg,
  yOf: (c: Chain, i: number) => number,
): Columns {
  const C = cols.length;
  // 列の幅はいちばん幅の広い箱（箱の無い列は作らないが、念のため既定の幅）
  const colW = cols.map(
    (col) => col.reduce((w, e) => (e.kind === 'box' ? Math.max(w, e.w) : w), 0) || cfg.boxW,
  );
  const perChan: VSeg[][] = Array.from({ length: C + 1 }, () => []);
  for (const c of chains) {
    c.xs = new Array<number>(c.chans.length).fill(0);
    for (let j = 0; j < c.chans.length; j++) {
      const ch = c.chans[j]!;
      const pa = pointOf(c, j);
      const pb = pointOf(c, j + 1);
      const ya = yOf(c, j);
      const yb = yOf(c, j + 1);
      const sa = pointCol(pa) === ch - 1 ? 'L' : 'R';
      const sb = pointCol(pb) === ch - 1 ? 'L' : 'R';
      const shape = sa === sb ? (sa === 'L' ? 'LL' : 'RR') : 'LR';
      const yl = sa === 'L' ? ya : yb;
      const yr = sa === 'L' ? yb : ya;
      perChan[ch]!.push({
        chain: c,
        j,
        lo: Math.min(ya, yb),
        hi: Math.max(ya, yb),
        shape,
        yl,
        yr,
        track: -1,
      });
    }
  }
  const chW: number[] = [];
  const nTracks: number[] = [];
  /** 通り道の左端から最初のトラックまで */
  const inset: number[] = [];
  // 切れている線の最後の区間がある通り道
  const cutAt = new Set<number>();
  for (const c of chains) if (c.cut && c.chans.length) cutAt.add(c.chans[c.chans.length - 1]!);
  const eps = cfg.pitch / 2;
  for (let ch = 0; ch <= C; ch++) {
    const segs = perChan[ch]!.filter((s) => s.hi > s.lo);
    const ll = segs
      .filter((s) => s.shape === 'LL')
      .sort((a, b) => a.hi - a.lo - (b.hi - b.lo) || a.lo - b.lo || bySeq(a, b));
    const down = segs
      .filter((s) => s.shape === 'LR' && s.yl < s.yr)
      .sort((a, b) => b.yl - a.yl || b.yr - a.yr || bySeq(a, b));
    const up = segs
      .filter((s) => s.shape === 'LR' && s.yl > s.yr)
      .sort((a, b) => a.yl - b.yl || a.yr - b.yr || bySeq(a, b));
    const rr = segs
      .filter((s) => s.shape === 'RR')
      .sort((a, b) => b.hi - b.lo - (a.hi - a.lo) || a.lo - b.lo || bySeq(a, b));
    const n = assignTracks([...ll, ...down, ...up, ...rr], eps);
    const w0 = Math.max(MIN_CHANNEL, n * cfg.pitch + MARGIN);
    const x0 = (w0 - n * cfg.pitch) / 2 + cfg.pitch / 2;
    // いちばん右のトラックから通り道の右端まで（切れている線の通り道は 2 × BROKEN_CUT 以上にする）
    const right = w0 - x0 - (n - 1) * cfg.pitch;
    const pad = n && cutAt.has(ch) ? Math.max(0, 2 * BROKEN_CUT - right) : 0;
    nTracks.push(n);
    inset.push(x0);
    chW.push(w0 + pad);
  }
  const chX: number[] = [];
  const colX: number[] = [];
  let x = ML;
  for (let k = 0; k <= C; k++) {
    chX.push(x);
    x += chW[k]!;
    if (k < C) {
      colX.push(x);
      x += colW[k]!;
    }
  }
  for (let ch = 0; ch <= C; ch++) {
    const w = chW[ch]!;
    const x0 = chX[ch]! + inset[ch]!;
    // 縦の区間の無いもの（左右の高さが同じ）は通り道の中央をまっすぐ横切る
    for (const s of perChan[ch]!)
      s.chain.xs[s.j] = s.track < 0 ? chX[ch]! + w / 2 : x0 + s.track * cfg.pitch;
  }
  return { colX, colW, chX, chW, width: x + ML };
}

/** 同点の区間は線の順、同じ線なら区間の順（数を 1 つにまとめると、区間が 64 を超える線で順が食い違う） */
export const bySeq = (a: VSeg, b: VSeg) => a.chain.seq - b.chain.seq || a.j - b.j;

/**
 * 縦の区間を順にトラックへ: 先に置いた区間のうち、縦に重なる（eps 未満の隙間も重なりとみる）もののトラックの最大 + 1、
 * 重なるものが無ければ 0（左詰め。重なる線どうしは並べた順を保つ）。トラックの数を返す。
 * 重ならない線は左のトラックを分け合う（最初に空いたトラックへ詰めると交差が 1.6 倍になった。8-3a の基準の graph で 470 → 771）。
 * 区間を半開区間 [lo, hi + eps) とみて端の y を座標圧縮し、区間の最大を返す・区間を最大で塗るセグメント木で解く
 * （トラックごとに置いた区間を全部見ると、重ならない区間が N 本あるだけで N² になる）
 */
export function assignTracks(segs: readonly VSeg[], eps: number): number {
  const n = segs.length;
  if (!n) return 0;
  const coords = new Float64Array(2 * n);
  for (let i = 0; i < n; i++) {
    coords[2 * i] = segs[i]!.lo;
    coords[2 * i + 1] = segs[i]!.hi + eps;
  }
  coords.sort();
  let m = 0;
  for (let i = 0; i < coords.length; i++)
    if (i === 0 || coords[i] !== coords[m - 1]) coords[m++] = coords[i]!;
  const at = (v: number) => {
    let lo = 0;
    let hi = m;
    while (lo < hi) {
      const k = (lo + hi) >> 1;
      if (coords[k]! < v) lo = k + 1;
      else hi = k;
    }
    return lo;
  };
  // 葉 i は座標の間 [coords[i], coords[i+1])。tag は節の範囲全体を塗った値、max は節の下のどこかを塗った値の最大
  const L = Math.max(1, m - 1);
  let size = 1;
  while (size < L) size <<= 1;
  const tag = new Int32Array(2 * size).fill(-1);
  const max = new Int32Array(2 * size).fill(-1);
  const query = (node: number, nl: number, nr: number, l: number, r: number): number => {
    if (r <= nl || nr <= l) return -1;
    if (l <= nl && nr <= r) return max[node]!;
    const mid = (nl + nr) >> 1;
    return Math.max(tag[node]!, query(2 * node, nl, mid, l, r), query(2 * node + 1, mid, nr, l, r));
  };
  const paint = (node: number, nl: number, nr: number, l: number, r: number, v: number) => {
    if (r <= nl || nr <= l) return;
    if (v > max[node]!) max[node] = v;
    if (l <= nl && nr <= r) {
      if (v > tag[node]!) tag[node] = v;
      return;
    }
    const mid = (nl + nr) >> 1;
    paint(2 * node, nl, mid, l, r, v);
    paint(2 * node + 1, mid, nr, l, r, v);
  };
  let tracks = 0;
  for (const s of segs) {
    const l = at(s.lo);
    const r = at(s.hi + eps);
    const t = query(1, 0, size, l, r) + 1;
    paint(1, 0, size, l, r, t);
    s.track = t;
    if (t + 1 > tracks) tracks = t + 1;
  }
  return tracks;
}
