// 列の中の順と縦の位置（docs/18 §3.1 の 6・7）。列には箱と通過点の束を積む。
// 順: 初めは宣言の順。左右交互に、項目のピンの y の重心で並べ直す（同じ group・同じ host の箱は隣り合わせる）。
// 往復ごとに隣り合う列の間の交差を数え、いちばん少なかった並びを残す。
// 縦の位置: 左から右へ、つながっている相手のピンの y の中央値を目標に、順序を保ったまま重なりを最小の移動で解く（PAVA）。
// 右から左へも同じことをして、2 つの解の平均を取る（制約が線形なので平均も重ならない）。
// 戻る線の折り返し（同じ列の箱のピンにつながる通過点）は、その箱の上か下に付けて並べる（箱と通過点が互いの位置を
// 追いかけて順が揺れないように）。箱の重心は、付けた通過点の先（隣の列の点）と、同じ列の相手の箱の重心を見る
import {
  DUMMY_TOP,
  GAP_BOX,
  GAP_BOX_DUMMY,
  GAP_DUMMY_BOX,
  HOST_HEAD,
  HOST_PAD,
  TOP,
  pointCol,
  pointOf,
  type Bundle,
  type Cfg,
  type ChainPoint,
  type Elem,
  type LBox,
  type Tpl,
} from './model.js';

/** 同じ列の中で閉じる線の縦の長さを、交差 1 つと同じ重さに数える長さ */
const SAME_COLUMN_PX = 200;

/** 列の中で隣り合わせる単位（host か group）。host の中は group ごと */
interface Unit {
  members: LBox[];
  subs: Unit[] | null;
  bary: number;
  rank: number;
}

function makeUnits(boxes: LBox[], key: (b: LBox) => string): Unit[] {
  const m = new Map<string, LBox[]>();
  for (const b of boxes) {
    const k = key(b);
    const g = m.get(k);
    if (g) g.push(b);
    else m.set(k, [b]);
  }
  return [...m.values()].map((members) => ({
    members,
    subs: null,
    bary: 0,
    rank: Math.min(...members.map((b) => b.rank)),
  }));
}

export class Placer {
  private readonly pitch: number;
  /** 列ごとの単位（箱の列は変わらないので先に作る） */
  private readonly units: Unit[][];

  constructor(
    readonly cols: Elem[][],
    readonly cfg: Cfg,
  ) {
    this.pitch = cfg.pitch;
    for (const col of cols) for (const e of col) this.prepare(e);
    this.units = cols.map((col) => {
      const us = makeUnits(
        col.filter((e): e is LBox => e.kind === 'box'),
        (b) => b.ukey,
      );
      for (const u of us)
        if (u.members.length > 1 && u.members[0]!.host)
          u.subs = makeUnits(u.members, (b) => b.group);
      return us;
    });
  }

  /** 線で隣り合う点を先に引いておく（列は決まっているので変わらない） */
  private prepare(e: Elem) {
    e.tpl = [];
    if (e.kind === 'box') {
      e.same = [];
      for (const end of e.ends) {
        const c = end.chain;
        const last = c.slots.length + 1;
        const self = pointOf(c, end.side === 'from' ? 0 : last);
        const step = end.side === 'from' ? 1 : -1;
        // 同じ列の折り返しの通過点は越えて、隣の列の点を相手にする
        let found = false;
        for (let i = end.side === 'from' ? 1 : last - 1; i >= 0 && i <= last; i += step) {
          const p = pointOf(c, i);
          const col = pointCol(p);
          if (col !== e.col) {
            e.tpl.push({ self, other: p, col });
            found = true;
            break;
          }
        }
        // 同じ列の中で閉じる線（相手も同じ列の箱）
        if (!found) {
          const other = pointOf(c, end.side === 'from' ? last : 0);
          if (other.kind === 'pin' && other.box !== e) e.same.push({ self, other, col: e.col });
        }
      }
    } else {
      e.attPins = [];
      const att = new Set<LBox>();
      for (const s of e.slots) {
        const self = pointOf(s.chain, s.idx + 1);
        for (const p of [pointOf(s.chain, s.idx), pointOf(s.chain, s.idx + 2)]) {
          const col = pointCol(p);
          if (col !== e.col) e.tpl.push({ self, other: p, col });
          else if (p.kind === 'pin') {
            att.add(p.box);
            e.attPins.push({ self, other: p, col });
          }
        }
      }
      e.att = [...att].sort((a, b) => a.decl - b.decl);
    }
  }

