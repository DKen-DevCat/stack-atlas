/**
 * ts-types 抽出器（言語アダプタ。docs/17 §3.2・§7、8-2a）: ts-morph が内蔵する TypeScript の型 API で、
 * 関数の単位の箱（画面・部品・hook・関数）と口・項目・links、同じ言語の中の線（呼び出し・戻り・render）を
 * `PartialGraph.v2` に出す。v1 の nodes / edges は出さない（ts-imports が出す）。
 *
 * - 箱と id は ts-imports / nextjs-app の規則を共有する（boxes.ts。ts-imports の解析と ts-morph の Project を共有）
 * - 口・項目・links・線は body.ts、型 → 項目は model.ts、runtime は runtime.ts
 * - 2 つ以上の runtime から使われる箱は使う側ごとに複製する（`<id>@<runtime>`、`meta.sharedOf` に元の id。docs/16 §4）
 * - 関数の箱が v1 のファイルの箱（`lib:<file>`）を全部置き換えるときは `groups`（関数の箱 → v1 の箱）で知らせる。
 *   mergeV2 がその v1 の箱を group にする（D47・D53）
 * - HTTP の呼び出しは `call_n` の `meta.http` まで。endpoint への線は合流の段（core の join.ts）が引く（D49）
 * - react の型が解けないときだけ最小の stub を足す（react-stub.ts）
 */
import { relative } from 'node:path';
import { ts, type Project, type SourceFile } from 'ts-morph';
import type { ItemV2, NamedType, Runtime, WireV2 } from '@stack-atlas/schema';
import type {
  Extractor,
  PartialGraph,
  PartialGraphV2,
  PartialNodeV2,
  RepoContext,
} from '@stack-atlas/core';
import { sectionFor } from '@stack-atlas/core';
import {
  analyzeTsRepo,
  declKey,
  tsconfigPaths,
  type TsRepoAnalysis,
} from '@stack-atlas/extractor-ts-imports';
import { findNextDirs, listNextFiles, readNextOutput } from '@stack-atlas/extractor-nextjs-app';
import {
  constResolverFor,
  detectWrappers,
  type ConstResolver,
} from '@stack-atlas/extractor-api-link';
import { collectSeeds, type Box } from './boxes.js';
import { buildCalls, buildLinks, buildPorts, type BuildContext, type BoxState } from './body.js';
import { countItems, type TypeEnv } from './model.js';
import { REACT_STUB_PATH, ensureReactTypes } from './react-stub.js';
import { fileRuntimes } from './runtime.js';

export { REACT_STUB, REACT_STUB_PATH, ensureReactTypes } from './react-stub.js';
export { fileRuntimes, isUseClient, directives } from './runtime.js';
export { itemId, wireTypeOf, makeItem } from './model.js';

export const NAME = 'ts-types';

/** 展開の深さと 1 箱の項目の上限の既定（docs/17 §3.2「上限」） */
export const DEFAULT_DEPTH = 2;
export const DEFAULT_MAX_ITEMS = 200;

const toPosix = (p: string) => p.split('\\').join('/');

/** tsconfig の extends が解けないとき（node_modules の共有設定など）は paths が黙って消えるので警告する（§7 #10） */
function warnUnresolvedExtends(ctx: RepoContext) {
  for (const tc of tsconfigPaths(ctx)) {
    const path = ctx.resolve(tc);
    const raw = ts.readConfigFile(path, ts.sys.readFile);
    const ext = (raw.config as { extends?: unknown } | undefined)?.extends;
    const list = typeof ext === 'string' ? [ext] : Array.isArray(ext) ? ext : [];
    if (!list.length) continue;
    const parsed = ts.getParsedCommandLineOfConfigFile(
      path,
      {},
      {
        ...ts.sys,
        onUnRecoverableConfigFileDiagnostic: () => {},
      },
    );
    const missing = (parsed?.errors ?? []).filter((d) => {
      const text = ts.flattenDiagnosticMessageText(d.messageText, ' ');
      return list.some((e) => typeof e === 'string' && text.includes(e));
    });
    if (missing.length)
      ctx.log.warn(
        `ts-types: ${tc} の extends（${list.join(', ')}）を解けません。共有の tsconfig にある paths などが効かず、import が解けない所があります（node_modules を入れて build してください）`,
      );
  }
}

