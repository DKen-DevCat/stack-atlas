/**
 * terraform 抽出器: 素の Terraform（HCL）→ infra ノードと flow エッジ（docs/12 §3.3）。
 * HCL は @cdktf/hcl2json（wasm、オフライン）で JSON にし、モジュール・参照を解決してから
 * @stack-atlas/tf-graph（cdktf / cloudformation と共通）に渡す。
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';
import { sectionFor } from '@stack-atlas/core';
import type { Extractor, PartialGraph, RepoContext } from '@stack-atlas/core';
import {
  buildInfraGraph,
  isObject,
  type JsonObject,
  type Located,
  type TfDocument,
  type TfResource,
} from '@stack-atlas/tf-graph';
import { loadModules, tfFiles, type ModuleInstance } from './load.js';
import { Resolver } from './resolve.js';

export const NAME = 'terraform';
export { Resolver, qualify } from './resolve.js';
export { loadModules } from './load.js';

const SEARCH_BASES = ['infra', 'terraform', 'iac', '.'];
const SKIP_DIRS = new Set(['.terraform', 'node_modules', '.git', 'dist', 'cdktf.out', '.gen']);
const BLOCK_RE = /^\s*(?:module|resource)\s+"/m;
const LOCAL_SOURCE_RE = /^\s*source\s*=\s*"(\.{1,2}\/[^"]*)"/gm;
const ENV_NAME = /^(dev|development|stg|staging|stage|prod|production|qa|test)(\b|[-_])/i;

const section = (ctx: RepoContext) => sectionFor(ctx, ctx.config.terraform);

const hasTf = (dir: string) => tfFiles(dir).length > 0;

/** module / resource ブロックを持つ *.tf があるディレクトリ（深さ 4 まで） */
function candidateDirs(base: string, maxDepth: number): string[] {
  const out: string[] = [];
  const walk = (d: string, depth: number) => {
    const files = tfFiles(d);
    if (files.some((f) => BLOCK_RE.test(readFileSync(f, 'utf8')))) out.push(d);
    if (depth >= maxDepth) return;
    let names: string[];
    try {
      names = readdirSync(d).sort();
    } catch {
      return;
    }
    for (const n of names) {
      if (SKIP_DIRS.has(n) || n.startsWith('.')) continue;
      const p = join(d, n);
      try {
        if (statSync(p).isDirectory()) walk(p, depth + 1);
      } catch {
        /* ignore */
      }
    }
  };
  walk(base, 0);
  return out;
}

/** root モジュールを決める（config.terraform.root が最優先） */
export function findRoot(ctx: RepoContext): string | undefined {
  if (ctx.config.terraform && !section(ctx)) return undefined; // 別の repo 向け
  const configured = section(ctx)?.root;
  if (configured) {
    const dir = ctx.resolve(configured);
    return hasTf(dir) ? dir : undefined;
  }
  for (const b of SEARCH_BASES) {
    const base = ctx.resolve(b);
    if (!existsSync(base)) continue;
    // ルート直下は浅く（モノレポの奥まで掘らない）
    const dirs = candidateDirs(base, b === '.' ? 1 : 4);
    if (dirs.length === 0) continue;
    // 他から module として呼ばれているディレクトリは root ではない
    const called = new Set<string>();
    for (const d of dirs) {
      for (const f of tfFiles(d)) {
        for (const m of readFileSync(f, 'utf8').matchAll(LOCAL_SOURCE_RE))
          called.add(resolve(d, m[1]!));
      }
    }
    const roots = dirs.filter((d) => !called.has(d));
    const pool = roots.length > 0 ? roots : dirs;
    const byName = (re: RegExp) => pool.filter((d) => re.test(basename(d))).sort();
    return byName(/^dev/i)[0] ?? byName(ENV_NAME)[0] ?? [...pool].sort()[0];
  }
  return undefined;
}

/** `resource "type" "name" {` の位置とブロック本文（最大 25 行） */
function locateBlock(m: ModuleInstance, r: TfResource, repoRoot: string): Located | undefined {
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`^\\s*resource\\s+"${esc(r.type)}"\\s+"${esc(r.logicalId)}"`);
  for (const f of m.files) {
    const lines = f.text.split('\n');
    const i = lines.findIndex((l) => re.test(l));
    if (i < 0) continue;
    let depth = 0;
    let opened = false;
    let end = i;
    for (let j = i; j < lines.length && j < i + 200; j++) {
      for (const c of lines[j]!) {
        if (c === '{') {
          depth++;
          opened = true;
        } else if (c === '}') depth--;
      }
      end = j;
      if (opened && depth <= 0) break;
    }
    return {
      file: relative(repoRoot, f.abs),
      line: i + 1,
      code: lines.slice(i, Math.min(end + 1, i + 25)).join('\n'),
    };
  }
  return undefined;
}

const address = (scope: string, type: string, name: string) =>
  [...(scope ? scope.split('/').map((s) => `module.${s}`) : []), `${type}.${name}`].join('.');

export const extractor: Extractor = {
  name: NAME,
  async detect(ctx) {
    return findRoot(ctx) !== undefined;
  },
  async extract(ctx): Promise<PartialGraph> {
    const rootDir = findRoot(ctx);
    if (!rootDir) return { nodes: [], edges: [] };
    const stack = basename(rootDir);
    ctx.log.info(`terraform: root = ${relative(ctx.root, rootDir) || '.'}`);
    const { modules, tfvars } = await loadModules(rootDir, ctx.log, ctx.root);
    const resolver = new Resolver(modules, tfvars);

    const docs: TfDocument[] = [];
    for (const m of modules.values()) {
      const resource: Record<string, Record<string, JsonObject>> = {};
      for (const [type, byName] of Object.entries(m.resource)) {
        resource[type] = {};
        for (const [name, body] of Object.entries(byName)) {
          const resolved = resolver.resolve(body, m.scope);
          resource[type]![name] = isObject(resolved) ? resolved : body;
        }
      }
      docs.push({
        tf: { resource },
        stack,
        module: m.scope,
        pathOf: (type, name) => address(m.scope, type, name),
      });
    }

    const g = buildInfraGraph(docs, {
      extractor: NAME,
      locate: (r) => {
        const m = modules.get(r.module);
        return m ? locateBlock(m, r, ctx.root) : undefined;
      },
      deploy: ctx.config.deploy,
      log: ctx.log,
      ...ctx.config.infra,
    });
    if (g.unresolved.length > 0) {
      const uniq = [...new Set(g.unresolved.map((t) => t.text.replace(/^mod:[^:]*:/, '')))];
      ctx.log.debug(
        `terraform: 解決できない参照 ${g.unresolved.length} 件（${uniq.slice(0, 20).join(', ')}${uniq.length > 20 ? ' …' : ''}）`,
      );
    }
    ctx.log.info(
      `terraform: ${modules.size} module(s), ${g.resources.length} resources, ${g.nodes.length} nodes, ${g.edges.length} edges`,
    );
    return { nodes: g.nodes, edges: g.edges };
  },
};

export default extractor;
