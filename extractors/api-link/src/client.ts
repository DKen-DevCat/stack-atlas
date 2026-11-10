/**
 * api client 側: 呼び出しの第 1 引数（ラッパーなら path の引数）からパスパターンを取り出す（docs/12 §3.6）。
 *
 * 呼び出しとして読むもの:
 * - `fetch` / `request` / `get` / `post` / `put` / `patch` / `delete` / `del` / `head`
 * - `api.callers` に書いた関数名（第 1 引数がパス）
 * - 自動検出したラッパー: 引数をそのままパスとして `fetch(\`${X}${arg}\`)` / `fetch(fn(arg))` /
 *   `X + arg` / 既知のラッパー（`request(arg, …)`）に渡す関数。推移的にたどる（fetcher → request → fetch）。
 *   ラッパーはクライアントファイルどうしで名前で共有する（import 先がクライアントファイルでなくても名前で当てる）
 * パスの式は文字列・テンプレート・`+` 連結。同じファイル（と import 先）の文字列定数は展開する。
 */
import { existsSync } from 'node:fs';
import { dirname, join, resolve as resolvePath } from 'node:path';
import {
  Node,
  Project,
  type CallExpression,
  type ObjectLiteralExpression,
  type SourceFile,
} from 'ts-morph';

export interface ApiCall {
  method: string;
  /** `/races/{id}` 形式 */
  path: string;
  /** 呼び出しを含む関数・プロパティ名（例: getRace） */
  via?: string;
  /** 呼び出しを含むトップレベルの宣言名（例: api） */
  top?: string;
  revalidate?: number | false;
  tags?: string[];
  cache?: string;
  line: number;
  /** 呼び出しのあるファイル（絶対パス） */
  file?: string;
}

const CALLEES: Record<string, string | undefined> = {
  fetch: undefined,
  request: undefined,
  get: 'GET',
  post: 'POST',
  put: 'PUT',
  patch: 'PATCH',
  delete: 'DELETE',
  del: 'DELETE',
  head: 'HEAD',
};

/** 識別子 → 文字列定数 */
export type ConstResolver = (n: Node) => string | undefined;

/** 式 → パス片。`${id}` / `+ id` は `{id}` にする。定数は resolve で展開する */
export function exprToPattern(n: Node, resolve?: ConstResolver): string | undefined {
  if (Node.isStringLiteral(n) || Node.isNoSubstitutionTemplateLiteral(n)) return n.getLiteralText();
  const r = resolve?.(n);
  if (r !== undefined) return r;
  if (Node.isTemplateExpression(n)) {
    let out = n.getHead().getLiteralText();
    for (const span of n.getTemplateSpans()) {
      const e = span.getExpression();
      out += resolve?.(e) ?? `{${paramName(e)}}`;
      out += span.getLiteral().getLiteralText();
    }
    return out;
  }
  if (Node.isBinaryExpression(n) && n.getOperatorToken().getText() === '+') {
    const l = exprToPattern(n.getLeft(), resolve) ?? `{${paramName(n.getLeft())}}`;
    const r2 = exprToPattern(n.getRight(), resolve) ?? `{${paramName(n.getRight())}}`;
    return l + r2;
  }
  if (Node.isParenthesizedExpression(n) || Node.isAsExpression(n))
    return exprToPattern(n.getExpression(), resolve);
  return undefined;
}

function paramName(e: Node): string {
  if (Node.isIdentifier(e)) return e.getText();
  if (Node.isPropertyAccessExpression(e)) return e.getName();
  if (Node.isCallExpression(e)) {
    const arg = e.getArguments()[0];
    if (arg) return paramName(arg);
  }
  return 'param';
}

/**
 * ベース URL を取り除いてパスにする。
 * - `/races` はそのまま
 * - `{BASE}/races` や `https://host/races` は最初の `/` から
 * - `/` が無い（`{BASE}{path}` など）ものは undefined（動的すぎて読めない）
 * クエリ文字列は落とす。
 */
