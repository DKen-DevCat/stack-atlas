// 列の中の順と縦の位置（docs/18 §3.1 の 6・7）。列には箱と通過点の束を積む。
// 順: 初めは宣言の順。左右交互に、項目のピンの y の重心で並べ直す（同じ group・同じ host の箱は、初めの順でも
// 並べ直しでも隣り合わせる）。往復ごとに並べ方の悪さ（交差の数 ＋ 同じ列の中の線の長さ）を数え、いちばん少なかった
// 並びを残す。その後、隣り合う単位・箱・束を入れ替えて悪さが減るものを残す（refine。塊は割らない）。
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
/**
 * 入れ替えを試す列の大きさの上限: 塊の数 ×（塊の数 ＋ 同じ列の中の線の数）。入れ替えは塊の数ほど試し、1 回ごとに
 * 塊の並びと同じ列の中の線を数え直すため（大きな列は重心の往復の並びのまま）
 */
const REFINE_BUDGET = 1_000_000;
/** 入れ替えの段: 単位（host・group）→ 単位の中の group → 箱 */
const LEVELS: ((b: LBox) => string)[] = [(b) => b.ukey, (b) => b.group, (b) => b.id];

/** 列の中で一緒に動くもの: 箱とその上下に付けた折り返しの束、または自由な束 1 つ */
interface Block {
  elems: Elem[];
  box: LBox | null;
  /** 線の相手の y（昇順）: 左は列 k-1 の要素の積んだ位置、右は列 k+1 の点の積んだ位置（交差の数え方に合わせる） */
  left: Float64Array;
  right: Float64Array;
}

const EMPTY = new Float64Array(0);

/** 列のいちばん上の要素の上端の下限 */
const topOf = (first: Elem | undefined): number =>
  !first ? TOP : first.kind === 'box' ? TOP + (first.host ? HOST_HEAD + HOST_PAD : 0) : DUMMY_TOP;
const elemOf = (p: ChainPoint): Elem => (p.kind === 'pin' ? p.box : p.slot.bundle);

/** 上の X と下の Y を入れ替えると増える交差の数: x < y の組は交差になり、x > y の組は交差でなくなる（同じ値は数えない） */
function flipSorted(x: Float64Array, y: Float64Array): number {
  let lt = 0;
  let gt = 0;
  let i1 = 0;
  let i2 = 0;
  for (let j = 0; j < y.length; j++) {
    const v = y[j]!;
    while (i1 < x.length && x[i1]! < v) i1++;
    while (i2 < x.length && x[i2]! <= v) i2++;
    lt += i1;
    gt += x.length - i2;
  }
  return lt - gt;
}

/** 塊を合わせた相手の y（昇順） */
function joined(bl: Block[], from: number, to: number, side: 'left' | 'right'): Float64Array {
  if (to - from === 1) return bl[from]![side];
  let n = 0;
  for (let i = from; i < to; i++) n += bl[i]![side].length;
  const out = new Float64Array(n);
  let o = 0;
  for (let i = from; i < to; i++) {
    out.set(bl[i]![side], o);
    o += bl[i]![side].length;
  }
  return out.sort();
}

/** 塊 [a0, a1) が塊 [b0, b1) の上から下へ移ると増える交差の数 */
function flip(bl: Block[], a0: number, a1: number, b0: number, b1: number): number {
  if (a0 === a1 || b0 === b1) return 0;
  return (
    flipSorted(joined(bl, a0, a1, 'left'), joined(bl, b0, b1, 'left')) +
    flipSorted(joined(bl, a0, a1, 'right'), joined(bl, b0, b1, 'right'))
  );
}

