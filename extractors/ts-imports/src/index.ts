/**
 * ts-imports 抽出器: ts-morph で export を分類してノードにし、import をシンボル単位で解決して `uses` エッジを張る。
 * 方法は docs/04-extractors.md §3。
 *
 * 分類（上から順に判定）:
 *   1. handlers/ ディレクトリ（または config.deploy[*].handlers の glob）にある関数の export → handler:
 *   2. type / interface: db/ ディレクトリにある、または名前が `Item` で終わる → schema:、それ以外 → type:
 *   3. `z.` で始まる呼び出しで初期化した const（zod スキーマ）→ type:（symbolKind 'zod'）
 *   4. `use` + 大文字で始まる関数 → hook:
 *   5. .tsx / .jsx の PascalCase の関数で、本体に JSX がある → comp:
 *   6. それ以外 → lib:<ファイル名の camelCase>（ファイル単位で 1 ノード）
 * App Router の page / layout はノードにしない（nextjs-app の担当）が、その import は route:/layout: からの `uses` になる。
 */
import { existsSync } from 'node:fs';
import { basename, dirname, extname, relative, sep } from 'node:path';
import { Node, Project, SyntaxKind, type ExportedDeclarations, type SourceFile } from 'ts-morph';
import type { Edge } from '@stack-atlas/schema';
import type { Extractor, PartialGraph, PartialNode, RepoContext } from '@stack-atlas/core';
import { findAppDir, listRouteFiles } from '@stack-atlas/core';
import { globToRegExp, toArray } from '@stack-atlas/core';

export { segmentToUrl } from '@stack-atlas/core';

export const NAME = 'ts-imports';

export type Category = 'comp' | 'hook' | 'lib' | 'type' | 'handler' | 'schema';
export type SymbolKind = 'function' | 'const' | 'type' | 'interface' | 'class' | 'zod';

const KIND_OF: Record<Category, string> = {
  comp: 'component',
  hook: 'hook',
  lib: 'lib',
  type: 'type',
  handler: 'handler',
  schema: 'schema',
};

const SOURCE_EXT = /\.(tsx?|jsx?|mts|cts)$/;
const LIB_SKIP_DIRS = new Set(['src', 'lib', 'app', 'dist', 'source']);

/** apiClient.ts → apiClient、api-client.ts → apiClient、foo/index.ts → foo（src/lib などは飛ばす） */
export function libName(relPath: string): string {
  let base = basename(relPath, extname(relPath));
  if (base === 'index') {
    const dirs = dirname(relPath).split(/[\\/]/).reverse();
    base = dirs.find((d) => d && d !== '.' && !LIB_SKIP_DIRS.has(d)) ?? 'index';
  }
  const parts = base.split(/[-_.\s]+/).filter(Boolean);
  return parts.map((p, i) => (i === 0 ? p : p[0]!.toUpperCase() + p.slice(1))).join('') || base;
}

/** ts.tsconfig → next.tsconfig → ./tsconfig.json */
export function tsconfigPaths(ctx: RepoContext): string[] {
  const list = [...(ctx.config.ts?.tsconfig ?? [])];
  if (ctx.config.next?.tsconfig && !list.includes(ctx.config.next.tsconfig))
    list.push(ctx.config.next.tsconfig);
  if (list.length === 0) list.push('tsconfig.json');
  return list.filter((p) => existsSync(ctx.resolve(p)));
}

const toPosix = (p: string) => p.split(sep).join('/');

interface DeclInfo {
  exportName: string;
  decl: Node;
  category: Category;
  symbolKind: SymbolKind;
}

interface NodeAcc {
  id: string;
  category: Category;
  name: string;
  file: string;
  line: number;
  code: string;
  exportNames: string[];
  symbolKind: SymbolKind;
  decls: Node[];
}

const truncate = (text: string, lines = 20) => {
  const ls = text.split('\n');
  return ls.length > lines ? [...ls.slice(0, lines), '  // …'].join('\n') : text;
};

/** 宣言を含む文（VariableDeclaration なら VariableStatement） */
function statementOf(decl: Node): Node {
  if (Node.isVariableDeclaration(decl)) return decl.getVariableStatement() ?? decl;
  return decl;
}

