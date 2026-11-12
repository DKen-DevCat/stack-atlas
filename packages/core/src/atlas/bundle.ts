/**
 * `.stack-atlas/` の図を、ビューアが読む 1 つの graph.json（契約 v2。部品と挙動つき）にまとめる（docs/25 §3.7、docs/26 §9）。
 * 検査に誤りがあれば、まとめない（誤りのある図を、ビューアに渡さない）
 */
import type { GraphV2 } from '@stack-atlas/schema';
import { inspectAtlas, toGraph } from './check.js';
import type { AtlasReport } from './types.js';

/** graph.json の project.generator.v2 に書く印。図が、エージェントの書いた `.stack-atlas/` から来たことを表す */
export const ATLAS_GENERATOR = 'atlas';

export interface BundleResult {
  report: AtlasReport;
  /** 検査の誤りが 0 のときだけ */
  graph?: GraphV2;
}

export function bundleAtlas(root: string, options: { name?: string } = {}): BundleResult {
  // 根拠と未読は見ない（docs/28 D261: コードを直すと根拠がずれ、ライブが開かなくなる）
  const { atlas, report } = inspectAtlas(root, { evidence: false });
  if (report.counts.errors > 0) return { report };
  const graph = toGraph(atlas);
  graph.project = { generator: { v2: ATLAS_GENERATOR } };
  if (options.name) graph.project.name = options.name;
  return { report, graph };
}