/** bl[from, to) の箱の塊を key の同じ並びに分ける（s は最初の箱の塊、e は最後の箱の塊の次。間の自由な束は並びの中） */
function runsOf(bl: Block[], from: number, to: number, key: (b: LBox) => string) {
  const runs: { s: number; e: number; boxes: number; k: string }[] = [];
  for (let i = from; i < to; i++) {
    const box = bl[i]!.box;
    if (!box) continue;
    const k = key(box);
    const last = runs[runs.length - 1];
    if (last && last.k === k) {
      last.e = i + 1;
      last.boxes++;
    } else runs.push({ s: i, e: i + 1, boxes: 1, k });
  }
  return runs;
}

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
  return [...m.values()].map((members) => {
    // 引数の展開は使わない（箱が 10 万を超えると RangeError）
    let rank = Infinity;
    for (const b of members) if (b.rank < rank) rank = b.rank;
    return { members, subs: null, bary: 0, rank };
  });
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
  frames(order: Elem[], out: (string | null)[] = new Array(order.length)): (string | null)[] {
    const n = order.length;
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
  offsets(
    order: Elem[],
    offs: number[] = new Array(order.length),
    fr = this.frames(order),
  ): { lb: number; offs: number[] } {
    let acc = 0;
    for (let i = 0; i < order.length; i++) {
      const e = order[i]!;
      if (i > 0) {
        const p = order[i - 1]!;
        acc += p.h + this.gap(p, e, fr[i - 1]!, fr[i]!);
      }
      offs[i] = acc;
    }
    return { lb: topOf(order[0]), offs };
  }

  /** 上の要素 p と下の要素 e の間の隙間（fp・fe はそれぞれの位置の枠） */
  private gap(p: Elem, e: Elem, fp: string | null, fe: string | null): number {
    let gap =
      p.kind === 'box'
        ? e.kind === 'box'
          ? GAP_BOX
          : GAP_BOX_DUMMY
        : e.kind === 'box'
          ? GAP_DUMMY_BOX
          : this.pitch;
    if (fe && fe !== fp) gap += HOST_HEAD + HOST_PAD;
    if (fp && fp !== fe) gap += HOST_PAD;
    return gap;
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
      e.bary = n ? sum / n : e.y + e.h / 2;
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

  /**
   * 初めの順: 箱と自由な束は今の y の順、折り返しは箱に付ける。並べ直しと同じく、同じ host・group の箱は隣り合わせる
   * （初めの順は往復が良くならなければそのまま残るので、ここで塊を割ると枠が外の箱に重なる）
   */
  initOrder(k: number) {
    const free: Elem[] = [];
    const attached: Bundle[] = [];
    for (const e of this.cols[k]!) {
      if (e.kind === 'bundle' && e.att.length) {
        attached.push(e);
        continue;
      }
      e.bary = e.y + e.h / 2;
      if (e.kind === 'bundle') free.push(e);
    }
    this.cols[k] = this.withAttached(sortWithGroups(this.units[k]!, free), attached);
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
   * 縦の長さ（SAME_COLUMN_PX ごとに 1）を足す（同じ列の呼ぶ・呼ばれるは交差に現れないので、離れても数が変わらない）。
   * 並び（列の中の順・項目の順・束の段）だけで決まる値にする: y は今の値ではなく、列を上から詰めて積んだ位置（sy）で測る。
   * 往復の後の列は積んであり、回の初めの列は PAVA の位置なので、今の y で測ると縦の長さの物差しが食い違う
   */
  score(): number {
    for (let k = 0; k < this.cols.length; k++) this.stackSy(k);
    let total = 0;
    for (let k = 0; k < this.cols.length; k++) total += this.between(k) + this.sameLen(k);
    return total;
  }

  /** 列 k を上から詰めて積んだ y（sy）。入れ替えのたびに呼ぶので、作業の配列は使い回す */
  private stackSy(k: number) {
    const col = this.cols[k]!;
    const { lb, offs } = this.offsets(col, this.offBuf, this.frames(col, this.frBuf));
    for (let i = 0; i < col.length; i++) col[i]!.sy = lb + offs[i]!;
  }

  private readonly offBuf: number[] = [];
  private readonly frBuf: (string | null)[] = [];

  private readonly sy = (e: Elem) => e.sy;
  private readonly sa: number[] = [];
  private readonly sb: number[] = [];

  /** 列 k と k + 1 の間の交差の数（sy で測る） */
  private between(k: number): number {
    const a = this.sa;
    const b = this.sb;
    a.length = 0;
    b.length = 0;
    // 列の要素は上から順なので a は単調。同じ要素から出る線どうしは数えない（要素を 1 点とみる 2 層の数え方）
    for (const e of this.cols[k] ?? [])
      for (const t of e.tpl)
        if (t.col === k + 1) {
          a.push(e.sy);
          b.push(this.yOf(t.other, this.sy));
        }
    return inversions(a, b);
  }

  /** 列 k の中で閉じる線の縦の長さ（sy で測る） */
  private sameLen(k: number): number {
    let total = 0;
    for (const e of this.cols[k]!)
      if (e.kind === 'box')
        for (const t of e.same)
          total +=
            Math.abs(e.sy + this.own(e, t) - this.yOf(t.other, this.sy)) / SAME_COLUMN_PX / 2;
    return total;
  }

  /**
   * 並びを少しずつ入れ替えて、悪さ（score）が減るものを残す（重心の往復は同じ列の中の線をほとんど見ないので、往復では
   * 届かない並びを探す）。入れ替えるのは、隣り合う単位（host・group）、単位の中の隣り合う group、group の中の隣り合う箱、
   * 自由な束と隣の塊。塊は割らない。交差の増減は入れ替えた塊の線の組だけで数え、同じ列の中の線の長さは積み直して数える。
   * 大きな列（REFINE_BUDGET を超える）は省く
   */
  refine() {
    for (let k = 0; k < this.cols.length; k++) this.stackSy(k);
    for (let k = 0; k < this.cols.length; k++) {
      this.refineCol(k);
      this.stack(k);
    }
  }

  /** 列 k を塊に分ける。相手の y は列 k の並びで変わらない（列 k-1・k+1 の積んだ位置） */
  private blocksOf(k: number): Block[] {
    const left = new Map<Elem, number[]>();
    // 列 k-1 → k の線は列 k-1 の要素の tpl にあり、交差は列 k-1 の要素の y で数える（between）
    if (k > 0)
      for (const e of this.cols[k - 1]!)
        for (const t of e.tpl)
          if (t.col === k) {
            const o = elemOf(t.other);
            const list = left.get(o);
            if (list) list.push(e.sy);
            else left.set(o, [e.sy]);
          }
    const blocks: Block[] = [];
    let pending: Elem[] = [];
    let last: Block | null = null;
    const open = (elems: Elem[], box: LBox | null) => {
      last = { elems, box, left: EMPTY, right: EMPTY };
      blocks.push(last);
    };
    for (const e of this.cols[k]!) {
      if (e.kind === 'box') {
        open([...pending, e], e);
        pending = [];
      } else if (e.att.length) {
        // 付けた束は、直前の箱に付いていればその下、そうでなければ次の箱の上
        const prev = last as Block | null;
        if (!pending.length && prev?.box && e.att.includes(prev.box)) prev.elems.push(e);
        else pending.push(e);
      } else {
        for (const x of pending) open([x], null);
        pending = [];
        open([e], null);
      }
    }
    for (const x of pending) open([x], null);
    for (const b of blocks) {
      const l: number[] = [];
      const r: number[] = [];
      for (const e of b.elems) {
        for (const v of left.get(e) ?? []) l.push(v);
        for (const t of e.tpl) if (t.col === k + 1) r.push(this.yOf(t.other, this.sy));
      }
      b.left = l.length ? Float64Array.from(l).sort() : EMPTY;
      b.right = r.length ? Float64Array.from(r).sort() : EMPTY;
    }
    return blocks;
  }

  private refineCol(k: number) {
    const col = this.cols[k]!;
    const n = col.length;
    // 列の箱に番号（ri）を付け、同じ列の中で閉じる線を番号で持つ（両向きの 2 つ。sameLen と同じ数え方。
    // 長さは |y(e) − y(other) + off|）
    const boxes: LBox[] = [];
    for (const e of col) if (e.kind === 'box') e.ri = boxes.push(e) - 1;
    const se: number[] = [];
    const so: number[] = [];
    const soff: number[] = [];
    for (const e of boxes)
      for (const t of e.same)
        if (t.other.kind === 'pin') {
          se.push(e.ri);
          so.push(t.other.box.ri);
          soff.push(this.own(e, t) - t.other.o);
        }
    const S = se.length;
    let bl = this.blocksOf(k);
    if (bl.length < 2 || bl.length * (bl.length + S) > REFINE_BUDGET) return;
    // 塊の最初の要素の位置と、箱の位置
    const starts = new Int32Array(bl.length + 1);
    const at = new Int32Array(boxes.length);
    const reindex = () => {
      let f = 0;
      bl.forEach((x, i) => {
        starts[i] = f;
        for (const e of x.elems) {
          if (e.kind === 'box') at[e.ri] = f;
          f++;
        }
      });
      starts[bl.length] = f;
    };
    reindex();
    const ny = new Float64Array(n);
    // 試す並びで積み直した箱の y（mark が今の回の箱だけ）
    const my = new Float64Array(boxes.length);
    const mark = new Int32Array(boxes.length);
    let trial = 0;
    /**
     * 塊 [r0, r1) を next の並びにしたときを試す（交差の増減 dx は数えてある）。良くなれば残す。
     * 同じ列の中の線の長さは、変えた所の上の箱から積み直し、変えた所の下の最初の箱から先はずれ（delta）だけ動かして数える
     */
    const attempt = (next: Block[], r0: number, r1: number, dx: number) => {
      const f0 = starts[r0]!;
      const f1 = starts[r1]!;
      let f = f0;
      for (let i = r0; i < r1; i++) for (const e of next[i]!.elems) col[f++] = e;
      let ds = 0;
      let start = 0;
      let j = n;
      let delta = 0;
      if (S) {
        trial++;
        // 変えた所より上の最後の箱（その位置は変わらない。間の束の枠は下の箱で変わりうる）
        start = f0 - 1;
        while (start >= 0 && col[start]!.kind !== 'box') start--;
        j = f1;
        while (j < n && col[j]!.kind !== 'box') j++;
        let prevHost: string | null;
        let fp: string | null;
        let i0: number;
        if (start < 0) {
          i0 = 0;
          ny[0] = topOf(col[0]);
          prevHost = null;
          fp = null;
        } else {
          i0 = start;
          ny[start] = col[start]!.sy;
          prevHost = (col[start] as LBox).host;
          fp = prevHost;
        }
        let nextBox = i0;
        for (let i = i0; i <= j && i < n; i++) {
          const e = col[i]!;
          let fe: string | null;
          if (e.kind === 'box') fe = prevHost = e.host;
          else {
            if (nextBox <= i) {
              nextBox = i + 1;
              while (nextBox < n && col[nextBox]!.kind !== 'box') nextBox++;
            }
            const below = nextBox < n ? (col[nextBox] as LBox).host : null;
            fe = prevHost === below ? prevHost : null;
          }
          if (i > i0) ny[i] = ny[i - 1]! + col[i - 1]!.h + this.gap(col[i - 1]!, e, fp, fe);
          fp = fe;
          if (e.kind === 'box') {
            mark[e.ri] = trial;
            my[e.ri] = ny[i]!;
          }
        }
        if (j < n) delta = ny[j]! - col[j]!.sy;
        // 積み直した箱はその y、変えた所の下の箱は delta だけずれる、上の箱はそのまま
        const yNew = (r: number) =>
          mark[r] === trial ? my[r]! : at[r]! > j ? boxes[r]!.sy + delta : boxes[r]!.sy;
        for (let q = 0; q < S; q++) {
          const a = se[q]!;
          const b = so[q]!;
          ds +=
            Math.abs(yNew(a) - yNew(b) + soff[q]!) -
            Math.abs(boxes[a]!.sy - boxes[b]!.sy + soff[q]!);
        }
        ds /= SAME_COLUMN_PX * 2;
      }
      if (dx + ds < -1e-9) {
        bl = next;
        if (S) {
          for (let i = Math.max(start, 0); i < j && i < n; i++) col[i]!.sy = ny[i]!;
          if (delta) for (let i = j; i < n; i++) col[i]!.sy += delta;
          else if (j < n) col[j]!.sy = ny[j]!;
        }
        reindex();
        return;
      }
      f = f0;
      for (let i = r0; i < r1; i++) for (const e of bl[i]!.elems) col[f++] = e;
    };
    // 段ごとに、隣り合う並び a・b を入れ替える（間の自由な束 g はそのまま間に残す: a g b → b g a）
    const level = (from: number, to: number, depth: number) => {
      const key = LEVELS[depth]!;
      for (let i = 0; ; i++) {
        const runs = runsOf(bl, from, to, key);
        if (i + 1 >= runs.length) {
          if (depth + 1 < LEVELS.length)
            for (const r of runs) if (r.boxes > 1) level(r.s, r.e, depth + 1);
          return;
        }
        const a = runs[i]!;
        const b = runs[i + 1]!;
        const dx =
          flip(bl, a.s, a.e, b.s, b.e) +
          flip(bl, a.s, a.e, a.e, b.s) +
          flip(bl, a.e, b.s, b.s, b.e);
        const next = bl.slice();
        let w = a.s;
        for (const part of [bl.slice(b.s, b.e), bl.slice(a.e, b.s), bl.slice(a.s, a.e)])
          for (const x of part) next[w++] = x;
        attempt(next, a.s, b.e, dx);
      }
    };
    level(0, bl.length, 0);
    // 自由な束を隣の塊と入れ替える（箱どうしの順は変えない）
    for (let i = 0; i + 1 < bl.length; i++) {
      if (bl[i]!.box && bl[i + 1]!.box) continue;
      const next = bl.slice();
      next[i] = bl[i + 1]!;
      next[i + 1] = bl[i]!;
      attempt(next, i, i + 2, flip(bl, i, i + 1, i + 1, i + 2));
    }
    this.stackSy(k);
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
    // j は i の次から（a[i] が NaN だと a[i] === a[i] が偽になり、i のままでは進まない）
    let j = i + 1;
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
