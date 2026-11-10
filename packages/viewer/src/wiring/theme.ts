// 箱の種類の形と色、種類の文字、レーンの背景の色（prototype/dataflow-mock.html 第 6 版と同じ）
import type { NodeKindV2 } from '@stack-atlas/schema';

export interface KindStyle {
  /** 線と塗りの色 */
  c: string;
  /** 角の丸み（999 は丸い端） */
  rx: number;
  dash?: string;
  /** 二重の枠（endpoint） */
  double?: boolean;
  /** 名前の下の帯（table） */
  band?: boolean;
}

export const KIND: Record<NodeKindV2, KindStyle> = {
  screen: { c: '#4f8cff', rx: 4 },
  component: { c: '#a78bfa', rx: 10 },
  hook: { c: '#c084fc', rx: 18 },
  helper: { c: '#94a3b8', rx: 2 },
  fn: { c: '#4ade80', rx: 6 },
  endpoint: { c: '#fbbf24', rx: 0, double: true },
  table: { c: '#f472b6', rx: 3, band: true },
  infra: { c: '#ff9f43', rx: 2, dash: '5 3' },
  cache: { c: '#22d3ee', rx: 14, dash: '2 3' },
  trigger: { c: '#fde047', rx: 999 },
  actor: { c: '#cbd5e1', rx: 999 },
  external: { c: '#f87171', rx: 2, dash: '5 3' },
  queue: { c: '#fb923c', rx: 8, dash: '6 2' },
};

/** 箱の外側の左上に出す種類（docs/15 §3.6 の唯一の例外。名前だけでは何か分からないので） */
export const KIND_LABEL: Record<NodeKindV2, string> = {
  screen: 'screen',
  component: 'component',
  hook: 'hook',
  helper: 'helper',
  fn: 'function',
  endpoint: 'endpoint',
  table: 'table',
  cache: 'cache',
  trigger: 'trigger',
  actor: 'actor',
  external: 'external',
  infra: 'infra',
  queue: 'queue',
};

/** レーンごとのうっすらした背景の色（拡大しても今どのレーンにいるか分かるように） */
export const LANE_TINT: Record<string, string> = {
  user: '#cbd5e1',
  browser: '#4f8cff',
  edge: '#22d3ee',
  build: '#a3e635',
  server: '#4ade80',
  data: '#f472b6',
  external: '#f87171',
};
