import {
  diffGraphs,
  diffGraphsV2,
  isEmptyDiff,
  isEmptyDiffV2,
  upgradeGraph,
  type GraphDiff,
  type GraphDiffV2,
  type WireRef,
} from '@stack-atlas/core';
import {
  detectGraphVersion,
  validateGraphV2,
  type Edge,
  type Graph,
  type GraphV2,
} from '@stack-atlas/schema';
import { readFileSync } from 'node:fs';

const edge = (e: Edge) => `${e.from} → ${e.to}（${e.kind}${e.label ? `: ${e.label}` : ''}）`;
const wire = (w: WireRef) => `${w.from} → ${w.to}（${w.via}）`;

/** 見出し・件数・行を足す（0 件なら出さない） */
function sections(lines: string[]) {
  return (title: string, items: string[]) => {
    if (!items.length) return;
    lines.push(`${title}（${items.length}）`);
    for (const i of items) lines.push(`  ${i}`);
  };
}

/** 差分を日本語のテキストにする（v1） */
export function formatDiff(d: GraphDiff, prevLabel = 'prev', nextLabel = 'next'): string {
  const lines = [`差分: ${prevLabel} → ${nextLabel}`];
  if (isEmptyDiff(d)) {
    lines.push('差分なし');
    return lines.join('\n');
  }
  const section = sections(lines);
  section('+ 追加ノード', d.addedNodes);
  section('- 削除ノード', d.removedNodes);
  section(
    '~ 変更ノード',
    d.changedNodes.map((c) => `${c.id}: ${c.fields.join(', ')}`),
  );
  section('+ 追加エッジ', d.addedEdges.map(edge));
  section('- 削除エッジ', d.removedEdges.map(edge));
  lines.push(
    `合計: ノード +${d.addedNodes.length} / -${d.removedNodes.length} / ~${d.changedNodes.length}、エッジ +${d.addedEdges.length} / -${d.removedEdges.length}`,
  );
  return lines.join('\n');
}

/** 差分を日本語のテキストにする（v2: 箱・線・型・項目。docs/16 §10） */
export function formatDiffV2(
  d: GraphDiffV2,
  prevLabel = 'prev',
  nextLabel = 'next',
  note?: string,
): string {
  const lines = [`差分: ${prevLabel} → ${nextLabel}（graph.json v2）`];
  if (note) lines.push(note);
  if (isEmptyDiffV2(d)) {
    lines.push('差分なし');
    return lines.join('\n');
  }
  const section = sections(lines);
  section('+ 追加の箱', d.addedNodes);
  section('- 削除の箱', d.removedNodes);
  section(
    '~ 変更の箱',
    d.changedNodes.map((c) => `${c.id}: ${c.fields.join(', ')}`),
  );
  section('+ 追加の項目', d.addedItems);
  section('- 削除の項目', d.removedItems);
  section('+ 追加の線', d.addedWires.map(wire));
  section('- 削除の線', d.removedWires.map(wire));
  section(
    '~ 変更の線',
    d.changedWires.map((w) => `${wire(w)}: ${w.fields.join(', ')}`),
  );
  section('+ 追加の型', d.addedTypes);
  section('- 削除の型', d.removedTypes);
  lines.push(
    `合計: 箱 +${d.addedNodes.length} / -${d.removedNodes.length} / ~${d.changedNodes.length}、` +
      `項目 +${d.addedItems.length} / -${d.removedItems.length}、` +
      `線 +${d.addedWires.length} / -${d.removedWires.length} / ~${d.changedWires.length}、` +
      `型 +${d.addedTypes.length} / -${d.removedTypes.length}`,
  );
  return lines.join('\n');
}

type Loaded = { version: 1; graph: Graph } | { version: 2; graph: GraphV2 };

function readGraph(file: string): Loaded {
  const json = JSON.parse(readFileSync(file, 'utf8')) as unknown;
  const version = detectGraphVersion(json);
  const g = json as { nodes?: unknown; edges?: unknown; wires?: unknown };
  if (version === 2) {
    if (!Array.isArray(g?.nodes) || !Array.isArray(g?.wires)) {
      throw new Error(`${file} は graph.json v2 ではありません（nodes / wires がありません）`);
    }
    // 形の崩れた v2（口の無い箱など）で比べると落ちるので、スキーマを通らなければ読めないものとして扱う。
    // 参照切れ（無い箱への線など）は比べられるので通す（stack-atlas validate で一覧）
    const r = validateGraphV2(json);
    if (!r.graph) {
      const shown = r.errors
        .slice(0, 3)
        .map((e) => `${e.path}: ${e.message}`)
        .join('; ');
      const more = r.errors.length > 3 ? ` ほか ${r.errors.length - 3} 件` : '';
      throw new Error(`${file} は graph.json v2 のスキーマを満たしません（${shown}${more}）`);
    }
    return { version: 2, graph: r.graph };
  }
  if (!Array.isArray(g?.nodes) || !Array.isArray(g?.edges)) {
    throw new Error(`${file} は graph.json ではありません（nodes / edges がありません）`);
  }
  return { version: 1, graph: json as Graph };
}

/**
 * `stack-atlas diff <prev.json> <next.json>`。差分があっても終了コードは 0。
 * 両方 v1 ならノード・エッジで、どちらかが v2 なら箱・線・型・項目で比べる（v1 の側は upgradeGraph で v2 にする。
 * Phase 8-1 より前の graph.json と比べられる）
 */
export function runDiff(args: string[], out: (s: string) => void = console.log): number {
  const [prev, next] = args;
  if (!prev || !next) {
    console.error('使い方: stack-atlas diff <prev.json> <next.json>');
    return 2;
  }
  let a: Loaded;
  let b: Loaded;
  try {
    a = readGraph(prev);
    b = readGraph(next);
  } catch (e) {
    console.error(`✗ ${(e as Error).message}`);
    return 2;
  }
  if (a.version === 1 && b.version === 1) {
    out(formatDiff(diffGraphs(a.graph, b.graph), prev, next));
    return 0;
  }
  const upgraded = [a, b].filter((x) => x.version === 1).length;
  const toV2 = (x: Loaded) => (x.version === 2 ? x.graph : upgradeGraph(x.graph));
  const note = upgraded
    ? `（v1 の側は v2 に変換して比べました。箱の単位なので、項目の差は言語アダプタの出力どうしでないと出ません）`
    : undefined;
  out(formatDiffV2(diffGraphsV2(toV2(a), toV2(b)), prev, next, note));
  return 0;
}
