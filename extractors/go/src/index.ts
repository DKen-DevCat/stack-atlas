/**
 * go 抽出器（docs/12 §3.4）: Go のソースを toolchain なしで正規表現で読み、
 * 1 パッケージ = 1 ノード、module 内 import → `uses`、HTTP ルート登録 → `meta.apiRoutes` にする。
 *
 * kind（上から順に判定）:
 *   1. `go.entries` の glob（既定 `cmd/*`）に合う、または `package main` → handler
 *   2. ルート登録（`HandleFunc("GET /x"` / chi・echo・gin・fiber の `r.Get("/x"` など）を含む → handler
 *   3. `classify` のルール（repo 相対のディレクトリかファイルに glob が合う、上から最初のもの）
 *   4. ディレクトリ名: domain / model(s) / types / entity / entities → type、
 *      store / db / repo / repository / repositories / dao → schema、それ以外 → lib
 * deploy: `config.deploy[<lambda>].go` を deploy エッジにする（core と同じ。重複はマージで消える）。
 *   明示が無い Lambda は function_name / image_uri / handler / ID が `-<入口名>` で終わるか `/<入口名>` を含めば推定（warn）。
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import type { Edge } from '@stack-atlas/schema';
import type {
  ClassifyRule,
  Extractor,
  PartialGraph,
  PartialNode,
  RepoContext,
} from '@stack-atlas/core';
import { findClassifyRule, globToRegExp, sectionFor } from '@stack-atlas/core';

export const NAME = 'go';

const toPosix = (p: string) => p.split(sep).join('/');

export interface GoRoute {
  method: string;
  path: string;
  line: number;
}

export interface GoFile {
  /** repo 相対（/ 区切り） */
  rel: string;
  pkg: string;
  imports: string[];
  routes: GoRoute[];
  src: string;
}

const SKIP_DIRS = new Set(['vendor', 'testdata', 'node_modules']);

/** `*.go`（`_test.go` を除く）を列挙する。vendor / testdata / `.` `_` で始まるディレクトリは飛ばす */
export function listGoFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    let names: string[];
    try {
      names = readdirSync(dir).sort();
    } catch {
      return;
    }
    for (const name of names) {
      const p = join(dir, name);
      let st;
      try {
        st = statSync(p);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        if (SKIP_DIRS.has(name) || name.startsWith('.') || name.startsWith('_')) continue;
        walk(p);
      } else if (name.endsWith('.go') && !name.endsWith('_test.go')) out.push(p);
    }
  };
  walk(root);
  return out;
}

/** go.mod の `module` 行 */
export function readModulePath(goMod: string): string | undefined {
  return /^\s*module\s+("?)([^\s"]+)\1/m.exec(goMod)?.[2];
}

