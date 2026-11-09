/**
 * stack-atlas.overrides.yaml（静的解析で取れない結線の補正、docs/09 §3.2）。
 *
 * 適用順: `remove` → `nodes`（upsert）→ `edges`（追加）→ `deploy`（deploy エッジを張る）。
 * remove を先にするので「消してから同じ ID で作り直す」書き方ができる。
 *
 * - `nodes`: 既存ノードには deep merge で上書き（overrides の値が勝つ。配列は置き換え）、無ければ追加
 * - `edges` / `deploy`: 参照するノードが無ければ **エラー**（人が書いたものなので厳密に）。そのエッジは張らない
 * - `remove`: ノード ID（そのノードに繋がるエッジも消す）か `{from, to, kind}`（kind 省略で from→to をすべて）。
 *   見つからなければ警告（ノード ID は、言語アダプタの v2 の箱 id（opts.knownIds）にあれば警告しない。v2 で消える。
 *   2026-11-09 8-4: v1 にだけ無い `fn:` の id で「ありません」と出て実態と合わなかった。docs/17 §8.3b の 8）
 * - `v2`: v2 の補い（docs/19 §3.1）。ここでは形（オブジェクトと配列）だけ確かめ、当てるのは supplements.ts
 */
import type { Edge, ValidationIssue } from '@stack-atlas/schema';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { AtlasConfigError, readYamlFile } from './config.js';
import { edgeKey } from './merge.js';
import { addExtractorName } from './meta.js';
import type { Overrides, PartialGraph, PartialNode, RepoContext, SupplementsV2 } from './types.js';
import { clone, deepMerge, isPlainObject, issue } from './util.js';

export const OVERRIDES_FILE = 'stack-atlas.overrides.yaml';
/** overrides で足した・書き換えたノードの meta.extractors に入る名前 */
export const OVERRIDES_SOURCE = 'overrides';

/** overrides の v2: の節のキー（docs/19 §3.1） */
export const SUPPLEMENT_KEYS = [
  'nodes',
  'wires',
  'retarget',
  'remove',
  'links',
  'variants',
  'when',
  'items',
] as const;

/** overrides.yaml を読む。無ければ `{}`。形が違う部分は警告して捨てる */
export function loadOverrides(ctx: RepoContext): Overrides {
  const file = [OVERRIDES_FILE, OVERRIDES_FILE.replace(/\.yaml$/, '.yml')]
    .map((f) => join(ctx.root, f))
    .find((p) => existsSync(p));
  if (!file) return {};
  const raw = readYamlFile(file);
  if (raw === null) return {};
  if (!isPlainObject(raw)) {
    throw new AtlasConfigError(`${file} のトップレベルはオブジェクトにしてください`);
  }
  return checkOverrides(raw, ctx, OVERRIDES_FILE);
}

const isEdgeLike = (v: unknown): v is Edge =>
  isPlainObject(v) && typeof v.from === 'string' && typeof v.to === 'string';

export function checkOverrides(
  raw: Record<string, unknown>,
  ctx: Pick<RepoContext, 'log'>,
  file = OVERRIDES_FILE,
): Overrides {
  const out: Overrides = {};
  const warn = (m: string) => ctx.log.warn(`${file}: ${m}`);
  for (const key of Object.keys(raw)) {
    if (!['nodes', 'edges', 'remove', 'deploy', 'v2'].includes(key))
      warn(`未知のキー "${key}" は無視します`);
  }
  if (raw.v2 != null) {
    if (!isPlainObject(raw.v2)) warn('v2 はオブジェクト（nodes・wires・… の配列）で書いてください');
    else {
      const v2: SupplementsV2 = {};
      for (const [k, list] of Object.entries(raw.v2)) {
        if (!(SUPPLEMENT_KEYS as readonly string[]).includes(k)) {
          warn(`v2 の未知のキー "${k}" は無視します（${SUPPLEMENT_KEYS.join(' / ')}）`);
          continue;
        }
        if (!Array.isArray(list)) {
          warn(`v2.${k} は配列で書いてください（無視します）`);
          continue;
        }
        // 要素は当てるときに確かめる（解けない補いとして report と strict に出す。ここで捨てると黙って消える）
        v2[k as keyof SupplementsV2] = list.map((x) => (isPlainObject(x) ? x : { invalid: x }));
      }
      out.v2 = v2;
    }
  }
  if (raw.nodes != null) {
    if (!Array.isArray(raw.nodes)) warn('nodes は配列で書いてください');
    else
      out.nodes = raw.nodes.filter((n, i) => {
        const ok = isPlainObject(n) && typeof n.id === 'string';
        if (!ok) warn(`nodes[${i}] に id がありません（無視します）`);
        return ok;
      }) as PartialNode[];
  }
  if (raw.edges != null) {
    if (!Array.isArray(raw.edges)) warn('edges は配列で書いてください');
    else
      out.edges = raw.edges.filter((e, i) => {
        const ok = isEdgeLike(e) && typeof e.kind === 'string';
        if (!ok) warn(`edges[${i}] には from / to / kind が必要です（無視します）`);
        return ok;
      }) as Edge[];
  }
  if (raw.remove != null) {
    if (!Array.isArray(raw.remove)) warn('remove は配列で書いてください');
    else
      out.remove = raw.remove.filter((r, i) => {
        const ok = typeof r === 'string' || isEdgeLike(r);
        if (!ok) warn(`remove[${i}] はノード ID か {from, to, kind} にしてください（無視します）`);
        return ok;
      }) as Array<string | Edge>;
  }
  if (raw.deploy != null) {
    if (!isPlainObject(raw.deploy))
      warn('deploy は「インフラノード ID: [ノード ID, ...]」で書いてください');
    else {
      out.deploy = {};
      for (const [k, v] of Object.entries(raw.deploy)) {
        const list = typeof v === 'string' ? [v] : v;
        if (!Array.isArray(list) || !list.every((x) => typeof x === 'string')) {
          warn(`deploy."${k}" はノード ID の配列にしてください（無視します）`);
          continue;
        }
        out.deploy[k] = list;
      }
    }
  }
  return out;
}

