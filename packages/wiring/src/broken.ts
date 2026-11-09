// 切れている線（docs/16 §6、docs/15 §3.3）。合流点で両側の項目が食い違っている所を、項目の木から計算する。
// 名前が相手に無い（error）、wireType が互換でない（error）、送る側が nullable / optional で受ける側は必須（warn）
import { wireTypeCompatible, type BrokenV2 } from '@stack-atlas/schema';
import type { GraphIndex, IndexedItem, IndexedWire } from './graph-index.js';

/** 切れている線の端（書かれた broken の 1 件ごと）。配線図はこの 2 点の間を赤の破線で描き、受ける側の手前で切る */
export interface BrokenEnd {
  /** `b<i>`（全部の線の broken を宣言順に数えた番号） */
  key: string;
  wire: IndexedWire;
  broken: BrokenV2;
  /** 送る側で path が指す項目（無ければ最も近い祖先。最後は線の from） */
  from: IndexedItem;
  /** 受ける側で path が指す項目（無ければ最も近い祖先。最後は線の to） */
  to: IndexedItem;
}

export interface BrokenWire {
  wire: IndexedWire;
  broken: BrokenV2[];
}

const relPath = (item: IndexedItem, root: IndexedItem) =>
  item === root ? '' : item.path.slice(root.path.length + 1);

/** 1 本の線の食い違い。子は再帰、配列は要素で（要素は配列の項目の子として書かれている） */
export function brokenOfWire(w: IndexedWire): BrokenV2[] {
  const out: BrokenV2[] = [];
  const seen = new Set<string>();
  const add = (b: BrokenV2) => {
    const k = `${b.path}|${b.level}|${b.reason}`;
    if (seen.has(k)) return;
    seen.add(k);
    out.push(b);
  };

  const compare = (a: IndexedItem, b: IndexedItem) => {
    const path = relPath(a, w.from);
    const wa = a.item.wireType;
    const wb = b.item.wireType;
    if (wa && wb && !wireTypeCompatible(wa, wb)) {
      add({ path, level: 'error', reason: `wireType が互換でない（${wa} → ${wb}）` });
    }
    if (a.item.nullable && !b.item.nullable) {
      add({ path, level: 'warn', reason: '送る側が nullable、受ける側は必須' });
    }
    if (a.item.optional && !b.item.optional) {
      add({ path, level: 'warn', reason: '送る側が optional、受ける側は必須' });
    }
    // 子の照合は両側が子を宣言しているときだけ（子の無い側は不透明。RequestInit や T など）
    if (a.children.length === 0 || b.children.length === 0) return;
    const byId = new Map(b.children.map((c) => [c.id, c]));
    for (const ca of a.children) {
      const cb = byId.get(ca.id);
      if (!cb) {
        add({
          path: relPath(ca, w.from),
          level: 'error',
          reason: `受ける側（${b.node.node.name}）に無い`,
        });
        continue;
      }
      compare(ca, cb);
    }
    const aIds = new Set(a.children.map((c) => c.id));
    for (const cb of b.children) {
      if (aIds.has(cb.id) || cb.item.optional) continue;
      // 受ける側だけにある必須の項目。path は「送る側にあれば」の位置（受ける側の相対パスと同じ）
      add({
        path: path ? `${path}.${cb.id}` : cb.id,
        level: 'error',
        reason: `送る側（${a.node.node.name}）に無い。受ける側（${b.node.node.name}）では必須`,
      });
    }
  };
  compare(w.from, w.to);
  return out;
}

/** 全部の線の食い違い（1 つ以上あるものだけ） */
export function detectBroken(index: GraphIndex): BrokenWire[] {
  const out: BrokenWire[] = [];
  for (const w of index.wires) {
    const broken = brokenOfWire(w);
    if (broken.length) out.push({ wire: w, broken });
  }
  return out;
}

/** 線の端の項目から、相対パスの最も深い所まで降りる（無い段で止まる） */
function descend(root: IndexedItem, path: string): IndexedItem {
  if (!path) return root;
  let cur = root;
  for (const seg of path.split('.')) {
    const next = cur.children.find((c) => c.id === seg);
    if (!next) break;
    cur = next;
  }
  return cur;
}

/**
 * graph.json に書かれた broken（抽出時の照合の結果。コードの事実）を、描く端の組にする。
 * 表示は書かれたものを正にする（detectBroken は抽出器とテストが使う）
 */
export function brokenEnds(index: GraphIndex): BrokenEnd[] {
  const out: BrokenEnd[] = [];
  for (const w of index.wires) {
    for (const b of w.wire.broken ?? []) {
      out.push({
        key: `b${out.length}`,
        wire: w,
        broken: b,
        from: descend(w.from, b.path),
        to: descend(w.to, b.path),
      });
    }
  }
  return out;
}
