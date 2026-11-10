/**
 * 言語の判定の表（Phase 9-L0。docs/23 §3.1、D170・D171）。拡張子・ファイル名・shebang → 言語と種類（source / config /
 * doc / asset）。表に無いものは `other`（数えるが、読めた・読めないの判定はしない）。
 *
 * 言語を足すのは表に 1 行足すことで、判定のコードは言語の名前を知らない（D170）。種類の決め方:
 * - source: 関数・型・呼び出しを持つコード（段 1 の構文で読む対象。読めないと strict の警告。9-L1 からエラー）
 * - config: 構成・契約・マニフェスト（YAML・JSON・plist・Dockerfile・Package.swift・OpenAPI など。報告の formats に出す）
 * - doc: 文書（Markdown・テキスト・LICENSE）
 * - asset: コードでない資産（画像・フォント・音声・スタイル・マークアップ・データ）。HTML と CSS もここ（関数の箱を持たない）
 */

import { globToRegExp } from './util.js';

export type FileCategory = 'source' | 'config' | 'doc' | 'asset';

export interface LanguageEntry {
  /** 言語・形式の名前（小文字。報告の `language` / `format`） */
  language: string;
  category: FileCategory;
  /** 拡張子（`.` 付き、小文字で比べる） */
  ext?: readonly string[];
  /** ファイル名そのもの（大文字小文字を区別しない） */
  names?: readonly string[];
  /** ファイル名の先頭（`Dockerfile.dev` など。大文字小文字を区別しない） */
  prefixes?: readonly string[];
  /** shebang のインタプリタ（`#!/usr/bin/env python3` → `python`。末尾の版の数字は外して比べる） */
  interpreters?: readonly string[];
  /** 今の抽出器が設定で読める言語なら、読めていないときのヒント（報告の unread の why） */
  hint?: string;
  /** テストのファイルの名前の規約（ファイル名の glob。合えば報告の test に数え、読めていなくても警告しない） */
  tests?: readonly string[];
}

/**
 * どの言語でもテストの置き場とみなすディレクトリ（段の名前と完全一致。2026-11-11 Phase 9-L0 のレビュー）。
 * Go の testdata と依存の vendor は数える範囲から除く（coverage.ts の GENERATED_DIRS）
 */
export const TEST_DIRS: readonly string[] = [
  '__tests__',
  '__mocks__',
  'test',
  'tests',
  'Tests',
  'spec',
  'specs',
  'e2e',
];

