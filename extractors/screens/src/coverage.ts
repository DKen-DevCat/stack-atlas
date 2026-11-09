/**
 * regions のカバー率（docs/18 §3.3、docs/14 §3.3 の 4）:
 * 「HTML の data-component で解けた部品の数 ÷ その画面から uses でたどれる部品（comp / hook）の数」。
 *
 * - たどる始点は route と、その route を包む layout（`layout:<URL>` の `(group)` を外したパスが route の前方にあるもの）
 * - data-component の名前は screenshots 抽出器と同じ規則で箱 id に解く（`comp:<名前>` → `hook:<名前>` → 末尾一致）
 * - 分子は「解けた id のうち、たどれる部品に入るもの」。たどれない所で解けたもの・解けない名前は別に返す
 */
import type { PartialGraph } from '@stack-atlas/core';
import { resolveRegionRef } from '@stack-atlas/extractor-screenshots';

export interface Coverage {
  /** その画面から uses でたどれる部品（id の昇順） */
  reachable: string[];
  /** 分子: data-component で解けて、たどれる部品に入るもの */
  covered: string[];
  /** たどれる部品のうち HTML に無いもの */
  absent: string[];
  /** 解けたが、この画面からはたどれないもの */
  outside: string[];
  /** 箱 id に解けない data-component の名前 */
  unresolved: string[];
  /** たどれる部品のうち、HTML に無く regions.yaml で補ったもの（計測の分子とは別に数える。docs/19 §3.7） */
  yaml: string[];
}

const isPart = (id: string, kind: string | undefined) =>
  id.startsWith('comp:') || id.startsWith('hook:') || kind === 'component' || kind === 'hook';

/** layout:<URL>（`(group)` を外す）が route のパスを包むか */
function wraps(layoutUrl: string, routeUrl: string): boolean {
  const l = layoutUrl
    .split('/')
    .filter((s) => s && !/^\(.*\)$/.test(s))
    .join('/');
  const r = routeUrl.split('/').filter(Boolean).join('/');
  return l === '' || r === l || r.startsWith(`${l}/`);
}

export function computeCoverage(
  routeId: string,
  graph: Readonly<PartialGraph>,
  names: readonly string[],
  yamlRefs: readonly string[] = [],
): Coverage {
  const kinds = new Map(graph.nodes.map((n) => [n.id, n.kind]));
  const uses = new Map<string, string[]>();
  for (const e of graph.edges) {
    if (e.kind !== 'uses') continue;
    const list = uses.get(e.from) ?? [];
    list.push(e.to);
    uses.set(e.from, list);
  }
  const routeUrl = routeId.slice('route:'.length);
  const starts = [
    routeId,
    ...graph.nodes
      .map((n) => n.id)
      .filter((id) => id.startsWith('layout:') && wraps(id.slice('layout:'.length), routeUrl)),
  ];
  const seen = new Set<string>(starts);
  const queue = [...starts];
  while (queue.length) {
    for (const to of uses.get(queue.shift()!) ?? []) {
      if (seen.has(to)) continue;
      seen.add(to);
      queue.push(to);
    }
  }
  const reachable = [...seen]
    .filter((id) => !starts.includes(id) && isPart(id, kinds.get(id)))
    .sort();
  const reach = new Set(reachable);

  const ids = new Set(kinds.keys());
  const resolved = new Set<string>();
  const unresolved = new Set<string>();
  for (const name of names) {
    const id = resolveRegionRef(name, ids);
    if (id) resolved.add(id);
    else unresolved.add(name);
  }
  const fromYaml = new Set(yamlRefs);
  return {
    reachable,
    covered: [...resolved].filter((id) => reach.has(id)).sort(),
    absent: reachable.filter((id) => !resolved.has(id) && !fromYaml.has(id)),
    outside: [...resolved].filter((id) => !reach.has(id)).sort(),
    unresolved: [...unresolved].sort(),
    yaml: reachable.filter((id) => !resolved.has(id) && fromYaml.has(id)),
  };
}
