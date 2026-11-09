// レイアウトの速さの目安（docs/18 §3.1・§4）: 箱 300・項目 3000・線 1000 の合成グラフで、配置 1 回が CPU 時間 300ms 以内。
// 時間はこのスレッドの CPU 時間で測る（壁時計ではない。pnpm -r の並列実行で待たされた分と、V8 の裏のスレッド（並行の
// JIT・GC）の分を数えない。process.threadCpuUsage が無い Node では process.cpuUsage）。
// 暖機 2 回の後の 5 回の最小を見る（1 回目は JIT の暖機を含む。CLI の upgrade-wiring.test と同じ考え）。
// 測った値（2026-11-09、手元・他の処理で負荷のある状態）: 1 回目 210〜240ms、2 回目 190ms、暖まった後 55〜70ms（このスレッド）。
// process.cpuUsage（全スレッド）では 2 回目が 500ms ほどになる（並行の JIT・GC の分）
import { describe, expect, it } from 'vitest';
import { indexGraph } from '../graph-index.js';
import { layoutWiring } from '../layout/index.js';
import { countCrossings, boxOverlaps, hostOverlaps, wiresThroughBoxes } from './metrics.js';
import { synthetic } from './synthetic.js';

const LIMIT_MS = 300;

type Usage = NodeJS.CpuUsage;
const threadCpu = (process as { threadCpuUsage?: (prev?: Usage) => Usage }).threadCpuUsage;
const usage = (prev?: Usage): Usage =>
  threadCpu ? threadCpu.call(process, prev) : process.cpuUsage(prev);
const cpuMs = (f: () => void) => {
  const t0 = usage();
  f();
  const d = usage(t0);
  return (d.user + d.system) / 1000;
};

describe('layoutWiring の速さ（箱 300・項目 3000・線 1000）', () => {
  it('合成グラフの大きさ', () => {
    const g = synthetic();
    const boxes = g.nodes.filter((n) => n.ports.length > 0);
    expect(boxes).toHaveLength(300);
    expect(boxes.reduce((a, n) => a + n.ports.reduce((b, p) => b + p.items.length, 0), 0)).toBe(
      3000,
    );
    expect(g.wires).toHaveLength(1000);
  });

  it(`配置 1 回が CPU 時間 ${LIMIT_MS}ms 未満`, () => {
    const index = indexGraph(synthetic());
    for (let i = 0; i < 2; i++) layoutWiring(index);
    const ms: number[] = [];
    for (let i = 0; i < 5; i++) ms.push(cpuMs(() => layoutWiring(index)));
    expect(Math.min(...ms)).toBeLessThan(LIMIT_MS);
  });

  it('大きな graph でも、箱・枠が重ならず、線は箱を通らない（交差の数は記録だけ）', () => {
    const layout = layoutWiring(indexGraph(synthetic()));
    expect(boxOverlaps(layout)).toEqual([]);
    expect(hostOverlaps(layout)).toEqual([]);
    expect(wiresThroughBoxes(layout)).toEqual([]);
    expect(countCrossings(layout)).toBeGreaterThan(0);
  });
});
