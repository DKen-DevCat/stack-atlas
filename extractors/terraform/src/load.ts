/**
 * HCL の読み込み: root ディレクトリの *.tf を hcl2json で JSON にし、ローカルの module を再帰的にたどる。
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';
import type { Logger } from '@stack-atlas/core';
import { isObject, normalizeHclJson, type Json, type JsonObject } from '@stack-atlas/tf-graph';

export const MAX_MODULE_DEPTH = 5;

export interface SourceFile {
  abs: string;
  text: string;
}

export interface ModuleInstance {
  /** モジュールのパス（呼び出し名を `/` でつなぐ）。root は '' */
  scope: string;
  dir: string;
  files: SourceFile[];
  resource: Record<string, Record<string, JsonObject>>;
  /** module 呼び出しの引数（親のスコープの式） */
  args: JsonObject;
  variable: Record<string, JsonObject>;
  output: Record<string, JsonObject>;
  locals: JsonObject;
  /** 子モジュールの呼び出し名 → scope */
  children: Record<string, string>;
}

type ParseFn = (filename: string, src: string) => Promise<unknown>;
let parser: ParseFn | undefined;
async function hclParse(): Promise<ParseFn> {
  if (!parser) {
    const mod = (await import('@cdktf/hcl2json')) as unknown as {
      parse?: ParseFn;
      default?: { parse?: ParseFn };
    };
    const p = mod.parse ?? mod.default?.parse;
    if (!p) throw new Error('@cdktf/hcl2json の parse が見つかりません');
    parser = p;
  }
  return parser;
}

/** ディレクトリ直下の *.tf（.terraform/ などは見ない） */
export function tfFiles(dir: string): string[] {
  try {
    return readdirSync(dir)
      .filter((n) => n.endsWith('.tf') && !n.startsWith('.'))
      .map((n) => join(dir, n))
      .filter((p) => statSync(p).isFile())
      .sort();
  } catch {
    return [];
  }
}

const isLocalSource = (s: string) => s.startsWith('./') || s.startsWith('../');

/** root（scope ''）から module を再帰的に読む */
export async function loadModules(
  rootDir: string,
  log: Logger,
  repoRoot: string,
): Promise<{ modules: Map<string, ModuleInstance>; tfvars: JsonObject; tfvarsFiles: string[] }> {
  const parse = await hclParse();
  const modules = new Map<string, ModuleInstance>();

  const load = async (dir: string, scope: string, args: JsonObject, depth: number) => {
    const inst: ModuleInstance = {
      scope,
      dir,
      files: [],
      resource: {},
      args,
      variable: {},
      output: {},
      locals: {},
      children: {},
    };
    modules.set(scope, inst);
    const calls: Record<string, JsonObject> = {};
    for (const abs of tfFiles(dir)) {
      const text = readFileSync(abs, 'utf8');
      inst.files.push({ abs, text });
      let json;
      try {
        json = normalizeHclJson(await parse(basename(abs), text));
      } catch (e) {
        log.warn(
          `terraform: ${relative(repoRoot, abs)} を解析できません: ${String(e).split('\n')[0]}`,
        );
        continue;
      }
      for (const [type, byName] of Object.entries(json.resource ?? {})) {
        inst.resource[type] = { ...(inst.resource[type] ?? {}), ...byName };
      }
      Object.assign(inst.variable, json.variable ?? {});
      Object.assign(inst.output, json.output ?? {});
      Object.assign(inst.locals, json.locals ?? {});
      Object.assign(calls, (json.module ?? {}) as Record<string, JsonObject>);
    }
    for (const [name, call] of Object.entries(calls)) {
      const source = typeof call['source'] === 'string' ? call['source'] : '';
      const childScope = scope ? `${scope}/${name}` : name;
      if (!isLocalSource(source)) {
        log.warn(
          `terraform: module "${childScope}" の source はローカルパスではないので読みません（${source || '不明'}）`,
        );
        continue;
      }
      if (depth >= MAX_MODULE_DEPTH) {
        log.warn(
          `terraform: module "${childScope}" は深さ ${MAX_MODULE_DEPTH} を超えるので読みません`,
        );
        continue;
      }
      const childDir = resolve(dir, source);
      if (!existsSync(childDir)) {
        log.warn(`terraform: module "${childScope}" の ${source} がありません`);
        continue;
      }
      const childArgs: JsonObject = {};
      for (const [k, v] of Object.entries(call)) {
        if (!['source', 'version', 'providers', 'depends_on', 'count', 'for_each'].includes(k))
          childArgs[k] = v as Json;
      }
      inst.children[name] = childScope;
      await load(childDir, childScope, childArgs, depth + 1);
    }
  };
  await load(rootDir, '', {}, 0);

  // root の terraform.tfvars / *.auto.tfvars（リテラルだけ使う）
  const tfvars: JsonObject = {};
  let names: string[] = [];
  try {
    names = readdirSync(rootDir).filter(
      (n) => n === 'terraform.tfvars' || n.endsWith('.auto.tfvars'),
    );
  } catch {
    /* ignore */
  }
  const tfvarsFiles: string[] = [];
  for (const n of names.sort()) {
    try {
      tfvarsFiles.push(join(rootDir, n));
      const j = await parse(n, readFileSync(join(rootDir, n), 'utf8'));
      if (isObject(j)) Object.assign(tfvars, j);
    } catch (e) {
      log.debug(`terraform: ${n} を読めません: ${String(e)}`);
    }
  }
  return { modules, tfvars, tfvarsFiles };
}
