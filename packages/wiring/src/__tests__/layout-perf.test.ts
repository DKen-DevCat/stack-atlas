// レイアウトの速さの目安（docs/18 §3.1・§4）: 箱 300・項目 3000・線 1000 の合成グラフで、配置 1 回が CPU 時間 300ms 以内。
// 時間はこのスレッドの CPU 時間で測る（壁時計ではない。pnpm -r の並列実行で待たされた分と、V8 の裏のスレッド（並行の
// JIT・GC）の分を数えない。process.threadCpuUsage が無い Node では process.cpuUsage）。
// 暖機 2 回の後の 5 回の最小を見る（1 回目は JIT の暖機を含む。CLI の upgrade-wiring.test と同じ考え）。
// 測った値（2026-11-09、手元・他の処理で負荷のある状態）: 1 回目 210〜240ms、2 回目 190ms、暖まった後 55〜70ms（このスレッド）。
// process.cpuUsage（全スレッド）では 2 回目が 500ms ほどになる（並行の JIT・GC の分）。
// 8-3a のレビューの修正の後（同日、node で直に）: 1 回目 200〜230ms、暖まった後 60〜70ms（直す前は同じ測り方で 150ms・55〜65ms。
// 増えた分は最後の回の入れ替え（Placer.refine）と、並べ方の悪さを積んだ位置で測る分）
import { describe, expect, it } from 'vitest';
import type { GraphV2 } from '@stack-atlas/schema';
import { indexGraph } from '../graph-index.js';
import { layoutWiring } from '../layout/index.js';
import type { Cfg, Chain, ChainPoint } from '../layout/model.js';
import { placeX } from '../layout/route.js';
import { I, N, P, W } from './fixture.js';
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

// 大きな入力で二乗にならない（8-3a のレビュー、2026-11-09。入力の形はセキュリティレビューの計測と同じものを縮めた）。
// 上限は、直した後の値の 3 倍ほどで、二乗の計算（直す前）なら上限の 3 倍以上かかる大きさにしてある（手元の CPU 時間）
describe('大きな入力で二乗にならない', () => {
  it('host の枠 6000・同じ 2 箱の間の線 16000 本: 配置 1 回が CPU 時間 1000ms 未満（以前は host ごとに全部の線を見た）', () => {
    // 測った値（手元）: 直す前 約 4000ms（host 6000 × 線 16000）、直した後 約 340ms
    const nodes = [
      N('fn:x', 'fn', 'browser', [P('out', 'out', [I('o', 'int')])]),
      N('fn:y', 'fn', 'server', [P('in', 'in', [I('a', 'int')])]),
    ];
    for (let i = 0; i < 6000; i++) {
      nodes.push(N(`infra:h${i}`, 'infra', 'server', []));
      nodes.push(N(`fn:b${i}`, 'fn', 'server', [], { host: `infra:h${i}` }));
    }
    const g: GraphV2 = {
      version: 2,
      nodes,
      wires: Array.from({ length: 16000 }, () => W('fn:x#out/o', 'fn:y#in/a', 'call')),
    };
    const index = indexGraph(g);
    let layout: ReturnType<typeof layoutWiring> | undefined;
    const ms = cpuMs(() => (layout = layoutWiring(index)));
    expect(layout!.hosts.size).toBe(6000);
    expect(ms).toBeLessThan(1000);
  });

  it('1 本の通り道に互いに重ならない縦の区間 6 万本: トラックの割り当てが CPU 時間 600ms 未満（以前はトラックの区間を全部見た）', () => {
    // 2 つの箱の間で組ごとに交差する線の対（セキュリティレビューの b_pair）の、通り道の中だけを取り出した形。
    // 測った値（手元）: 直す前 約 4600ms（6 万 × 6 万 / 2 回の重なりの判定）、直した後 約 130ms
    const n = 60_000;
    const pin = (col: number) =>
      ({ kind: 'pin', box: { col }, ref: '', o: 0 }) as unknown as ChainPoint;
    const chains = Array.from(
      { length: n },
      (_, seq) =>
        ({
          seq,
          cut: false,
          chans: [1],
          slots: [],
          xs: [],
          points: [pin(0), pin(1)],
        }) as unknown as Chain,
    );
    const cfg = { boxW: 300, rowH: 18, pitch: 8, aspect: 1.6, widthOf: () => 300 } as Cfg;
    let out: ReturnType<typeof placeX> | undefined;
    const ms = cpuMs(() => (out = placeX([[], []], chains, cfg, (c, i) => c.seq * 100 + i * 50)));
    // 重ならないので全部トラック 0（通り道の幅は最小）
    expect(new Set(chains.map((c) => c.xs[0])).size).toBe(1);
    expect(out!.chW[1]).toBe(40);
    expect(ms).toBeLessThan(600);
  });
});
