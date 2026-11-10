// レイアウトの速さを測る合成グラフ（docs/18 §3.1 の性能の目安: 箱 300・項目 3000・線 1000）。決定的（乱数は線形合同法）
import type { GraphV2, NodeV2, Runtime, WireV2 } from '@stack-atlas/schema';
import { I, N, P, W } from './fixture.js';

/** 0 以上 1 未満の決定的な数列 */
function lcg(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

/**
 * 箱 300（ブラウザ 150・サーバー 120・データ 30）、箱ごとに in 5・out 5 の項目（計 3000）、線 1000。
 * 線はたいてい同じレーンの次の段か隣のレーンへ（呼び出しの深さが付く）、ときどき遠くへ・戻りへ。
 * サーバーの箱は 10 箱ずつ host の枠（infra:lambda_<n>）に入れる
 */
export function synthetic(): GraphV2 {
  const rnd = lcg(83);
  const nodes: NodeV2[] = [];
  const lanes: [Runtime, number][] = [
    ['browser', 150],
    ['server', 120],
    ['data', 30],
  ];
  const byLane: string[][] = [];
  let n = 0;
  for (const [rt, count] of lanes) {
    const ids: string[] = [];
    for (let i = 0; i < count; i++, n++) {
      const id = `fn:b${n}`;
      const host = rt === 'server' ? { host: `infra:lambda_${Math.floor(i / 10)}` } : {};
      nodes.push(
        N(
          id,
          'fn',
          rt,
          [
            P(
              'in',
              'in',
              Array.from({ length: 5 }, (_, j) => I(`i${j}`, 'int')),
            ),
            P(
              'out',
              'out',
              Array.from({ length: 5 }, (_, j) => I(`o${j}`, 'int')),
            ),
          ],
          { file: `src/m${Math.floor(i / 6)}/f${i}.ts`, ...host },
        ),
      );
      ids.push(id);
    }
    byLane.push(ids);
  }
  for (let h = 0; h < 12; h++) nodes.push(N(`infra:lambda_${h}`, 'infra', 'server', []));
  const wires: WireV2[] = [];
  const pick = <T>(a: T[]) => a[Math.floor(rnd() * a.length)]!;
  while (wires.length < 1000) {
    const li = Math.floor(rnd() * 3);
    const from = byLane[li]!;
    const fi = Math.floor(rnd() * from.length);
    const r = rnd();
    let to: string;
    if (r < 0.55) {
      // 同じレーンの少し先
      const ti = Math.min(from.length - 1, fi + 1 + Math.floor(rnd() * 12));
      if (ti === fi) continue;
      to = from[ti]!;
    } else if (r < 0.9 && li < 2) to = pick(byLane[li + 1]!);
    else to = pick(pick(byLane));
    if (to === from[fi]) continue;
    const reply = r > 0.95;
    wires.push(
      W(
        `${from[fi]}#out/o${Math.floor(rnd() * 5)}`,
        `${to}#in/i${Math.floor(rnd() * 5)}`,
        reply ? 'return' : 'call',
        reply,
      ),
    );
  }
  return { version: 2, nodes, wires };
}
