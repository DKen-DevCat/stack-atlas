// レイアウトの数え方（docs/18 §4 の受け入れ条件）。テストと計測の両方で使う
import type { Point, Rect, WiringLayout } from '../layout/index.js';

export const overlaps = (a: Rect, b: Rect) =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/** 直交の折れ線の区間が箱の内側を通るか（箱の辺に触れるだけ＝ピンの出入りは通らない扱い） */
export const crossesBox = (pts: readonly Point[], r: Rect) => {
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1]!;
    const b = pts[i]!;
    const x0 = Math.min(a.x, b.x);
    const x1 = Math.max(a.x, b.x);
    const y0 = Math.min(a.y, b.y);
    const y1 = Math.max(a.y, b.y);
    if (a.y === b.y && a.y > r.y && a.y < r.y + r.h && x1 > r.x && x0 < r.x + r.w) return true;
    if (a.x === b.x && a.x > r.x && a.x < r.x + r.w && y1 > r.y && y0 < r.y + r.h) return true;
  }
  return false;
};

/** 全部の経路（線と切れている線）。線のキー（切れている線は元の線のキー）つき */
export const allRoutes = (l: WiringLayout) => [
  ...[...l.routes.entries()].map(([k, r]) => ({ key: k, wire: k, points: r.points })),
  ...l.broken.map((b) => ({ key: b.key, wire: b.wire, points: b.route.points })),
];

interface Seg {
  wire: string;
  a: Point;
  b: Point;
}

const same = (p: Point, q: Point) => p.x === q.x && p.y === q.y;

/**
 * 直交の線分どうしの交差の数（docs/18 §4）。横の線分と縦の線分が、両方の内側の 1 点で交わるものを数える。
 * 端点を共有する線分どうしと、同じ線（切れている線は元の線と同じ線として扱う）の線分どうしは数えない
 */
export function countCrossings(l: WiringLayout): number {
  const hs: Seg[] = [];
  const vs: Seg[] = [];
  for (const r of allRoutes(l)) {
    for (let i = 1; i < r.points.length; i++) {
      const a = r.points[i - 1]!;
      const b = r.points[i]!;
      if (a.y === b.y && a.x !== b.x) hs.push({ wire: r.wire, a, b });
      else if (a.x === b.x && a.y !== b.y) vs.push({ wire: r.wire, a, b });
    }
  }
  let n = 0;
  for (const h of hs) {
    const x0 = Math.min(h.a.x, h.b.x);
    const x1 = Math.max(h.a.x, h.b.x);
    const y = h.a.y;
    for (const v of vs) {
      if (v.wire === h.wire) continue;
      const x = v.a.x;
      const y0 = Math.min(v.a.y, v.b.y);
      const y1 = Math.max(v.a.y, v.b.y);
      if (!(x0 < x && x < x1 && y0 < y && y < y1)) continue;
      if (same(h.a, v.a) || same(h.a, v.b) || same(h.b, v.a) || same(h.b, v.b)) continue;
      n++;
    }
  }
  return n;
}

/** 箱どうしの重なりの数 */
export function boxOverlaps(l: WiringLayout): string[] {
  const boxes = [...l.boxes.values()];
  const out: string[] = [];
  for (let i = 0; i < boxes.length; i++)
    for (let j = i + 1; j < boxes.length; j++)
      if (overlaps(boxes[i]!, boxes[j]!)) out.push(`${boxes[i]!.id} と ${boxes[j]!.id}`);
  return out;
}

/** host の枠と、中身でない箱の重なり */
export function hostOverlaps(l: WiringLayout): string[] {
  const out: string[] = [];
  for (const h of l.hosts.values())
    for (const b of l.boxes.values())
      if (!h.members.includes(b.id) && overlaps(h, b)) out.push(`${h.id} と ${b.id}`);
  return out;
}

/** 箱を通る線 */
export function wiresThroughBoxes(l: WiringLayout): string[] {
  const out: string[] = [];
  for (const r of allRoutes(l))
    for (const b of l.boxes.values()) if (crossesBox(r.points, b)) out.push(`${r.key} が ${b.id}`);
  return out;
}
