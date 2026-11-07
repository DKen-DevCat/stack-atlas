/**
 * api client 側: fetch / get / post / request 呼び出しの第 1 引数からパスパターンを取り出す。
 */
import { Node, Project, type CallExpression, type ObjectLiteralExpression } from 'ts-morph';

export interface ApiCall {
  method: string;
  /** `/races/{id}` 形式 */
  path: string;
  /** 呼び出しを含む関数・プロパティ名（例: getRace） */
  via?: string;
  revalidate?: number | false;
  tags?: string[];
  cache?: string;
  line: number;
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

/** 式 → パス片。`${id}` / `+ id` は `{id}` にする */
export function exprToPattern(n: Node): string | undefined {
  if (Node.isStringLiteral(n) || Node.isNoSubstitutionTemplateLiteral(n)) return n.getLiteralText();
  if (Node.isTemplateExpression(n)) {
    let out = n.getHead().getLiteralText();
    for (const span of n.getTemplateSpans()) {
      out += `{${paramName(span.getExpression())}}`;
      out += span.getLiteral().getLiteralText();
    }
    return out;
  }
  if (Node.isBinaryExpression(n) && n.getOperatorToken().getText() === '+') {
    const l = exprToPattern(n.getLeft()) ?? `{${paramName(n.getLeft())}}`;
    const r = exprToPattern(n.getRight()) ?? `{${paramName(n.getRight())}}`;
    return l + r;
  }
  if (Node.isParenthesizedExpression(n)) return exprToPattern(n.getExpression());
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
  p = p.replace(/[?#].*$/, '');
  // `/races{qs}` のように / の直後でない末尾のプレースホルダ（クエリ文字列の連結）を落とす
  p = p.replace(/(?<=[^/])\{[^}]*\}$/, '');
  return p === '' ? '/' : p;
}

function prop(obj: ObjectLiteralExpression, name: string): Node | undefined {
  const p = obj.getProperty(name);
  if (p && Node.isPropertyAssignment(p)) return p.getInitializer();
  return undefined;
}

function enclosingName(call: CallExpression): string | undefined {
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

export function parseClientCalls(file: string): { calls: ApiCall[]; unreadable: string[] } {
  const project = new Project({
    skipAddingFilesFromTsConfig: true,
    skipFileDependencyResolution: true,
    compilerOptions: { allowJs: true },
  });
  const sf = project.addSourceFileAtPath(file);
  const calls: ApiCall[] = [];
  const unreadable: string[] = [];
  sf.forEachDescendant((n) => {
    if (!Node.isCallExpression(n)) return;
    const callee = n.getExpression();
    const fname = Node.isIdentifier(callee)
      ? callee.getText()
      : Node.isPropertyAccessExpression(callee)
        ? callee.getName()
        : undefined;
    if (!fname || !(fname in CALLEES)) return;
    const [first, ...rest] = n.getArguments();
    if (!first) return;
    const pattern = exprToPattern(first);
    const path = pattern === undefined ? undefined : toPath(pattern);
    if (!path) {
      unreadable.push(`${fname}(${first.getText()}) @${n.getStartLineNumber()}`);
      return;
    }
    const call: ApiCall = { method: CALLEES[fname] ?? 'GET', path, line: n.getStartLineNumber() };
    const via = enclosingName(n);
    if (via) call.via = via;
    for (const a of rest) {
      if (!Node.isObjectLiteralExpression(a)) continue;
      const m = prop(a, 'method');
      if (m && (Node.isStringLiteral(m) || Node.isNoSubstitutionTemplateLiteral(m)))
        call.method = m.getLiteralText().toUpperCase();
      const c = prop(a, 'cache');
      if (c && Node.isStringLiteral(c)) call.cache = c.getLiteralText();
      const next = prop(a, 'next');
      if (next && Node.isObjectLiteralExpression(next)) {
        const rv = prop(next, 'revalidate');
        if (rv && Node.isNumericLiteral(rv)) call.revalidate = rv.getLiteralValue();
        else if (rv && rv.getText() === 'false') call.revalidate = false;
        const tags = prop(next, 'tags');
        if (tags && Node.isArrayLiteralExpression(tags)) {
          call.tags = tags.getElements().map((e) => exprToPattern(e) ?? `{${paramName(e)}}`);
        }
      }
    }
    calls.push(call);
  });
  return { calls, unreadable };
}
