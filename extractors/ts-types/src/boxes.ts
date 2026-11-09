/**
 * 箱を集める（docs/17 §3.2 の表 ＋ §7 #4・#10）。ID は ts-imports / nextjs-app の規則を共有する（D47。同じ関数が
 * 2 箱にならないように）:
 *
 * | 箱 | 判定 | id |
 * |---|---|---|
 * | 画面 | Next の page / layout の default export（nextjs-app の listNextFiles） | `route:/` / `layout:/` |
 * | 部品 | ts-imports の comp（.tsx の大文字の関数で JSX がある。構文で判定） | `comp:<名前>` |
 * | hook | ts-imports の hook（`use` で始まる関数） | `hook:<名前>` |
 * | 関数 | それ以外の export された関数・アロー関数 | `fn:<名前>`（衝突は `fn:<file>~<名前>`） |
 *
 * - lib のファイルの関数で、ファイルの export がその 1 つだけで、名前がファイルの lib 名と同じもの（`lib/fetcher/index.ts`
 *   の `fetcher`）は v1 の id（`lib:fetcher`、kind helper）のまま。v1 の箱がそのまま関数の箱になる（group にしない）
 * - TS のハンドラ（ts-imports の handler）は v1 の id（`handler:<名前>`、kind fn）のまま
 * - config.classify で kind を変えたものは ts-imports の id のまま（type / schema は箱にしない）
 * - ts-imports の id が `#` を含む（衝突の退避 `comp:<path>#<名前>`）ものは v2 に入れられないので `<接頭辞>:<path>~<名前>`
 */
import { relative } from 'node:path';
import { Node, type Project, type SourceFile } from 'ts-morph';
import type { ItemV2, NodeKindV2 } from '@stack-atlas/schema';
import {
  declKey,
  functionInit,
  libName,
  statementOf,
  type TsRepoAnalysis,
} from '@stack-atlas/extractor-ts-imports';
import type { NextFile } from '@stack-atlas/extractor-nextjs-app';

/** 箱の元になる関数 */
export interface BoxSeed {
  id: string;
  kind: NodeKindV2;
  name: string;
  /** repo 相対パス */
  file: string;
  abs: string;
  line: number;
  code: string;
  /** 関数（FunctionDeclaration・ArrowFunction・FunctionExpression） */
  fn: Node;
  /** 宣言（declKey の元。FunctionDeclaration か VariableDeclaration） */
  decl: Node;
  exportName: string;
  /** 置き換える v1 の箱（ファイルの lib の箱。id と違うときだけ） */
  v1Box?: string;
  project: Project;
  sf: SourceFile;
}

/** 箱（口・項目・links はあとで埋める） */
export interface Box extends BoxSeed {
  inItems: ItemV2[];
  outItems: ItemV2[];
  /** 起動の項目（in/call・in/props・in/html）を後から足せるように、in の項目 id の集合 */
  inIds: Set<string>;
  outIds: Set<string>;
}

const KIND_V2: Record<string, NodeKindV2> = {
  component: 'component',
  hook: 'hook',
  lib: 'helper',
  handler: 'fn',
  page: 'screen',
  layout: 'screen',
};

const truncate = (text: string, lines = 20) => {
  const ls = text.split('\n');
  return ls.length > lines ? [...ls.slice(0, lines), '  // …'].join('\n') : text;
};

/** `#` を含む id（ts-imports の衝突の退避）を v2 で使える形にする */
const v2Safe = (id: string) => {
  const i = id.indexOf('#');
  return i < 0 ? id : `${id.slice(0, i)}~${id.slice(i + 1)}`;
};

const isFunctionNode = (n: Node | undefined): n is Node =>
  !!n && (Node.isFunctionDeclaration(n) || Node.isArrowFunction(n) || Node.isFunctionExpression(n));