function hasJsx(n: Node): boolean {
  return (
    n.getFirstDescendant(
      (d) => Node.isJsxElement(d) || Node.isJsxSelfClosingElement(d) || Node.isJsxFragment(d),
    ) !== undefined
  );
}

/** 関数として扱える初期化子（arrow / function 式 / memo(() => …) など） */
function functionInit(decl: Node): Node | undefined {
  if (Node.isFunctionDeclaration(decl)) return decl;
  if (!Node.isVariableDeclaration(decl)) return undefined;
  const init = decl.getInitializer();
  if (!init) return undefined;
  if (Node.isArrowFunction(init) || Node.isFunctionExpression(init)) return init;
  if (Node.isCallExpression(init)) {
    const fn = init
      .getArguments()
      .find((a) => Node.isArrowFunction(a) || Node.isFunctionExpression(a));
    if (fn) return fn;
  }
  return undefined;
}

function symbolKindOf(decl: Node): SymbolKind {
  if (Node.isFunctionDeclaration(decl)) return 'function';
  if (Node.isClassDeclaration(decl)) return 'class';
  if (Node.isInterfaceDeclaration(decl)) return 'interface';
  if (Node.isTypeAliasDeclaration(decl) || Node.isEnumDeclaration(decl)) return 'type';
  if (Node.isVariableDeclaration(decl)) {
    const init = decl.getInitializer();
    if (init && Node.isCallExpression(init) && /^z\s*\./.test(init.getText())) return 'zod';
    if (functionInit(decl)) return 'function';
  }
  return 'const';
}

interface ClassifyOptions {
  rel: string;
  handlerGlobs: RegExp[];
}

export function classify(exportName: string, decl: Node, o: ClassifyOptions): DeclInfo {
  const symbolKind = symbolKindOf(decl);
  const dirs = toPosix(dirname(o.rel)).split('/');
  const isFn = symbolKind === 'function';
  const base = { exportName, decl, symbolKind };
  const inHandlers = dirs.includes('handlers') || o.handlerGlobs.some((g) => g.test(o.rel));
  if (inHandlers && isFn) return { ...base, category: 'handler' };
  if (symbolKind === 'type' || symbolKind === 'interface') {
    if (dirs.includes('db') || /Item$/.test(exportName)) return { ...base, category: 'schema' };
    return { ...base, category: 'type' };
  }
  if (symbolKind === 'zod') return { ...base, category: 'type' };
  if (isFn && /^use[A-Z0-9]/.test(exportName)) return { ...base, category: 'hook' };
  if (/\.(tsx|jsx)$/.test(o.rel) && /^[A-Z]/.test(exportName)) {
    const fn = functionInit(decl) ?? (Node.isClassDeclaration(decl) ? decl : undefined);
    if (fn && hasJsx(fn)) return { ...base, category: 'comp' };
  }
  return { ...base, category: 'lib' };
}

/** 宣言の中で使われている識別子（同じファイルの非 export のトップレベル宣言は推移的にたどる） */
function referencedNames(decls: Node[], locals: Map<string, Node[]>): Set<string> {
  const seen = new Set<string>();
  const queue = [...decls];
  const visited = new Set<Node>();
  while (queue.length > 0) {
    const n = queue.pop()!;
    if (visited.has(n)) continue;
    visited.add(n);
    for (const id of n.getDescendantsOfKind(SyntaxKind.Identifier)) {
      const t = id.getText();
      if (seen.has(t)) continue;
      seen.add(t);
      const l = locals.get(t);
      if (l) queue.push(...l);
    }
  }
  return seen;
}

/** 非 export のトップレベル宣言: 名前 → 宣言 */
function localDeclarations(sf: SourceFile): Map<string, Node[]> {
  const m = new Map<string, Node[]>();
  const add = (name: string | undefined, n: Node) => {
    if (!name) return;
    m.set(name, [...(m.get(name) ?? []), n]);
  };
  for (const st of sf.getStatements()) {
    if (Node.isVariableStatement(st)) {
      if (st.isExported()) continue;
      for (const d of st.getDeclarations()) add(d.getName(), d);
    } else if (
      Node.isFunctionDeclaration(st) ||
      Node.isClassDeclaration(st) ||
      Node.isInterfaceDeclaration(st) ||
      Node.isTypeAliasDeclaration(st) ||
      Node.isEnumDeclaration(st)
    ) {
      if (st.isExported()) continue;
      add(st.getName(), st);
    }
  }
  return m;
}

