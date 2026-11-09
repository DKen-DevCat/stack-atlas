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
 *
 * table の線（D66。2026-11-09 8-2b の決定）:
 * - 読む線（`table#read/row → fn#in/row`、reply）は受ける側の子（SELECT で選んだカラム）だけを比べる。テーブルにしか
 *   無いカラム（送る側だけの子）は選ばなかっただけなので error にしない。SQL の式（`SUM(amount)`。項目の `meta.expr`）は
 *   テーブルのカラムではないので、受ける側だけにあっても error にしない
 * - UPDATE の線（`update_n → table#write/row`）は送る側の子（SET のカラム）だけを比べる（必須のカラムを全部書かなくてよい）。
 *   INSERT は従来どおり両側（必須のカラムを書いていなければ error）
 *
 * 役割ごとの欠け（D59。合流の段が broken を書いた線）は照合し直さない（opts.fixed）
 */
import type { BrokenV2, GraphV2, WireV2 } from '@stack-atlas/schema';
import { brokenOfWire, indexGraph, type IndexedItem, type IndexedWire } from '@stack-atlas/wiring';
import { boxOf, wireKey } from './v2-parts.js';
import { isPlainObject } from './util.js';

const JOIN_KINDS = new Set(['endpoint', 'table']);

/** 合流点に触れる線か */
export function isJoinWire(w: Pick<WireV2, 'from' | 'to'>, kindOf: Map<string, string>): boolean {
  return (
    JOIN_KINDS.has(kindOf.get(boxOf(w.from)) ?? '') || JOIN_KINDS.has(kindOf.get(boxOf(w.to)) ?? '')
  );
}

export interface WriteBrokenOptions {
  /** broken を書いたまま照合し直さない線の wireKey（合流の段の D59 の線） */
  fixed?: ReadonlySet<string>;
}

/** 相対パスの項目（無ければ undefined） */
function at(root: IndexedItem, path: string): IndexedItem | undefined {
  if (!path) return root;
  let cur: IndexedItem | undefined = root;
  for (const seg of path.split('.')) {
    cur = cur?.children.find((c) => c.id === seg);
    if (!cur) return undefined;
  }
  return cur;
}

const isSqlExpr = (it: IndexedItem | undefined) =>
  !!it && isPlainObject(it.item.meta) && typeof it.item.meta.expr === 'string';

/** table の線の照合の絞り込み（D66） */
function filterTable(iw: IndexedWire, broken: BrokenV2[]): BrokenV2[] {
  const fromTable = iw.fromNode.node.kind === 'table';
  const toTable = iw.toNode.node.kind === 'table';
  if (fromTable && iw.wire.reply && iw.from.port.id === 'read') {
    // 読む線: 受ける側（SELECT の 1 行）にある子だけ。式の項目は比べない
    return broken.filter((b) => {
      const to = at(iw.to, b.path);
      if (!to) return false;
      return !(isSqlExpr(to) && !at(iw.from, b.path));
    });
  }
  if (toTable && iw.to.port.id === 'write') {
    const sql = iw.from.item.meta?.sql;
    const op = isPlainObject(sql) && typeof sql.op === 'string' ? sql.op.toLowerCase() : '';
    // UPDATE: 送る側（SET のカラム）にある子だけ
    if (op === 'update') return broken.filter((b) => !!at(iw.from, b.path));
  }
  return broken;
}

/**
 * 合流点の線の broken を計算して書く（書いてあったものは置き換える。食い違いが無ければ消す）。
 * graph を書き換え、broken を持つ線の数を返す
 */
export function writeBroken(graph: GraphV2, opts: WriteBrokenOptions = {}): number {
  const kindOf = new Map(graph.nodes.map((n) => [n.id, n.kind as string]));
  const fixed = opts.fixed ?? new Set<string>();
  let count = 0;
  const targets = graph.wires.filter((w) => {
    if (fixed.has(wireKey(w))) {
      if (w.broken?.length) count++;
      return false;
    }
    return (
      isJoinWire(w, kindOf) &&
      !(w.reply && kindOf.get(boxOf(w.from)) === 'endpoint' && w.from.endsWith('#out/status'))
    );
  });
  if (!targets.length) return count;
  // 索引は合流点の線だけで作る（線の参照が解けないと indexGraph は例外。掃除で落としてある前提）
  const index = indexGraph({ ...graph, wires: targets });
  for (const iw of index.wires) {
    const broken = filterTable(iw, brokenOfWire(iw));
    if (broken.length) {
      iw.wire.broken = broken;
      count++;
    } else delete iw.wire.broken;
  }
  return count;
}
