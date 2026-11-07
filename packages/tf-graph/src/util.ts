import { isObject } from './refs.js';
import type { Json, JsonObject } from './types.js';

export const str = (v: Json | undefined): string | undefined =>
  typeof v === 'string' ? v : undefined;
export const num = (v: Json | undefined): number | undefined =>
  typeof v === 'number' ? v : typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : undefined;
/** ブロックのリスト（cdk.tf.json は object か配列、hcl2json は配列） */
export const arr = (v: Json | undefined): Json[] => (Array.isArray(v) ? v : isObject(v) ? [v] : []);
/** 1 つだけのブロック（hcl2json では要素 1 の配列） */
export const one = (v: Json | undefined): JsonObject | undefined =>
  isObject(v) ? v : Array.isArray(v) && isObject(v[0]) ? v[0] : undefined;
/** 式を含まない文字列（名前に使える）なら返す */
export const literal = (v: Json | undefined): string | undefined => {
  const s = str(v);
  return s !== undefined && s !== '' && !s.includes('${') ? s : undefined;
};