  /** 要素の上端から、テンプレートの自分の点まで */
  private own(_e: Elem, t: Tpl): number {
    const p = t.self;
    return p.kind === 'pin' ? p.o : p.slot.pos * this.pitch;
  }

  /** 要素の高さ（束は段の数 - 1 の間隔） */
  height(e: Elem): number {
    return e.kind === 'box' ? e.h : (e.slots.length - 1) * this.pitch;
  }

  yOf(p: ChainPoint, y?: (e: Elem) => number): number {
    if (p.kind === 'pin') return (y ? y(p.box) : p.box.y) + p.o;
    return (y ? y(p.slot.bundle) : p.slot.bundle.y) + p.slot.pos * this.pitch;
  }

  /** 束の中の段を、相手の y の平均で並べ直す */
  sortSlots(b: Bundle) {
    if (b.slots.length < 2) return;
    const key = new Map(
      b.slots.map((s) => {
        const prev = pointOf(s.chain, s.idx);
        const next = pointOf(s.chain, s.idx + 2);
        return [s, (this.yOf(prev) + this.yOf(next)) / 2] as const;
      }),
    );
    b.slots.sort((p, q) => key.get(p)! - key.get(q)! || p.chain.seq - q.chain.seq);
    b.slots.forEach((s, i) => (s.pos = i));
  }

  /** 列の要素ごとの枠（その位置が host の枠の中か）。束は上下の箱が同じ host の中にあるときだけ枠の中 */
  frames(order: Elem[]): (string | null)[] {
    const n = order.length;
    const out: (string | null)[] = new Array(n);
    let last: string | null = null;
    for (let i = 0; i < n; i++) {
      const e = order[i]!;
      if (e.kind === 'box') last = e.host;
      out[i] = last;
    }
    last = null;
    for (let i = n - 1; i >= 0; i--) {
      const e = order[i]!;
      if (e.kind === 'box') last = e.host;
      else if (out[i] !== last) out[i] = null;
    }
    return out;
  }

  /** 列の要素の上端の下限（いちばん上）と、要素 i の上端から要素 0 の上端までの最小の距離 */
  offsets(order: Elem[]): { lb: number; offs: number[] } {
    const fr = this.frames(order);
    const offs: number[] = new Array(order.length);
    let acc = 0;
    for (let i = 0; i < order.length; i++) {
      const e = order[i]!;
      if (i > 0) {
        const p = order[i - 1]!;
        let gap =
          p.kind === 'box'
            ? e.kind === 'box'
              ? GAP_BOX
              : GAP_BOX_DUMMY
            : e.kind === 'box'
              ? GAP_DUMMY_BOX
              : this.pitch;
        if (fr[i] && fr[i] !== fr[i - 1]) gap += HOST_HEAD + HOST_PAD;
        if (fr[i - 1] && fr[i - 1] !== fr[i]) gap += HOST_PAD;
        acc += (p.kind === 'box' ? p.h : (p.slots.length - 1) * this.pitch) + gap;
      }
      offs[i] = acc;
    }
    const first = order[0];
    const lb = !first
      ? TOP
      : first.kind === 'box'
        ? TOP + (first.host ? HOST_HEAD + HOST_PAD : 0)
        : DUMMY_TOP;
    return { lb, offs };
  }

  /** 列を上から詰めて積む */
  stack(k: number) {
    const order = this.cols[k]!;
    const { lb, offs } = this.offsets(order);
    for (let i = 0; i < order.length; i++) order[i]!.y = lb + offs[i]!;
  }

