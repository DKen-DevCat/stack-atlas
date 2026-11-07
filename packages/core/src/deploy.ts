/**
 * config.deploy（インフラノード → 載っているもの、docs/12 §3.1）を deploy エッジにする。
 * 抽出器が同じエッジを出していてもマージで重複排除されるので、二重に張っても問題ない。
 * キーのノードは何でもよい（Lambda・S3・ECS…）。
 *
 * - `{ app: 'next' }`: そのノードに `meta.deployApp = 'next'` を付け、route / layout（kind page・layout）すべてへ deploy
 * - `{ handlers: glob | glob[] }`: `file` が glob に一致する handler ノードへ deploy。
 *   glob は repo 相対（複数 repo なら `<repo>/` を外して照合）。`<repo>/…` 付きの glob も可
 * - `{ go: 'cmd/api' }`: Go のパッケージノードへ deploy。対象は、ID が `<kind>:cmd/api`（handler: / lib: など）、
 *   `meta.go.pkg === 'cmd/api'`、または `file` のディレクトリ（repo 相対）が `cmd/api` のコードノード（infra 以外）
 * - `{ nodes: [id…] }`: 指定 ID へ直接 deploy。無い ID は **エラー**
 * - キーのノードが無ければ **エラー**（人が書いたものなので厳密に。overrides と同じ）
 * - `go` / `handlers` が 1 つも合わなければ警告
 */
import type { Edge, ValidationIssue } from '@stack-atlas/schema';
import { posix } from 'node:path';
import type { RepoOf } from './classify.js';
import { edgeKey } from './merge.js';
import { splitRepoFile } from './repo.js';
import type { PartialGraph, PartialNode, StackAtlasConfig } from './types.js';
import { clone, globToRegExp, isPlainObject, issue, toArray, toPosix } from './util.js';

/** Go のパッケージノードか（`go` 指定で deploy 先にする） */
function isGoPackage(n: PartialNode, pkg: string, repoOf: RepoOf): boolean {
  if (n.kind === 'infra' || n.kind === 'actor') return false;
  const i = n.id.indexOf(':');
  if (i > 0 && n.id.slice(i + 1) === pkg) return true;
  const go = n.meta?.go;
  if (isPlainObject(go) && go.pkg === pkg) return true;
  if (n.file) {
    const { path } = repoOf(n.file);
    if (path.endsWith('.go') && posix.dirname(path) === pkg) return true;
  }
  return false;
}

export function applyDeployConfig(
  graph: PartialGraph,
  config: StackAtlasConfig,
  repoOf: RepoOf = (f) => splitRepoFile(f, Object.keys(config.repos ?? {})),
): { graph: PartialGraph; issues: ValidationIssue[] } {
  const g = clone(graph);
  const issues: ValidationIssue[] = [];
  const keys = new Set(g.edges.map(edgeKey));
  const byId = new Map(g.nodes.map((n) => [n.id, n]));
  const add = (e: Edge) => {
    if (keys.has(edgeKey(e))) return;
    keys.add(edgeKey(e));
    g.edges.push(e);
  };
  for (const [infraId, spec] of Object.entries(config.deploy ?? {})) {
    const path = `config#/deploy/${infraId}`;
    const host = byId.get(infraId);
    if (!host) {
      issues.push(
        issue('error', path, `config.deploy のノード "${infraId}" が抽出結果にありません`),
      );
      continue;
    }
    if (!isPlainObject(spec as unknown)) {
      issues.push(
        issue('warning', path, `config.deploy.${infraId} はオブジェクトで書いてください`),
      );
      continue;
    }
    const deployTo = (to: string) => add({ from: infraId, to, kind: 'deploy' });
    if (spec.app === 'next') {
      host.meta = { ...(host.meta ?? {}), deployApp: host.meta?.deployApp ?? 'next' };
      for (const n of g.nodes) if (n.kind === 'page' || n.kind === 'layout') deployTo(n.id);
    }
    if (spec.handlers) {
      const globs = toArray(spec.handlers).map((p) => globToRegExp(toPosix(p)));
      let hit = 0;
      for (const n of g.nodes) {
        if (n.kind !== 'handler' || !n.file) continue;
        const full = toPosix(n.file);
        const rel = repoOf(full).path;
        if (globs.some((re) => re.test(rel) || re.test(full))) {
          deployTo(n.id);
          hit++;
        }
      }
      if (!hit)
        issues.push(
          issue('warning', `${path}/handlers`, `handlers に合う handler ノードがありません`),
        );
    }
    if (spec.go) {
      const pkg = toPosix(spec.go).replace(/\/+$/, '');
      const targets = g.nodes.filter((n) => isGoPackage(n, pkg, repoOf));
      for (const n of targets) deployTo(n.id);
      if (!targets.length)
        issues.push(
          issue('warning', `${path}/go`, `Go のパッケージ "${pkg}" のノードがありません`),
        );
    }
    for (const [j, id] of toArray(spec.nodes).entries()) {
      if (!byId.has(id)) {
        issues.push(
          issue(
            'error',
            `${path}/nodes/${j}`,
            `config.deploy.${infraId}.nodes のノード "${id}" がありません`,
          ),
        );
        continue;
      }
      deployTo(id);
    }
  }
  return { graph: g, issues };
}