export function toPath(pattern: string): string | undefined {
  let p = pattern;
  if (!p.startsWith('/')) {
    const m = /^[a-z][a-z0-9+.-]*:\/\/[^/]*/i.exec(p);
    if (m) p = p.slice(m[0].length);
    else {
      const lead = /^(\{[^}]*\})+/.exec(p);
      if (!lead) return undefined;
      p = p.slice(lead[0].length);
    }
    if (!p.startsWith('/')) return undefined;
  }
  const q = p.search(/[?#]/);
  if (q >= 0) p = p.slice(0, q);
  // `/races{qs}` のように / の直後でない末尾のプレースホルダ（クエリ文字列の連結）を落とす。
  // 中身の文字クラスから `{` も除く（`{` が多くて `}` が無い入力で二次の走査にならない。2026-11-09 レビュー S2）
  p = p.replace(/(?<=[^/])\{[^{}]*\}$/, '');
  return p === '' ? '/' : p;
}

function prop(obj: ObjectLiteralExpression, name: string): Node | undefined {
  const p = obj.getProperty(name);
  if (p && Node.isPropertyAssignment(p)) return p.getInitializer();
  return undefined;
}

function enclosingName(call: Node): string | undefined {
  for (const a of call.getAncestors()) {
    if (
      Node.isPropertyAssignment(a) ||
      Node.isMethodDeclaration(a) ||
      Node.isFunctionDeclaration(a)
    )
      return a.getName();
    if (Node.isVariableDeclaration(a)) return a.getName();
  }
  return undefined;
}

/** 呼び出しを含むトップレベルの宣言名 */
function topLevelName(call: Node): string | undefined {
  let name: string | undefined;
  for (const a of call.getAncestors()) {
    if (Node.isSourceFile(a)) break;
    if (
      Node.isFunctionDeclaration(a) ||
      Node.isClassDeclaration(a) ||
      Node.isVariableDeclaration(a)
    )
      name = a.getName() ?? name;
  }
  return name;
}

const calleeName = (call: CallExpression): string | undefined => {
  const callee = call.getExpression();
  if (Node.isIdentifier(callee)) return callee.getText();
  if (Node.isPropertyAccessExpression(callee)) return callee.getName();
  return undefined;
};

export interface Wrapper {
  /** パスを受け取る引数の位置 */
  pathIndex: number;
  /** 本体で固定しているメソッド（`{ method: 'POST' }`） */
  method?: string;
}

interface FunctionLike {
  name: string;
  params: string[];
  body: Node;
}

/** トップレベル・オブジェクトのプロパティ・クラスのメソッドなど、名前のある関数 */
function functionsOf(sf: SourceFile): FunctionLike[] {
  const out: FunctionLike[] = [];
  const paramsOf = (fn: Node) =>
    Node.isFunctionLikeDeclaration(fn) || Node.isArrowFunction(fn) || Node.isFunctionExpression(fn)
      ? fn.getParameters().map((p) => p.getName())
      : [];
  sf.forEachDescendant((n) => {
    let name: string | undefined;
    let fn: Node | undefined;
    if (Node.isFunctionDeclaration(n) || Node.isMethodDeclaration(n)) {
      name = n.getName();
      fn = n;
    } else if (Node.isVariableDeclaration(n) || Node.isPropertyAssignment(n)) {
      const init = n.getInitializer();
      if (init && (Node.isArrowFunction(init) || Node.isFunctionExpression(init))) {
        name = n.getName();
        fn = init;
      }
    }
    if (name && fn) out.push({ name, params: paramsOf(fn), body: fn });
  });
  return out;
}

/** 式が引数 p を「そのまま」パスとして通すか（前にリテラルの文字が無い。ベース URL の変数だけは前に来てよい） */
export function passesParam(e: Node, p: string): boolean {
  if (Node.isIdentifier(e)) return e.getText() === p;
  if (Node.isParenthesizedExpression(e) || Node.isAsExpression(e) || Node.isNonNullExpression(e))
    return passesParam(e.getExpression(), p);
  if (Node.isTemplateExpression(e)) {
    // 引数より前にリテラルの文字が無い（`${BASE}${path}` は可、`/x/${id}` や `${X}?q=${v}` は不可）
    let literal = e.getHead().getLiteralText();
    for (const span of e.getTemplateSpans()) {
      if (passesParam(span.getExpression(), p)) return literal === '';
      literal += span.getLiteral().getLiteralText();
    }
    return false;
  }
  if (Node.isBinaryExpression(e) && e.getOperatorToken().getText() === '+') {
    if (passesParam(e.getLeft(), p)) return true;
    const left = e.getLeft();
    const isLiteral = (n: Node): boolean =>
      Node.isStringLiteral(n) ||
      Node.isNoSubstitutionTemplateLiteral(n) ||
      Node.isTemplateExpression(n) ||
      (Node.isBinaryExpression(n) && (isLiteral(n.getLeft()) || isLiteral(n.getRight())));
    return !isLiteral(left) && passesParam(e.getRight(), p);
  }
  if (Node.isCallExpression(e) || Node.isNewExpression(e))
    return (e.getArguments() ?? []).some((a) => passesParam(a, p));
  return false;
}

function literalMethod(args: Node[]): string | undefined {
  for (const a of args) {
    if (!Node.isObjectLiteralExpression(a)) continue;
    const m = prop(a, 'method');
    if (m && (Node.isStringLiteral(m) || Node.isNoSubstitutionTemplateLiteral(m)))
      return m.getLiteralText().toUpperCase();
  }
  return undefined;
}

const NAME_VERB: Array<[RegExp, string]> = [
  [/^(post|create|add|submit)(?=[A-Z_]|$)/, 'POST'],
  [/^(put|update|upsert|replace)(?=[A-Z_]|$)/, 'PUT'],
  [/^patch(?=[A-Z_]|$)/, 'PATCH'],
  [/^(delete|remove|del|destroy)(?=[A-Z_]|$)/, 'DELETE'],
];

/** ファイル群からラッパーを検出する（seed は callers）。固定点まで繰り返す */
export function detectWrappers(files: SourceFile[], callers: string[] = []): Map<string, Wrapper> {
  const wrappers = new Map<string, Wrapper>();
  for (const c of callers) wrappers.set(c, { pathIndex: 0 });
  const fns = files.flatMap(functionsOf);
  const known = (name: string): Wrapper | undefined =>
    name === 'fetch' ? { pathIndex: 0 } : wrappers.get(name);
  for (let changed = true; changed;) {
    changed = false;
    for (const f of fns) {
      if (wrappers.has(f.name) || f.params.length === 0) continue;
      let found: Wrapper | undefined;
      f.body.forEachDescendant((n, t) => {
        if (!Node.isCallExpression(n)) return;
        const callee = calleeName(n);
        const w = callee ? known(callee) : undefined;
        if (!w || callee === f.name) return;
        const args = n.getArguments();
        const arg = args[w.pathIndex];
        if (!arg) return;
        const idx = f.params.findIndex((p) => passesParam(arg, p));
        if (idx < 0) return;
        found = { pathIndex: idx };
        const m = literalMethod(args.filter((_, i) => i !== w.pathIndex)) ?? w.method;
        if (m) found.method = m;
        t.stop();
      });
      if (found) {
        wrappers.set(f.name, found);
        changed = true;
      }
    }
  }
  return wrappers;
}

/** 文字列定数（`const X = '/days'`、`as const` も可）: ファイル → 名前 → 値 */
function stringConsts(sf: SourceFile): Map<string, string> {
  const m = new Map<string, string>();
  for (const st of sf.getVariableStatements()) {
    for (const d of st.getDeclarations()) {
      const init = d.getInitializer();
      if (!init) continue;
      const v = exprToPattern(init, (n) => (Node.isIdentifier(n) ? m.get(n.getText()) : undefined));
      if (v !== undefined && !/^\{[^}]*\}$/.test(v)) m.set(d.getName(), v);
    }
  }
  return m;
}

