/**
 * TS の型 → v2 の項目（docs/17 §3.2「型」、docs/16 §5）。
 *
 * - `type` は `checker.typeToString`（リテラル型は広げる。`'/today'` → `string`）
 * - `wireType` は対応表: number → number、string → string、boolean、bigint → integer、Date → datetime、
 *   Uint8Array / ArrayBuffer / Blob → bytes、配列・タプル → array、オブジェクト → object、any / unknown / 型引数 /
 *   関数 → unknown。void / undefined / null だけの型は書かない
 * - `typeRef` は名前付きの型（type alias・interface・class・enum）の宣言が repo の中にあるとき、その宣言の型 id
 *   （env.typeIdOf。ts-imports の `type:` の id。無ければ `type:<file>~<名前>`）。配列は要素、型引数 T は除く。
 *   自分が名前付きでないプロパティの項目は、所属する型（親の型）を指す
 * - `optional` は `?`・既定値・`| undefined`、`nullable` は `| null`
 * - 子はプロパティ（配列は要素のプロパティ。`[]` の段は作らない）。repo の外で宣言された型（RequestInit・Promise・Date
 *   など）と index signature だけの型（Record）は展開しない（不透明）。深さは既定 2、1 箱の項目は既定 200 まで
 */
import { ts } from 'ts-morph';
import type { ItemV2, NamedType, WireType } from '@stack-atlas/schema';
import { itemId } from '@stack-atlas/core';

export { itemId };

/** 1 箱の項目の残り（上限に着いたら子を作らない） */
export interface Budget {
  left: number;
  truncated: boolean;
}

export interface TypeEnv {
  checker: ts.TypeChecker;
  /** 宣言が repo の中（node_modules・lib・stub でない）か */
  inRepo(fileName: string): boolean;
  /** 絶対パス → repo 相対パス */
  rel(fileName: string): string;
  /** 名前付きの型の宣言 → typeRef の id（ts-imports の id。無ければ file で修飾。C7） */
  typeIdOf(decls: readonly ts.Declaration[], name: string): string;
  depth: number;
  /** typeRef の宛先にした名前付きの型（types[] に出す） */
  named: Map<string, NamedType>;
}

const FORMAT =
  ts.TypeFormatFlags.NoTruncation | ts.TypeFormatFlags.UseAliasDefinedOutsideCurrentScope;

/** 同じ口・同じ親の中で重ならない id */
export function uniqueId(base: string, used: Set<string>): string {
  let id = itemId(base);
  for (let k = 2; used.has(id); k++) id = `${itemId(base)}_${k}`;
  used.add(id);
  return id;
}

/** 表示用の型の文字列（リテラル型は広げる） */
export function typeText(env: TypeEnv, t: ts.Type): string {
  const c = env.checker;
  const widened =
    t.isLiteral() || t.flags & ts.TypeFlags.BooleanLiteral ? c.getBaseTypeOfLiteralType(t) : t;
  return c.typeToString(widened, undefined, FORMAT);
}

/** `Promise<T>` → T（それ以外はそのまま） */
export function unwrapPromise(env: TypeEnv, t: ts.Type): ts.Type {
  const sym = t.getSymbol();
  if (sym?.getName() === 'Promise') {
    const args = env.checker.getTypeArguments(t as ts.TypeReference);
    if (args.length) return args[0]!;
  }
  return t;
}

const NULLISH = ts.TypeFlags.Null | ts.TypeFlags.Undefined | ts.TypeFlags.Void;

/** null / undefined を外す */
export function stripNullish(
  env: TypeEnv,
  t: ts.Type,
): { t: ts.Type; nullable: boolean; undef: boolean } {
  if (!t.isUnion()) return { t, nullable: false, undef: false };
  const nullable = t.types.some((x) => x.flags & ts.TypeFlags.Null);
  const undef = t.types.some((x) => x.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Void));
  if (!nullable && !undef) return { t, nullable, undef };
  const nn = env.checker.getNonNullableType(t);
  return { t: nn, nullable, undef };
}

const isArrayLike = (env: TypeEnv, t: ts.Type) =>
  env.checker.isArrayType(t) || env.checker.isTupleType(t);

const elementOf = (env: TypeEnv, t: ts.Type): ts.Type | undefined =>
  env.checker.isArrayType(t) ? env.checker.getTypeArguments(t as ts.TypeReference)[0] : undefined;

const libName = (env: TypeEnv, t: ts.Type) => {
  const sym = t.aliasSymbol ?? t.getSymbol();
  const decl = sym?.declarations?.[0];
  if (!sym || !decl || env.inRepo(decl.getSourceFile().fileName)) return undefined;
  return sym.getName();
};

/** 線の上の形（docs/15 §3.3 の対応表） */
export function wireTypeOf(env: TypeEnv, t: ts.Type): WireType | undefined {
  const f = t.flags;
  if (
    f &
    (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.TypeParameter | ts.TypeFlags.Never)
  )
    return 'unknown';
  if (f & NULLISH) return undefined;
  if (f & ts.TypeFlags.BooleanLike) return 'boolean';
  if (f & ts.TypeFlags.StringLike) return 'string';
  if (f & ts.TypeFlags.NumberLike) return 'number';
  if (f & ts.TypeFlags.BigIntLike) return 'integer';
  if (f & ts.TypeFlags.ESSymbolLike) return 'unknown';
  if (t.isUnion()) {
    const ws = new Set(
      t.types.map((x) => wireTypeOf(env, x)).filter((x): x is WireType => x !== undefined),
    );
    if (ws.size === 0) return undefined;
    return ws.size === 1 ? [...ws][0]! : 'unknown';
  }
  if (isArrayLike(env, t)) return 'array';
  const lib = libName(env, t);
  if (lib === 'Date') return 'datetime';
  if (lib && /^(Uint8Array|ArrayBuffer|Blob|Buffer)$/.test(lib)) return 'bytes';
  if (t.getCallSignatures().length && !t.getProperties().length) return 'unknown';
  if (f & ts.TypeFlags.Object || t.isIntersection()) return 'object';
  return 'unknown';
}

