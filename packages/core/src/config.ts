/**
 * stack-atlas.config.yaml の読み込み（docs/09 §3.3）。
 * 検証はゆるく、知らないキーや型の違いは警告にとどめる（設定ミスで build 全体を止めない）。
 * YAML として壊れている・トップレベルがオブジェクトでない場合だけ例外にする。
 */
import { existsSync, readFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { parse } from 'yaml';
import type { Logger, RepoContext, StackAtlasConfig } from './types.js';
import { isPlainObject } from './util.js';
import { silentLogger } from './logger.js';
import { repoPathProblem } from './secrets.js';

export const CONFIG_FILES = ['stack-atlas.config.yaml', 'stack-atlas.config.yml'] as const;

const KNOWN_KEYS: Record<keyof StackAtlasConfig, 'object' | 'array'> = {
  project: 'object',
  layers: 'array',
  layerOf: 'object',
  repos: 'object',
  cdktf: 'object',
  terraform: 'object',
  cloudformation: 'object',
  infra: 'object',
  next: 'object',
  ts: 'object',
  go: 'object',
  openapi: 'object',
  sql: 'object',
  deploy: 'object',
  api: 'object',
  classify: 'array',
  files: 'array',
  kinds: 'object',
  screenshots: 'object',
  screens: 'object',
  extractors: 'object',
  adapters: 'object',
};

/** 読み込みエラー（YAML の構文エラーなど）。CLI はメッセージだけを出して終了する */
export class AtlasConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AtlasConfigError';
  }
}

/** root 直下の YAML を読む。無ければ undefined。構文エラーは AtlasConfigError */
export function readYamlFile(path: string): unknown {
  if (!existsSync(path)) return undefined;
  try {
    return parse(readFileSync(path, 'utf8'));
  } catch (e) {
    throw new AtlasConfigError(`${path} を YAML として読めません: ${(e as Error).message}`);
  }
}

/** 設定ファイルのパス（.yaml → .yml の順で探す）。無ければ undefined */
export function findConfigFile(repoRoot: string): string | undefined {
  return CONFIG_FILES.map((f) => join(repoRoot, f)).find((p) => existsSync(p));
}

/**
 * repoRoot の stack-atlas.config.yaml（.yml も可）を読む。
 * ファイルが無ければ警告を出して `{}` を返す。
 */
export function loadConfig(repoRoot: string, log: Logger = silentLogger): StackAtlasConfig {
  const file = findConfigFile(repoRoot);
  if (!file) {
    log.warn(`設定ファイル（${CONFIG_FILES[0]}）がありません。既定値で解析します`);
    return {};
  }
  const raw = readYamlFile(file);
  if (raw === null || raw === undefined) return {};
  if (!isPlainObject(raw)) {
    throw new AtlasConfigError(`${file} のトップレベルはオブジェクト（key: value）にしてください`);
  }
  return checkConfig(raw, log, file);
}

/** loadConfigFile の結果 */
export interface LoadedConfig {
  config: StackAtlasConfig;
  /** config のあるディレクトリ（絶対パス）。repos の相対パスや overrides / flows / memos の基準 */
  configDir: string;
  /** 読んだ設定ファイル（無ければ undefined） */
  file?: string;
}

/** loadConfig と同じだが、configDir（と読んだファイル）も返す */
export function loadConfigFile(dir: string, log: Logger = silentLogger): LoadedConfig {
  const configDir = resolve(dir);
  const file = findConfigFile(configDir);
  const config = loadConfig(configDir, log);
  return file ? { config, configDir, file } : { config, configDir };
}

