/**
 * 合流のあとに `wires[].broken` を書く（docs/17 §3.4、D46）。照合そのものは @stack-atlas/wiring の brokenOfWire。
 *
 * 掛けるのは合流点（endpoint / table）に触れる線だけ。「切れる」はコードの事実で、合流点で両側が食い違っている線に
 * 限る（docs/15 §3.5）。言語の中の線は型検査器が通しており、構造的部分型（送る側に余分なプロパティがある）を
 * 「受ける側に無い」の error にしてしまうので掛けない。
 *
 * body の無い応答（endpoint の `out/status`）から呼び出し元の戻りへの線も照合しない: 呼び出し元の戻りは状態コードでは
 * なく、生の fetch なら Response、ラッパーなら `void` などで、integer と比べると必ず切れてしまう（2026-11-09 の確認。
 * PushToggle の fetch）
 */
import type { GraphV2, WireV2 } from '@stack-atlas/schema';
import { brokenOfWire, indexGraph } from '@stack-atlas/wiring';
import { boxOf } from './v2-parts.js';

const JOIN_KINDS = new Set(['endpoint', 'table']);

/** 合流点に触れる線か */
export function isJoinWire(w: Pick<WireV2, 'from' | 'to'>, kindOf: Map<string, string>): boolean {
  return (
    JOIN_KINDS.has(kindOf.get(boxOf(w.from)) ?? '') || JOIN_KINDS.has(kindOf.get(boxOf(w.to)) ?? '')
  );
}

/**
 * 合流点の線の broken を計算して書く（書いてあったものは置き換える。食い違いが無ければ消す）。
 * graph を書き換え、broken を持つ線の数を返す
 */
export function writeBroken(graph: GraphV2): number {
  const kindOf = new Map(graph.nodes.map((n) => [n.id, n.kind as string]));
  const targets = graph.wires.filter(
    (w) =>
      isJoinWire(w, kindOf) &&
      !(w.reply && kindOf.get(boxOf(w.from)) === 'endpoint' && w.from.endsWith('#out/status')),
  );
  if (!targets.length) return 0;
  // 索引は合流点の線だけで作る（線の参照が解けないと indexGraph は例外。掃除で落としてある前提）
  const index = indexGraph({ ...graph, wires: targets });
  let count = 0;
  for (const iw of index.wires) {
    const broken = brokenOfWire(iw);
    if (broken.length) {
      iw.wire.broken = broken;
      count++;
    } else delete iw.wire.broken;
  }
  return count;
}
