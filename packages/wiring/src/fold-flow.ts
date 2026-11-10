// 畳んだ表示の球の時刻と流れ（docs/21 §2.3。D129）。たどる・時刻を作るのは全体の索引のまま（select・schedule）で、
// 線の時間だけを「その線が写る、見えている線の経路長 / 速さ」に変える。単位の中に入って見えない線は固定の時間。
// 地図と共有するのは、重なりをまとめる関数（mergeOverlaps）と脈動の最短の長さ（PULSE_MIN）だけ（mapFlow の本体は使わない）
import { segmentOn, type FoldView } from './fold.js';
import { defaultWidthOf, segmentRoute } from './layout/index.js';
import { isForward } from './layout/model.js';
import type { LayoutOptions, WiringLayout } from './layout/types.js';
import { mergeOverlaps, PULSE_MIN } from './map-flow.js';
import { drawnBalls, type Ball, type Schedule } from './schedule.js';
import type { Segment } from './traverse.js';

/** 畳んだ箱の幅（ふつうの箱は 300） */
export const FOLD_WIDTH = 200;
/** 単位の中に入って見えない線の時間（秒）。箱の中を通る時間（schedule の inner の既定）と同じ */
export const FOLD_HIDDEN = 0.25;

/** `layoutWiring` の `widthOf`: 畳んだ箱は FOLD_WIDTH、それ以外は今の既定（`base`。省略時は画面が 2 倍） */
export function foldWidthOf(
  view: FoldView,
  base: NonNullable<LayoutOptions['widthOf']> = defaultWidthOf,
): NonNullable<LayoutOptions['widthOf']> {
  return (node, boxWidth) => (view.units.has(node.id) ? FOLD_WIDTH : base(node, boxWidth));
}

/**
 * 畳んだ索引の配置（`layoutWiring(view.index, foldLayoutOptions(view))`）に渡す設定: 畳んだ箱の幅（`foldWidthOf`）と、
 * 層を決める線（`view.forward`。束は中の線から決める）。`base` のほかの設定はそのまま。何も畳んでいなければ `base` に幅だけ足したもの
 */
export function foldLayoutOptions(view: FoldView, base: LayoutOptions = {}): LayoutOptions {
  const widthOf = foldWidthOf(view, base.widthOf ?? defaultWidthOf);
  if (!view.folded) return { ...base, widthOf };
  const forward = base.forward ?? isForward;
  return {
    ...base,
    widthOf,
    forward: (w) => view.forward.get(w.key) ?? forward(w),
  };
}

export interface FoldLengthOptions {
  /** `schedule` に渡すのと同じ速さ（隠れた線の長さを「hidden 秒ぶん」にするのに使う）。省略時 1 */
  speed?: number;
  /** 単位の中に入って見えない線の時間（秒）。省略時 FOLD_HIDDEN。0 にすると、その線の球が地図から消える */
  hidden?: number;
}

/**
 * `schedule` の `lengthOf`（全体の索引の区間 → 長さ）。`layout` は畳んだ索引の配置（`layoutWiring(view.index)`）。
 * - 見えている線に写る区間: その見えている線の経路長（束に写った線は、束の経路の長さ）
 * - 単位の中に入って見えない線: `hidden` 秒ぶん（`hidden × speed`）
 * 何も畳んでいなければ、今の配線図と同じ長さ（`segmentRoute(layout, seg)`）
 */
export function foldLengths(
  view: FoldView,
  layout: WiringLayout,
  opts: FoldLengthOptions = {},
): (seg: Segment) => number {
  const hidden = (opts.hidden ?? FOLD_HIDDEN) * (opts.speed ?? 1);
  // 束に写る区間は多くが同じ経路になるので、写した先の区間ごとに 1 回だけ経路を作る
  const lengths = new Map<string, number>();
  return (seg) => {
    if (seg.kind !== 'wire' || !seg.wire) return 0;
    const on = segmentOn(view, seg);
    if (!on) return hidden;
    let len = lengths.get(on.key);
    if (len === undefined) {
      len = segmentRoute(layout, on)?.length ?? 0;
      lengths.set(on.key, len);
    }
    return len;
  };
}