/** 生の設定オブジェクトをゆるく検証する。おかしなキーは警告して取り除く */
export function checkConfig(
  raw: Record<string, unknown>,
  log: Logger,
  file = 'config',
): StackAtlasConfig {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    const expected = KNOWN_KEYS[key as keyof StackAtlasConfig];
    if (!expected) {
      log.warn(`${file}: 未知のキー "${key}" は無視します`);
      continue;
    }
    if (value === null || value === undefined) continue;
    const ok = expected === 'array' ? Array.isArray(value) : isPlainObject(value);
    if (!ok) {
      log.warn(
        `${file}: "${key}" は${expected === 'array' ? '配列' : 'オブジェクト'}で書いてください（無視します）`,
      );
      continue;
    }
    out[key] = value;
  }
  const cfg = out as StackAtlasConfig;
  if (cfg.layers) {
    cfg.layers = cfg.layers.filter((l, i) => {
      const ok = isPlainObject(l) && typeof l.id === 'string' && typeof l.name === 'string';
      if (!ok) log.warn(`${file}: layers[${i}] には id と name（文字列）が必要です（無視します）`);
      return ok;
    });
  }
  if (cfg.repos) {
    for (const [k, v] of Object.entries(cfg.repos)) {
      if (typeof v !== 'string' || !v) {
        log.warn(`${file}: repos.${k} はパス（文字列）で書いてください（無視します）`);
        delete cfg.repos[k];
      }
    }
  }
  for (const key of ['classify', 'files'] as const) {
    const list = cfg[key] as unknown[] | undefined;
    if (!list) continue;
    const kept = list.filter((r, i) => {
      const ok =
        isPlainObject(r) &&
        typeof r.glob === 'string' &&
        (key === 'classify' || typeof r.kind === 'string');
      if (!ok)
        log.warn(
          `${file}: ${key}[${i}] には glob${key === 'files' ? ' と kind' : ''}（文字列）が必要です（無視します）`,
        );
      return ok;
    });
    (cfg as Record<string, unknown>)[key] = kept;
  }
  if (cfg.kinds) {
    for (const [k, def] of Object.entries(cfg.kinds)) {
      if (!isPlainObject(def)) {
        log.warn(`${file}: kinds.${k} はオブジェクトで書いてください（無視します）`);
        delete cfg.kinds[k];
        continue;
      }
      if (def.color !== undefined && !/^#[0-9a-fA-F]{6}$/.test(String(def.color))) {
        log.warn(`${file}: kinds.${k}.color は #rrggbb で書いてください（無視します）`);
        delete def.color;
      }
      const size = def.size as unknown;
      if (
        size !== undefined &&
        !(
          Array.isArray(size) &&
          size.length === 3 &&
          size.every((x) => typeof x === 'number' && x > 0)
        )
      ) {
        log.warn(`${file}: kinds.${k}.size は正の数 3 つの配列で書いてください（無視します）`);
        delete def.size;
      }
    }
  }
  dropOutsidePaths(cfg, log, file);
  if (cfg.screens) checkScreens(cfg.screens as Record<string, unknown>, log, file);
  if (cfg.extractors) {
    for (const [k, v] of Object.entries(cfg.extractors)) {
      if (typeof v !== 'boolean') {
        log.warn(`${file}: extractors.${k} は true / false で書いてください（無視します）`);
        delete cfg.extractors[k];
      }
    }
  }
  return cfg;
}

/**
 * 抽出器が読むパス・glob のうち、repo の外を字面で指すもの（絶対パス・`~`・`..` の段）を警告して取り除く
 * （2026-11-10 8-4 のレビュー S2: 設定は解析対象の repo のもので信用しない。`files: [{ glob: "../../x/*.env" }]` で
 * repo の外のファイルの中身が graph.json の code に入った）。repo の中を指すシンボリックリンクの先は、抽出器が読む前に
 * realpath で確かめる（secrets.ts の repoPath）。`repos`（config の外の repo を並べる）と、照合にだけ使う glob
 * （classify・deploy の handlers・go.entries）は対象外
 */
