// SVG の文字列を作るときの小さな道具（render.ts と paint.ts の両方が使う。DOM に触らない）
import type { Point } from '@stack-atlas/wiring';

export const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** 小数 1 桁に丸める */
export const n1 = (v: number) => Math.round(v * 10) / 10;

/** 折れ線を path の d にする */
export function pathD(points: readonly Point[]): string {
  return points.map((p, i) => `${i ? 'L' : 'M'}${n1(p.x)},${n1(p.y)}`).join(' ');
}