/** `//` と `/* *\/` のコメントを（行番号を保ったまま）空白にする。文字列リテラル内は残す */
export function stripComments(src: string): string {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    const n = src[i + 1];
    if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      while (j < src.length && src[j] !== c) {
        if (src[j] === '\\' && c !== '`') j++;
        if (src[j] === '\n' && c !== '`') break;
        j++;
      }
      out += src.slice(i, j + 1);
      i = j + 1;
    } else if (c === '/' && n === '/') {
      while (i < src.length && src[i] !== '\n') i++;
    } else if (c === '/' && n === '*') {
      const end = src.indexOf('*/', i + 2);
      const stop = end < 0 ? src.length : end + 2;
      out += src.slice(i, stop).replace(/[^\n]/g, ' ');
      i = stop;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

/** import 宣言（単独・ブロック、別名付き）のパス */
export function parseImports(src: string): string[] {
  const out: string[] = [];
  for (const m of src.matchAll(/^\s*import\s*\(([\s\S]*?)\)/gm)) {
    for (const s of m[1]!.matchAll(/(?:^|\n)\s*(?:[\w.]+\s+)?"([^"]+)"/g)) out.push(s[1]!);
  }
  for (const m of src.matchAll(/^\s*import\s+(?:[\w.]+\s+)?"([^"]+)"/gm)) out.push(m[1]!);
  return [...new Set(out)];
}

const METHODS = 'GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|CONNECT|TRACE';
const lineAt = (src: string, index: number) => src.slice(0, index).split('\n').length;

/** `"GET /x"` / `"/x"` / `"GET example.com/x"`（Go 1.22 の ServeMux パターン）→ method + path */
export function parseServeMuxPattern(p: string): { method: string; path: string } | undefined {
  const m = new RegExp(`^(?:(${METHODS})\\s+)?([^/\\s]*)(/\\S*)$`).exec(p.trim());
  if (!m) return undefined;
  return { method: m[1] ?? 'ANY', path: m[3]! };
}

/**
 * HTTP ルートの登録を読む:
 * - net/http: `mux.HandleFunc("GET /x", ...)` / `Handle("POST /x"`（メソッド無しは ANY）
 * - chi / echo / gin / fiber: `r.Get("/x"` / `e.GET("/x"` / `app.Post("/x"`
 * - `router.Handle("GET", "/x"` / `r.Method(http.MethodGet, "/x"`
 * `http.Get(` などクライアント呼び出しは除く。
 */
export function parseRoutes(rawSrc: string): GoRoute[] {
  const src = stripComments(rawSrc);
  const out: GoRoute[] = [];
  const seen = new Set<string>();
  const push = (method: string, rawPath: string, index: number) => {
    // gin / echo / fiber の `:id` と `*rest` を `{id}` / `{rest...}` にそろえる
    const path = rawPath
      .replace(/\/:(\w+)/g, '/{$1}')
      .replace(/\/\*(\w*)$/, (_, n: string) => `/{${n || 'rest'}...}`);
    const k = `${method} ${path}`;
    if (seen.has(k)) return;
    seen.add(k);
    out.push({ method, path, line: lineAt(src, index) });
  };
  const methodArg = new RegExp(
    `\\.(?:Handle|HandleFunc|Method|MethodFunc|Handler|HandlerFunc|Add|Match)\\(\\s*(?:http\\.Method(\\w+)|"(${METHODS})")\\s*,\\s*"(/[^"]*)"`,
    'gi',
  );
  const taken = new Set<number>();
  for (const m of src.matchAll(methodArg)) {
    const method = (m[1] ?? m[2]!).toUpperCase();
    push(method, m[3]!, m.index);
    taken.add(m.index);
  }
  for (const m of src.matchAll(/\.(?:HandleFunc|Handle)\(\s*"([^"]+)"/g)) {
    if (taken.has(m.index)) continue;
    const r = parseServeMuxPattern(m[1]!);
    if (r) push(r.method, r.path, m.index);
  }
  const verb =
    /([A-Za-z_][\w]*)\.(Get|Post|Put|Patch|Delete|Head|Options|GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|Any|ANY|All)\(\s*"(\/[^"]*)"/g;
  for (const m of src.matchAll(verb)) {
    const recv = m[1]!;
    if (recv === 'http' || /client/i.test(recv)) continue;
    const v = m[2]!.toUpperCase();
    push(v === 'ALL' ? 'ANY' : v, m[3]!, m.index);
  }
  return out.sort((a, b) => a.line - b.line);
}

export function parseGoFile(rel: string, src: string): GoFile {
  const clean = stripComments(src);
  const pkg = /^\s*package\s+(\w+)/m.exec(clean)?.[1] ?? '';
  return { rel, pkg, imports: parseImports(clean), routes: parseRoutes(src), src };
}

const TYPE_DIRS = new Set(['domain', 'model', 'models', 'types', 'entity', 'entities']);
const SCHEMA_DIRS = new Set(['store', 'db', 'repo', 'repository', 'repositories', 'dao']);

/** classify のルール（repo 相対のパスのどれかに合う最初のルール。照合は core の findClassifyRule） */
export function matchClassify(
  rules: ClassifyRule[] | undefined,
  repoName: string,
  paths: string[],
): ClassifyRule | undefined {
  for (const r of rules ?? []) {
    if (paths.some((p) => findClassifyRule([r], p, repoName))) return r;
  }
  return undefined;
}

export interface GoPackage {
  /** module 相対のディレクトリ（root は `.`） */
  dir: string;
  name: string;
  files: GoFile[];
  kind: string;
  /** 入口パッケージ（entries の glob か package main） */
  entry: boolean;
  layer?: string;
  routes: GoRoute[];
  /** module 内 import（ディレクトリ） */
  internal: string[];
  imports: string[];
}

export interface GoAnalysis {
  module: string;
  packages: GoPackage[];
}

/** 入口パッケージ名（ディレクトリの最後のセグメント） */
const entryName = (dir: string) => dir.split('/').pop() ?? dir;

