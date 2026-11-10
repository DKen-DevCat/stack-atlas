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
import {
  Node,
  Project,
  SyntaxKind,
  ts,
  type ExportedDeclarations,
  type SourceFile,
} from 'ts-morph';
import type { Edge } from '@stack-atlas/schema';
import type {
  ClassifyRule,
  Extractor,
  PartialGraph,
  PartialNode,
  RepoContext,
} from '@stack-atlas/core';
import {
  confineRepoPath,
  findClassifyRule,
  globToRegExp,
  sectionFor,
  toArray,
} from '@stack-atlas/core';
import {
  findNextDirs,
  listNextFiles,
  type NextDirs,
  type NextFile,
} from '@stack-atlas/extractor-nextjs-app';

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

/** kind → ID の接頭辞（classify で kind を変えたとき） */
const KIND_PREFIX: Record<string, string> = { component: 'comp', page: 'route' };

/** classify のルール（repo 相対パスに最初に合ったもの。core の findClassifyRule） */
export function matchClassify(
  rules: ClassifyRule[] | undefined,
  repoName: string,
  rel: string,
): ClassifyRule | undefined {
  return findClassifyRule(rules, rel, repoName);
}

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

/** ts.tsconfig → next.tsconfig → ./tsconfig.json（repo 指定のあるセクションはその repo だけ） */
export function tsconfigPaths(ctx: RepoContext): string[] {
  const ts = sectionFor(ctx, ctx.config.ts);
  const next = sectionFor(ctx, ctx.config.next);
  const list = [...(ts?.tsconfig ?? [])];
  if (next?.tsconfig && !list.includes(next.tsconfig)) list.push(next.tsconfig);
  if (list.length === 0) list.push('tsconfig.json');
  // repo の外（絶対パス・`..`・外へ出るリンク）は読まない（2026-11-10 8-4 のレビュー S2）
  return list.filter((p) => 'abs' in confineRepoPath(ctx.root, p) && existsSync(ctx.resolve(p)));
}

const toPosix = (p: string) => p.split(sep).join('/');

export interface DeclInfo {
  exportName: string;
  decl: Node;
  category: Category;
  symbolKind: SymbolKind;
  /** config.classify で指定した kind（あれば category より優先） */
  kind?: string;
  layer?: string;
}

const truncate = (text: string, lines = 20) => {
  const ls = text.split('\n');
  return ls.length > lines ? [...ls.slice(0, lines), '  // …'].join('\n') : text;
};

/** 宣言を含む文（VariableDeclaration なら VariableStatement） */
export function statementOf(decl: Node): Node {
  if (Node.isVariableDeclaration(decl)) return decl.getVariableStatement() ?? decl;
  return decl;
}

export function hasJsx(n: Node): boolean {
  return (
    n.getFirstDescendant(
      (d) => Node.isJsxElement(d) || Node.isJsxSelfClosingElement(d) || Node.isJsxFragment(d),
    ) !== undefined
  );
}