  /** 列 k を、相手の y の重心で並べ直す（side: 'L' は左の列、'R' は右の列の相手） */
  reorder(k: number, side: 'L' | 'R') {
    const order = this.cols[k]!;
    const nb = side === 'L' ? k - 1 : k + 1;
    const free: Elem[] = [];
    const attached: Bundle[] = [];
    const withSame: LBox[] = [];
    const adjS: number[] = [];
    const adjN: number[] = [];
    for (const e of order) {
      if (e.kind === 'bundle' && e.att.length) {
        attached.push(e);
        continue;
      }
      free.push(e);
      let sum = 0;
      let n = 0;
      for (const t of e.tpl)
        if (t.col === nb) {
          sum += this.yOf(t.other);
          n++;
        }
      e.bary = n ? sum / n : e.y + this.height(e) / 2;
      if (e.kind === 'box' && e.same.length) {
        withSame.push(e);
        adjS.push(sum);
        adjN.push(n);
      }
    }
    // 同じ列の相手の箱は、相手の重心を自分の相手の点に数える（同じ物差しで比べるため、相手の y そのものは使わない）。
    // 呼ぶ箱 → 呼ばれる箱 → その先、と伝わるよう 3 回くり返す
    const next: number[] = new Array(withSame.length);
    for (let it = 0; it < 3 && withSame.length; it++) {
      withSame.forEach((e, i) => {
        let sum = adjS[i]!;
        let n = adjN[i]!;
        for (const t of e.same) {
          sum += (t.other as { box: LBox }).box.bary;
          n++;
        }
        next[i] = n ? sum / n : e.bary;
      });
      withSame.forEach((e, i) => (e.bary = next[i]!));
    }
    this.cols[k] = this.withAttached(
      sortWithGroups(
        this.units[k]!,
        free.filter((e) => e.kind === 'bundle'),
      ),
      attached,
    );
  }

  /** 初めの順: 箱と自由な束は今の y の順、折り返しは箱に付ける */
  initOrder(k: number) {
    const free = this.cols[k]!.filter((e) => e.kind === 'box' || !e.att.length);
    const attached = this.cols[k]!.filter(
      (e): e is Bundle => e.kind === 'bundle' && e.att.length > 0,
    );
    for (const e of free) e.bary = e.y + this.height(e) / 2;
    free.sort((a, b) => a.bary - b.bary || a.rank - b.rank);
    this.cols[k] = this.withAttached(free, attached);
  }

  /**
   * 折り返しの通過点を箱の上か下に差し込む。箱 1 つに付くものは、隣の列の相手が箱のピンより上なら上、下なら下
   * （箱に近い順は相手の y の順）。同じ列の 2 つの箱をつなぐものは、上の箱の下
   */
  private withAttached(seq: Elem[], attached: Bundle[]): Elem[] {
    if (!attached.length) return seq;
    for (let i = 0; i < seq.length; i++) {
      const e = seq[i]!;
      if (e.kind !== 'box') continue;
      e.pos = i;
      e.above.length = 0;
      e.below.length = 0;
    }
    for (const b of attached) {
      let pinSum = 0;
      for (const t of b.attPins) pinSum += this.yOf(t.other);
      let otherSum = 0;
      for (const t of b.tpl) otherSum += this.yOf(t.other);
      const pinN = b.attPins.length;
      const otherN = b.tpl.length;
      b.bary = otherN ? otherSum / otherN : pinN ? pinSum / pinN : b.y;
      if (b.att.length > 1) {
        b.att.reduce((a, x) => (x.pos < a.pos ? x : a)).below.push(b);
      } else {
        const host = b.att[0]!;
        if (otherN && pinN && b.bary < pinSum / pinN) host.above.push(b);
        else host.below.push(b);
      }
    }
    const out: Elem[] = [];
    for (const e of seq) {
      if (e.kind === 'box' && e.above.length) for (const x of e.above.sort(byBundle)) out.push(x);
      out.push(e);
      if (e.kind === 'box' && e.below.length) for (const x of e.below.sort(byBundle)) out.push(x);
    }
    return out;
  }