/** 判定の表（データ）。上の行が先に当たる（ファイル名 → 先頭 → 拡張子 → shebang の順に引く） */
export const LANGUAGE_TABLE: readonly LanguageEntry[] = [
  // --- source: Web・JS 系
  {
    language: 'typescript',
    category: 'source',
    ext: ['.ts', '.tsx', '.mts', '.cts'],
    interpreters: ['ts-node', 'tsx', 'deno', 'bun'],
    hint: 'ts.tsconfig の tsconfig の include・files に入っていない',
    tests: ['*.{test,spec}.{ts,tsx,mts,cts}'],
  },
  {
    language: 'javascript',
    category: 'source',
    ext: ['.js', '.jsx', '.mjs', '.cjs'],
    interpreters: ['node', 'nodejs'],
    hint: 'allowJs の tsconfig（ts.tsconfig）に入っていない',
    tests: ['*.{test,spec}.{js,jsx,mjs,cjs}'],
  },
  { language: 'svelte', category: 'source', ext: ['.svelte'] },
  { language: 'vue', category: 'source', ext: ['.vue'] },
  { language: 'astro', category: 'source', ext: ['.astro'] },
  { language: 'coffeescript', category: 'source', ext: ['.coffee'] },
  { language: 'elm', category: 'source', ext: ['.elm'] },
  { language: 'purescript', category: 'source', ext: ['.purs'] },
  // --- source: Apple・JVM・.NET
  {
    language: 'swift',
    category: 'source',
    ext: ['.swift'],
    interpreters: ['swift'],
    tests: ['*Tests.swift', '*Test.swift'],
  },
  { language: 'objective-c', category: 'source', ext: ['.m'] },
  { language: 'objective-cpp', category: 'source', ext: ['.mm'] },
  {
    language: 'kotlin',
    category: 'source',
    ext: ['.kt', '.kts'],
    tests: ['*Test.kt', '*Tests.kt'],
  },
  {
    language: 'java',
    category: 'source',
    ext: ['.java'],
    tests: ['*Test.java', '*Tests.java', '*IT.java'],
  },
  {
    language: 'scala',
    category: 'source',
    ext: ['.scala', '.sc'],
    tests: ['*Spec.scala', '*Test.scala', '*Suite.scala'],
  },
  {
    language: 'groovy',
    category: 'source',
    ext: ['.groovy'],
    names: ['Jenkinsfile'],
    interpreters: ['groovy'],
  },
  { language: 'clojure', category: 'source', ext: ['.clj', '.cljs', '.cljc'] },
  {
    language: 'csharp',
    category: 'source',
    ext: ['.cs', '.csx'],
    tests: ['*Tests.cs', '*Test.cs'],
  },
  { language: 'fsharp', category: 'source', ext: ['.fs', '.fsx', '.fsi'] },
  { language: 'visual-basic', category: 'source', ext: ['.vb'] },
  // --- source: システム
  {
    language: 'go',
    category: 'source',
    ext: ['.go'],
    hint: 'go 抽出器の対象外（go.mod のあるディレクトリを repo にする。_test.go と _・. で始まるディレクトリは読まない）',
    tests: ['*_test.go'],
  },
  { language: 'rust', category: 'source', ext: ['.rs'] },
  { language: 'c', category: 'source', ext: ['.c', '.h'], tests: ['*_test.c'] },
  {
    language: 'cpp',
    category: 'source',
    ext: ['.cc', '.cpp', '.cxx', '.c++', '.hh', '.hpp', '.hxx', '.ino'],
    tests: ['*_test.{cc,cpp}', '*_unittest.{cc,cpp}'],
  },
  { language: 'zig', category: 'source', ext: ['.zig'] },
  { language: 'nim', category: 'source', ext: ['.nim'] },
  { language: 'd', category: 'source', ext: ['.di'] },
  { language: 'assembly', category: 'source', ext: ['.s', '.asm'] },
  { language: 'cuda', category: 'source', ext: ['.cu', '.cuh'] },
  { language: 'glsl', category: 'source', ext: ['.glsl', '.vert', '.frag', '.comp'] },
  { language: 'metal', category: 'source', ext: ['.metal'] },
  { language: 'solidity', category: 'source', ext: ['.sol'] },
  { language: 'fortran', category: 'source', ext: ['.f90', '.f95', '.f03', '.for'] },
  { language: 'pascal', category: 'source', ext: ['.pas'] },
  { language: 'ada', category: 'source', ext: ['.adb', '.ads'] },
  // --- source: スクリプト
  {
    language: 'python',
    category: 'source',
    ext: ['.py', '.pyi', '.pyw'],
    interpreters: ['python', 'pypy'],
    tests: ['test_*.py', '*_test.py', 'conftest.py'],
  },
  { language: 'jupyter', category: 'source', ext: ['.ipynb'] },
  {
    language: 'ruby',
    category: 'source',
    ext: ['.rb', '.rake', '.gemspec'],
    names: ['Rakefile', 'Vagrantfile'],
    interpreters: ['ruby'],
    tests: ['*_spec.rb', '*_test.rb'],
  },
  {
    language: 'php',
    category: 'source',
    ext: ['.php', '.phtml'],
    interpreters: ['php'],
    tests: ['*Test.php'],
  },
  { language: 'perl', category: 'source', ext: ['.pl', '.pm'], interpreters: ['perl'] },
  {
    language: 'lua',
    category: 'source',
    ext: ['.lua'],
    interpreters: ['lua', 'luajit'],
    tests: ['*_spec.lua'],
  },
  { language: 'r', category: 'source', ext: ['.r'], interpreters: ['rscript'] },
  { language: 'julia', category: 'source', ext: ['.jl'], interpreters: ['julia'] },
  { language: 'dart', category: 'source', ext: ['.dart'], tests: ['*_test.dart'] },
  {
    language: 'elixir',
    category: 'source',
    ext: ['.ex', '.exs'],
    interpreters: ['elixir'],
    tests: ['*_test.exs'],
  },
  { language: 'erlang', category: 'source', ext: ['.erl', '.hrl'], interpreters: ['escript'] },
  {
    language: 'haskell',
    category: 'source',
    ext: ['.hs', '.lhs'],
    interpreters: ['runhaskell'],
    tests: ['*Spec.hs'],
  },
  { language: 'ocaml', category: 'source', ext: ['.ml', '.mli'] },
  { language: 'crystal', category: 'source', ext: ['.cr'] },
  { language: 'tcl', category: 'source', ext: ['.tcl'], interpreters: ['tclsh'] },
  { language: 'awk', category: 'source', ext: ['.awk'], interpreters: ['awk', 'gawk'] },
  {
    language: 'shell',
    category: 'source',
    ext: ['.sh', '.bash', '.zsh', '.ksh', '.command'],
    interpreters: ['sh', 'bash', 'zsh', 'dash', 'ksh'],
  },
  { language: 'fish', category: 'source', ext: ['.fish'], interpreters: ['fish'] },
  {
    language: 'powershell',
    category: 'source',
    ext: ['.ps1', '.psm1'],
    interpreters: ['pwsh', 'powershell'],
  },
  { language: 'batch', category: 'source', ext: ['.bat', '.cmd'] },
  {
    language: 'applescript',
    category: 'source',
    ext: ['.applescript'],
    interpreters: ['osascript'],
  },
  { language: 'vim-script', category: 'source', ext: ['.vim'] },
  { language: 'emacs-lisp', category: 'source', ext: ['.el'] },
  { language: 'common-lisp', category: 'source', ext: ['.lisp'] },
  { language: 'nix', category: 'source', ext: ['.nix'] },
  // --- source: データ・IaC の言語
  { language: 'sql', category: 'source', ext: ['.sql'], hint: 'sql.migrations の glob に合わない' },
  {
    language: 'terraform',
    category: 'source',
    ext: ['.tf', '.hcl'],
    hint: 'terraform.root から module で辿れない',
  },

  // --- config: マニフェスト（ファイル名で当てる。拡張子より先に引く）
  { language: 'swiftpm', category: 'config', names: ['Package.swift', 'Package.resolved'] },
  { language: 'npm', category: 'config', names: ['package.json'] },
  {
    language: 'lockfile',
    category: 'config',
    names: [
      'package-lock.json',
      'pnpm-lock.yaml',
      'yarn.lock',
      'bun.lockb',
      'Cargo.lock',
      'Gemfile.lock',
      'Podfile.lock',
      'poetry.lock',
      'uv.lock',
      'composer.lock',
      'go.sum',
    ],
  },
  { language: 'go-mod', category: 'config', names: ['go.mod', 'go.work'] },
  { language: 'cargo', category: 'config', names: ['Cargo.toml'] },
  {
    language: 'pyproject',
    category: 'config',
    names: ['pyproject.toml', 'setup.cfg', 'requirements.txt', 'Pipfile'],
  },
  { language: 'gemfile', category: 'config', names: ['Gemfile', 'Brewfile'] },
  { language: 'podfile', category: 'config', names: ['Podfile', 'Cartfile'] },
  { language: 'gradle', category: 'config', ext: ['.gradle'] },
  {
    language: 'dockerfile',
    category: 'config',
    ext: ['.dockerfile'],
    names: ['Dockerfile', 'Containerfile'],
    prefixes: ['Dockerfile.', 'Containerfile.'],
  },
  {
    language: 'compose',
    category: 'config',
    names: ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml'],
  },
  {
    language: 'makefile',
    category: 'config',
    ext: ['.mk', '.mak'],
    names: ['Makefile', 'GNUmakefile', 'makefile', 'justfile'],
  },
  { language: 'cmake', category: 'config', ext: ['.cmake'], names: ['CMakeLists.txt'] },
  { language: 'bazel', category: 'config', ext: ['.bzl', '.bazel'], names: ['BUILD', 'WORKSPACE'] },
  { language: 'procfile', category: 'config', names: ['Procfile'] },
  // --- config: 形式（拡張子）
  { language: 'json', category: 'config', ext: ['.json', '.jsonc', '.json5', '.webmanifest'] },
  { language: 'yaml', category: 'config', ext: ['.yaml', '.yml'] },
  { language: 'toml', category: 'config', ext: ['.toml'] },
  {
    language: 'xml',
    category: 'config',
    ext: ['.xml', '.xsd', '.xcscheme', '.xcworkspacedata', '.xcsettings'],
  },
  { language: 'plist', category: 'config', ext: ['.plist', '.entitlements'] },
  { language: 'pbxproj', category: 'config', ext: ['.pbxproj'] },
  { language: 'xcconfig', category: 'config', ext: ['.xcconfig'] },
  { language: 'interface-builder', category: 'config', ext: ['.storyboard', '.xib'] },
  { language: 'strings', category: 'config', ext: ['.strings', '.stringsdict', '.xcstrings'] },
  { language: 'tfvars', category: 'config', ext: ['.tfvars'] },
  { language: 'ini', category: 'config', ext: ['.ini', '.cfg', '.conf', '.properties'] },
  { language: 'graphql', category: 'config', ext: ['.graphql', '.gql'] },
  { language: 'protobuf', category: 'config', ext: ['.proto'] },
  { language: 'jsonnet', category: 'config', ext: ['.jsonnet', '.libsonnet'] },
  { language: 'edn', category: 'config', ext: ['.edn'] },

  // --- doc
  { language: 'markdown', category: 'doc', ext: ['.md', '.mdx', '.markdown'] },
  {
    language: 'text',
    category: 'doc',
    ext: ['.txt', '.rst', '.adoc', '.org', '.tex'],
    names: [
      'LICENSE',
      'LICENCE',
      'COPYING',
      'NOTICE',
      'AUTHORS',
      'CHANGELOG',
      'README',
      'CODEOWNERS',
    ],
  },

  // --- asset: マークアップ・スタイル（関数の箱を持たない）
  { language: 'html', category: 'asset', ext: ['.html', '.htm', '.xhtml'] },
  {
    language: 'css',
    category: 'asset',
    ext: ['.css', '.scss', '.sass', '.less', '.styl', '.pcss'],
  },
  // --- asset: 画像・フォント・音声・動画・データ・まとめたもの
  {
    language: 'image',
    category: 'asset',
    ext: [
      '.png',
      '.jpg',
      '.jpeg',
      '.gif',
      '.svg',
      '.webp',
      '.ico',
      '.icns',
      '.bmp',
      '.tif',
      '.tiff',
      '.avif',
      '.heic',
      '.psd',
      '.sketch',
      '.fig',
    ],
  },
  { language: 'font', category: 'asset', ext: ['.woff', '.woff2', '.ttf', '.otf', '.eot'] },
  {
    language: 'media',
    category: 'asset',
    ext: ['.mp3', '.wav', '.aac', '.m4a', '.ogg', '.flac', '.mp4', '.mov', '.webm', '.m4v', '.caf'],
  },
  {
    language: 'document',
    category: 'asset',
    ext: ['.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.key', '.numbers', '.pages'],
  },
  {
    language: 'data',
    category: 'asset',
    ext: ['.csv', '.tsv', '.parquet', '.sqlite', '.db', '.ndjson', '.jsonl'],
  },
  {
    language: 'archive',
    category: 'asset',
    ext: [
      '.zip',
      '.tar',
      '.gz',
      '.tgz',
      '.bz2',
      '.xz',
      '.7z',
      '.jar',
      '.war',
      '.ipa',
      '.apk',
      '.dmg',
    ],
  },
];