export const extractor: Extractor = {
  name: NAME,
  async detect(ctx) {
    if (ctx.config.ts?.repo && !sectionFor(ctx, ctx.config.ts)) return false;
    return tsconfigPaths(ctx).length > 0;
  },
  async extract(ctx, upstream): Promise<PartialGraph> {
    const started = performance.now();
    const a = analyzeTsRepo(ctx, upstream);
    if (!a.files.size) return { nodes: [], edges: [] };
    const v2 = buildV2(ctx, upstream, a);
    const items = v2.nodes.reduce(
      (acc, n) => acc + n.ports.reduce((x, p) => x + countItems(p.items), 0),
      0,
    );
    const links = v2.nodes.flatMap((n) => n.links ?? []);
    ctx.log.info(
      `ts-types: 箱 ${v2.nodes.length}、項目 ${items}、線 ${v2.wires.length}、links ${links.length}` +
        `（exact ${links.filter((l) => l.confidence === 'exact').length} / crude ${links.filter((l) => l.confidence === 'crude').length}）` +
        `、${Math.round(performance.now() - started)}ms`,
    );
    return { nodes: [], edges: [], v2 };
  },
};

export default extractor;

/** out の項目の順: 呼び出し・描画（出現位置の順）、参照の `_`、戻り値（docs/16 §5 の例と同じく最後） */
const outOrder = (items: ItemV2[]) => [
  ...items.filter((i) => i.id !== 'return' && i.id !== '_'),
  ...items.filter((i) => i.id === '_'),
  ...items.filter((i) => i.id === 'return'),
];

