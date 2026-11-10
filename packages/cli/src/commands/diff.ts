import { diffGraphs, isEmptyDiff, type GraphDiff } from '@stack-atlas/core';
import type { Edge, Graph } from '@stack-atlas/schema';
import { readFileSync } from 'node:fs';

const edge = (e: Edge) => `${e.from} → ${e.to}（${e.kind}${e.label ? `: ${e.label}` : ''}）`;

/** 差分を日本語のテキストにする */
export function formatDiff(d: GraphDiff, prevLabel = 'prev', nextLabel = 'next'): string {
  const lines = [`差分: ${prevLabel} → ${nextLabel}`];
  if (isEmptyDiff(d)) {
    lines.push('差分なし');
    return lines.join('\n');
  }
  const section = (title: string, items: string[]) => {
    if (!items.length) return;
    lines.push(`${title}（${items.length}）`);
    for (const i of items) lines.push(`  ${i}`);
  };
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

function readGraph(file: string): Graph {
  const json = JSON.parse(readFileSync(file, 'utf8')) as Graph;
  if (!Array.isArray(json?.nodes) || !Array.isArray(json?.edges)) {
    throw new Error(`${file} は graph.json ではありません（nodes / edges がありません）`);
  }
  return json;
}

/** `stack-atlas diff <prev.json> <next.json>`。差分があっても終了コードは 0 */
export function runDiff(args: string[], out: (s: string) => void = console.log): number {
  const [prev, next] = args;
  if (!prev || !next) {
    console.error('使い方: stack-atlas diff <prev.json> <next.json>');
    return 2;
  }
  let a: Graph;
  let b: Graph;
  try {
    a = readGraph(prev);
    b = readGraph(next);
  } catch (e) {
    console.error(`✗ ${(e as Error).message}`);
    return 2;
  }
  out(formatDiff(diffGraphs(a, b), prev, next));
  return 0;
}
