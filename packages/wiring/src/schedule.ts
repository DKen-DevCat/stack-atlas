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

  // 項目 ref → 出て行く区間
  const outOf = new Map<string, Segment[]>();
  for (const s of lit.segs) {
    const arr = outOf.get(s.from.ref);
    if (arr) arr.push(s);
    else outOf.set(s.from.ref, [s]);
  }

  // 深さ優先で DAG を作る（戻る辺を切る）。訪問の完了順の逆がトポロジカル順
  const taken = new Set<Segment>();
  const onStack = new Set<string>();
  const done = new Set<string>();
  const finish: string[] = [];
  const visit = (ref: string) => {
    onStack.add(ref);
    for (const s of outOf.get(ref) ?? []) {
      if (onStack.has(s.to.ref)) continue; // 戻る辺: この周回では流さない
      taken.add(s);
      if (!done.has(s.to.ref) && !onStack.has(s.to.ref)) visit(s.to.ref);
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
    for (const s of outOf.get(ref) ?? []) {
      if (!taken.has(s)) continue;
      const dur = durOf(s);
      ballOf.set(s, { seg: s, t0: a, dur });
      const arrive = a + dur;
      if ((t.get(s.to.ref) ?? -Infinity) < arrive) t.set(s.to.ref, arrive);
    }
  }

  const balls = lit.segs.filter((s) => ballOf.has(s)).map((s) => ballOf.get(s)!);
  const skipped = lit.segs.filter((s) => !ballOf.has(s));
  let end = 0;
  for (const b of balls) end = Math.max(end, b.t0 + b.dur);
  return { balls, end, cycle: end + rest, skipped };
}