/** import 先のファイル（相対 / `@/` / `~/` は src/ か root から）。見つからなければ undefined */
function resolveImport(fromFile: string, spec: string, root: string): string | undefined {
  let base: string | undefined;
  if (spec.startsWith('.')) base = resolvePath(dirname(fromFile), spec);
  else if (/^[@~]\//.test(spec)) {
    for (const r of [join(root, 'src'), root]) {
      const b = join(r, spec.slice(2));
      if (['', '.ts', '.tsx', '/index.ts', '/index.tsx'].some((x) => existsSync(b + x))) {
        base = b;
        break;
      }
    }
  }
  if (!base) return undefined;
  for (const x of ['', '.ts', '.tsx', '.js', '.jsx', '/index.ts', '/index.tsx', '/index.js']) {
    const p = base + x;
    if (existsSync(p) && /\.[cm]?[jt]sx?$/.test(p)) return p;
  }
  return undefined;
}

/** HTTP の呼び出しの情報（parseClientFiles と ts-types の共通の規則） */
export interface HttpCallInfo {
  method: string;
  /** `/races/{id}` 形式（クエリ文字列は落とす） */
  path: string;
  /** パスの式を展開したもの（クエリ文字列を含む。`/days?month={month}`） */
  pattern: string;
  /** パスを渡している引数の位置 */
  pathIndex: number;
  /** 呼び先の名前（fetch・fetcher・get など） */
  callee: string;
}