/** ts-types の v2 の部分グラフを作る（テストから直接呼べるように extract から分けた） */
export function buildV2(
  ctx: RepoContext,
  upstream: Readonly<PartialGraph>,
  a: TsRepoAnalysis = analyzeTsRepo(ctx, upstream),
): PartialGraphV2 {
  warnUnresolvedExtends(ctx);
  const depth = ctx.config.adapters?.depth ?? DEFAULT_DEPTH;
  const maxItems = ctx.config.adapters?.maxItems ?? DEFAULT_MAX_ITEMS;
  const multiRepo = Object.keys(ctx.repos ?? {}).length > 1;

  // react の型（解けない Project にだけ stub を足す）
  for (const p of a.projects) {
    const files = [...a.files.keys()].filter((f) => a.projectOf.get(f) === p.project);
    if (ensureReactTypes(p.project, files))
      ctx.log.info(`ts-types: react の型が解けないので最小の stub を足します（${p.tsconfig}）`);
  }

  const dirs = findNextDirs(ctx.root, sectionFor(ctx, ctx.config.next) ?? {});
  const nextFiles = listNextFiles(ctx.root, dirs).files;
  const staticExport = readNextOutput(ctx.root, dirs) === 'export';

  const otherIds = new Set((upstream.v2?.nodes ?? []).map((n) => n.id));
  const seeds = collectSeeds({
    analysis: a,
    nextFiles,
    otherIds,
    repoName: ctx.repoName,
    multiRepo,
  });
  const boxes: Box[] = seeds.map((s) => ({
    ...s,
    inItems: [],
    outItems: [],
    inIds: new Set(),
    outIds: new Set(),
  }));
  const boxByKey = new Map(boxes.map((b) => [declKey(b.decl), b]));
  const boxById = new Map(boxes.map((b) => [b.id, b]));

  // 型の環境（Project ごとに checker が違う）
  const named = new Map<string, NamedType>();
  const envs = new Map<Project, TypeEnv>();
  const root = a.root;
  const envOf = (project: Project): TypeEnv => {
    let env = envs.get(project);
    if (!env) {
      env = {
        checker: project.getTypeChecker().compilerObject,
        inRepo: (f) => {
          const p = toPosix(f);
          if (p === REACT_STUB_PATH) return false;
          const r = toPosix(relative(root, p));
          return !r.startsWith('..') && !r.split('/').includes('node_modules');
        },
        rel: (f) => toPosix(relative(root, f)),
        depth,
        named,
      };
      envs.set(project, env);
    }
    return env;
  };

  // HTTP の呼び出し: api-link と同じラッパー検出と文字列定数
  const callers = sectionFor(ctx, ctx.config.api)?.callers ?? [];
  const wrappers = detectWrappers([...a.files.values()], callers);
  const constCache = new Map<SourceFile, Map<string, string>>();
  const resolvers = new Map<SourceFile, ConstResolver>();
  const resolverOf = (sf: SourceFile) => {
    let r = resolvers.get(sf);
    if (!r) {
      r = constResolverFor(
        sf,
        (spec, from) =>
          from
            .getImportDeclarations()
            .find((d) => d.getModuleSpecifierValue() === spec)
            ?.getModuleSpecifierSourceFile(),
        constCache,
      );
      resolvers.set(sf, r);
    }
    return r;
  };

  // phase A: 引数・戻り値。B1: 呼び出し・描画・参照と線。B2: links（呼び先に足した起動の項目も見る）
  const wires: WireV2[] = [];
  const bctx: BuildContext = {
    boxByKey,
    boxById,
    v1ByKey: a.nodeOfDecl,
    v1Kind: (id) => a.nodes.get(id)?.kind,
    wrappers,
    resolverOf,
    wires,
    maxItems,
    warn: (m) => ctx.log.warn(m),
  };
  const states: BoxState[] = boxes.map((b) => buildPorts(b, envOf(b.project), maxItems));
  for (const st of states) buildCalls(st, bctx);
  const linksOf = new Map(states.map((st) => [st.box.id, buildLinks(st)]));

  // runtime（import の閉包。D54）
  const runtimes = fileRuntimes({
    files: a.files,
    appScreens: nextFiles
      .filter((f) => f.router === 'app' && (f.kind === 'page' || f.kind === 'layout'))
      .map((f) => toPosix(f.abs)),
    pagesScreens: nextFiles
      .filter((f) => f.router === 'pages' && f.kind !== 'handler')
      .map((f) => toPosix(f.abs)),
    serverEntries: [
      ...nextFiles.filter((f) => f.kind === 'handler').map((f) => toPosix(f.abs)),
      ...[...a.nodes.values()]
        .filter((n) => n.kind === 'handler')
        .map((n) => toPosix(ctx.resolve(n.file))),
    ],
    staticExport,
  });
  const runtimeOf = (b: Box): Runtime[] => (b.kind === 'screen' ? ['browser'] : runtimes.of(b.abs));
  /** 呼ぶ側の文脈の runtime（画面は server component なら server / build） */
  const contextOf = (b: Box): Runtime | undefined =>
    b.kind === 'screen' ? runtimes.screenContext(b.abs) : runtimeOf(b)[0];

  // 複製（2 つ以上の runtime から使われる箱）
  const copies = new Map<string, Array<{ id: string; runtime?: Runtime }>>();
  for (const b of boxes) {
    const rts = runtimeOf(b);
    copies.set(
      b.id,
      rts.length > 1
        ? rts.map((rt) => ({ id: `${b.id}@${rt}`, runtime: rt }))
        : [{ id: b.id, ...(rts[0] ? { runtime: rts[0] } : {}) }],
    );
  }
  const boxOfRef = (ref: string) => boxById.get(ref.slice(0, ref.indexOf('#')));
  const withBox = (ref: string, id: string) => `${id}${ref.slice(ref.indexOf('#'))}`;
  const outWires: WireV2[] = [];
  const seen = new Set<string>();
  const push = (w: WireV2) => {
    const k = `${w.from}\u0000${w.to}`;
    if (seen.has(k)) return;
    seen.add(k);
    outWires.push(w);
  };
  for (const w of wires) {
    const fb = boxOfRef(w.from);
    const tb = boxOfRef(w.to);
    const fc = fb ? copies.get(fb.id)! : [];
    const tc = tb ? copies.get(tb.id)! : [];
    if (fc.length <= 1 && tc.length <= 1) {
      push({
        ...w,
        ...(fb ? { from: withBox(w.from, fc[0]!.id) } : {}),
        ...(tb ? { to: withBox(w.to, tc[0]!.id) } : {}),
      });
      continue;
    }
    // 呼ぶ側（行きの線は from、戻りは to）の複製ごとに、呼ばれる側の同じ runtime の複製へ
    const callerBox = w.reply ? tb : fb;
    const calleeBox = w.reply ? fb : tb;
    const callerCopies = callerBox ? copies.get(callerBox.id)! : [{ id: '' }];
    for (const cc of callerCopies) {
      // 画面は自分の runtime（browser）ではなく、描く文脈（server component なら server / build）で選ぶ
      const rt =
        callerBox?.kind === 'screen'
          ? contextOf(callerBox)
          : (cc.runtime ?? (callerBox ? contextOf(callerBox) : undefined));
      const list = calleeBox ? copies.get(calleeBox.id)! : [{ id: '' }];
      const targets = calleeBox ? [list.find((x) => x.runtime === rt) ?? list[0]!] : [{ id: '' }];
      for (const t of targets) {
        const callerRef = (ref: string) => (callerBox ? withBox(ref, cc.id) : ref);
        const calleeRef = (ref: string) => (calleeBox ? withBox(ref, t.id) : ref);
        push(
          w.reply
            ? { ...w, from: calleeRef(w.from), to: callerRef(w.to) }
            : { ...w, from: callerRef(w.from), to: calleeRef(w.to) },
        );
      }
    }
  }

  // v1 のファイルの箱（lib）を全部置き換える関数の箱 → groups
  const coveredBy = new Map<string, Box[]>();
  for (const b of boxes)
    if (b.v1Box) coveredBy.set(b.v1Box, [...(coveredBy.get(b.v1Box) ?? []), b]);
  const fullyCovered = new Set<string>();
  for (const [v1, members] of coveredBy) {
    const exports = a.nodes.get(v1)?.exportNames ?? [];
    const names = new Set(members.map((m) => m.exportName));
    if (exports.length && exports.every((e) => names.has(e))) fullyCovered.add(v1);
  }

  const nodes: PartialNodeV2[] = [];
  const groups: Record<string, string> = {};
  for (const b of boxes) {
    const list = copies.get(b.id)!;
    const shared = list.length > 1;
    for (const cp of list) {
      const ports = [
        { id: 'in', dir: 'in' as const, items: structuredClone(b.inItems) },
        { id: 'out', dir: 'out' as const, items: structuredClone(outOrder(b.outItems)) },
      ].filter((p) => p.items.length);
      const links = linksOf.get(b.id) ?? [];
      const node: PartialNodeV2 = {
        id: cp.id,
        kind: b.kind,
        name: b.name,
        ...(cp.runtime ? { runtime: cp.runtime } : {}),
        file: b.file,
        line: b.line,
        code: b.code,
        ports,
        ...(links.length ? { links: structuredClone(links) } : {}),
        meta: {
          extractors: [NAME],
          ts: { exportName: b.exportName, symbolKind: 'function' },
          ...(shared ? { sharedOf: b.id } : {}),
        },
      };
      nodes.push(node);
      if (b.v1Box && fullyCovered.has(b.v1Box)) groups[cp.id] = b.v1Box;
      else if (shared) groups[cp.id] = b.id;
    }
  }
  const out: PartialGraphV2 = { nodes, wires: outWires };
  if (named.size) out.types = [...named.values()];
  if (Object.keys(groups).length) out.groups = groups;
  return out;
}