export function analyzeGo(
  root: string,
  opts: {
    module?: string;
    entries?: string[];
    classify?: ClassifyRule[];
    repoName?: string;
  } = {},
): GoAnalysis {
  const goMod = join(root, 'go.mod');
  const module =
    opts.module ??
    (existsSync(goMod) ? readModulePath(readFileSync(goMod, 'utf8')) : undefined) ??
    '';
  const byDir = new Map<string, GoFile[]>();
  for (const abs of listGoFiles(root)) {
    const rel = toPosix(relative(root, abs));
    const f = parseGoFile(rel, readFileSync(abs, 'utf8'));
    if (!f.pkg) continue;
    const dir = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '.';
    byDir.set(dir, [...(byDir.get(dir) ?? []), f]);
  }
  const entryRes = (opts.entries ?? ['cmd/*']).map(globToRegExp);
  const toDir = (imp: string): string | undefined => {
    if (!module) return undefined;
    if (imp === module) return '.';
    return imp.startsWith(module + '/') ? imp.slice(module.length + 1) : undefined;
  };
  const packages: GoPackage[] = [];
  for (const [dir, all] of [...byDir].sort(([a], [b]) => a.localeCompare(b))) {
    // 同じディレクトリに複数パッケージ（main と xxx_test 以外）がある場合は多い方を採る
    const counts = new Map<string, number>();
    for (const f of all) counts.set(f.pkg, (counts.get(f.pkg) ?? 0) + 1);
    const pkgName = [...counts].sort((a, b) => b[1] - a[1])[0]![0];
    const files = all.filter((f) => f.pkg === pkgName);
    const base = entryName(dir);
    const preferred = ['main.go', `${base}.go`, `${pkgName}.go`, 'doc.go'];
    files.sort((a, b) => {
      const ra = preferred.indexOf(a.rel.split('/').pop()!);
      const rb = preferred.indexOf(b.rel.split('/').pop()!);
      return (ra < 0 ? 99 : ra) - (rb < 0 ? 99 : rb) || a.rel.localeCompare(b.rel);
    });
    const routes = files.flatMap((f) => f.routes);
    const imports = [...new Set(files.flatMap((f) => f.imports))].sort();
    const internal = [
      ...new Set(imports.map(toDir).filter((d): d is string => d !== undefined && d !== dir)),
    ];
    let kind: string;
    let layer: string | undefined;
    const rule = matchClassify(opts.classify, opts.repoName ?? '', [
      dir,
      `${dir}/`,
      ...files.map((f) => f.rel),
    ]);
    const entry = entryRes.some((re) => re.test(dir)) || pkgName === 'main';
    if (entry) kind = 'handler';
    else if (routes.length > 0) kind = 'handler';
    else if (rule?.kind) kind = rule.kind;
    else if (TYPE_DIRS.has(base)) kind = 'type';
    else if (SCHEMA_DIRS.has(base)) kind = 'schema';
    else kind = 'lib';
    if (rule?.layer) layer = rule.layer;
    const pkg: GoPackage = { dir, name: pkgName, files, kind, entry, routes, internal, imports };
    if (layer) pkg.layer = layer;
    packages.push(pkg);
  }
  return { module, packages };
}

const ID_PREFIX: Record<string, string> = { component: 'comp' };
export const goNodeId = (p: Pick<GoPackage, 'kind' | 'dir'>, module = '') =>
  `${ID_PREFIX[p.kind] ?? p.kind}:${p.dir === '.' ? module.split('/').pop() || '.' : p.dir}`;

/** infra ノードの Terraform 型（cdktf / terraform / cloudformation のどれでも） */
export function infraType(n: PartialNode): string | undefined {
  for (const key of ['infra', 'cdktf']) {
    const v = n.meta?.[key] as { type?: unknown } | undefined;
    if (v && typeof v.type === 'string') return v.type;
  }
  return undefined;
}

const strings = (v: unknown, out: string[] = []): string[] => {
  if (typeof v === 'string') out.push(v);
  else if (Array.isArray(v)) for (const x of v) strings(x, out);
  else if (v && typeof v === 'object') for (const x of Object.values(v)) strings(x, out);
  return out;
};

/**
 * Lambda の名前の手がかり。強い順に 2 グループ:
 * 1. `image_config.command`（コンテナの起動バイナリ。例 `/var/task/gmail-auth`）
 * 2. function_name / image_uri / handler、ID、name
 * attrs は `meta.infra.attrs`（tf-graph）を見る。無ければ code の HCL / JSON を正規表現で読む
 */
export function lambdaHints(n: PartialNode): string[][] {
  const attrs = (n.meta?.['infra'] as { attrs?: Record<string, unknown> } | undefined)?.attrs;
  const strong: string[] = strings(attrs?.['image_config']);
  const weak: string[] = [];
  for (const k of ['function_name', 'image_uri', 'handler']) {
    const v = attrs?.[k];
    if (typeof v === 'string') weak.push(v);
  }
  if (n.code) {
    for (const m of n.code.matchAll(/"?command"?\s*[=:]\s*\[([^\]]*)\]/g))
      for (const q of m[1]!.matchAll(/"([^"]+)"/g)) strong.push(q[1]!);
    for (const m of n.code.matchAll(
      /"?\b(?:function_name|image_uri|handler)"?\s*[=:]\s*"([^"]+)"/g,
    ))
      weak.push(m[1]!);
  }
  weak.push(n.id.replace(/^infra:/, ''));
  if (n.name) weak.push(n.name);
  return [strong, weak];
}

