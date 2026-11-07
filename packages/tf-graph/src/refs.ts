/**
 * `${...}` 式の参照の抽出。
 * - リソース参照: `<provider>_<type>.<name>[idx].<attr>`（`data.` と `var.` などは除く）。
 *   呼び出し側（terraform）がモジュールをまたいで置換した参照は `mod:<path>:` で修飾される。
 * - トークン: `var.x` / `local.x` / `module.m.out`（terraform 抽出器が解決する）
 */
import type { Json, JsonObject, Reference, Token } from './types.js';

export const isObject = (v: unknown): v is JsonObject =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** `${` … `}` の中身（入れ子の `{}` も数える） */
export function interpolations(s: string): Array<{ start: number; end: number; expr: string }> {
  const out: Array<{ start: number; end: number; expr: string }> = [];
  let i = s.indexOf('${');
  while (i >= 0) {
    let depth = 1;
    let j = i + 2;
    let quote: string | undefined;
    for (; j < s.length && depth > 0; j++) {
      const c = s[j];
      if (quote) {
        if (c === '\\') j++;
        else if (c === quote) quote = undefined;
      } else if (c === '"') quote = c;
      else if (c === '{') depth++;
      else if (c === '}') depth--;
    }
    if (depth !== 0) break;
    out.push({ start: i, end: j, expr: s.slice(i + 2, j - 1) });
    i = s.indexOf('${', j);
  }
  return out;
}

const MOD = String.raw`(?:mod:([\w/-]*):)?`;
const IDX = String.raw`(?:\[[^\]]*\])?`;
/** リソース参照。provider_type は `_` を 1 つ以上含む小文字 */
export const REF_RE = new RegExp(
  String.raw`(?<![\w.:])${MOD}([a-z][a-z0-9]*_[a-z0-9_]+)\.([A-Za-z_][\w-]*)${IDX}(?:\.([A-Za-z_]\w*))?`,
  'g',
);
export const TOKEN_RE = new RegExp(
  String.raw`(?<![\w.:])${MOD}(?:(var|local)\.([A-Za-z_][\w-]*)|module\.([A-Za-z_][\w-]*)${IDX}\.([A-Za-z_][\w-]*))`,
  'g',
);

function walk(value: Json, at: string, fn: (s: string, at: string) => void): void {
  if (typeof value === 'string') fn(value, at);
  else if (Array.isArray(value)) for (const v of value) walk(v, at, fn);
  else if (isObject(value)) {
    for (const [k, v] of Object.entries(value)) {
      if (k === '//') continue;
      walk(v, at ? `${at}.${k}` : k, fn);
    }
  }
}

/** 値の中のリソース参照（`at` は属性パス） */
export function collectRefs(value: Json | undefined, at = ''): Reference[] {
  const out: Reference[] = [];
  if (value === undefined) return out;
  walk(value, at, (s, path) => {
    for (const { expr } of interpolations(s)) {
      for (const r of expr.matchAll(REF_RE)) {
        const type = r[2]!;
        const ref: Reference = { type, logicalId: r[3]!, attr: r[4] ?? '', at: path };
        if (r[1] !== undefined) ref.module = r[1];
        out.push(ref);
      }
    }
  });
  return out;
}

/** 値の中の var / local / module トークン */
export function collectTokens(value: Json | undefined, at = ''): Token[] {
  const out: Token[] = [];
  if (value === undefined) return out;
  walk(value, at, (s, path) => {
    for (const { expr } of interpolations(s)) {
      for (const m of expr.matchAll(TOKEN_RE)) {
        const t: Token = m[2]
          ? { kind: m[2] as 'var' | 'local', name: m[3]!, at: path, text: m[0] }
          : { kind: 'module', name: m[4]!, output: m[5]!, at: path, text: m[0] };
        if (m[1] !== undefined) t.module = m[1];
        out.push(t);
      }
    }
  });
  return out;
}

/** 式が 1 つの `${...}` だけでできているか */
export function isPureInterpolation(s: string): boolean {
  const i = interpolations(s);
  return i.length === 1 && i[0]!.start === 0 && i[0]!.end === s.length;
}
