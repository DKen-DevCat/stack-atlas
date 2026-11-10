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