const norm = (s: string) => s.toLowerCase().replace(/_/g, '-');
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Lambda の手がかりが入口名に合うか（一致、`-<name>` で終わる、または `/<name>` を含む） */
export function lambdaMatchesEntry(hints: string[], entry: string): boolean {
  const e = norm(entry);
  const inPath = new RegExp(`/${esc(e)}(?![a-z0-9-])`);
  return hints.some((h) => {
    const s = norm(h).replace(/:[^/:]*$/, ''); // image_uri のタグ
    return s === e || s.endsWith(`-${e}`) || inPath.test(s);
  });
}

export const extractor: Extractor = {
  name: NAME,
  async detect(ctx) {
    // repo 指定があればその repo だけ。無ければ go.mod のある repo
    if (ctx.config.go?.repo) return sectionFor(ctx, ctx.config.go) !== undefined;
    return existsSync(ctx.resolve('go.mod'));
  },
  async extract(ctx: RepoContext, upstream): Promise<PartialGraph> {
    const cfg = sectionFor(ctx, ctx.config.go) ?? {};
    const opts: Parameters<typeof analyzeGo>[1] = { repoName: ctx.repoName };
    if (cfg.module) opts.module = cfg.module;
    if (cfg.entries) opts.entries = cfg.entries;
    if (ctx.config.classify) opts.classify = ctx.config.classify;
    const a = analyzeGo(ctx.root, opts);
    if (!a.module)
      ctx.log.warn('go: go.mod の module が読めません（module 内 import を結べません）');
    const idOf = new Map(a.packages.map((p) => [p.dir, goNodeId(p, a.module)]));
    const nodes: PartialNode[] = [];
    const edges = new Map<string, Edge>();
    const addEdge = (from: string, to: string, kind: string) => {
      if (from === to) return;
      edges.set(`${from}\0${to}\0${kind}`, { from, to, kind });
    };
    for (const p of a.packages) {
      const first = p.files[0]!;
      const meta: Record<string, unknown> = {
        extractors: [NAME],
        go: { pkg: p.dir, name: p.name, imports: p.imports },
      };
      if (p.routes.length > 0) {
        const routes = p.routes.map((r) => ({ method: r.method, path: r.path }));
        meta['apiRoutes'] = routes;
        meta['api'] = routes[0];
      }
      const node: PartialNode = {
        id: idOf.get(p.dir)!,
        kind: p.kind,
        name: p.dir === '.' ? a.module.split('/').pop() || '.' : p.dir,
        file: first.rel,
        line: 1,
        code: first.src.split('\n').slice(0, 25).join('\n'),
        meta,
      };
      if (p.layer) node.layer = p.layer;
      nodes.push(node);
      for (const d of p.internal) {
        const to = idOf.get(d);
        if (to) addEdge(node.id, to, 'uses');
        else ctx.log.debug(`go: ${p.dir} の import ${d} にパッケージがありません`);
      }
    }

    // --- deploy: 明示（config.deploy[*].go）と推定
    const entries = a.packages.filter((p) => p.entry);
    const upIds = new Set(upstream.nodes.map((n) => n.id));
    const explicit = new Set<string>();
    for (const [infraId, d] of Object.entries(ctx.config.deploy ?? {})) {
      if (!d.go) continue;
      explicit.add(infraId);
      const to = idOf.get(d.go.replace(/^\.\//, '').replace(/\/$/, ''));
      if (!to) {
        ctx.log.warn(`go: config.deploy の ${infraId} の go: ${d.go} がパッケージにありません`);
        continue;
      }
      if (!upIds.has(infraId))
        ctx.log.debug(
          `go: config.deploy の ${infraId} がまだ上流にありません（core が判定します）`,
        );
      addEdge(infraId, to, 'deploy');
    }
    const named = new Set(Object.keys(ctx.config.deploy ?? {}));
    const lambdas = upstream.nodes.filter(
      (n) => infraType(n) === 'aws_lambda_function' && !named.has(n.id) && !explicit.has(n.id),
    );
    for (const l of lambdas) {
      let match: GoPackage | undefined;
      for (const hints of lambdaHints(l)) {
        match = entries
          .filter((p) => lambdaMatchesEntry(hints, entryName(p.dir)))
          .sort((x, y) => entryName(y.dir).length - entryName(x.dir).length)[0];
        if (match) break;
      }
      if (!match) continue;
      addEdge(l.id, idOf.get(match.dir)!, 'deploy');
      ctx.log.warn(`推定: ${l.id} → ${match.dir}（deploy で明示できます）`);
    }

    const routes = a.packages.reduce((s, p) => s + p.routes.length, 0);
    ctx.log.info(
      `go: ${a.packages.length} packages, ${routes} routes, ${edges.size} edges（module ${a.module || '?'}）`,
    );
    return { nodes, edges: [...edges.values()] };
  },
};

export default extractor;