/** 判定の結果。表に無いものは `{ language: 'other', category: 'other' }` */
export interface DetectedLanguage {
  language: string;
  category: FileCategory | 'other';
}

export const OTHER: DetectedLanguage = Object.freeze({ language: 'other', category: 'other' });

interface Index {
  names: Map<string, LanguageEntry>;
  prefixes: Array<[string, LanguageEntry]>;
  ext: Map<string, LanguageEntry>;
  interpreters: Map<string, LanguageEntry>;
}

let index: Index | undefined;
function buildIndex(): Index {
  const ix: Index = { names: new Map(), prefixes: [], ext: new Map(), interpreters: new Map() };
  for (const e of LANGUAGE_TABLE) {
    for (const n of e.names ?? [])
      if (!ix.names.has(n.toLowerCase())) ix.names.set(n.toLowerCase(), e);
    for (const p of e.prefixes ?? []) ix.prefixes.push([p.toLowerCase(), e]);
    for (const x of e.ext ?? []) if (!ix.ext.has(x.toLowerCase())) ix.ext.set(x.toLowerCase(), e);
    for (const i of e.interpreters ?? []) if (!ix.interpreters.has(i)) ix.interpreters.set(i, e);
  }
  return ix;
}

/** ファイル名の拡張子（`.d.ts` は `.ts`、`a.auto.tfvars` は `.tfvars`）。無ければ空 */
export function extOf(base: string): string {
  const i = base.lastIndexOf('.');
  return i > 0 ? base.slice(i).toLowerCase() : '';
}