function dropOutsidePaths(cfg: StackAtlasConfig, log: Logger, file: string) {
  const bad = (v: unknown) => typeof v === 'string' && repoPathProblem(v) !== undefined;
  const warn = (where: string, v: unknown) =>
    log.warn(
      `${file}: ${where} の "${String(v)}" は repo の外を指す（絶対パスか ..）ので無視します`,
    );
  /** セクションの文字列のキー */
  const scalar = (section: Record<string, unknown> | undefined, name: string, keys: string[]) => {
    if (!isPlainObject(section)) return;
    for (const k of keys)
      if (bad(section[k])) {
        warn(`${name}.${k}`, section[k]);
        delete section[k];
      }
  };
  /** セクションの文字列の配列のキー（{ path } のオブジェクトも） */
  const list = (section: Record<string, unknown> | undefined, name: string, keys: string[]) => {
    if (!isPlainObject(section)) return;
    for (const k of keys) {
      const v = section[k];
      if (typeof v === 'string') {
        scalar(section, name, [k]);
        continue;
      }
      if (!Array.isArray(v)) continue;
      section[k] = v.filter((x, i) => {
        const p = isPlainObject(x) ? x.path : x;
        if (!bad(p)) return true;
        warn(`${name}.${k}[${i}]`, p);
        return false;
      });
    }
  };
  const c = cfg as Record<string, Record<string, unknown> | undefined>;
  if (cfg.files)
    cfg.files = cfg.files.filter((r, i) => {
      if (!bad(r.glob)) return true;
      warn(`files[${i}].glob`, r.glob);
      return false;
    });
  scalar(c.cdktf, 'cdktf', ['out', 'sourceDir']);
  scalar(c.terraform, 'terraform', ['root', 'sourceDir']);
  list(c.cloudformation, 'cloudformation', ['templates']);
  scalar(c.next, 'next', ['appDir', 'pagesDir', 'tsconfig']);
  list(c.ts, 'ts', ['tsconfig']);
  list(c.openapi, 'openapi', ['files']);
  list(c.sql, 'sql', ['migrations']);
  scalar(c.api, 'api', ['client']);
  list(c.api, 'api', ['clients']);
  scalar(c.screenshots, 'screenshots', ['storageState']);
  scalar(c.screens, 'screens', ['dir', 'publicDir']);
}

/** screens（docs/18 §3.3）のキー。おかしな値は警告して取り除く。outDir は設定ファイルからは受け付けない */
function checkScreens(sc: Record<string, unknown>, log: Logger, file: string) {
  const drop = (key: string, why: string) => {
    log.warn(`${file}: screens.${key} ${why}（無視します）`);
    delete sc[key];
  };
  if ('outDir' in sc) {
    // 書き出し先は build の出力先（graph.json の隣）に決まっている。repo の設定で repo の外に書かせない
    drop('outDir', 'は設定できません。書き出し先は build の出力先の screens/ です');
  }
  for (const key of Object.keys(sc)) {
    if (!['repo', 'from', 'dir', 'routes', 'viewport', 'publicDir', 'outDir'].includes(key))
      drop(key, 'は未知のキーです');
  }
  if (sc.from !== undefined && sc.from !== 'next-export' && sc.from !== 'dir')
    drop('from', 'は next-export か dir で書いてください');
  for (const key of ['repo', 'dir', 'publicDir']) {
    if (sc[key] !== undefined && (typeof sc[key] !== 'string' || !sc[key]))
      drop(key, 'は文字列で書いてください');
  }
  if (sc.from === 'dir' && sc.dir === undefined)
    log.warn(
      `${file}: screens.from が dir のときは screens.dir に HTML のディレクトリを書いてください`,
    );
  const vp = sc.viewport;
  if (
    vp !== undefined &&
    !(
      isPlainObject(vp) &&
      [vp.width, vp.height].every((x) => Number.isInteger(x) && (x as number) > 0)
    )
  )
    drop('viewport', 'は { width, height }（正の整数）で書いてください');
  const routes = sc.routes;
  if (routes !== undefined) {
    if (!isPlainObject(routes))
      drop('routes', 'は { "<ルート>": ["<サンプル>"] } で書いてください');
    else
      for (const [k, v] of Object.entries(routes)) {
        if (!Array.isArray(v) || !v.every((x) => typeof x === 'string')) {
          log.warn(`${file}: screens.routes["${k}"] は文字列の配列で書いてください（無視します）`);
          delete routes[k];
        }
      }
  }
}

/** 抽出器に渡す RepoContext を作る */
export function createRepoContext(
  root: string,
  config: StackAtlasConfig,
  log: Logger = silentLogger,
  opts: { repoName?: string; repos?: Record<string, string>; configDir?: string } = {},
): RepoContext {
  const abs = resolve(root);
  const repoName = opts.repoName ?? basename(abs);
  return {
    root: abs,
    repoName,
    repos: opts.repos ?? { [repoName]: abs },
    configDir: opts.configDir ?? abs,
    config,
    log,
    resolve: (...segments: string[]) => resolve(abs, ...segments),
  };
}
