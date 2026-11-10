/**
 * `.stack-atlas/views.yaml`（docs/19 §3.4。形は docs/16 §8: `{ id, name, description?, start, variants? }`）を v2 の views に
 * 重ねる。同じ id なら flows.yaml 由来の view（upgrade が作ったもの）より勝つ。start が解けない・分岐のキーが解けない view は
 * 落として、解けない補い（kind view）にする（strict の 4）。start が group になった v1 の箱なら中の最初の関数の箱にする
 * （flows 由来の view と同じ。cleanupV2）
 *
 * トップレベルは配列か `{ views: [...] }`。上限は 256KB・500 件。YAML の別名は 100 まで。シンボリックリンクは読まない
 */
import { parseItemRef, parseWhenKey, type GraphV2, type ViewV2 } from '@stack-atlas/schema';
import { HARNESS_DIR, parseLocalYaml, readLocalFile, whyText } from './local-files.js';
import type { SupplementResult } from './supplements.js';
import type { BuildIssue } from './types.js';
import { isPlainObject } from './util.js';
import { walkItems } from './v2-parts.js';

export const VIEWS_FILES = ['views.yaml', 'views.yml'] as const;
export const VIEWS_LIMITS = { bytes: 256 * 1024, views: 500 } as const;

export interface ViewsYamlResult {
  /** 読んだファイル（config のディレクトリからの相対）。無ければ undefined */
  file?: string;
  results: SupplementResult[];
  issues: BuildIssue[];
}

/** views.yaml を読み、graph.views に重ねる（graph を書き換える）。groups は group になった v1 の箱 → 中の関数の箱 */
export function applyViewsYaml(
  graph: GraphV2,
  configDir: string,
  groups: ReadonlyMap<string, readonly string[]> = new Map(),
): ViewsYamlResult {
  const out: ViewsYamlResult = { results: [], issues: [] };
  let read: ReturnType<typeof readLocalFile> | undefined;
  let name: string | undefined;
  for (const f of VIEWS_FILES) {
    const r = readLocalFile(configDir, [HARNESS_DIR, f], VIEWS_LIMITS.bytes);
    if ('why' in r && r.why === 'missing') continue;
    read = r;
    name = f;
    break;
  }
  if (!read || !name) return out;
  const file = `${HARNESS_DIR}/${name}`;
  out.file = file;
  // ファイルの問題は解けない補いにだけ入れる（パイプラインが警告にする。issues にも入れると 2 回出る）
  const fileIssue = (message: string) => {
    out.results.push({ kind: 'view', index: -1, status: 'unresolved', target: file, message });
  };
  if ('why' in read) {
    fileIssue(`${file} が${whyText(read.why)}`);
    return out;
  }
  const parsed = parseLocalYaml(read.text);
  if ('error' in parsed) {
    fileIssue(`${file} を YAML として読めません: ${parsed.error}`);
    return out;
  }
  const raw = parsed.value;
  if (raw === null || raw === undefined) return out;
  const list = Array.isArray(raw)
    ? raw
    : isPlainObject(raw) && Array.isArray(raw.views)
      ? raw.views
      : undefined;
  if (!list) {
    fileIssue(`${file} は view の配列か { views: [...] } で書いてください`);
    return out;
  }
  if (list.length > VIEWS_LIMITS.views)
    out.issues.push({
      level: 'warning',
      path: `views:${file}`,
      message: `view が ${list.length} 件あります。最初の ${VIEWS_LIMITS.views} 件だけ読みます`,
    });

  const nodes = new Map(graph.nodes.map((n) => [n.id, n]));
  const items = new Set<string>();
  for (const n of graph.nodes)
    for (const p of n.ports) walkItems(p.items, (_, path) => items.add(`${n.id}#${p.id}/${path}`));
  const wires = new Set(graph.wires.map((w) => `${w.from}\u0000${w.to}`));
  const views = graph.views ?? [];
  const seen = new Set<string>();

  list.slice(0, VIEWS_LIMITS.views).forEach((v: unknown, index) => {
    const result = (status: SupplementResult['status'], target?: string, message?: string) => {
      const r: SupplementResult = { kind: 'view', index, status };
      if (target) r.target = target;
      if (message) r.message = message;
      out.results.push(r);
    };
    if (!isPlainObject(v) || typeof v.id !== 'string' || !v.id || typeof v.name !== 'string')
      return result('unresolved', undefined, 'view には id と name（文字列）が要ります');
    const id = v.id;
    if (seen.has(id))
      return result('unresolved', id, `view の id ${id} が views.yaml の中で重複しています`);
    seen.add(id);
    let start: ViewV2['start'] | undefined;
    let note: string | undefined;
    if (typeof v.start === 'string') {
      const s = v.start;
      if (nodes.has(s)) start = s;
      else if (parseItemRef(s) && items.has(s)) start = s;
      else if (groups.get(s)?.length) {
        start = groups.get(s)![0]!;
        note = `start ${s} は group になったので中の ${start} にしました`;
      }
    } else if (
      isPlainObject(v.start) &&
      typeof v.start.from === 'string' &&
      typeof v.start.to === 'string'
    ) {
      if (wires.has(`${v.start.from}\u0000${v.start.to}`))
        start = { from: v.start.from, to: v.start.to };
    }
    if (start === undefined)
      return result(
        'unresolved',
        id,
        `start ${JSON.stringify(v.start)} が graph にありません（箱 id・項目の参照・線 { from, to }）`,
      );
    const view: ViewV2 = { id, name: v.name, start };
    if (typeof v.description === 'string') view.description = v.description;
    if (v.variants !== undefined) {
      if (!isPlainObject(v.variants))
        return result(
          'unresolved',
          id,
          'variants は { "<箱 id>#<分岐 id>": true|false } で書いてください',
        );
      const bad = Object.entries(v.variants).filter(([key, val]) => {
        const { nodeId, variantId } = parseWhenKey(key);
        return (
          typeof val !== 'boolean' ||
          nodeId === undefined ||
          !nodes.get(nodeId)?.variants?.some((x) => x.id === variantId)
        );
      });
      if (bad.length)
        return result(
          'unresolved',
          id,
          `分岐 ${bad.map(([k]) => k).join(', ')} が解けません（"<箱 id>#<分岐 id>": true|false。箱がその分岐を宣言していること）`,
        );
      view.variants = { ...(v.variants as Record<string, boolean>) };
    }
    const at = views.findIndex((x) => x.id === id);
    if (at >= 0) views[at] = view;
    else views.push(view);
    result(
      'applied',
      id,
      at >= 0
        ? `flows.yaml 由来の同じ id の view を置き換えました${note ? `。${note}` : ''}`
        : note,
    );
  });
  if (views.length) graph.views = views;
  return out;
}
