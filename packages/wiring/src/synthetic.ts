// 大きさを測るための合成グラフ（docs/18 §3.1 の性能の目安: 箱 300・項目 3000・線 1000）。決定的（乱数は線形合同法）。
// 配置の速さの単体テスト（__tests__/layout-perf.test.ts）、ビューアの e2e、塗りの計測（packages/viewer/scripts/
// measure-paint.mjs。docs/18 §11.14）が同じものを使う。index.ts からは出さない（ビューアの束に入れない。相対パスで読む）
import type { GraphV2, NodeV2, Runtime, WireV2 } from '@stack-atlas/schema';

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
  const items = (prefix: string) =>
    Array.from({ length: 5 }, (_, j) => ({
      id: `${prefix}${j}`,
      name: `${prefix}${j}`,
      type: 'int',
    }));
  const byLane: string[][] = [];
  let n = 0;
  for (const [rt, count] of lanes) {
    const ids: string[] = [];
    for (let i = 0; i < count; i++, n++) {
      const id = `fn:b${n}`;
      nodes.push({
        id,
        kind: 'fn',
        name: `b${n}`,
        runtime: rt,
        ports: [
          { id: 'in', dir: 'in', items: items('i') },
          { id: 'out', dir: 'out', items: items('o') },
        ],
        file: `src/m${Math.floor(i / 6)}/f${i}.ts`,
        ...(rt === 'server' ? { host: `infra:lambda_${Math.floor(i / 10)}` } : {}),
      });
      ids.push(id);
    }
    byLane.push(ids);
  }
  for (let h = 0; h < 12; h++)
    nodes.push({
      id: `infra:lambda_${h}`,
      kind: 'infra',
      name: `lambda_${h}`,
      runtime: 'server',
      ports: [],
    });
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
    wires.push({
      from: `${from[fi]}#out/o${Math.floor(rnd() * 5)}`,
      to: `${to}#in/i${Math.floor(rnd() * 5)}`,
      via: reply ? 'return' : 'call',
      ...(reply ? { reply: true } : {}),
    });
  }
  return { version: 2, nodes, wires };
}
