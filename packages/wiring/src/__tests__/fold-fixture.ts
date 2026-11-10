// 畳む（docs/21）のテストで使う合成 graph と、基準の graph の読み込み
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { GraphV2, NodeV2, Runtime } from '@stack-atlas/schema';
import { I, N, P } from './fixture.js';

export function load(name: string): GraphV2 {
  return JSON.parse(
    readFileSync(fileURLToPath(new URL(`./fixtures/${name}.v2.json`, import.meta.url)), 'utf8'),
  ) as GraphV2;
}

/** 入力を壊していないことを確かめるための凍結（深く） */
export function deepFreeze<T>(x: T): T {
  const stack: unknown[] = [x];
  while (stack.length) {
    const v = stack.pop();
    if (v === null || typeof v !== 'object' || Object.isFrozen(v)) continue;
    Object.freeze(v);
    for (const k of Object.keys(v)) stack.push((v as Record<string, unknown>)[k]);
  }
  return x;
}

/** in/a と out/r を持つ箱 */
export function fbox(
  id: string,
  file: string | undefined,
  extra: Partial<NodeV2> = {},
  runtime: Runtime = 'browser',
): NodeV2 {
  return N(
    id,
    'fn',
    runtime,
    [P('in', 'in', [I('a', 'string')]), P('out', 'out', [I('r', 'string')])],
    { ...(file === undefined ? {} : { file }), ...extra },
  );
}

/**
 * 見えている単位を、木を箱ごとに根までたどって数える（foldView・initialCut とは別の数え方。突き合わせ用）。
 * 返すのは単位のキー: 見えている箱は箱の id、畳んだ箱は `<入れ物の id>\n<置き場>`。木は直したもの（循環が無い）を渡す
 */
export function visibleUnits(
  c: { containers: Map<string, { parent?: string }>; parentOfBox: Map<string, string> },
  open: ReadonlySet<string>,
  boxes: Iterable<string>,
  slice: ReadonlyMap<string, string>,
): string[] {
  const out = new Set<string>();
  for (const box of boxes) {
    const chain: string[] = [];
    for (let p = c.parentOfBox.get(box); p !== undefined; p = c.containers.get(p)?.parent)
      chain.push(p);
    // 根の側から見て、最初の閉じた入れ物
    const closed = chain.reverse().find((id) => !open.has(id));
    out.add(closed === undefined ? box : `${closed}\n${slice.get(box) ?? ''}`);
  }
  return [...out];
}

/** 箱（host の枠を除く）の id */
export function boxIds(graph: GraphV2): string[] {
  const hosts = new Set(graph.nodes.flatMap((n) => (n.host === undefined ? [] : [n.host])));
  return graph.nodes.filter((n) => !hosts.has(n.id)).map((n) => n.id);
}
