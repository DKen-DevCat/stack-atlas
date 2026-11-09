// 画面の部品の領域（docs/18 §3.3、docs/14 §3.3 の 3）: data-component の名前 → 箱 id、ビューポートでの切り詰め、
// graph の screen.regions と計測の優先。DOM に触らない（測るのはビューア。ここは測った値の扱いだけ）。
// 名前の解き方は screenshots 抽出器と同じ規則（抽出器は @stack-atlas/core の再 export からこれを使う。D44 でビューアは
// 抽出器に依存しないため、規則の正本をここに置く）
import type { ScreenV2 } from '@stack-atlas/schema';
import { screenViewport } from './layout/screen.js';

/**
 * `data-component` の名前 → 箱 id。名前そのもの（`data-component="comp:Foo"` のように id を書いた場合）→ `comp:<名前>`
 * → `hook:<名前>` → `:<名前>` で終わる id（ids の順で最初のもの）。見つからなければ undefined
 */
export function resolveRegionRef(name: string, nodeIds: Iterable<string>): string | undefined {
  const ids = nodeIds instanceof Set ? (nodeIds as Set<string>) : new Set(nodeIds);
  if (ids.has(name)) return name;
  for (const prefix of ['comp:', 'hook:']) {
    if (ids.has(prefix + name)) return prefix + name;
  }
  for (const id of ids) {
    if (id.endsWith(`:${name}`)) return id;
  }
  return undefined;
}

/** 測ったままの領域（data-component の名前とビューポートの座標） */
export interface RawRegion {
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 箱 id に解いた領域（座標は画面のビューポート。screenViewport） */
export interface ScreenRegion {
  ref: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** ビューポートに入る部分だけに切り詰め、整数に丸める。はみ出して面積 0 になるもの・数でないものは捨てる */
export function clipRegion<T extends { x: number; y: number; w: number; h: number }>(
  r: T,
  viewport: { width: number; height: number },
): T | undefined {
  if (![r.x, r.y, r.w, r.h].every(Number.isFinite)) return undefined;
  const x1 = Math.max(0, r.x);
  const y1 = Math.max(0, r.y);
  const x2 = Math.min(viewport.width, r.x + r.w);
  const y2 = Math.min(viewport.height, r.y + r.h);
  if (x2 <= x1 || y2 <= y1) return undefined;
  const x = Math.round(x1);
  const y = Math.round(y1);
  const w = Math.round(x2) - x;
  const h = Math.round(y2) - y;
  if (w <= 0 || h <= 0) return undefined;
  return { ...r, x, y, w, h };
}

/** 測った領域を箱 id に解き、ビューポートで切り詰める（解けない名前と、画面の外のものは落とす） */
export function resolveRegions(
  raw: readonly RawRegion[],
  nodeIds: Iterable<string>,
  viewport: { width: number; height: number },
): ScreenRegion[] {
  const ids = nodeIds instanceof Set ? (nodeIds as Set<string>) : new Set(nodeIds);
  const out: ScreenRegion[] = [];
  for (const r of raw) {
    if (!r.name) continue;
    const ref = resolveRegionRef(r.name, ids);
    if (!ref) continue;
    const c = clipRegion({ x: r.x, y: r.y, w: r.w, h: r.h }, viewport);
    if (c) out.push({ ref, ...c });
  }
  return out;
}

export interface RegionsOf {
  regions: ScreenRegion[];
  /** graph: graph.json の screen.regions、measured: ビューアが測った値、none: どちらも無い */
  from: 'graph' | 'measured' | 'none';
}

/**
 * 画面の領域。graph.json の screen.regions（空でない配列）があれば計測より優先する（docs/18 §3.3）。graph の regions は
 * screen.width × height の座標なので、ビューポート（screenViewport。範囲に収めた値）の座標に直して切り詰める。
 * 空の regions（スクショで data-component が 1 つも無かった）は無いのと同じに扱い、計測を使う
 */
export function regionsOf(
  screen: ScreenV2 | undefined,
  measured: readonly ScreenRegion[] | undefined,
): RegionsOf {
  const vp = screenViewport(screen);
  const given = screen?.regions;
  if (Array.isArray(given) && given.length > 0) {
    const sx = screen && screen.width > 0 ? vp.width / screen.width : 1;
    const sy = screen && screen.height > 0 ? vp.height / screen.height : 1;
    const regions: ScreenRegion[] = [];
    for (const r of given) {
      if (typeof r?.ref !== 'string') continue;
      const c = clipRegion({ x: r.x * sx, y: r.y * sy, w: r.w * sx, h: r.h * sy }, vp);
      if (c) regions.push({ ref: r.ref, ...c });
    }
    return { regions, from: 'graph' };
  }
  if (measured && measured.length > 0) return { regions: [...measured], from: 'measured' };
  return { regions: [], from: 'none' };
}
