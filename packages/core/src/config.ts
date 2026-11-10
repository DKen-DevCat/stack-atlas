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
  extractors: 'object',
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
