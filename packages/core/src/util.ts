import type { ValidationIssue } from '@stack-atlas/schema';

export const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

export function clone<T>(v: T): T {
  return structuredClone(v);
}

export function issue(
  level: ValidationIssue['level'],
  path: string,
  message: string,
): ValidationIssue {
  return { level, path, message };
}

/**
 * 配列のマージ方法。key はパス（`screen.regions` など、ルートからドット区切り）。
 * 戻り値 undefined なら既定（JSON 等価で重複排除して連結）。
 */
type ArrayMerger = (a: unknown[], b: unknown[]) => unknown[];

function uniqueBy(items: unknown[], key: (v: unknown) => string): unknown[] {
  const seen = new Set<string>();
  const out: unknown[] = [];
  for (const v of items) {
    const k = key(v);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(v);
  }
  return out;
}

const jsonKey = (v: unknown) => JSON.stringify(v);

const regionKey = (v: unknown) =>
  isPlainObject(v) ? `${String(v.ref)}|${String(v.x)}|${String(v.y)}` : jsonKey(v);

const ARRAY_MERGERS: Record<string, ArrayMerger> = {
  'screen.regions': (a, b) => uniqueBy([...a, ...b], regionKey),
  'cache.rules': (a, b) => uniqueBy([...a, ...b], jsonKey),
  'meta.extractors': (a, b) => uniqueBy([...a, ...b], jsonKey),
};

export interface DeepMergeOptions {
  /**
   * 値がぶつかったときにどちらを残すか。
   * - `'target'`（抽出器どうしのマージ）: 先に出た値を残し、後続は欠けているフィールドだけ埋める
   * - `'source'`（overrides）: 後から来た値で上書きする。配列も置き換える（meta.extractors だけは和集合）
   */
  prefer: 'target' | 'source';
}

/**
 * target に source を deep merge した新しい値を返す（引数は変更しない）。
 * オブジェクトは再帰的にマージ。配列は prefer=target なら連結＋重複排除
 * （`screen.regions` は ref+x+y、`cache.rules` と `meta.extractors` は値で）。
 */
export function deepMerge<T>(target: T, source: unknown, opts: DeepMergeOptions, path = ''): T {
  if (source === undefined) return clone(target);
  if (target === undefined) return clone(source) as T;
  if (isPlainObject(target) && isPlainObject(source)) {
    const out: Record<string, unknown> = clone(target);
    for (const [k, v] of Object.entries(source)) {
      if (v === undefined) continue;
      out[k] = deepMerge(out[k], v, opts, path ? `${path}.${k}` : k);
    }
    return out as T;
  }
  if (Array.isArray(target) && Array.isArray(source)) {
    const merger = ARRAY_MERGERS[path];
    if (opts.prefer === 'source' && path !== 'meta.extractors') return clone(source) as T;
    return clone((merger ?? ((a, b) => uniqueBy([...a, ...b], jsonKey)))(target, source)) as T;
  }
  return clone(opts.prefer === 'source' ? source : target) as T;
}

/** 極小の glob → RegExp（`**` は / をまたぐ、`*` と `?` はまたがない） */
export function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i++;
        if (glob[i + 1] === '/') {
          i++;
          re += '(?:.*/)?';
        } else re += '.*';
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

export function toPosix(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.\//, '');
}