/** 見えている区間の上の球（Ball と同じ形に、まとめた線を足したもの） */
export interface FoldBall extends Ball {
  /** この球にまとめた全体の線のキー（箱の中の対応の球は空） */
  wires: string[];
}

/** 畳んだ箱の脈動（単位の中に入って見えない線の球） */
export interface FoldPulse {
  /** 畳んだ箱の id */
  unit: string;
  t0: number;
  t1: number;
  /** この脈動にまとめた全体の線のキー */
  wires: string[];
}

export interface FoldFlow {
  balls: FoldBall[];
  pulses: FoldPulse[];
  cycle: number;
}

/**
 * schedule（全体の索引の区間の球）を畳んだ表示に写す。描く球（drawnBalls）だけを見る。
 * - 見えている線の上の球: 同じ線の上で時間の重なる球は 1 つ（D33。束は 1 本の線なので、向きは 1 つ）。
 *   区間は、まとめた中でいちばん早い球のもの
 * - 見えている箱の中の対応の球はそのまま。畳んだ箱の中の対応は無い
 * - 単位の中に入って見えない線の球は、その畳んだ箱の脈動（最短 PULSE_MIN 秒。周期は超えない）。時間の重なる脈動は 1 つ
 * 球は時刻の順（同じ時刻は schedule の順）、脈動は畳んだ箱の順。
 * 何も畳んでいなければ、球は今の `drawnBalls` と同じもの・同じ順で、脈動は無い
 */
export function flowOn(view: FoldView, sched: Schedule): FoldFlow {
  const drawn = drawnBalls(sched);
  if (!view.folded) {
    return {
      balls: drawn.map((b) => ({
        seg: b.seg,
        t0: b.t0,
        dur: b.dur,
        wires: b.seg.kind === 'wire' && b.seg.wire ? [b.seg.wire.key] : [],
      })),
      pulses: [],
      cycle: sched.cycle,
    };
  }

  interface Span extends FoldBall {
    t1: number;
    order: number;
  }
  const byLine = new Map<string, Span[]>();
  const spans: Span[] = [];
  const pulses = new Map<string, FoldPulse[]>();
  drawn.forEach((b, order) => {
    const s = b.seg;
    const on = segmentOn(view, s);
    if (s.kind !== 'wire' || !s.wire) {
      if (on) spans.push({ seg: on, t0: b.t0, dur: b.dur, t1: b.t0 + b.dur, wires: [], order });
      return;
    }
    if (!on || !on.wire) {
      // 単位の中に入って見えない線だけが脈動になる（lineOf が null）。それ以外で写せない区間は、この view の全体の索引
      // （source）のものではない（別の索引で作った schedule）ので描かない
      if (view.lineOf.get(s.wire.key) !== null) return;
      const unit = view.unitOf.get(s.from.node.id);
      if (unit === undefined || !view.units.has(unit)) return;
      const t1 = Math.min(Math.max(b.t0 + b.dur, b.t0 + PULSE_MIN), sched.cycle);
      const list = pulses.get(unit);
      const pulse = { unit, t0: b.t0, t1, wires: [s.wire.key] };
      if (list) list.push(pulse);
      else pulses.set(unit, [pulse]);
      return;
    }
    const span = {
      seg: on,
      t0: b.t0,
      dur: b.dur,
      t1: b.t0 + b.dur,
      wires: [s.wire.key],
      order,
    };
    const list = byLine.get(on.wire.key);
    if (list) list.push(span);
    else byLine.set(on.wire.key, [span]);
  });
  for (const list of byLine.values()) spans.push(...mergeOverlaps(list));
  spans.sort((a, b) => a.t0 - b.t0 || a.order - b.order);

  const outPulses: FoldPulse[] = [];
  for (const id of view.units.keys()) {
    const list = pulses.get(id);
    if (list) outPulses.push(...mergeOverlaps(list));
  }
  return {
    // まとめなかった球の所要は元のまま（t1 − t0 に作り直すと、丸めで元の値とずれる）
    balls: spans.map((x) => ({
      seg: x.seg,
      t0: x.t0,
      dur: x.t0 + x.dur === x.t1 ? x.dur : x.t1 - x.t0,
      wires: x.wires,
    })),
    pulses: outPulses,
    cycle: sched.cycle,
  };
}