/** 関数として扱える初期化子（arrow / function 式 / memo(() => …) など） */
export function functionInit(decl: Node): Node | undefined {
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
export function referencedNames(decls: Node[], locals: Map<string, Node[]>): Set<string> {
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
export function localDeclarations(sf: SourceFile): Map<string, Node[]> {
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

/** 宣言の位置のキー（ファイルの絶対パス#開始位置）。Project をまたいで同じ宣言を指す */
export const declKey = (d: Node) => `${d.getSourceFile().getFilePath()}#${d.getStart()}`;

/** tsconfig ごとの Project（ts-imports と ts-types で共有する。docs/17 §7 #10） */
export interface TsProject {
  /** repo 相対の tsconfig のパス */
  tsconfig: string;
  project: Project;
  /**
   * 解けなかった `extends`（node_modules の共有設定など。paths が黙って消える。docs/17 §7 #10）。
   * ts-morph が tsconfig を読んだときの診断から取る（読み直さない）
   */
  unresolvedExtends: string[];
}

/** ts-imports の分類と ID の結果（ts-types が同じ規則で箱を作るために共有する） */
export interface TsRepoAnalysis {
  /** repo の root（/ 区切り） */
  root: string;
  projects: TsProject[];
  /** ソースファイル（絶対パス → SourceFile。最初の tsconfig のものを使う） */
  files: Map<string, SourceFile>;
  /** ファイル（絶対パス）→ そのファイルを持つ Project */
  projectOf: Map<string, Project>;
  /** Next の page / layout / route.ts（絶対パス → nextjs-app と同じ ID） */
  routeIdOf: Map<string, string>;
  /** Next の app / pages のディレクトリと、その中のファイル（ts-types が同じ走査の結果を使う） */
  nextDirs: NextDirs;
  nextFiles: NextFile[];
  /** 分類した export（ファイルの絶対パスごと） */
  perFile: Map<string, DeclInfo[]>;
  /** 宣言（declKey）→ ノード ID */
  nodeOfDecl: Map<string, string>;
  /** ノード ID → ノード */
  nodes: Map<string, TsNodeInfo>;
  /** ファイル（絶対パス）→ そのファイルのノード */
  nodesOfFile: Map<string, TsNodeInfo[]>;
}

/** 分類した 1 ノード（lib はファイル単位で export を束ねる） */
export interface TsNodeInfo {
  id: string;
  category: Category;
  kind: string;
  layer: string | undefined;
  name: string;
  /** repo 相対パス */
  file: string;
  line: number;
  code: string;
  exportNames: string[];
  symbolKind: SymbolKind;
  decls: Node[];
}

/** ctx ごとの解析結果（同じ build の ts-imports と ts-types で 1 回だけ読む） */
const analyses = new WeakMap<RepoContext, TsRepoAnalysis>();

/**
 * repo の TS を読み、export を分類して ID を決める（ts-imports の手順 1〜4）。同じ ctx では 1 回だけ読んで使い回す
 * （ts-morph の Project を抽出器の間で共有する。docs/17 §7 #10）
 */
export function analyzeTsRepo(ctx: RepoContext, upstream: Readonly<PartialGraph>): TsRepoAnalysis {
  const cached = analyses.get(ctx);
  if (cached) return cached;
  const a = analyze(ctx, upstream);
  analyses.set(ctx, a);
  return a;
}

function analyze(ctx: RepoContext, upstream: Readonly<PartialGraph>): TsRepoAnalysis {
  const root = toPosix(ctx.root);
  const inRepo = (abs: string) => {
    const r = toPosix(relative(root, abs));
    return !r.startsWith('..') && !r.split('/').includes('node_modules');
  };

  // 1) tsconfig ごとに Project を作り、ソースファイルをパスで一意にする
  const files = new Map<string, SourceFile>();
  const projects: TsProject[] = [];
  const projectOf = new Map<string, Project>();
  for (const tc of tsconfigPaths(ctx)) {
    let project: Project;
    try {
      project = new Project({ tsConfigFilePath: ctx.resolve(tc) });
    } catch (e) {
      ctx.log.warn(`ts-imports: ${tc} を読めません: ${String(e)}`);
      continue;
    }
    projects.push({
      tsconfig: tc,
      project,
      unresolvedExtends: unresolvedExtends(ctx, tc, project),
    });
    for (const sf of project.getSourceFiles()) {
      const p = sf.getFilePath();
      if (sf.isDeclarationFile() || !SOURCE_EXT.test(p) || !inRepo(p) || files.has(p)) continue;
      files.set(p, sf);
      projectOf.set(p, project);
    }
  }

  // 2) Next の page / layout / route.ts / pages（nextjs-app と同じ ID。ファイル単位）
  const routeIdOf = new Map<string, string>();
  const nextDirs = findNextDirs(ctx.root, sectionFor(ctx, ctx.config.next) ?? {});
  const nextFiles = listNextFiles(ctx.root, nextDirs).files;
  for (const f of nextFiles) routeIdOf.set(toPosix(f.abs), f.id);

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

  // 3.5) config.classify（glob → kind / layer）で上書き
  for (const [p, infos] of perFile) {
    const rel = toPosix(relative(root, p));
    const rule = matchClassify(ctx.config.classify, ctx.repoName, rel);
    if (!rule) continue;
    for (const info of infos) {
      if (rule.kind) info.kind = rule.kind;
      if (rule.layer) info.layer = rule.layer;
    }
  }

  // 4) ID を決める（衝突したらファイルパス付き。複数 repo なら他 repo の lib: とも衝突させない）
  const multiRepo = Object.keys(ctx.repos ?? {}).length > 1;
  const otherRepoIds = new Set(
    multiRepo
      ? upstream.nodes
          .filter((n) => !(n.file ?? '').startsWith(`${ctx.repoName}/`))
          .map((n) => n.id)
      : [],
  );
  const prefixOf = (info: DeclInfo) =>
    info.kind ? (KIND_PREFIX[info.kind] ?? info.kind) : info.category;
  const isLib = (info: DeclInfo) => (info.kind ? info.kind === 'lib' : info.category === 'lib');
  const candidate = (rel: string, info: DeclInfo) => {
    if (!isLib(info)) return `${prefixOf(info)}:${info.exportName}`;
    const id = `lib:${libName(rel)}`;
    return otherRepoIds.has(id) ? `lib:${ctx.repoName}/${rel}` : id;
  };
  const filesById = new Map<string, Set<string>>();
  for (const [p, infos] of perFile) {
    const rel = toPosix(relative(root, p));
    for (const info of infos) {
      const id = candidate(rel, info);
      filesById.set(id, (filesById.get(id) ?? new Set()).add(p));
    }
  }
  const nodes = new Map<string, TsNodeInfo>();
  const nodeOfDecl = new Map<string, string>();
  const nodesOfFile = new Map<string, TsNodeInfo[]>();
  for (const [p, infos] of perFile) {
    const rel = toPosix(relative(root, p));
    for (const info of infos) {
      let id = candidate(rel, info);
      if ((filesById.get(id)?.size ?? 0) > 1) {
        const scoped = multiRepo ? `${ctx.repoName}/${rel}` : rel;
        const fallback = isLib(info)
          ? `lib:${scoped}`
          : `${prefixOf(info)}:${scoped}#${info.exportName}`;
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
      const n: TsNodeInfo = {
        id,
        category: info.category,
        kind: info.kind ?? KIND_OF[info.category],
        layer: info.layer,
        name: isLib(info) ? libName(rel) : info.exportName,
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
    if (n.decls.length > 1 && n.kind !== 'lib') {
      const sorted = [...n.decls].sort((a, b) => a.getStart() - b.getStart());
      n.code = truncate(sorted.map((d) => statementOf(d).getText()).join('\n'));
      n.line = statementOf(sorted[0]!).getStartLineNumber();
    }
  }
  return {
    root,
    projects,
    files,
    projectOf,
    routeIdOf,
    nextDirs,
    nextFiles,
    perFile,
    nodeOfDecl,
    nodes,
    nodesOfFile,
  };
}

/**
 * tsconfig の `extends` のうち解けなかったもの。ts-morph が Project を作るときに読んだ診断（getConfigFileParsingDiagnostics）
 * から取る。extends の値は tsconfig の生の JSON から（extends の連鎖は解き直さない）
 */
function unresolvedExtends(ctx: RepoContext, tc: string, project: Project): string[] {
  const raw = ts.readConfigFile(ctx.resolve(tc), ts.sys.readFile);
  const ext = (raw.config as { extends?: unknown } | undefined)?.extends;
  const list = (typeof ext === 'string' ? [ext] : Array.isArray(ext) ? ext : []).filter(
    (e): e is string => typeof e === 'string',
  );
  if (!list.length) return [];
  const texts = project
    .getConfigFileParsingDiagnostics()
    .map((d) => ts.flattenDiagnosticMessageText(d.compilerObject.messageText, ' '));
  return list.filter((e) => texts.some((t) => t.includes(e)));
}

export const extractor: Extractor = {
  name: NAME,
  async detect(ctx) {
    if (ctx.config.ts?.repo && !sectionFor(ctx, ctx.config.ts)) return false;
    return tsconfigPaths(ctx).length > 0;
  },
  async extract(ctx, upstream): Promise<PartialGraph> {
    const { root, files, routeIdOf, nodeOfDecl, nodes, nodesOfFile } = analyzeTsRepo(ctx, upstream);

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
      kind: n.kind,
      ...(n.layer ? { layer: n.layer } : {}),
      name: n.name,
      file: n.file,
      line: n.line,
      code: n.code,
      meta: {
        extractors: [NAME],
        ts:
          n.kind === 'lib'
            ? { exportName: n.exportNames[0]!, symbolKind: n.symbolKind, exports: n.exportNames }
            : { exportName: n.exportNames[0]!, symbolKind: n.symbolKind },
      },
    }));
    ctx.log.info(`ts-imports: ${files.size} files, ${out.length} nodes, ${edges.size} edges`);
    // 読んだファイル（tsconfig の program のソースすべて。export の無いファイルも。docs/23 §3.1）
    const read = [...files.keys()].map((p) => toPosix(relative(root, p))).sort();
    return { nodes: out, edges: [...edges.values()], read };
  },
};

export default extractor;