/**
 * shebang（先頭行の `#!`）のインタプリタ。`#!/usr/bin/env -S python3 -u` → `python`、`#!/bin/bash` → `bash`。
 * 末尾の版の数字（`python3.11`）は外す
 */
export function shebangInterpreter(firstLine: string): string | undefined {
  if (!firstLine.startsWith('#!')) return undefined;
  const words = firstLine.slice(2).trim().split(/\s+/);
  let cmd = words[0];
  if (!cmd) return undefined;
  if (cmd.endsWith('/env') || cmd === 'env') cmd = words.slice(1).find((w) => !w.startsWith('-'));
  if (!cmd) return undefined;
  const base = cmd.split('/').pop()!.toLowerCase();
  return base.replace(/[\d.]+$/, '') || base;
}

/**
 * パス（repo 相対、`/` 区切り）の言語と種類。ファイル名 → ファイル名の先頭 → 拡張子 → shebang（firstLine を渡したとき。
 * 拡張子が表に無いファイルだけ）の順に引く
 */
export function detectLanguage(path: string, firstLine?: string): DetectedLanguage {
  const ix = (index ??= buildIndex());
  const base = path.slice(path.lastIndexOf('/') + 1);
  const lower = base.toLowerCase();
  const byName = ix.names.get(lower);
  if (byName) return { language: byName.language, category: byName.category };
  for (const [p, e] of ix.prefixes)
    if (lower.startsWith(p)) return { language: e.language, category: e.category };
  const byExt = ix.ext.get(extOf(base));
  if (byExt) return { language: byExt.language, category: byExt.category };
  if (firstLine !== undefined) {
    const interp = shebangInterpreter(firstLine);
    const e = interp ? ix.interpreters.get(interp) : undefined;
    if (e) return { language: e.language, category: e.category };
  }
  return OTHER;
}

const testRes = new Map<string, RegExp[]>();
const TEST_DIR_SET = new Set(TEST_DIRS);

/** path（repo 相対）がテストのファイルか: 言語の名前の規約に合うか、途中の段が TEST_DIRS のどれか */
export function isTestFile(path: string, language: string): boolean {
  const segs = path.split('/');
  if (segs.slice(0, -1).some((d) => TEST_DIR_SET.has(d))) return true;
  let res = testRes.get(language);
  if (!res) {
    res = LANGUAGE_TABLE.filter((e) => e.language === language)
      .flatMap((e) => e.tests ?? [])
      .map((g) => globToRegExp(g));
    testRes.set(language, res);
  }
  const base = segs[segs.length - 1] ?? '';
  return res.some((re) => re.test(base));
}

/** 読めていないときのヒント（今の抽出器が設定で読める言語だけ） */
export function languageHint(language: string): string | undefined {
  return LANGUAGE_TABLE.find((e) => e.language === language && e.hint)?.hint;
}

/** 表の言語の名前（重複なし、表の順） */
export function knownLanguages(category?: FileCategory): string[] {
  return [
    ...new Set(
      LANGUAGE_TABLE.filter((e) => !category || e.category === category).map((e) => e.language),
    ),
  ];
}