const declKey = (d: Node) => `${d.getSourceFile().getFilePath()}#${d.getStart()}`;

export const extractor: Extractor = {
  name: NAME,
  async detect(ctx) {
    return tsconfigPaths(ctx).length > 0;
  },
  async extract(ctx): Promise<PartialGraph> {
    const root = toPosix(ctx.root);
    const inRepo = (abs: string) => {
      const r = toPosix(relative(root, abs));
      return !r.startsWith('..') && !r.split('/').includes('node_modules');
    };

    // 1) tsconfig ごとに Project を作り、ソースファイルをパスで一意にする
    const files = new Map<string, SourceFile>();
    for (const tc of tsconfigPaths(ctx)) {
      let project: Project;
      try {
        project = new Project({ tsConfigFilePath: ctx.resolve(tc) });
      } catch (e) {
        ctx.log.warn(`ts-imports: ${tc} を読めません: ${String(e)}`);
        continue;
      }
      for (const sf of project.getSourceFiles()) {
        const p = sf.getFilePath();
        if (sf.isDeclarationFile() || !SOURCE_EXT.test(p) || !inRepo(p) || files.has(p)) continue;
        files.set(p, sf);
      }
    }

    // 2) App Router の page / layout
    const routeIdOf = new Map<string, string>();
    const appDir = findAppDir(ctx.root, ctx.config.next?.appDir);
    if (appDir) {
      for (const f of listRouteFiles(ctx.root, appDir).files) routeIdOf.set(toPosix(f.abs), f.id);
    }

    const handlerGlobs = Object.values(ctx.config.deploy ?? {}).flatMap((d) =>
      toArray(d.handlers).map(globToRegExp),
    );

    // 3) export の分類
    const perFile = new Map<string, DeclInfo[]>();
    for (const [p, sf] of files) {
      if (routeIdOf.has(p)) continue;
      const rel = toPosix(relative(root, p));
      const infos: DeclInfo[] = [];
      for (const [exportName, decls] of sf.getExportedDeclarations()) {
        for (const decl of decls) {
          if (decl.getSourceFile() !== sf) continue; // 再エクスポートは宣言元で数える
          let name = exportName;
          if (name === 'default') {
            const own = (
              decl as ExportedDeclarations & { getName?: () => string | undefined }
            ).getName?.();
            name = own ?? libName(rel);
          }
          infos.push(classify(name, decl, { rel, handlerGlobs }));
        }
      }
      if (infos.length > 0) perFile.set(p, infos);
    }

    // 4) ID を決める（衝突したらファイルパス付き）
    const candidate = (rel: string, info: DeclInfo) =>
      info.category === 'lib' ? `lib:${libName(rel)}` : `${info.category}:${info.exportName}`;
    const filesById = new Map<string, Set<string>>();
    for (const [p, infos] of perFile) {
      const rel = toPosix(relative(root, p));
      for (const info of infos) {
        const id = candidate(rel, info);
        filesById.set(id, (filesById.get(id) ?? new Set()).add(p));
      }
    }
    const nodes = new Map<string, NodeAcc>();
    const nodeOfDecl = new Map<string, string>();
    const nodesOfFile = new Map<string, NodeAcc[]>();
    for (const [p, infos] of perFile) {
      const rel = toPosix(relative(root, p));
      for (const info of infos) {
        let id = candidate(rel, info);
        if ((filesById.get(id)?.size ?? 0) > 1) {
          const fallback =
            info.category === 'lib' ? `lib:${rel}` : `${info.category}:${rel}#${info.exportName}`;
          ctx.log.info(`ts-imports: ${id} が複数ファイルにあるので ${fallback} にします`);
          id = fallback;
        }
        nodeOfDecl.set(declKey(info.decl), id);
        const stmt = statementOf(info.decl);
        const acc = nodes.get(id);
        if (acc) {
          acc.decls.push(info.decl);
          if (!acc.exportNames.includes(info.exportName)) acc.exportNames.push(info.exportName);
          if (info.symbolKind === 'zod') acc.symbolKind = 'zod';
          continue;
        }
        const n: NodeAcc = {
          id,
          category: info.category,
          name: info.category === 'lib' ? libName(rel) : info.exportName,
          file: rel,
          line: stmt.getStartLineNumber(),
          code: truncate(stmt.getText()),
          exportNames: [info.exportName],
          symbolKind: info.symbolKind,
          decls: [info.decl],
        };
        nodes.set(id, n);
        nodesOfFile.set(p, [...(nodesOfFile.get(p) ?? []), n]);
      }
    }
    // 同じ ID に型と zod の両方がある（EntryInput）など: コード片は宣言を並べる
    for (const n of nodes.values()) {
      if (n.decls.length > 1 && n.category !== 'lib') {
        const sorted = [...n.decls].sort((a, b) => a.getStart() - b.getStart());
        n.code = truncate(sorted.map((d) => statementOf(d).getText()).join('\n'));
        n.line = statementOf(sorted[0]!).getStartLineNumber();
      }
    }

    // 5) import → uses エッジ
    const edges = new Map<string, Edge>();
    const addEdge = (from: string, to: string) => {
      if (from === to) return;
      edges.set(`${from}\0${to}`, { from, to, kind: 'uses' });
    };
    const idsFor = (decls: readonly Node[] | undefined): string[] =>
      (decls ?? []).map((d) => nodeOfDecl.get(declKey(d))).filter((x): x is string => !!x);

    for (const [p, sf] of files) {
      const routeId = routeIdOf.get(p);
      const owners = routeId ? undefined : nodesOfFile.get(p);
      if (!routeId && !owners) continue;

      // ローカル名 → 参照先ノード ID
      const imported = new Map<string, string[]>();
      for (const imp of sf.getImportDeclarations()) {
        const spec = imp.getModuleSpecifierValue();
        const target = imp.getModuleSpecifierSourceFile();
        if (!target || !files.has(target.getFilePath())) {
          ctx.log.debug(`ts-imports: ${toPosix(relative(root, p))}: '${spec}' は外部として無視`);
          continue;
        }
        const exported = target.getExportedDeclarations();
        const def = imp.getDefaultImport();
        if (def) imported.set(def.getText(), idsFor(exported.get('default')));
        const ns = imp.getNamespaceImport();
        if (ns)
          imported.set(
            ns.getText(),
            [...exported.values()].flatMap((d) => idsFor(d)),
          );
        for (const named of imp.getNamedImports()) {
          const name = named.getName();
          const local = named.getAliasNode()?.getText() ?? name;
          const ids = idsFor(exported.get(name));
          if (ids.length === 0)
            ctx.log.debug(`ts-imports: ${spec} の ${name} はノードに対応しません`);
          imported.set(local, ids);
        }
      }

      if (routeId) {
        // ルートファイルはファイル単位
        for (const ids of imported.values()) for (const id of ids) addEdge(routeId, id);
        continue;
      }
      const locals = localDeclarations(sf);
      const sameFile = new Map<string, string>();
      for (const n of owners!) for (const e of n.exportNames) sameFile.set(e, n.id);
      for (const n of owners!) {
        const refs = referencedNames(n.decls, locals);
        for (const [local, ids] of imported) {
          if (refs.has(local)) for (const id of ids) addEdge(n.id, id);
        }
        for (const [name, id] of sameFile) if (refs.has(name)) addEdge(n.id, id);
      }
    }

    const out: PartialNode[] = [...nodes.values()].map((n) => ({
      id: n.id,
      kind: KIND_OF[n.category],
      name: n.name,
      file: n.file,
      line: n.line,
      code: n.code,
      meta: {
        extractors: [NAME],
        ts:
          n.category === 'lib'
            ? { exportName: n.exportNames[0]!, symbolKind: n.symbolKind, exports: n.exportNames }
            : { exportName: n.exportNames[0]!, symbolKind: n.symbolKind },
      },
    }));
    ctx.log.info(`ts-imports: ${files.size} files, ${out.length} nodes, ${edges.size} edges`);
    return { nodes: out, edges: [...edges.values()] };
  },
};

export default extractor;
