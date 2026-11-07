/**
 * 参照の解決（docs/12 §3.3）。モジュールごとの環境で `var.x` / `local.x` / `module.m.out` を式に置き換え、
 * 最終的にリソース参照（`aws_x.y.attr`）にたどり着けば tf-graph がエッジにする。
 * 別のモジュールの式を持ち込むときは、その中のトークン・参照を `mod:<scope>:` で修飾する。
 */
import {
  interpolations,
  isObject,
  REF_RE,
  TOKEN_RE,
  type Json,
  type JsonObject,
} from '@stack-atlas/tf-graph';
import type { ModuleInstance } from './load.js';

export const MAX_ROUNDS = 5;
const MAX_LEN = 50_000;

const parentScope = (scope: string) =>
  scope.includes('/') ? scope.slice(0, scope.lastIndexOf('/')) : '';

/** 値の中の修飾されていないトークン・参照に `mod:<scope>:` を付ける */
export function qualify(value: Json, scope: string): Json {
  if (typeof value === 'string') {
    if (!value.includes('${')) return value;
    let out = '';
    let last = 0;
    for (const it of interpolations(value)) {
      const expr = it.expr
        .replace(REF_RE, (m, mod: string | undefined) =>
          mod !== undefined ? m : `mod:${scope}:${m}`,
        )
        .replace(TOKEN_RE, (m, mod: string | undefined) =>
          mod !== undefined ? m : `mod:${scope}:${m}`,
        );
      out += value.slice(last, it.start) + '${' + expr + '}';
      last = it.end;
    }
    return out + value.slice(last);
  }
  if (Array.isArray(value)) return value.map((v) => qualify(v, scope));
  if (isObject(value)) {
    const o: JsonObject = {};
    for (const [k, v] of Object.entries(value)) o[k] = qualify(v, scope);
    return o;
  }
  return value;
}

/** 値を「式の中に埋め込める文字列」にする（参照の検出だけが目的） */
function asExpr(v: Json): string {
  if (typeof v === 'string') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(asExpr).join(', ')}]`;
  if (isObject(v))
    return `{${Object.entries(v)
      .map(([k, x]) => `${JSON.stringify(k)}: ${asExpr(x)}`)
      .join(', ')}}`;
  return JSON.stringify(v);
}

export class Resolver {
  constructor(
    private readonly modules: Map<string, ModuleInstance>,
    private readonly tfvars: JsonObject,
  ) {}

  /** トークン 1 つの置き換え先（定義側のスコープで修飾済み）。解決できなければ undefined */
  lookup(scope: string, kind: string, name: string, output?: string): Json | undefined {
    const m = this.modules.get(scope);
    if (!m) return undefined;
    if (kind === 'var') {
      if (scope && name in m.args) return qualify(m.args[name]!, parentScope(scope));
      if (!scope && name in this.tfvars) return this.tfvars[name]!;
      const def = m.variable[name]?.['default'];
      if (def !== undefined && def !== null) return qualify(def, scope);
      return undefined;
    }
    if (kind === 'local') {
      return name in m.locals ? qualify(m.locals[name]!, scope) : undefined;
    }
    const child = m.children[name];
    const cm = child !== undefined ? this.modules.get(child) : undefined;
    const val = cm && output ? cm.output[output]?.['value'] : undefined;
    return val !== undefined ? qualify(val, cm!.scope) : undefined;
  }

  /** 文字列 1 つを 1 段だけ置き換える */
  private step(s: string, scope: string): Json {
    if (!s.includes('${') || s.length > MAX_LEN) return s;
    const its = interpolations(s);
    let out = '';
    let last = 0;
    let changed = false;
    for (const it of its) {
      const expr = it.expr.trim();
      TOKEN_RE.lastIndex = 0;
      const whole = [...expr.matchAll(TOKEN_RE)];
      const single = whole.length === 1 && whole[0]![0] === expr ? whole[0]! : undefined;
      if (single) {
        const rep = this.lookupMatch(single, scope);
        if (rep !== undefined) {
          changed = true;
          // 文字列全体が 1 トークンなら構造ごと置き換える（object / list を保つ）
          if (its.length === 1 && it.start === 0 && it.end === s.length) return rep;
          out +=
            s.slice(last, it.start) + (typeof rep === 'string' ? rep : '${' + asExpr(rep) + '}');
          last = it.end;
          continue;
        }
      }
      const replaced = it.expr.replace(TOKEN_RE, (...args: unknown[]) => {
        const m = args.slice(0, -2) as unknown as RegExpMatchArray;
        const rep = this.lookupMatch(m, scope);
        if (rep === undefined) return m[0];
        changed = true;
        return `(${asExpr(rep)})`;
      });
      out += s.slice(last, it.start) + '${' + replaced + '}';
      last = it.end;
    }
    return changed ? out + s.slice(last) : s;
  }

  private lookupMatch(m: RegExpMatchArray, scope: string): Json | undefined {
    const sc = m[1] ?? scope;
    return m[2] ? this.lookup(sc, m[2], m[3]!) : this.lookup(sc, 'module', m[4]!, m[5]!);
  }

  private stepValue(v: Json, scope: string): Json {
    if (typeof v === 'string') return this.step(v, scope);
    if (Array.isArray(v)) return v.map((x) => this.stepValue(x, scope));
    if (isObject(v)) {
      const o: JsonObject = {};
      for (const [k, x] of Object.entries(v)) o[k] = k === '//' ? x : this.stepValue(x, scope);
      return o;
    }
    return v;
  }

  /** 最大 MAX_ROUNDS 段まで置き換える */
  resolve(value: Json, scope: string): Json {
    let cur = value;
    for (let i = 0; i < MAX_ROUNDS; i++) {
      const next = this.stepValue(cur, scope);
      if (JSON.stringify(next) === JSON.stringify(cur)) break;
      cur = next;
    }
    return cur;
  }
}
