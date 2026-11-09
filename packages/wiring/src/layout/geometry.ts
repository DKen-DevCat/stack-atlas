// 経路の小道具: 計画と両端のピンから直交の折れ線を作る、長さ、折れ線の上の点、光る区間の経路
import type { Segment } from '../traverse.js';
import type { Point, Route, RoutePlan, WiringLayout } from './types.js';

/** 同じ点の連続と、一直線に並んだ真ん中の点を除く */
export function simplify(pts: Point[]): Point[] {
  const out: Point[] = [];
  for (const p of pts) {
    const last = out[out.length - 1];
    if (last && last.x === p.x && last.y === p.y) continue;
    const prev = out[out.length - 2];
    if (
      prev &&
      last &&
      ((prev.x === last.x && last.x === p.x) || (prev.y === last.y && last.y === p.y))
    ) {
      // prev → last → p が一直線。ただし折り返し（向きが逆になる）は残す
      const forward =
        prev.x === last.x
          ? Math.sign(last.y - prev.y) === Math.sign(p.y - last.y)
          : Math.sign(last.x - prev.x) === Math.sign(p.x - last.x);
      if (forward) {
        out[out.length - 1] = { x: p.x, y: p.y };
        continue;
      }
    }
    out.push({ x: p.x, y: p.y });
  }
  return out;
}

/**
 * 直交の経路を、計画と両端のピンから作る:
 * 出口 → 右の通り道 xs[0] →（通過点 ys[0] の高さで列を横切る → 次の通り道 xs[1] → …）→ 最後の通り道 → 入口
 */
export function routeBetween(plan: RoutePlan, a: Point, b: Point): Point[] {
  const pts: Point[] = [{ x: a.x, y: a.y }];
  const n = plan.ys.length;
  if (plan.xs.length === 0) {
    pts.push({ x: b.x, y: a.y }, { x: b.x, y: b.y });
  } else {
    let y = a.y;
    for (let i = 0; i < plan.xs.length; i++) {
      const x = plan.xs[i]!;
      const next = i < n ? plan.ys[i]! : b.y;
      pts.push({ x, y }, { x, y: next });
      y = next;
    }
  }
  pts.push({ x: b.x, y: b.y });
  return simplify(pts);
}

/** 箱の中の対応（キャッシュの links）の経路。左右のピンの中央で折れる */
export function innerRoute(a: Point, b: Point): Point[] {
  const xm = (a.x + b.x) / 2;
  return simplify([
    { x: a.x, y: a.y },
    { x: xm, y: a.y },
    { x: xm, y: b.y },
    { x: b.x, y: b.y },
  ]);
}

export function routeLength(points: readonly Point[]): number {
  let len = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!;
    const b = points[i]!;
    len += Math.abs(b.x - a.x) + Math.abs(b.y - a.y);
  }
  return len;
}

/** 折れ線の始点から距離 d の点（球の位置） */
export function pointAt(points: readonly Point[], d: number): Point {
  const first = points[0];
  if (!first) return { x: 0, y: 0 };
  let rest = Math.max(0, d);
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!;
    const b = points[i]!;
    const len = Math.abs(b.x - a.x) + Math.abs(b.y - a.y);
    if (rest <= len) {
      const f = len === 0 ? 0 : rest / len;
      return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f };
    }
    rest -= len;
  }
  const last = points[points.length - 1]!;
  return { x: last.x, y: last.y };
}

export const toRoute = (points: Point[]): Route => ({ points, length: routeLength(points) });

/**
 * 光る区間（線か、箱の中の対応）の経路。親の単位の線を子からたどった区間は、線の計画を子のピンで使う。
 * ピンが無い（host の枠の箱の項目など）ときは null
 */
export function segmentRoute(layout: WiringLayout, seg: Segment): Route | null {
  const a = layout.pins.get(seg.from.ref);
  const b = layout.pins.get(seg.to.ref);
  if (!a || !b) return null;
  if (seg.kind === 'link') return toRoute(innerRoute(a, b));
  const plan = seg.wire ? layout.plans.get(seg.wire.key) : undefined;
  if (!plan) return null;
  return toRoute(routeBetween(plan, a, b));
}
