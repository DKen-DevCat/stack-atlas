/**
 * TS の箱の runtime（docs/17 §3.2「runtime」・D54、docs/16 §4）。import の閉包で決める:
 *
 * - `'use client'` のファイルとその import の閉包 → browser（Pages Router の page も browser の入口）
 * - App Router の server component（`'use client'` の無い page / layout）から `'use client'` を越えずにたどれる
 *   ファイル → server（静的エクスポート `output: 'export'` なら build。ビルド時に描画される）
 * - route.ts と TS のハンドラ（handlers/ ・deploy.*.handlers）の閉包 → server
 * - 画面の箱（page / layout）そのものは静的エクスポートでも browser（D54。利用者が見ているもの）
 * - どこからもたどれないファイルは決めない（upgrade の値か、置き換える v1 の箱の値が残る）
 * - 2 つ以上の runtime から使われる箱は、使う側ごとに複製する（`<id>@<runtime>`。index.ts）
 */
import { Node, type SourceFile } from 'ts-morph';
import type { Runtime } from '@stack-atlas/schema';

/** ファイルの先頭の指令（'use client' など） */
export function directives(sf: SourceFile): string[] {
  const out: string[] = [];
  for (const st of sf.getStatements()) {
    if (!Node.isExpressionStatement(st)) break;
    const e = st.getExpression();
    if (!Node.isStringLiteral(e)) break;
    out.push(e.getLiteralText());
  }
  return out;
}

export const isUseClient = (sf: SourceFile) => directives(sf).includes('use client');

/** repo の中の import 先（import と export … from） */
export function importsOf(sf: SourceFile, files: ReadonlyMap<string, SourceFile>): string[] {
  const out = new Set<string>();
  const add = (t: SourceFile | undefined) => {
    if (t && files.has(t.getFilePath())) out.add(t.getFilePath());
  };
  for (const d of sf.getImportDeclarations()) add(d.getModuleSpecifierSourceFile());
  for (const d of sf.getExportDeclarations()) add(d.getModuleSpecifierSourceFile());
  return [...out];
}

export interface RuntimeInput {
  files: ReadonlyMap<string, SourceFile>;
  /** App Router の page / layout（絶対パス） */
  appScreens: string[];
  /** Pages Router の page / layout（絶対パス） */
  pagesScreens: string[];
  /** route.ts と TS のハンドラ（絶対パス） */
  serverEntries: string[];
  /** next.config の output: 'export' */
  staticExport: boolean;
}

export interface RuntimeOfFiles {
  /** ファイル → 使われる runtime（宣言の順: browser, build / server） */
  of(file: string): Runtime[];
  /** 画面のファイルが部品を描くときの文脈の runtime（server component なら server / build） */
  screenContext(file: string): Runtime;
}

export function fileRuntimes(input: RuntimeInput): RuntimeOfFiles {
  const { files } = input;
  const imports = new Map<string, string[]>();
  const importsOfFile = (p: string) => {
    let list = imports.get(p);
    if (!list) {
      const sf = files.get(p);
      list = sf ? importsOf(sf, files) : [];
      imports.set(p, list);
    }
    return list;
  };
  const client = new Set<string>();
  for (const p of files.keys()) if (isUseClient(files.get(p)!)) client.add(p);
  const closure = (roots: Iterable<string>, stopAtClient: boolean) => {
    const seen = new Set<string>();
    const q = [...roots];
    for (let i = 0; i < q.length; i++) {
      const p = q[i]!;
      if (seen.has(p)) continue;
      if (stopAtClient && client.has(p)) continue;
      seen.add(p);
      for (const t of importsOfFile(p)) if (!seen.has(t)) q.push(t);
    }
    return seen;
  };
  const browser = closure([...client, ...input.pagesScreens], false);
  const serverComponents = input.appScreens.filter((p) => !client.has(p));
  const rendered = closure(serverComponents, true);
  const handlers = closure(input.serverEntries, false);
  const renderRt: Runtime = input.staticExport ? 'build' : 'server';
  return {
    of(file) {
      const out: Runtime[] = [];
      if (browser.has(file)) out.push('browser');
      if (rendered.has(file)) out.push(renderRt);
      if (handlers.has(file) && !out.includes('server')) out.push('server');
      return out;
    },
    screenContext(file) {
      return client.has(file) || input.pagesScreens.includes(file) ? 'browser' : renderRt;
    },
  };
}
