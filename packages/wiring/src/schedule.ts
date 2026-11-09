// 球の時刻（docs/15 §3.5 の球の規則）。1 通信 = 1 球。線を進み切ってから次の球を生む。
// 合流は全部の球が着いてから（最長経路）。同じ線を 1 周回に 2 回流さない（たどり済みの辺を切って DAG にする。D43）
import type { Lit, Segment } from './traverse.js';

export interface ScheduleOptions {
  /** 区間の長さ（線だけ。ビューアは描いた経路の長さを渡す）。省略時 1 */
  lengthOf?: (seg: Segment) => number;
  /** 長さ / 速さ = 線の所要時間。省略時 1 */
  speed?: number;
  /** 箱の中（links）の固定の所要時間。省略時 0.25 */
  inner?: number;
  /** 末端で止まる時間。省略時 0.6 */
  rest?: number;
  /** クリックした箱（この箱の中の links は時間 0。「もう入っている」。§8 #26） */
  startBoxes?: Set<string>;
}

export interface Ball {
  seg: Segment;
  /** 出発時刻 */
  t0: number;
  /** 所要時間 */
  dur: number;
}

export interface Schedule {
  /** 流れる球（始点から届く区間だけ。1 区間 1 球） */
  balls: Ball[];
  /** 最後の球が着く時刻 */
  end: number;
  /** 1 周回の長さ（end ＋ rest） */
  cycle: number;
  /** 球が流れなかった区間（循環で切った辺、始点から届かない辺） */
  skipped: Segment[];
}

/**
 * 光っている区間に球の出発時刻を与える。
 * - flowStarts の項目を時刻 0 とし、そこから下流へ 1 本の流れ（上流は光るだけ）
 * - 親の項目に着いた時刻は、その子から出る区間にも効く（値の全体は部分も運ぶ）
 * - 分かれる数は出て行く区間の数、合流は最長経路で待つ
 * - 深さ優先で見つけた「戻る辺」（いま辿っている経路上の項目へ戻る辺）は切る → DAG。残りをトポロジカル順に緩和する
 */
export function schedule(
  lit: Lit,
  flowStarts: Iterable<string>,
  opts: ScheduleOptions = {},
): Schedule {
  const lengthOf = opts.lengthOf ?? (() => 1);
  const speed = opts.speed ?? 1;
  const inner = opts.inner ?? 0.25;
  const rest = opts.rest ?? 0.6;
  const startBoxes = opts.startBoxes ?? new Set<string>();

  const durOf = (s: Segment) => {
    if (s.kind === 'link') return s.node && startBoxes.has(s.node.id) ? 0 : inner;
    return lengthOf(s) / speed;
  };

  // 項目 ref → 出て行く辺。区間（球）に加えて、親から子への時間 0 の辺を足す:
  // 親に届いた値は子も運ぶので、子に引かれた線は親が着いた時刻に出られる（8-0b で判明。fn:getToday#out/call_1 に
  // 届いた対応の先で、子の call_1.url に引かれた HTTP の線が流れなかった）
  interface Edge {
    to: string;
    seg: Segment | null;
  }
  const outOf = new Map<string, Edge[]>();
  const add = (from: string, e: Edge) => {
    const arr = outOf.get(from);
    if (arr) arr.push(e);
    else outOf.set(from, [e]);
  };
  for (const s of lit.segs) add(s.from.ref, { to: s.to.ref, seg: s });
  const carried = new Set<string>();
  for (const s of lit.segs) {
    for (let x = s.from; x.parent; x = x.parent) {
      const k = `${x.parent.ref}>${x.ref}`;
      if (carried.has(k)) break;
      carried.add(k);
      add(x.parent.ref, { to: x.ref, seg: null });
    }
  }

  // 深さ優先で DAG を作る（戻る辺を切る）。訪問の完了順の逆がトポロジカル順
  const taken = new Set<Edge>();
  const onStack = new Set<string>();
  const done = new Set<string>();
  const finish: string[] = [];
  const visit = (ref: string) => {
    onStack.add(ref);
    for (const e of outOf.get(ref) ?? []) {
      if (onStack.has(e.to)) continue; // 戻る辺: この周回では流さない
      taken.add(e);
      if (!done.has(e.to) && !onStack.has(e.to)) visit(e.to);
    }
    onStack.delete(ref);
    done.add(ref);
    finish.push(ref);
  };
  const starts = [...new Set(flowStarts)];
  for (const ref of starts) if (!done.has(ref)) visit(ref);

  // 最長経路（トポロジカル順に緩和）
  const t = new Map<string, number>();
  for (const ref of starts) t.set(ref, 0);
  const order = finish.slice().reverse();
  const ballOf = new Map<Segment, Ball>();
  for (const ref of order) {
    const a = t.get(ref);
    if (a === undefined) continue;
    for (const e of outOf.get(ref) ?? []) {
      if (!taken.has(e)) continue;
      const dur = e.seg ? durOf(e.seg) : 0;
      if (e.seg) ballOf.set(e.seg, { seg: e.seg, t0: a, dur });
      const arrive = a + dur;
      if ((t.get(e.to) ?? -Infinity) < arrive) t.set(e.to, arrive);
    }
  }

  const balls = lit.segs.filter((s) => ballOf.has(s)).map((s) => ballOf.get(s)!);
  const skipped = lit.segs.filter((s) => !ballOf.has(s));
  let end = 0;
  for (const b of balls) end = Math.max(end, b.t0 + b.dur);
  return { balls, end, cycle: end + rest, skipped };
}

/**
 * 描く球: 線ごとに 1 球（1 通信 = 1 球）。親の単位の線を子の区間で何度も通るとき（`return` と `return.total` など）は
 * 最も早い区間の球だけを描く。ほかの区間は時刻と項目の光り（出発・到着）にだけ使う。箱の中の対応はそのまま
 */
export function drawnBalls(s: Schedule): Ball[] {
  const first = new Map<string, Ball>();
  for (const b of s.balls) {
    if (b.seg.kind !== 'wire' || !b.seg.wire) continue;
    const cur = first.get(b.seg.wire.key);
    if (!cur || b.t0 < cur.t0) first.set(b.seg.wire.key, b);
  }
  return s.balls.filter(
    (b) => b.seg.kind !== 'wire' || !b.seg.wire || first.get(b.seg.wire.key) === b,
  );
}
