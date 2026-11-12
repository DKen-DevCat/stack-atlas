/**
 * 操作の時間の軸と、再生バーの帯（docs/27 §4.3）。
 * 軸は、操作の始まりから、最後に何かが起きた時刻まで。帯は、軸を出来事の境目（送った・返った・画面が変わった）で切ったもので、
 * 合計は実際の時間と同じ（同時に出た通信を、足し合わせない）
 */
import type { LiveOperation } from './operations.js';

export interface TimeSlice {
  /** 操作の始まりからの時刻（ミリ秒） */
  from: number;
  to: number;
  /**
   * - before: 押してから、最初の通信を送るまで
   * - wait: 通信の返事を待っている（request は、そのとき待っている通信のうち、いちばん先に出たもの）
   * - between: 通信と通信の間
   * - after: 最後の返事から、最後の画面の変化まで
   * - local: 通信の無い操作（押してから、画面が変わるまで）
   */
  kind: 'before' | 'wait' | 'between' | 'after' | 'local';
  request?: string;
}

export interface LiveTimeline {
  /** 軸の長さ（ミリ秒） */
  total: number;
  slices: TimeSlice[];
  /** いちばん長い帯の番号（帯が無ければ -1） */
  longest: number;
  /** 通信ごとの「送ってから返るまで」。同時に出た通信は重なるので、合計は total と合わないことがある */
  requests: Array<{ id: string; from: number; to: number; ms: number; pending: boolean }>;
  /** 画面の変化ごとの時刻（op.changes と同じ順・同じ数。届いた順 = 時刻の順） */
  changes: number[];
}

export function timelineOf(op: LiveOperation): LiveTimeline {
  const rel = (at: number) => Math.max(0, at - op.start);
  const total = rel(op.end);
  const requests = op.requests
    .map((r) => {
      const from = Math.min(rel(r.start), total);
      const pending = r.end === undefined;
      const to = pending ? total : Math.min(Math.max(rel(r.end!), from), total);
      return { id: r.id, from, to, ms: to - from, pending };
    })
    .sort((a, b) => a.from - b.from);
  const changes = op.changes.map((c) => Math.min(rel(c.at), total));
  const changeCuts = new Set(changes);

  const cuts = [
    ...new Set([0, total, ...changes, ...requests.flatMap((r) => [r.from, r.to])]),
  ].sort((a, b) => a - b);
  const firstStart = requests.length ? requests[0]!.from : total;
  const lastEnd = requests.reduce((m, r) => Math.max(m, r.to), 0);
  const slices: TimeSlice[] = [];
  for (let i = 0; i + 1 < cuts.length; i++) {
    const from = cuts[i]!;
    const to = cuts[i + 1]!;
    const inFlight = requests.find((r) => r.from <= from && r.to >= to && r.to > r.from);
    const slice: TimeSlice = inFlight
      ? { from, to, kind: 'wait', request: inFlight.id }
      : requests.length === 0
        ? { from, to, kind: 'local' }
        : { from, to, kind: to <= firstStart ? 'before' : from >= lastEnd ? 'after' : 'between' };
    const prev = slices[slices.length - 1];
    // 同じ種類が続いても、画面の変化の境目では切ったままにする（再生バーで、画面が変わった所が分かるように）
    if (prev && prev.kind === slice.kind && prev.request === slice.request && !changeCuts.has(from))
      prev.to = to;
    else slices.push(slice);
  }
  let longest = -1;
  for (const [i, s] of slices.entries())
    if (longest < 0 || s.to - s.from > slices[longest]!.to - slices[longest]!.from) longest = i;
  return { total, slices, longest, requests, changes };
}

/**
 * 軸の上の時刻 t（操作の始まりからのミリ秒）で、どこまで進んでいるか（再生が、何を光らせるかを決める）。
 * changes は、起きた画面の変化の数（op.changes の先頭から、この数だけが起きている）。slice は、いまの帯の番号（帯が無ければ -1）
 */
export function progressAt(
  line: LiveTimeline,
  t: number,
): { sent: string[]; returned: string[]; changes: number; slice: number } {
  const at = Math.min(Math.max(t, 0), line.total);
  const sent = line.requests.filter((r) => r.from <= at).map((r) => r.id);
  const returned = line.requests.filter((r) => !r.pending && r.to <= at).map((r) => r.id);
  const changes = line.changes.filter((c) => c <= at).length;
  let slice = line.slices.findIndex((s) => at >= s.from && at < s.to);
  if (slice < 0) slice = line.slices.length - 1;
  return { sent, returned, changes, slice };
}