export interface ApplyOverridesResult {
  graph: PartialGraph;
  issues: ValidationIssue[];
}

/** graph に overrides を当てた新しい graph を返す（引数は変更しない） */
export function applyOverrides(
  graph: PartialGraph,
  overrides: Overrides,
  file = OVERRIDES_FILE,
  opts: { knownIds?: ReadonlySet<string> } = {},
): ApplyOverridesResult {
  const g = clone(graph);
  const issues: ValidationIssue[] = [];
  const err = (path: string, m: string) => issues.push(issue('error', `${file}#${path}`, m));
  const warn = (path: string, m: string) => issues.push(issue('warning', `${file}#${path}`, m));

  // remove
  overrides.remove?.forEach((r, i) => {
    if (typeof r === 'string') {
      const before = g.nodes.length;
      g.nodes = g.nodes.filter((n) => n.id !== r);
      if (g.nodes.length === before) {
        if (!opts.knownIds?.has(r))
          warn(`/remove/${i}`, `削除しようとしたノード "${r}" は v1 にも v2 にもありません`);
        return;
      }
      g.edges = g.edges.filter((e) => e.from !== r && e.to !== r);
    } else {
      const before = g.edges.length;
      g.edges = g.edges.filter(
        (e) => !(e.from === r.from && e.to === r.to && (r.kind === undefined || e.kind === r.kind)),
      );
      if (g.edges.length === before) {
        warn(
          `/remove/${i}`,
          `削除しようとしたエッジ "${r.from}" → "${r.to}"（${r.kind ?? '全 kind'}）はありません`,
        );
      }
    }
  });

  // nodes（upsert）
  const index = new Map(g.nodes.map((n, i) => [n.id, i]));
  for (const n of overrides.nodes ?? []) {
    const at = index.get(n.id);
    if (at === undefined) {
      index.set(n.id, g.nodes.length);
      g.nodes.push(addExtractorName(clone(n), OVERRIDES_SOURCE));
    } else {
      g.nodes[at] = addExtractorName(
        deepMerge(g.nodes[at]!, n, { prefer: 'source' }),
        OVERRIDES_SOURCE,
      );
    }
  }

  // edges / deploy（参照先が無ければエラー）
  const ids = new Set(g.nodes.map((n) => n.id));
  const keys = new Set(g.edges.map(edgeKey));
  const addEdge = (e: Edge, path: string) => {
    const missing = [e.from, e.to].filter((id) => !ids.has(id));
    if (missing.length) {
      for (const id of missing)
        err(path, `ノード "${id}" がありません（${e.from} → ${e.to}、${e.kind}）`);
      return;
    }
    const k = edgeKey(e);
    if (keys.has(k)) {
      const prev = g.edges.find((x) => edgeKey(x) === k)!;
      if (e.label !== undefined) prev.label = e.label;
      return;
    }
    keys.add(k);
    g.edges.push(clone(e));
  };
  overrides.edges?.forEach((e, i) => addEdge(e, `/edges/${i}`));
  for (const [from, list] of Object.entries(overrides.deploy ?? {})) {
    list.forEach((to, j) => addEdge({ from, to, kind: 'deploy' }, `/deploy/${from}/${j}`));
  }

  return { graph: g, issues };
}
