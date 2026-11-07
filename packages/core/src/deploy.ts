/**
 * config.deploy（Lambda などのインフラノード → 載っているもの）を deploy エッジにする。
 * 抽出器が同じエッジを出していてもマージで重複排除されるので、二重に張っても問題ない。
 *
 * - `{ app: 'next' }`: そのノードに `meta.deployApp = 'next'` を付け、route / layout（kind page・layout）すべてへ deploy
 * - `{ handlers: glob | glob[] }`: `file` が glob（config のあるディレクトリ基準）に一致する handler ノードへ deploy
 * - 指定のインフラノードが無ければ警告（抽出器が出していない＝設定かインフラが変わった）
 */
import type { Edge, ValidationIssue } from '@stack-atlas/schema';
import { edgeKey } from './merge.js';
import type { PartialGraph, StackAtlasConfig } from './types.js';
import { clone, globToRegExp, issue, toPosix } from './util.js';

export function applyDeployConfig(
  graph: PartialGraph,
  config: StackAtlasConfig,
): { graph: PartialGraph; issues: ValidationIssue[] } {
  const g = clone(graph);
  const issues: ValidationIssue[] = [];
  const keys = new Set(g.edges.map(edgeKey));
  const add = (e: Edge) => {
    if (keys.has(edgeKey(e))) return;
    keys.add(edgeKey(e));
    g.edges.push(e);
  };
  for (const [infraId, spec] of Object.entries(config.deploy ?? {})) {
    const host = g.nodes.find((n) => n.id === infraId);
    if (!host) {
      issues.push(
        issue(
          'warning',
          `config#/deploy/${infraId}`,
          `config.deploy のノード "${infraId}" が抽出結果にありません`,
        ),
      );
      continue;
    }
    if (spec?.app === 'next') {
      host.meta = { ...(host.meta ?? {}), deployApp: host.meta?.deployApp ?? 'next' };
      for (const n of g.nodes) {
        if (n.kind === 'page' || n.kind === 'layout')
          add({ from: infraId, to: n.id, kind: 'deploy' });
      }
    }
    if (spec?.handlers) {
      const globs = (Array.isArray(spec.handlers) ? spec.handlers : [spec.handlers]).map((p) =>
        globToRegExp(toPosix(p)),
      );
      for (const n of g.nodes) {
        if (n.kind === 'handler' && n.file && globs.some((re) => re.test(toPosix(n.file!)))) {
          add({ from: infraId, to: n.id, kind: 'deploy' });
        }
      }
    }
  }
  return { graph: g, issues };
}
