/**
 * cloudformation 抽出器: AWS CDK（cdk.out/*.template.json）/ SAM（template.yaml）/ 素の CFn → infra ノードと flow エッジ。
 * テンプレートを Terraform JSON の形に変換して @stack-atlas/tf-graph（cdktf / terraform と共通）に渡す。docs/12 §3.3。
 */
import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import { basename, relative } from 'node:path';
import { confineRepoPath, matchGlob, sectionFor } from '@stack-atlas/core';
import type { Extractor, PartialGraph, RepoContext } from '@stack-atlas/core';
import {
  buildInfraGraph,
  type Located,
  type TfDocument,
  type TfResource,
} from '@stack-atlas/tf-graph';
import { convertTemplate } from './convert.js';
import { looksLikeTemplate, parseTemplate } from './template.js';

export const NAME = 'cloudformation';
export { convertTemplate, tfTypeOf, snake, TYPE_MAP } from './convert.js';
export { parseTemplate, CFN_TAGS } from './template.js';

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', '.aws-sam', 'coverage']);
const DEFAULT_SAM = ['template.yaml', 'template.yml', 'template.json'];

const section = (ctx: RepoContext) => sectionFor(ctx, ctx.config.cloudformation);
const toPosix = (p: string) => p.split('\\').join('/');

/**
 * glob に合うファイル（repo 相対、posix）。repo の外（絶対パス・`..`・外へ出るリンク）は読まず、途中のシンボリックリンクは
 * 辿らない（2026-11-10 8-4 のレビュー S2）
 */
function globFiles(ctx: RepoContext, glob: string): string[] {
  if (!/[*?{[]/.test(glob))
    return 'abs' in confineRepoPath(ctx.root, glob) && existsSync(ctx.resolve(glob))
      ? [toPosix(glob)]
      : [];
  // ワイルドカードより前の固定部分から歩く
  const segs = toPosix(glob).split('/');
  const fixed: string[] = [];
  for (const s of segs) {
    if (/[*?{[]/.test(s)) break;
    fixed.push(s);
  }
  const out: string[] = [];
  if (!('abs' in confineRepoPath(ctx.root, fixed.join('/') || '.'))) return out;
  const walk = (dir: string, depth: number) => {
    let names: string[];
    try {
      names = readdirSync(ctx.resolve(dir)).sort();
    } catch {
      return;
    }
    for (const n of names) {
      if (SKIP_DIRS.has(n)) continue;
      const rel = dir ? `${dir}/${n}` : n;
      let st;
      try {
        st = lstatSync(ctx.resolve(rel));
      } catch {
        continue;
      }
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) {
        if (depth < 8) walk(rel, depth + 1);
      } else if (matchGlob(rel, glob)) out.push(rel);
    }
  };
  walk(fixed.join('/'), 0);
  return out;
}

/** 読むテンプレート（repo 相対） */
export function listTemplates(ctx: RepoContext): string[] {
  if (ctx.config.cloudformation && !section(ctx)) return []; // 別の repo 向け
  const globs = section(ctx)?.templates;
  if (globs?.length) return [...new Set(globs.flatMap((g) => globFiles(ctx, g)))].sort();
  const cdk = globFiles(ctx, 'cdk.out/*.template.json');
  if (cdk.length > 0) return cdk;
  return DEFAULT_SAM.filter((f) => {
    const p = ctx.resolve(f);
    return existsSync(p) && looksLikeTemplate(readFileSync(p, 'utf8'));
  });
}

/** テンプレート名（`MyStack.template.json` → `MyStack`、`template.yaml` → `template`） */
const stackName = (file: string) => basename(file).replace(/(\.template)?\.(json|ya?ml)$/, '');

/** 論理 ID のキーの位置（JSON: `"Id": {`、YAML: `  Id:`）と、そこから最大 25 行 */
function locate(lines: string[], file: string, logicalId: string): Located {
  const esc = logicalId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`^\\s*(?:"${esc}"|${esc})\\s*:`);
  const i = lines.findIndex((l) => re.test(l));
  if (i < 0) return { file };
  const indent = /^\s*/.exec(lines[i]!)![0].length;
  let end = i + 1;
  while (end < lines.length && end < i + 25) {
    const l = lines[end]!;
    if (l.trim() && /^\s*/.exec(l)![0].length <= indent) break;
    end++;
  }
  return { file, line: i + 1, code: lines.slice(i, end).join('\n') };
}

/** CDK の construct path から短い名前（`Stack/Api/Handler/Resource` → `Handler`） */
function cdkLabel(path: string | undefined): string | undefined {
  if (!path) return undefined;
  const segs = path.split('/').filter((s) => s && s !== 'Resource' && s !== 'Default');
  return segs.length > 1 ? segs[segs.length - 1] : undefined;
}

export const extractor: Extractor = {
  name: NAME,
  async detect(ctx) {
    return listTemplates(ctx).length > 0;
  },
  async extract(ctx): Promise<PartialGraph> {
    const files = listTemplates(ctx);
    const docs: TfDocument[] = [];
    const lines = new Map<string, string[]>();
    const cdkPaths = new Map<string, Record<string, string>>();
    for (const file of files) {
      let text: string;
      let tpl: unknown;
      try {
        text = readFileSync(ctx.resolve(file), 'utf8');
        tpl = parseTemplate(file, text);
      } catch (e) {
        ctx.log.warn(`cloudformation: ${file} を読めません: ${String(e).split('\n')[0]}`);
        continue;
      }
      const stack = stackName(file);
      const conv = convertTemplate(tpl);
      lines.set(stack, text.split('\n'));
      cdkPaths.set(stack, conv.cdkPaths);
      docs.push({
        tf: conv.tf,
        stack,
        pathOf: (_type, id) => conv.cdkPaths[id] ?? `${stack}/${id}`,
      });
    }
    const stackFile = new Map(files.map((f) => [stackName(f), f]));
    const multi = docs.length > 1;
    const g = buildInfraGraph(docs, {
      extractor: NAME,
      idOf: (r: TfResource) => (multi ? `infra:${r.stack}/${r.logicalId}` : `infra:${r.logicalId}`),
      labelOf: (r) => cdkLabel(cdkPaths.get(r.stack)?.[r.logicalId]),
      locate: (r) => {
        const f = stackFile.get(r.stack);
        const ls = lines.get(r.stack);
        return f && ls
          ? locate(ls, toPosix(relative(ctx.root, ctx.resolve(f))), r.logicalId)
          : undefined;
      },
      deploy: ctx.config.deploy,
      log: ctx.log,
      ...ctx.config.infra,
    });
    ctx.log.info(
      `cloudformation: ${docs.length} template(s), ${g.resources.length} resources, ${g.nodes.length} nodes, ${g.edges.length} edges`,
    );
    return { nodes: g.nodes, edges: g.edges };
  },
};

export default extractor;