  /**
   * 並べ方の悪さ（比べるだけに使う）: 隣り合う列の間の線の交差の数（2 層の交差の数え方）に、同じ列の中で閉じる線の
   * 縦の長さ（SAME_COLUMN_PX ごとに 1）を足す（同じ列の呼ぶ・呼ばれるは交差に現れないので、離れても数が変わらない）
   */
  private readonly sa: number[] = [];
  private readonly sb: number[] = [];

  score(): number {
    let total = 0;
    const a = this.sa;
    const b = this.sb;
    for (let k = 0; k < this.cols.length; k++) {
      a.length = 0;
      b.length = 0;
      // 列の要素は上から順なので a は単調。同じ要素から出る線どうしは数えない（要素を 1 点とみる 2 層の数え方）
      for (const e of this.cols[k]!) {
        for (const t of e.tpl)
          if (t.col === k + 1) {
            a.push(e.y);
            b.push(this.yOf(t.other));
          }
        if (e.kind === 'box')
          for (const t of e.same)
            total += Math.abs(e.y + this.own(e, t) - this.yOf(t.other)) / SAME_COLUMN_PX / 2;
      }
      total += inversions(a, b);
    }
    return total;
  }

  /** 今の並びを覚える / 戻す */
  snapshot(): Elem[][] {
    return this.cols.map((c) => [...c]);
  }
  restore(s: Elem[][]) {
    s.forEach((c, k) => {
      this.cols[k] = [...c];
      this.stack(k);
    });
  }

  private passNo = 0;

  /** 縦の位置（PAVA を左右から 1 回ずつ。平均を取る） */
  position() {
    const C = this.cols.length;
    const want: number[] = [];
    // pass の中で解いた列はその解（ty）、まだの列は今の y を読む
    const pass = (dir: 'L' | 'R') => {
      const stamp = ++this.passNo;
      const y = (e: Elem) => (e.stamp === stamp ? e.ty : e.y);
      const out = new Map<Elem, number>();
      for (let s = 0; s < C; s++) {
        const k = dir === 'L' ? s : C - 1 - s;
        const nb = dir === 'L' ? k - 1 : k + 1;
        const order = this.cols[k]!;
        const targets: number[] = new Array(order.length);
        const weights: number[] = new Array(order.length);
        for (let i = 0; i < order.length; i++) {
          const e = order[i]!;
          want.length = 0;
          for (const t of e.tpl) if (t.col === nb) want.push(this.yOf(t.other, y) - this.own(e, t));
          // 折り返しの通過点は、付いた箱のピンの高さを目標にする（箱に寄り添う）
          if (e.kind === 'bundle')
            for (const t of e.attPins) want.push(this.yOf(t.other, y) - this.own(e, t));
          if (want.length) {
            targets[i] = median(want);
            weights[i] = want.length;
          } else {
            targets[i] = e.y;
            weights[i] = 1;
          }
        }
        const { lb, offs } = this.offsets(order);
        const ys = pava(targets, weights, offs, lb);
        for (let i = 0; i < order.length; i++) {
          const e = order[i]!;
          e.ty = ys[i]!;
          e.stamp = stamp;
          out.set(e, e.ty);
        }
      }
      return out;
    };
    const a = pass('L');
    const b = pass('R');
    for (const col of this.cols) for (const e of col) e.y = (a.get(e)! + b.get(e)!) / 2;
  }
}

/**
 * 組 (a[i], b[i]) で、a の順と b の順が食い違う組の数（a が同じもの・b が同じものは数えない）。
 * a は単調非減少で渡す。b を順位に直して、Fenwick 木で「先に入れた b のうち自分より大きいもの」を数える
 */
export function inversions(a: number[], b: number[]): number {
  const n = a.length;
  if (n < 2) return 0;
  const sorted = new Float64Array(n);
  for (let i = 0; i < n; i++) sorted[i] = b[i]!;
  sorted.sort();
  const rank = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    // b[i] 以下の個数（1 始まりの順位）
    const v = b[i]!;
    let lo = 0;
    let hi = n;
    while (lo < hi) {
      const m = (lo + hi) >> 1;
      if (sorted[m]! <= v) lo = m + 1;
      else hi = m;
    }
    rank[i] = lo;
  }
  const tree = new Int32Array(n + 1);
  let inv = 0;
  let seen = 0;
  for (let i = 0; i < n;) {
    let j = i;
    while (j < n && a[j] === a[i]) j++;
    for (let t = i; t < j; t++) {
      let le = 0;
      for (let x = rank[t]!; x > 0; x -= x & -x) le += tree[x]!;
      inv += seen - le;
    }
    for (let t = i; t < j; t++) {
      for (let x = rank[t]!; x <= n; x += x & -x) tree[x]!++;
      seen++;
    }
    i = j;
  }
  return inv;
}

