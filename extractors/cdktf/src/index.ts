/**
 * cdktf 抽出器: `cdktf synth` の出力（cdktf.out/stacks/<stack>/cdk.tf.json）→ infra ノードと flow エッジ。
 * 解析は @stack-atlas/tf-graph（terraform / cloudformation と共通）。ここは cdk.tf.json を読むのと、
 * construct id で .ts ソースの file / line を探すだけの薄いアダプタ。docs/04 §1・§5、docs/12 §3.3。
 */
import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { repoPath, sectionFor } from '@stack-atlas/core';
import type { Extractor, PartialGraph, RepoContext } from '@stack-atlas/core';
import {
  buildInfraGraph,
  collectRefs,
  DEFAULT_NODE_TYPES,
  listResources,
  type JsonObject,
  type TfDocument,
  type TfJson,
} from '@stack-atlas/tf-graph';

export const NAME = 'cdktf';

/** 既定でノードにするリソース型（tf-graph の許可リスト。互換のため名前を残す） */
export const NODE_RESOURCE_TYPES = DEFAULT_NODE_TYPES;

export type { Reference } from '@stack-atlas/tf-graph';
export { collectRefs };

export interface Resource {
  stack: string;
  type: string;
  logicalId: string;
  body: JsonObject;
  /** construct path（`//`.metadata.path） */
  path: string;
}

const isObject = (v: unknown): v is JsonObject =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const section = (ctx: RepoContext) => sectionFor(ctx, ctx.config.cdktf);

/** cdktf.out ディレクトリ（存在しなければ undefined） */
export function cdktfOutDir(ctx: RepoContext): string | undefined {
  if (ctx.config.cdktf && !section(ctx)) return undefined; // 別の repo 向けの設定
  // repo の外（絶対パス・`..`・外へ出るリンク）は読まない（2026-11-10 8-4 のレビュー S2）
  const dir = repoPath(ctx, section(ctx)?.out ?? 'infra/cdktf.out', 'cdktf.out');
  return dir && existsSync(join(dir, 'stacks')) ? dir : undefined;
}

/** stacks/<stack>/cdk.tf.json を列挙する。config.cdktf.stack があればそれだけ */
export function listStacks(ctx: RepoContext): Array<{ stack: string; file: string }> {
  const out = cdktfOutDir(ctx);
  if (!out) return [];
  const stacksDir = join(out, 'stacks');
  const wanted = section(ctx)?.stack;
  return readdirSync(stacksDir)
    .filter((s) => (wanted ? s === wanted : true))
    .map((stack) => ({ stack, file: join(stacksDir, stack, 'cdk.tf.json') }))
    .filter((s) => existsSync(s.file))
    .sort((a, b) => a.stack.localeCompare(b.stack));
}

/** スタックごとの cdk.tf.json */
export function loadDocuments(ctx: RepoContext): TfDocument[] {
  const docs: TfDocument[] = [];
  for (const { stack, file } of listStacks(ctx)) {
    let json: unknown;
    try {
      json = JSON.parse(readFileSync(file, 'utf8'));
    } catch (e) {
      ctx.log.warn(`cdktf: ${relative(ctx.root, file)} を JSON として読めません: ${String(e)}`);
      continue;
    }
    if (isObject(json)) docs.push({ tf: json as TfJson, stack });
  }
  return docs;
}

export function loadResources(ctx: RepoContext): Resource[] {
  return listResources(loadDocuments(ctx)).map(({ stack, type, logicalId, body, path }) => ({
    stack,
    type,
    logicalId,
    body,
    path,
  }));
}

/** ソースの .ts から construct id の文字列リテラルを探す */
interface SourceIndex {
  files: Array<{ rel: string; lines: string[] }>;
}

function indexSources(ctx: RepoContext): SourceIndex {
  const dir = repoPath(ctx, section(ctx)?.sourceDir ?? 'infra', 'cdktf.sourceDir');
  const files: SourceIndex['files'] = [];
  if (!dir) return { files };
  const outDir = cdktfOutDir(ctx);
  const walk = (d: string) => {
    let entries: string[];
    try {
      entries = readdirSync(d);
    } catch {
      return;
    }
    for (const name of entries.sort()) {
      if (name === 'node_modules' || name === '.gen' || name.startsWith('.')) continue;
      const p = join(d, name);
      if (outDir && p === outDir) continue;
      // シンボリックリンクは辿らない（repo の外へ出させない）
      const st = lstatSync(p);
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) walk(p);
      else if (name.endsWith('.ts') && !name.endsWith('.d.ts')) {
        files.push({ rel: relative(ctx.root, p), lines: readFileSync(p, 'utf8').split('\n') });
      }
    }
  };
  if (existsSync(dir)) walk(dir);
  return { files };
}

function findConstruct(
  idx: SourceIndex,
  constructId: string,
): { file: string; line: number; code: string } | undefined {
  const esc = constructId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // 1) `new X(scope, "id"` の第 2 引数 2) ただの文字列リテラル
  const patterns = [new RegExp(`,\\s*(["'\`])${esc}\\1`), new RegExp(`(["'\`])${esc}\\1`)];
  for (const re of patterns) {
    for (const f of idx.files) {
      const i = f.lines.findIndex((l) => re.test(l));
      if (i >= 0) {
        const start = Math.max(0, i - 1);
        return {
          file: f.rel,
          line: i + 1,
          code: f.lines.slice(start, start + 12).join('\n'),
        };
      }
    }
  }
  return undefined;
}

export function infraIdFor(r: { stack: string; logicalId: string }, multiStack: boolean): string {
  return multiStack ? `infra:${r.stack}/${r.logicalId}` : `infra:${r.logicalId}`;
}

export const extractor: Extractor = {
  name: NAME,
  async detect(ctx) {
    return listStacks(ctx).length > 0;
  },
  async extract(ctx): Promise<PartialGraph> {
    const stacks = listStacks(ctx);
    const multiStack = !section(ctx)?.stack && stacks.length > 1;
    const src = indexSources(ctx);
    const g = buildInfraGraph(loadDocuments(ctx), {
      extractor: NAME,
      idOf: (r) => infraIdFor(r, multiStack),
      locate: (r) => findConstruct(src, r.path.split('/').pop() || r.logicalId),
      deploy: ctx.config.deploy,
      log: ctx.log,
      ...ctx.config.infra,
    });
    ctx.log.info(
      `cdktf: ${stacks.length} stack(s), ${g.nodes.length} nodes, ${g.edges.length} edges`,
    );
    // 読んだファイル（スタックの cdk.tf.json。docs/23 §3.1）。sourceDir の .ts は construct id の文字列を探すだけで、
    // TS として読んではいない（型も呼び出しも取らない）ので申告しない。construct が見つかったファイルは箱の file で
    // 「読んだ」に数える。2026-11-11 Phase 9-L0 のレビュー: 以前は sourceDir の .ts を全部申告し、tsconfig の外の TS が
    // 読めたように見えていた
    const read = stacks.map((s) => relative(ctx.root, s.file).split('\\').join('/')).sort();
    return { nodes: g.nodes, edges: g.edges, read };
  },
};

export default extractor;