/**
 * 呼び出しが HTTP の呼び出し（fetch・既知の動詞・検出したラッパー・api.callers）で、パスが読めるなら情報を返す。
 * パスが読めない（動的すぎる）なら `{ unreadable }`、HTTP の呼び出しでなければ undefined。
 * ラッパーの中で引数をそのまま渡す中継かどうかは呼ぶ側で判定する（passesParam）
 */
export function httpCallInfo(
  n: CallExpression,
  wrappers: ReadonlyMap<string, Wrapper>,
  resolve?: ConstResolver,
): HttpCallInfo | { unreadable: string } | undefined {
  const fname = calleeName(n);
  if (!fname) return undefined;
  const w = wrappers.get(fname);
  const builtin = Object.hasOwn(CALLEES, fname);
  if (!w && !builtin) return undefined;
  const pathIndex = w?.pathIndex ?? 0;
  const args = n.getArguments();
  const first = args[pathIndex];
  if (!first) return undefined;
  const pattern = exprToPattern(first, resolve);
  const path = pattern === undefined ? undefined : toPath(pattern);
  if (!path || pattern === undefined)
    return { unreadable: `${fname}(${first.getText()}) @${n.getStartLineNumber()}` };
  const rest = args.filter((_, i) => i !== pathIndex);
  const verb = NAME_VERB.find(([re]) => re.test(fname))?.[1];
  const method =
    literalMethod(rest) ?? w?.method ?? (builtin ? CALLEES[fname] : undefined) ?? verb ?? 'GET';
  return { method, path, pattern, pathIndex, callee: fname };
}

/**
 * ファイルの文字列定数の解決（同じファイルと、import 先のファイルの export の文字列定数を 1 段）。
 * load は import 先の絶対パス → SourceFile（無ければ undefined）。cache はファイルごとの定数の表
 */
export function constResolverFor(
  sf: SourceFile,
  load: (spec: string, from: SourceFile) => SourceFile | undefined,
  cache: Map<SourceFile, Map<string, string>> = new Map(),
): ConstResolver {
  const fileConsts = (f: SourceFile) => {
    let m = cache.get(f);
    if (!m) {
      m = stringConsts(f);
      cache.set(f, m);
    }
    return m;
  };
  const local = new Map(fileConsts(sf));
  for (const imp of sf.getImportDeclarations()) {
    const tsf = load(imp.getModuleSpecifierValue(), sf);
    if (!tsf) continue;
    const tc = fileConsts(tsf);
    for (const named of imp.getNamedImports()) {
      const v = tc.get(named.getName());
      if (v !== undefined) local.set(named.getAliasNode()?.getText() ?? named.getName(), v);
    }
  }
  return (x) => (Node.isIdentifier(x) ? local.get(x.getText()) : undefined);
}

