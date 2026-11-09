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
 * - 子はカラムの名前で組にする（8-2b レビューで決めたこと）: 大文字小文字を区別しない（引用符の無い識別子は
 *   小文字に畳まれる。C3）、別名（`name AS user_name`）は元のカラム（項目の `meta.sql.column`）で（C1）。
 *   JOIN した行（`meta.sql.tables` が 2 つ以上）は、そのテーブルのカラム（typeRef が `table:<そのテーブル>`）だけを比べる（C2）
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

const isSqlExpr = (it: IndexedItem) =>
  isPlainObject(it.item.meta) && typeof it.item.meta.expr === 'string';

/** カラムの照合のキー（別名は元のカラム。小文字） */
function columnKey(it: IndexedItem): string {
  const sql = it.item.meta?.sql;
  const col = isPlainObject(sql) && typeof sql.column === 'string' ? sql.column : it.id;
  return col.replace(/[^A-Za-z0-9_$-]/g, '_').toLowerCase();
}

const tableNameOf = (n: IndexedItem['node']['node']): string | undefined => {
  const sql = n.meta?.sql;
  if (isPlainObject(sql) && typeof sql.table === 'string') return sql.table;
  return n.id.startsWith('schema:') ? n.id.slice('schema:'.length) : undefined;
};

/** 子を外した端（親どうしだけを brokenOfWire で比べる） */
const shallow = (it: IndexedItem): IndexedItem => ({ ...it, children: [] });

/**
 * table の線の照合（D66 と 8-2b レビューの C1〜C3）。親どうしは brokenOfWire、子はカラムの名前で組にして 1 つずつ
 * brokenOfWire で比べる。path は送る側の相対パス（組にした子は送る側の子の id）
 */
function brokenOfTableWire(iw: IndexedWire): BrokenV2[] {
  const out: BrokenV2[] = [];
  const seen = new Set<string>();
  const add = (b: BrokenV2) => {
    const k = `${b.path}|${b.level}|${b.reason}`;
    if (seen.has(k)) return;
    seen.add(k);
    out.push(b);
  };
  for (const b of brokenOfWire({ ...iw, from: shallow(iw.from), to: shallow(iw.to) })) add(b);
  const fromTable = iw.fromNode.node.kind === 'table';
  const toTable = iw.toNode.node.kind === 'table';
  const read = fromTable && iw.reply && iw.from.port.id === 'read';
  const sql = iw.from.item.meta?.sql;
  const update =
    toTable &&
    iw.to.port.id === 'write' &&
    isPlainObject(sql) &&
    typeof sql.op === 'string' &&
    sql.op.toLowerCase() === 'update';
  const senders = iw.from.children;
  let receivers = iw.to.children;
  // 子の照合は両側が子を宣言しているときだけ（子の無い側は不透明）
  if (!senders.length || !receivers.length) return out;
  if (read) {
    // JOIN した行: このテーブルのカラムだけ（C2）
    const rowSql = iw.to.item.meta?.sql;
    const joined =
      isPlainObject(rowSql) && Array.isArray(rowSql.tables) && rowSql.tables.length > 1;
    if (joined) {
      const own = `table:${tableNameOf(iw.fromNode.node) ?? ''}`.toLowerCase();
      receivers = receivers.filter((c) => (c.item.typeRef ?? '').toLowerCase() === own);
    }
  }
  const byKey = new Map<string, IndexedItem>();
  for (const c of receivers) if (!byKey.has(columnKey(c))) byKey.set(columnKey(c), c);
  const paired = new Set<IndexedItem>();
  const rel = (c: IndexedItem, root: IndexedItem) => c.path.slice(root.path.length + 1);
  for (const ca of senders) {
    const cb = byKey.get(columnKey(ca));
    const path = rel(ca, iw.from);
    if (!cb) {
      // 読む線: テーブルにしか無いカラムは選ばなかっただけ
      if (!read) add({ path, level: 'error', reason: `受ける側（${iw.toNode.node.name}）に無い` });
      continue;
    }
    paired.add(cb);
    for (const b of brokenOfWire({ ...iw, from: ca, to: cb }))
      add({ ...b, path: b.path ? `${path}.${b.path}` : path });
  }
  if (update) return out;
  for (const cb of receivers) {
    if (paired.has(cb) || cb.item.optional) continue;
    // 読む線: SQL の式はテーブルのカラムではない
    if (read && isSqlExpr(cb)) continue;
    add({
      path: rel(cb, iw.to),
      level: 'error',
      reason: `送る側（${iw.fromNode.node.name}）に無い。受ける側（${iw.toNode.node.name}）では必須`,
    });
  }
  return out;
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
    const touchesTable = iw.fromNode.node.kind === 'table' || iw.toNode.node.kind === 'table';
    const broken = touchesTable ? brokenOfTableWire(iw) : brokenOfWire(iw);
    if (broken.length) {
      iw.wire.broken = broken;
      count++;
    } else delete iw.wire.broken;
  }
  return count;
}
