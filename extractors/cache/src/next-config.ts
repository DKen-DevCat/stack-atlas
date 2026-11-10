/**
 * Lambda に載せた Next.js: next.config の cacheHandler / isrMemoryCacheSize から ISR キャッシュの置き場所を読む。
 */
import { LAMBDA_FS_ISR_NOTE } from '@stack-atlas/core';
import type { Cache, CacheRule } from '@stack-atlas/schema';
import { Node } from 'ts-morph';
import { literalText, numberValue, parseSource, propName, stringValue, unwrap } from './ast.js';

export const NEXT_CONFIG_FILES = [
  'next.config.js',
  'next.config.mjs',
  'next.config.cjs',
  'next.config.ts',
  'next.config.mts',
] as const;

export interface NextCacheConfig {
  /** `cacheHandler`（Next 14.1+）か `experimental.incrementalCacheHandlerPath`（〜14.0） */
  cacheHandler?: string;
  /** 見つけたキー名 */
  cacheHandlerKey?: 'cacheHandler' | 'incrementalCacheHandlerPath';
  /** `cacheMaxMemorySize`（14.1+）か `experimental.isrMemoryCacheSize`（バイト） */
  memorySize?: { key: string; value: string };
  output?: string;
}

const MEMORY_KEYS = new Set(['cacheMaxMemorySize', 'isrMemoryCacheSize']);

function formatBytes(n: number): string {
  if (n === 0) return '0（メモリキャッシュ無効）';
  if (n % (1024 * 1024) === 0) return `${n / (1024 * 1024)}MB`;
  if (n % 1_000_000 === 0) return `${n / 1_000_000}MB`;
  return `${n} バイト`;
}

/**
 * next.config のソースを読む。コメントは見ない（プロパティ代入だけ）。
 * 設定がファクトリ関数や別変数でも、ファイル内のプロパティ名で拾う（ゆるめ）。
 */
export function parseNextConfig(fileName: string, text: string): NextCacheConfig {
  const out: NextCacheConfig = {};
  if (
    !/cacheHandler|incrementalCacheHandlerPath|isrMemoryCacheSize|cacheMaxMemorySize|output/.test(
      text,
    )
  )
    return out;
  const sf = parseSource(fileName, text);
  sf.forEachDescendant((n) => {
    if (!Node.isPropertyAssignment(n) && !Node.isShorthandPropertyAssignment(n)) return;
    const name = propName(n);
    const init = Node.isPropertyAssignment(n) ? n.getInitializer() : n.getNameNode();
    if (!name || !init) return;
    const value = unwrap(init);
    if ((name === 'cacheHandler' || name === 'incrementalCacheHandlerPath') && !out.cacheHandler) {
      // `cacheHandler: undefined` / `null` / `false` は未設定扱い
      if (/^(undefined|null|false)$/.test(value.getText())) return;
      out.cacheHandler = stringValue(value) ?? literalText(value);
      out.cacheHandlerKey = name;
    } else if (MEMORY_KEYS.has(name) && !out.memorySize) {
      const num = numberValue(value);
      out.memorySize = {
        key: name,
        value: num !== undefined ? formatBytes(num) : literalText(value),
      };
    } else if (name === 'output' && !out.output) {
      out.output = stringValue(value) ?? literalText(value);
    }
  });
  return out;
}

/** next.config の内容から Lambda ノードの cache を作る */
export function lambdaNextCache(cfg: NextCacheConfig, configFile: string): Cache {
  const rules: CacheRule[] = [];
  const memory = cfg.memorySize ?? { key: 'isrMemoryCacheSize', value: '既定（50MB）' };
  if (cfg.cacheHandler) {
    rules.push({ key: cfg.cacheHandlerKey ?? 'cacheHandler', value: cfg.cacheHandler });
    rules.push({ key: memory.key, value: memory.value });
    if (cfg.output) rules.push({ key: 'output', value: cfg.output });
    rules.push({ key: '設定', value: configFile });
    return { tone: 'ok', badge: 'ISR custom handler', rules };
  }
  rules.push({ key: 'cacheHandler', value: 'なし（ファイルシステム）' });
  rules.push({ key: 'incrementalCache', value: 'Lambda の /tmp（インスタンスごと）' });
  rules.push({ key: 'revalidatePath', value: '実行したインスタンスにしか効かない' });
  rules.push({ key: memory.key, value: memory.value });
  if (cfg.output) rules.push({ key: 'output', value: cfg.output });
  rules.push({ key: '設定', value: configFile });
  return { tone: 'warn', badge: 'ISR /tmp', rules, note: LAMBDA_FS_ISR_NOTE };
}
