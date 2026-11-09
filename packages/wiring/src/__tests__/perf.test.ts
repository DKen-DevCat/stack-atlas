// たどりの速さの目安（退行の防止）: 箱 200 × 項目 40 の合成グラフで、箱と host の枠のクリックが十分に速いこと。
// 2026-11-09: 辺の解決（links の解決・子孫の走査・写し）を状態ごとに覚えるようにした（同じ項目を 2 段のたどりの回ごと、
// host の枠の箱ごとに解き直していた）。直す前はこのグラフの host の枠のクリックに 1 秒以上かかった。
// 時間は壁時計ではなく CPU 時間で測る（pnpm -r の並列実行で待たされた分を数えない）。links を読む回数は決定的に数える
import { describe, expect, it } from 'vitest';
import type { GraphV2, LinkV2, NodeV2, WireV2 } from '@stack-atlas/schema';
import { indexGraph } from '../graph-index.js';
import { select } from '../select.js';
import { defaultState } from '../variants.js';
import { I, N, P, W } from './fixture.js';

const BOXES = 200;
/** 口ごとの子の数（口の項目は 親 1 ＋ 子 19 = 20、箱は 40） */
const KIDS = 19;
/** CPU 時間の上限。直した後は 130〜250ms（並列実行中）、直す前は host の枠のクリックが 1.3 秒以上。遅い CI でも落ちない幅を取る */
const LIMIT_MS = 1000;

/**
 * 箱 k の out/res → 箱 k+1 の in/req の鎖。箱の中は親どうし・子どうしの links（in/req.a<j> → out/res.b<j>）。
 * 4 箱ごとに共有の store を呼び、store は呼び出し元へ戻す（往復の相手が多いので 2 段のたどりが回る）。
 * 50 箱ごとに 1 つ（計 4 つ）を host の枠 infra:lambda に入れる
 */
function bigGraph(): GraphV2 {
  const nodes: NodeV2[] = [];
  const wires: WireV2[] = [];
  const kids = (p: string) => Array.from({ length: KIDS }, (_, j) => I(`${p}${j}`, 'int'));
  for (let k = 0; k < BOXES; k++) {
    const links: LinkV2[] = [{ from: 'in/req', to: 'out/res' }];
    for (let j = 0; j < KIDS; j++) links.push({ from: `in/req.a${j}`, to: `out/res.b${j}` });
    nodes.push(
      N(
        `fn:f${k}`,
        'fn',
        'server',
        [
          P('in', 'in', [I('req', 'Req', { children: kids('a') })]),
          P('out', 'out', [I('res', 'Res', { children: kids('b') })]),
        ],
        { links, ...(k % 50 === 25 ? { host: 'infra:lambda' } : {}) },
      ),
    );
  }
  nodes.push(N('infra:lambda', 'infra', 'server', []));
  nodes.push(
    N('fn:store', 'fn', 'server', [
      P('in', 'in', [I('q', 'int')]),
      P('out', 'out', [I('r', 'int')]),
    ]),
  );
  for (let k = 0; k + 1 < BOXES; k++)
    wires.push(W(`fn:f${k}#out/res`, `fn:f${k + 1}#in/req`, 'call'));
  for (let k = 0; k < BOXES; k += 4) {
    wires.push(W(`fn:f${k}#out/res.b0`, 'fn:store#in/q', 'call'));
    wires.push(W('fn:store#out/r', `fn:f${k}#in/req.a1`, 'return', true));
  }
  return { version: 2, nodes, wires };
}

/** 箱の links を読んだ回数を数える（links を読むのは linksOf だけ。辺の表を覚えていれば箱ごと状態ごとに 1 回） */
function countLinkReads(g: GraphV2): Map<string, number> {
  const reads = new Map<string, number>();
  for (const n of g.nodes) {
    const links = n.links;
    if (!links) continue;
    Object.defineProperty(n, 'links', {
      configurable: true,
      enumerable: true,
      get() {
        reads.set(n.id, (reads.get(n.id) ?? 0) + 1);
        return links;
      },
    });
  }
  return reads;
}

/** この処理（プロセス）が使った CPU 時間（ms）。並列に走る他のテストに待たされた分を含めない */
const cpuMs = (f: () => void) => {
  const t0 = process.cpuUsage();
  f();
  const d = process.cpuUsage(t0);
  return (d.user + d.system) / 1000;
};

describe('traverse の速さ（箱 200 × 項目 40）', () => {
  it('箱の links の解決は、箱ごと状態ごとに 1 回（2 段のたどりの回ごと・host の枠の箱ごとに解き直さない）', () => {
    const g = bigGraph();
    const reads = countLinkReads(g);
    const idx = indexGraph(g);
    const st = defaultState(idx);
    select(idx, st, { kind: 'box', id: 'fn:f100' });
    select(idx, st, { kind: 'host', id: 'infra:lambda' });
    select(idx, st, { kind: 'item', ref: 'fn:f10#in/req.a3' });
    expect(reads.size).toBe(BOXES);
    expect(Math.max(...reads.values())).toBe(1);
  });

  // テストごとに索引を作る（辺の表は索引ごとに覚えるので、前のテストの分を持ち越さない）
  it(`真ん中の箱をクリック（上流＋下流）: CPU 時間 ${LIMIT_MS}ms 未満`, () => {
    const idx = indexGraph(bigGraph());
    const st = defaultState(idx);
    let lit: ReturnType<typeof select> = null;
    const ms = cpuMs(() => (lit = select(idx, st, { kind: 'box', id: 'fn:f100' })));
    expect(lit!.boxes.size).toBe(BOXES + 1);
    expect(ms).toBeLessThan(LIMIT_MS);
  });

  it(`host の枠をクリック（中の箱 4 つを独立にたどって合併）: CPU 時間 ${LIMIT_MS}ms 未満`, () => {
    const idx = indexGraph(bigGraph());
    const st = defaultState(idx);
    let lit: ReturnType<typeof select> = null;
    const ms = cpuMs(() => (lit = select(idx, st, { kind: 'host', id: 'infra:lambda' })));
    expect(lit!.startBoxes.size).toBe(4);
    expect(lit!.boxes.size).toBe(BOXES + 1);
    expect(ms).toBeLessThan(LIMIT_MS);
  });
});