export interface ParseClientOptions {
  /** 第 1 引数がパスの関数名（api.callers） */
  callers?: string[];
  /** `@/` の解決に使う repo の root */
  root?: string;
}

export interface ParseClientResult {
  calls: ApiCall[];
  unreadable: string[];
  wrappers: Map<string, Wrapper>;
}

/** 複数のクライアントファイルを読む（ラッパーと定数はファイルをまたいで共有） */
export function parseClientFiles(
  files: string[],
  opts: ParseClientOptions = {},
): ParseClientResult {
  const project = new Project({
    skipAddingFilesFromTsConfig: true,
    skipFileDependencyResolution: true,
    compilerOptions: { allowJs: true },
  });
  const sfs = files.map((f) => project.addSourceFileAtPath(f));
  const wrappers = detectWrappers(sfs, opts.callers);
  const root = opts.root ?? (files[0] ? dirname(files[0]) : '.');

  // 定数: ファイルごと + import 先（クライアント以外も 1 段だけ読む）
  const constsOf = new Map<SourceFile, Map<string, string>>();
  const load = (spec: string, from: SourceFile) => {
    const target = resolveImport(from.getFilePath(), spec, root);
    if (!target) return undefined;
    return project.getSourceFile(target) ?? project.addSourceFileAtPath(target);
  };
  const calls: ApiCall[] = [];
  const unreadable: string[] = [];
  for (const sf of sfs) {
    const resolve = constResolverFor(sf, load, constsOf);
    const ownFns = functionsOf(sf);
    sf.forEachDescendant((n) => {
      if (!Node.isCallExpression(n)) return;
      const fname = calleeName(n);
      if (!fname) return;
      const w = wrappers.get(fname);
      const builtin = Object.hasOwn(CALLEES, fname);
      if (!w && !builtin) return;
      const pathIndex = w?.pathIndex ?? 0;
      const args = n.getArguments();
      const first = args[pathIndex];
      if (!first) return;
      // ラッパーの中で引数をそのまま渡している呼び出しは、呼び出しではなく中継
      const inside = ownFns.find(
        (f) =>
          f.body.containsRange(n.getPos(), n.getEnd()) &&
          f.params.some((p) => passesParam(first, p)),
      );
      if (inside) return;
      const info = httpCallInfo(n, wrappers, resolve);
      if (!info) return;
      if ('unreadable' in info) {
        unreadable.push(info.unreadable);
        return;
      }
      const rest = args.filter((_, i) => i !== pathIndex);
      const call: ApiCall = {
        method: info.method,
        path: info.path,
        line: n.getStartLineNumber(),
        file: sf.getFilePath(),
      };
      const via = enclosingName(n);
      if (via) call.via = via;
      const top = topLevelName(n);
      if (top) call.top = top;
      for (const a of rest) {
        if (!Node.isObjectLiteralExpression(a)) continue;
        const c = prop(a, 'cache');
        if (c && Node.isStringLiteral(c)) call.cache = c.getLiteralText();
        const next = prop(a, 'next');
        if (next && Node.isObjectLiteralExpression(next)) {
          const rv = prop(next, 'revalidate');
          if (rv && Node.isNumericLiteral(rv)) call.revalidate = rv.getLiteralValue();
          else if (rv && rv.getText() === 'false') call.revalidate = false;
          const tags = prop(next, 'tags');
          if (tags && Node.isArrayLiteralExpression(tags)) {
            call.tags = tags
              .getElements()
              .map((e) => exprToPattern(e, resolve) ?? `{${paramName(e)}}`);
          }
        }
      }
      calls.push(call);
    });
  }
  return { calls, unreadable, wrappers };
}

/** 従来の 1 ファイル版 */
export function parseClientCalls(
  file: string,
  opts: ParseClientOptions = {},
): { calls: ApiCall[]; unreadable: string[] } {
  const { calls, unreadable } = parseClientFiles([file], opts);
  return {
    calls: calls.map((c) => {
      const out = { ...c };
      delete out.file;
      delete out.top;
      return out;
    }),
    unreadable,
  };
}