export interface CollectInput {
  analysis: TsRepoAnalysis;
  nextFiles: NextFile[];
  /** 他の repo のアダプタが出した箱 id（fn: の衝突の判定） */
  otherIds: ReadonlySet<string>;
  repoName: string;
  multiRepo: boolean;
}

/** 箱の元を集める（ファイルの順） */
export function collectSeeds(input: CollectInput): BoxSeed[] {
  const { analysis: a } = input;
  const seeds: BoxSeed[] = [];
  const rel = (abs: string) => relative(a.root, abs).split('\\').join('/');
  const projectOf = (abs: string) => a.projectOf.get(abs)!;

  // 画面（page / layout の default export）
  for (const f of input.nextFiles) {
    if (f.kind !== 'page' && f.kind !== 'layout') continue;
    const abs = f.abs.split('\\').join('/');
    const sf = a.files.get(abs);
    if (!sf) continue;
    const decl = sf.getExportedDeclarations().get('default')?.[0];
    const fn = decl && (Node.isFunctionDeclaration(decl) ? decl : functionInit(decl));
    if (!decl || !isFunctionNode(fn)) continue;
    seeds.push({
      id: f.id,
      kind: 'screen',
      name: f.url,
      file: rel(abs),
      abs,
      line: statementOf(decl).getStartLineNumber(),
      code: truncate(statementOf(decl).getText()),
      fn,
      decl,
      exportName: 'default',
      project: projectOf(abs),
      sf,
    });
  }

  // 部品・hook・関数（ts-imports の分類と id）
  const fnSeeds: Array<{ seed: BoxSeed; candidate: string }> = [];
  for (const [abs, infos] of a.perFile) {
    const sf = a.files.get(abs)!;
    const r = rel(abs);
    const libExports = infos.filter((i) => (i.kind ?? i.category) === 'lib');
    for (const info of infos) {
      if (info.symbolKind !== 'function') continue;
      const kindV1 = info.kind ?? (info.category === 'comp' ? 'component' : info.category);
      if (kindV1 === 'type' || kindV1 === 'schema') continue;
      const fn = Node.isFunctionDeclaration(info.decl) ? info.decl : functionInit(info.decl);
      if (!isFunctionNode(fn)) continue;
      const v1 = a.nodeOfDecl.get(declKey(info.decl));
      if (!v1) continue;
      const base = {
        name: info.exportName,
        file: r,
        abs,
        line: statementOf(info.decl).getStartLineNumber(),
        code: truncate(statementOf(info.decl).getText()),
        fn,
        decl: info.decl,
        exportName: info.exportName,
        project: projectOf(abs),
        sf,
      };
      if (kindV1 !== 'lib') {
        seeds.push({ ...base, id: v2Safe(v1), kind: KIND_V2[kindV1] ?? 'helper' });
        continue;
      }
      // lib のファイルの関数: export が 1 つでファイル名と同じなら v1 の id のまま
      if (libExports.length === 1 && libName(r) === info.exportName) {
        seeds.push({ ...base, id: v2Safe(v1), kind: 'helper' });
        continue;
      }
      fnSeeds.push({
        seed: { ...base, id: '', kind: 'fn', v1Box: v2Safe(v1) },
        candidate: `fn:${info.exportName}`,
      });
    }
  }
  // fn: の衝突（同じ repo の複数ファイル、他の repo）はファイルで修飾する（D47）
  const count = new Map<string, number>();
  for (const s of fnSeeds) count.set(s.candidate, (count.get(s.candidate) ?? 0) + 1);
  const taken = new Set(seeds.map((s) => s.id));
  for (const { seed, candidate } of fnSeeds) {
    let id = candidate;
    if ((count.get(id) ?? 0) > 1 || taken.has(id) || input.otherIds.has(id)) {
      const file = input.multiRepo ? `${input.repoName}/${seed.file}` : seed.file;
      id = `fn:${file}~${seed.exportName}`;
    }
    taken.add(id);
    seeds.push({ ...seed, id });
  }
  return seeds;
}
