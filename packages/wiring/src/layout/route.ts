// 列の幅・通り道の幅と、線の縦の区間のトラック（docs/18 §3.1 の 8・9）。
// 縦の区間は通り道の中のトラックに左詰めで割り当てる（区間が重なるものは同じトラックに置かない）。
// 交差が減る順に詰める: 両端が左の列にある区間（C の字）を短い順 → 左から右へ下りる区間を左端の y が下の順 →
// 上る区間を左端の y が上の順 → 両端が右の列にある区間（逆 C の字）を長い順
// （C の字は内側ほど左、逆 C の字は内側ほど右、下りる Z は左端が下のものほど左にすると、横の区間が縦の区間を横切らない）
import {
  MARGIN,
  MIN_CHANNEL,
  ML,
  pointCol,
  pointOf,
  type Cfg,
  type Chain,
  type Elem,
} from './model.js';

interface VSeg {
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
  const eps = cfg.pitch / 2;
  for (let ch = 0; ch <= C; ch++) {
    const segs = perChan[ch]!.filter((s) => s.hi > s.lo);
    const seq = (s: VSeg) => s.chain.seq * 64 + s.j;
    const ll = segs
      .filter((s) => s.shape === 'LL')
      .sort((a, b) => a.hi - a.lo - (b.hi - b.lo) || a.lo - b.lo || seq(a) - seq(b));
    const down = segs
      .filter((s) => s.shape === 'LR' && s.yl < s.yr)
      .sort((a, b) => b.yl - a.yl || b.yr - a.yr || seq(a) - seq(b));
    const up = segs
      .filter((s) => s.shape === 'LR' && s.yl > s.yr)
      .sort((a, b) => a.yl - b.yl || a.yr - b.yr || seq(a) - seq(b));
    const rr = segs
      .filter((s) => s.shape === 'RR')
      .sort((a, b) => b.hi - b.lo - (a.hi - a.lo) || a.lo - b.lo || seq(a) - seq(b));
    const tracks: VSeg[][] = [];
    // 左詰め。ただし区間が重なる線どうしは上の順を保つ（先に置いたものより右のトラックへ）。
    // 重ならない線は左のトラックを分け合う（最初に空いたトラックへ詰めると、交差が 1.6 倍になった。基準の graph で 470 → 771）
    for (const s of [...ll, ...down, ...up, ...rr]) {
      let t = 0;
      for (let u = tracks.length - 1; u >= 0; u--)
        if (tracks[u]!.some((o) => o.lo < s.hi + eps && s.lo < o.hi + eps)) {
          t = u + 1;
          break;
        }
      while (tracks.length <= t) tracks.push([]);
      tracks[t]!.push(s);
      s.track = t;
    }
    nTracks.push(tracks.length);
    chW.push(Math.max(MIN_CHANNEL, tracks.length * cfg.pitch + MARGIN));
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
    const x0 = chX[ch]! + (w - nTracks[ch]! * cfg.pitch) / 2 + cfg.pitch / 2;
    // 縦の区間の無いもの（左右の高さが同じ）は通り道の中央をまっすぐ横切る
    for (const s of perChan[ch]!)
      s.chain.xs[s.j] = s.track < 0 ? chX[ch]! + w / 2 : x0 + s.track * cfg.pitch;
  }
  return { colX, colW, chX, chW, width: x + ML };
}
