// 配線図のレイアウトの受け入れ条件（docs/18 §4 のレイアウトの行。Phase 8-3a）。
// 基準の graph は 8-2a の fixture-poly の出力を固定したもの（fixtures/poly-82a.v2.json。8-2b が fixture-poly を変えても動かない）。
// 測った値（2026-11-09。8-0 の近似 → 8-3a → 8-3a のレビューの修正の後）:
//   基準の graph（箱 46・枠 4・線 109）: 3348×6486（縦横比 0.516、交差 1531）→ 4488×2365（1.898、交差 470）
//                                        → 4656×2366（1.968、交差 425）
//   /today の例（箱 18・枠 2・線 32）:   2252×2543（0.886、交差 67）  → 2636×1534（1.718、交差 45）
//                                        → 2676×1516（1.765、交差 50）
// 交差の上限は実装時の値 ×1.1（切り上げ）。数え方は metrics.ts の countCrossings。
// /today の 45 は group を割った並び（lib:fetcher が feature/spend の間、host の中の api と store が交互）だった。
// 塊を割らない今は 50 で、上限 50 は 8-3a の時のまま（基準の graph は 425 × 1.1 = 468 に締めた）
// 2026-11-09 変更（8-2b の取り込み）: 8-2b が例を直した（InsertTransaction は複数の入口から使われるので host を外して
// meta.hosts に、POST /transactions に login の分岐）。InsertTransaction の線が Lambda の枠の外を通るようになり、
// /today は 2676×1526（1.754、交差 53）。入力が変わったので上限を 53 × 1.1 = 59 に置き直した
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { GraphV2 } from '@stack-atlas/schema';
import { indexGraph } from '../graph-index.js';
import { layoutWiring } from '../layout/index.js';
import { boxOverlaps, countCrossings, hostOverlaps, wiresThroughBoxes } from './metrics.js';

const read = (rel: string) =>
  JSON.parse(readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')) as GraphV2;
const baseline = () => read('./fixtures/poly-82a.v2.json');
const today = () => read('../../../../examples/fixture-poly.today.v2.json');

/** 8-0 の近似での基準の graph の高さ（docs/18 の 3348×6486） */
const OLD_BASELINE_HEIGHT = 6486;
/** 縦横比（幅 / 高さ）の許す範囲: 1:1.6〜2.2:1 */
const ASPECT_MIN = 1 / 1.6;
const ASPECT_MAX = 2.2;

describe.each([
  ['基準の graph（poly-82a）', baseline, 468],
  ['/today の例', today, 59],
])('受け入れ条件: %s', (_name, make, maxCrossings) => {
  const index = indexGraph(make());
  const layout = layoutWiring(index);

  it('縦横比は 1:1.6〜2.2:1', () => {
    const a = layout.width / layout.height;
    expect(a).toBeGreaterThanOrEqual(ASPECT_MIN);
    expect(a).toBeLessThanOrEqual(ASPECT_MAX);
  });

  it('箱どうし・host の枠と中身でない箱が重ならない。箱を通る線は無い', () => {
    expect(boxOverlaps(layout)).toEqual([]);
    expect(hostOverlaps(layout)).toEqual([]);
    expect(wiresThroughBoxes(layout)).toEqual([]);
  });

  it('レーンの背景は自分の列と箱を全部含む', () => {
    for (const l of layout.lanes) {
      for (const c of l.columns) {
        const col = layout.columns[c]!;
        expect(col.x).toBeGreaterThanOrEqual(l.x0);
        expect(col.x + col.w).toBeLessThanOrEqual(l.x1);
      }
      for (const b of layout.boxes.values())
        if (b.lane === l.index) {
          expect(b.x).toBeGreaterThanOrEqual(l.x0);
          expect(b.x + b.w).toBeLessThanOrEqual(l.x1);
        }
    }
  });

  it(`直交の線分どうしの交差は ${maxCrossings} 以下（実装時の値 ×1.1）`, () => {
    expect(countCrossings(layout)).toBeLessThanOrEqual(maxCrossings);
  });

  it('同じ入力から同じ配置（選択・分岐の状態は入力に無い。graph ごとに 1 回）', () => {
    const again = layoutWiring(indexGraph(make()));
    for (const [id, b] of layout.boxes) {
      const c = again.boxes.get(id)!;
      expect([c.x, c.y, c.w, c.h]).toEqual([b.x, b.y, b.w, b.h]);
    }
    expect(countCrossings(again)).toBe(countCrossings(layout));
  });
});

describe('受け入れ条件: 基準の graph の高さ', () => {
  it(`8-0 の高さ（${OLD_BASELINE_HEIGHT}）の 50% 以下`, () => {
    const layout = layoutWiring(indexGraph(baseline()));
    expect(layout.height).toBeLessThanOrEqual(OLD_BASELINE_HEIGHT * 0.5);
  });
});
