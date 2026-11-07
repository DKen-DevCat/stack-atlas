/**
 * ts-morph の小道具（このパッケージ内で共有）。
 */
import { Node, Project, type ObjectLiteralExpression, type SourceFile } from 'ts-morph';

let project: Project | undefined;

/** tsconfig を読まずに 1 ファイルだけ構文解析する（型解決はしない） */
export function parseSource(fileName: string, text: string): SourceFile {
  project ??= new Project({
    useInMemoryFileSystem: true,
    compilerOptions: { allowJs: true, jsx: 4 /* ReactJSX */ },
  });
  return project.createSourceFile(fileName.replace(/^\/+/, ''), text, { overwrite: true });
}

/** プロパティ名（識別子・文字列キーとも） */
export function propName(p: Node): string | undefined {
  if (Node.isPropertyAssignment(p) || Node.isShorthandPropertyAssignment(p)) {
    const n = p.getNameNode();
    if (Node.isIdentifier(n)) return n.getText();
    if (Node.isStringLiteral(n) || Node.isNoSubstitutionTemplateLiteral(n))
      return n.getLiteralText();
  }
  return undefined;
}

/** オブジェクトリテラルの name → 値の式 */
export function objectProps(obj: ObjectLiteralExpression): Map<string, Node> {
  const out = new Map<string, Node>();
  for (const p of obj.getProperties()) {
    const name = propName(p);
    if (!name) continue;
    if (Node.isPropertyAssignment(p)) {
      const init = p.getInitializer();
      if (init) out.set(name, unwrap(init));
    } else if (Node.isShorthandPropertyAssignment(p)) out.set(name, p.getNameNode());
  }
  return out;
}

/** `(x)` / `x as T` / `x satisfies T` を外す */
export function unwrap(n: Node): Node {
  let cur = n;
  for (;;) {
    if (Node.isParenthesizedExpression(cur) || Node.isAsExpression(cur)) cur = cur.getExpression();
    else if (Node.isSatisfiesExpression(cur)) cur = cur.getExpression();
    else return cur;
  }
}

/** 数値リテラル（`2_000`・`5 * 60 * 1000` のような掛け算も） */
export function numberValue(n: Node): number | undefined {
  const e = unwrap(n);
  if (Node.isNumericLiteral(e)) return e.getLiteralValue();
  if (Node.isIdentifier(e) && e.getText() === 'Infinity') return Infinity;
  if (Node.isPrefixUnaryExpression(e) && e.getText().startsWith('-')) {
    const v = numberValue(e.getOperand());
    return v === undefined ? undefined : -v;
  }
  if (Node.isBinaryExpression(e)) {
    const op = e.getOperatorToken().getText();
    const l = numberValue(e.getLeft());
    const r = numberValue(e.getRight());
    if (l === undefined || r === undefined) return undefined;
    if (op === '*') return l * r;
    if (op === '+') return l + r;
    if (op === '-') return l - r;
    if (op === '/' && r !== 0) return l / r;
  }
  return undefined;
}

/** 文字列リテラル（`require.resolve('./x')` の中身も） */
export function stringValue(n: Node): string | undefined {
  const e = unwrap(n);
  if (Node.isStringLiteral(e) || Node.isNoSubstitutionTemplateLiteral(e)) return e.getLiteralText();
  if (Node.isCallExpression(e)) {
    const arg = e.getArguments()[0];
    if (
      arg &&
      /^(require\.resolve|path\.(resolve|join)|resolve|join)$/.test(e.getExpression().getText())
    )
      return stringValue(e.getArguments().at(-1) ?? arg);
  }
  return undefined;
}

/** 値を表示用の文字列にする（リテラルはそのまま、式はソースの文字列） */
export function literalText(n: Node): string {
  const e = unwrap(n);
  const s = stringValue(e);
  if (s !== undefined) return s;
  const t = e.getText().replace(/\s+/g, ' ');
  return t.length > 60 ? `${t.slice(0, 57)}...` : t;
}

/** ミリ秒を「2秒」「500ms」「5分」に */
export function formatMs(ms: number): string {
  if (ms === Infinity) return '無期限';
  if (ms % 3_600_000 === 0 && ms >= 3_600_000) return `${ms / 3_600_000}時間`;
  if (ms % 60_000 === 0 && ms >= 60_000) return `${ms / 60_000}分`;
  if (ms % 1000 === 0) return `${ms / 1000}秒`;
  return `${ms}ms`;
}

/** ミリ秒をバッジ用に「2s」「500ms」「5m」 */
export function shortMs(ms: number): string {
  if (ms === Infinity) return '∞';
  if (ms % 3_600_000 === 0 && ms >= 3_600_000) return `${ms / 3_600_000}h`;
  if (ms % 60_000 === 0 && ms >= 60_000) return `${ms / 60_000}m`;
  if (ms % 1000 === 0) return `${ms / 1000}s`;
  return `${ms}ms`;
}
