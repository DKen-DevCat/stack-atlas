/**
 * `stack-atlas init-views <repo> [--out <file>]`（docs/19 §3.4）
 *
 * いまの graph（build と同じ抽出。スクショは撮らない）から `.stack-atlas/views.yaml` の雛形を書く。始点の候補は画面（route）・
 * trigger（時刻）・actor（利用者）。分岐（キャッシュの hit・認証の login など）はコメントで並べる。形は docs/16 §8 だけ
 * （docs/15 §3.9 の caches: の形は使わない）。
 *
 * 既存のファイルは上書きしない（views.yaml か views.yml があれば止める）。書き先の `.stack-atlas` とファイルのシンボリック
 * リンクは辿らない（core の SafeOutput。--out のときは O_EXCL で作る）
 */
import {
  AtlasConfigError,
  HARNESS_DIR,
  SafeOutput,
  VIEWS_FILES,
  buildGraph,
  createConsoleLogger,
  loadConfig,
  type Extractor,
  type Logger,
} from '@stack-atlas/core';
import type { GraphV2, NodeV2 } from '@stack-atlas/schema';
import { existsSync, lstatSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { loadExtractors } from '../extractors.js';

export interface InitViewsOptions {
  repo: string;
  /** 書き出し先（既定 <repo>/.stack-atlas/views.yaml） */
  out?: string;
  log?: Logger;
  /** 抽出器の差し替え（テスト用） */
  extractors?: Extractor[];
}

const START_KINDS = ['screen', 'trigger', 'actor'] as const;

/** view の id（英小文字・数字・-） */
function viewId(n: NodeV2, used: Set<string>): string {
  const base =
    n.id
      .replace(/^[a-z]+:/, `${n.kind === 'screen' ? 'screen' : n.kind}-`)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || n.kind;
  let id = base;
  for (let k = 2; used.has(id); k++) id = `${base}-${k}`;
  used.add(id);
  return id;
}

const nameOf = (n: NodeV2): string =>
  n.kind === 'screen'
    ? `${n.id.replace(/^[a-z]+:/, '')} を開く`
    : n.kind === 'trigger'
      ? `${n.name} が動く`
      : `${n.name} から`;

/** 始点の候補（画面は route だけ。layout は route の中で光る） */
export function viewCandidates(g: GraphV2): NodeV2[] {
  const order = new Map<string, number>(START_KINDS.map((k, i) => [k, i]));
  return g.nodes
    .filter(
      (n) => order.has(n.kind) && !n.id.startsWith('layout:') && n.meta?.sharedOf === undefined,
    )
    .sort((a, b) => order.get(a.kind)! - order.get(b.kind)! || a.id.localeCompare(b.id));
}

const q = (s: string) => JSON.stringify(s);

/** views.yaml の雛形の文 */
export function serializeViewsYaml(g: GraphV2): string {
  const starts = viewCandidates(g);
  const count = (k: string) => starts.filter((n) => n.kind === k).length;
  const lines = [
    '# views.yaml（stack-atlas init-views が書いた雛形。docs/16 §8・docs/19 §3.4）',
    '# 配線図の名前付きの始点。id が flows.yaml 由来の view と同じなら、こちらが勝つ。',
    '# start は箱 id か項目の参照（<箱>#<口>/<項目>）、線なら { from, to }。variants のキーは "<箱 id>#<分岐 id>"。',
    '# start が graph に無い view は build で落とし、build --strict はエラーにする。',
    `# 始点の候補: 画面 ${count('screen')}・trigger ${count('trigger')}・利用者 ${count('actor')}（要らないものは消し、name を直す）`,
    '',
  ];
  if (!starts.length) lines.push('views: []');
  else {
    lines.push('views:');
    const used = new Set<string>();
    for (const n of starts) {
      lines.push(`  - id: ${q(viewId(n, used))}`);
      lines.push(`    name: ${q(nameOf(n))}`);
      lines.push(`    start: ${q(n.id)}`);
    }
  }
  const variants = g.nodes.flatMap((n) =>
    (n.variants ?? []).map((v) => `${n.id}#${v.id}（${v.name}${v.default ? '。既定 true' : ''}）`),
  );
  if (variants.length) {
    lines.push('', '# 分岐の候補（view の variants に "<箱 id>#<分岐 id>": true|false で書く）:');
    for (const v of variants) lines.push(`#   ${v}`);
  }
  return `${lines.join('\n')}\n`;
}

export async function runInitViews(opts: InitViewsOptions): Promise<number> {
  const log = opts.log ?? createConsoleLogger();
  const repo = resolve(opts.repo);
  if (!existsSync(repo) || !statSync(repo).isDirectory()) {
    log.error(`リポジトリ ${repo} がありません`);
    return 2;
  }
  const out = opts.out ? resolve(opts.out) : undefined;
  const existing = out
    ? lstatSync(out, { throwIfNoEntry: false })
      ? out
      : undefined
    : VIEWS_FILES.map((f) => join(repo, HARNESS_DIR, f)).find((p) =>
        lstatSync(p, { throwIfNoEntry: false }),
      );
  if (existing) {
    log.error(`${existing} はすでにあります（上書きしません）`);
    return 1;
  }
  let graph: GraphV2 | undefined;
  try {
    const config = loadConfig(repo, log);
    const extractors = opts.extractors ?? (await loadExtractors(log, { skip: ['screenshots'] }));
    log.info(`解析中: ${repo}`);
    ({ graphV2: graph } = await buildGraph({ root: repo, extractors, log, config, commit: false }));
  } catch (e) {
    if (e instanceof AtlasConfigError) {
      log.error(e.message);
      return 2;
    }
    throw e;
  }
  const text = serializeViewsYaml(graph!);
  let file: string;
  try {
    if (out) {
      writeFileSync(out, text, { flag: 'wx' });
      file = out;
    } else {
      const r = new SafeOutput(repo).create([HARNESS_DIR, VIEWS_FILES[0]], text);
      if (!r.created) {
        log.error(`${r.file} はすでにあります（上書きしません）`);
        return 1;
      }
      file = r.file;
    }
  } catch (e) {
    log.error(`views.yaml を書けません: ${(e as Error).message}`);
    return (e as { code?: string }).code === 'EEXIST' ? 1 : 2;
  }
  console.log(
    [
      `views.yaml の雛形を書きました: ${file}`,
      `  始点の候補 ${viewCandidates(graph!).length}（画面・trigger・利用者）。name を直し、要らないものを消してください`,
    ].join('\n'),
  );
  return 0;
}