export function median(v: number[]): number {
  if (v.length === 1) return v[0]!;
  if (v.length === 2) return (v[0]! + v[1]!) / 2;
  const s = new Float64Array(v.length);
  for (let i = 0; i < v.length; i++) s[i] = v[i]!;
  s.sort();
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

/**
 * 順序を保ったまま、y_i ≥ y_{i-1} + (offs_i - offs_{i-1}) と y_0 ≥ lb の下で Σ w (y - t)² を最小にする。
 * z = y - offs と置くと z は単調非減少（隣接ブロックの併合 = PAVA）。下限は z_0 ≥ lb で、単調なので全体を lb で切る
 */
export function pava(t: number[], w: number[], offs: number[], lb: number): number[] {
  const n = t.length;
  const sw: number[] = [];
  const sv: number[] = [];
  const cnt: number[] = [];
  for (let i = 0; i < n; i++) {
    sw.push(w[i]!);
    sv.push(w[i]! * (t[i]! - offs[i]!));
    cnt.push(1);
    while (sw.length > 1) {
      const j = sw.length - 1;
      if (sv[j - 1]! / sw[j - 1]! <= sv[j]! / sw[j]!) break;
      sw[j - 1]! += sw[j]!;
      sv[j - 1]! += sv[j]!;
      cnt[j - 1]! += cnt[j]!;
      sw.pop();
      sv.pop();
      cnt.pop();
    }
  }
  const out: number[] = [];
  for (let j = 0; j < sw.length; j++) {
    const z = Math.max(lb, sv[j]! / sw[j]!);
    for (let k = 0; k < cnt[j]!; k++) out.push(z + offs[out.length]!);
  }
  return out;
}

const byBundle = (p: Bundle, q: Bundle) => p.bary - q.bary || p.seq - q.seq;
const byElem = (a: Elem, b: Elem) => a.bary - b.bary || a.rank - b.rank;
const byUnit = (a: Unit, b: Unit) => a.bary - b.bary || a.rank - b.rank;
const meanOf = (u: Unit) => {
  let sum = 0;
  for (const b of u.members) sum += b.bary;
  u.bary = sum / u.members.length;
};

/**
 * 重心（bary）で並べる。箱は同じ host（無ければ同じ group）の単位で隣り合わせ、単位の中は host の中の group、重心の順。
 * 束（通過点）は自由に、重心の位置で箱の並びに差し込む。同点は初めの順（rank）
 */
export function sortWithGroups(units: Unit[], bundles: Elem[]): Elem[] {
  bundles.sort(byElem);
  for (const u of units) meanOf(u);
  const sortedUnits = units.slice().sort(byUnit);
  const out: Elem[] = [];
  let j = 0;
  let run = -Infinity;
  // 箱の並びの重心は単調とは限らないので、累積の最大で比べる（束が単位の途中に入ってもよい）
  const emit = (b: LBox) => {
    if (b.bary > run) run = b.bary;
    while (j < bundles.length && bundles[j]!.bary < run) out.push(bundles[j++]!);
    out.push(b);
  };
  for (const u of sortedUnits) {
    if (u.subs) {
      // host の中は group ごと
      for (const s of u.subs) meanOf(s);
      for (const s of u.subs.slice().sort(byUnit)) for (const b of s.members.sort(byElem)) emit(b);
    } else if (u.members.length === 1) emit(u.members[0]!);
    else for (const b of u.members.sort(byElem)) emit(b);
  }
  while (j < bundles.length) out.push(bundles[j++]!);
  return out;
}
