/**
 * hcl2json の出力（ブロックの値が「本体の配列」）を cdk.tf.json の形に寄せる。
 * `resource.<type>.<name>: [body]` → `resource.<type>.<name>: body`（module / output / variable / data も同じ）。
 * ネストしたブロック（`environment { ... }` → `[{...}]`）はそのまま（tf-graph は配列でも読める）。
 */
import { isObject } from './refs.js';
import type { Json, JsonObject, TfJson } from './types.js';

const firstBody = (v: Json): JsonObject | undefined =>
  isObject(v) ? v : Array.isArray(v) && isObject(v[0]) ? v[0] : undefined;

export function normalizeHclJson(raw: unknown): TfJson & {
  variable?: Record<string, JsonObject>;
  output?: Record<string, JsonObject>;
  locals?: JsonObject;
} {
  const out: Record<string, unknown> = {};
  if (!isObject(raw)) return out;
  for (const [section, value] of Object.entries(raw)) {
    if (section === 'resource' || section === 'data') {
      const types: Record<string, Record<string, JsonObject>> = {};
      if (isObject(value)) {
        for (const [type, byName] of Object.entries(value)) {
          if (!isObject(byName)) continue;
          const names: Record<string, JsonObject> = {};
          for (const [name, body] of Object.entries(byName)) {
            const b = firstBody(body);
            if (b) names[name] = b;
          }
          types[type] = names;
        }
      }
      out[section] = types;
    } else if (section === 'module' || section === 'output' || section === 'variable') {
      const named: Record<string, JsonObject> = {};
      if (isObject(value)) {
        for (const [name, body] of Object.entries(value)) {
          const b = firstBody(body);
          if (b) named[name] = b;
        }
      }
      out[section] = named;
    } else if (section === 'locals') {
      // locals は複数ブロックを 1 つにまとめる
      const merged: JsonObject = {};
      for (const b of Array.isArray(value) ? value : [value]) {
        if (isObject(b)) Object.assign(merged, b);
      }
      out[section] = merged;
    } else {
      out[section] = value;
    }
  }
  return out as ReturnType<typeof normalizeHclJson>;
}