/** 名前付きの型（repo の中の宣言）→ 型 id（env.typeIdOf）。配列は要素。型引数は除く */
export function namedRef(env: TypeEnv, t0: ts.Type): string | undefined {
  let t = stripNullish(env, t0).t;
  const el = elementOf(env, t);
  if (el) t = stripNullish(env, el).t;
  if (t.flags & ts.TypeFlags.TypeParameter) return undefined;
  const sym = t.aliasSymbol ?? t.getSymbol();
  if (!sym) return undefined;
  const name = sym.getName();
  if (!name || name.startsWith('__')) return undefined; // 無名の型リテラル（__type / __object）
  const decl = sym.declarations?.[0];
  if (!decl || !env.inRepo(decl.getSourceFile().fileName)) return undefined;
  if (
    !ts.isTypeAliasDeclaration(decl) &&
    !ts.isInterfaceDeclaration(decl) &&
    !ts.isClassDeclaration(decl) &&
    !ts.isEnumDeclaration(decl)
  )
    return undefined;
  const id = env.typeIdOf(sym.declarations ?? [decl], name);
  if (!env.named.has(id)) {
    const sf = decl.getSourceFile();
    env.named.set(id, {
      id,
      name,
      file: env.rel(sf.fileName),
      line: sf.getLineAndCharacterOfPosition(decl.getStart()).line + 1,
      source: 'typescript',
    });
  }
  return id;
}

export interface ItemOptions {
  /** 所属する名前付きの型（プロパティの項目のとき） */
  ownerRef?: string;
  optional?: boolean;
  /** 子の深さ（既定は env.depth） */
  depth?: number;
  budget: Budget;
  /** 表示用の型を上書きする（Promise を剥がす前の戻り値など） */
  display?: string;
  /** 子を作らない */
  noChildren?: boolean;
}

/** 型 → 項目（子は再帰。上限は budget） */
export function makeItem(
  env: TypeEnv,
  id: string,
  name: string,
  t: ts.Type,
  o: ItemOptions,
): ItemV2 {
  const { t: base, nullable, undef } = stripNullish(env, t);
  const item: ItemV2 = { id: itemId(id), name, type: o.display ?? typeText(env, t) };
  const wt = wireTypeOf(env, base);
  if (wt) item.wireType = wt;
  if (nullable) item.nullable = true;
  if (o.optional || undef) item.optional = true;
  const own = namedRef(env, base);
  const ref = own ?? o.ownerRef;
  if (ref) item.typeRef = ref;
  const depth = o.depth ?? env.depth;
  if (!o.noChildren && depth > 0) {
    const children = childrenOf(env, base, depth, own ?? o.ownerRef, o.budget);
    if (children?.length) item.children = children;
  }
  return item;
}

/** 子（プロパティ）。配列は要素のプロパティ */
function childrenOf(
  env: TypeEnv,
  t0: ts.Type,
  depth: number,
  owner: string | undefined,
  budget: Budget,
): ItemV2[] | undefined {
  let t = t0;
  const el = elementOf(env, t);
  if (el) t = stripNullish(env, el).t;
  if (!(t.flags & ts.TypeFlags.Object) && !t.isIntersection()) return undefined;
  if (t.getCallSignatures().length && !t.getProperties().length) return undefined;
  const c = env.checker;
  const props = c.getPropertiesOfType(t).filter((p) => {
    const d = p.valueDeclaration ?? p.declarations?.[0];
    return !!d && env.inRepo(d.getSourceFile().fileName);
  });
  if (!props.length) return undefined;
  const out: ItemV2[] = [];
  const used = new Set<string>();
  for (const p of props) {
    if (budget.left <= 0) {
      budget.truncated = true;
      break;
    }
    budget.left--;
    const d = (p.valueDeclaration ?? p.declarations?.[0])!;
    const pt = c.getTypeOfSymbolAtLocation(p, d);
    const optional = (p.flags & ts.SymbolFlags.Optional) !== 0;
    out.push(
      makeItem(env, uniqueId(p.getName(), used), p.getName(), pt, {
        ...(owner ? { ownerRef: owner } : {}),
        optional,
        depth: depth - 1,
        budget,
      }),
    );
  }
  return out;
}

/**
 * 型のプロパティを、repo の中で宣言されたもの（項目にする）と外で宣言されたもの（node_modules・lib・stub。React の DOM の
 * 属性など。項目にせず不透明な 1 項目にまとめる）に分ける（2026-11-09 レビュー C3）。宣言の無いプロパティ（mapped type
 * など）は中とみなす（従来どおり項目にする）
 */
export function splitProps(env: TypeEnv, t: ts.Type): { own: ts.Symbol[]; external: ts.Symbol[] } {
  const own: ts.Symbol[] = [];
  const external: ts.Symbol[] = [];
  for (const p of env.checker.getPropertiesOfType(t)) {
    const d = p.valueDeclaration ?? p.declarations?.[0];
    if (d && !env.inRepo(d.getSourceFile().fileName)) external.push(p);
    else own.push(p);
  }
  return { own, external };
}

/** 1 箱の項目の数（入れ子を含む） */
export function countItems(items: readonly ItemV2[]): number {
  let n = 0;
  for (const it of items) n += 1 + countItems(it.children ?? []);
  return n;
}
