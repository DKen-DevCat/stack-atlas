/** テスト用: examples/race-site.graph.json（v1）と examples/fixture-poly.today.v2.json（v2）を読み込む（Node 環境専用。本体からは import しない） */
import { readFileSync } from 'node:fs';
import { validateGraph, type Graph } from '@stack-atlas/schema';

export const SAMPLE_PATH = new URL('../../../../examples/race-site.graph.json', import.meta.url);
export const SAMPLE_V2_PATH = new URL(
  '../../../../examples/fixture-poly.today.v2.json',
  import.meta.url,
);

export function loadSampleGraph(): Graph {
  const res = validateGraph(JSON.parse(readFileSync(SAMPLE_PATH, 'utf8')));
  if (!res.graph) throw new Error('sample graph is invalid');
  return res.graph;
}
