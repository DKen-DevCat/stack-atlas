// 段 0（Phase 9-L0。docs/23 §3.1、D171）: 言語の判定の表・数える範囲（walk と git）・「読んだ」・報告の決定性・strict
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  attributesFor,
  computeCoverage,
  countLines,
  coverageIssues,
  emptyGraphText,
  formatCoverage,
  hasGeneratedHeader,
  isMinified,
  parseGitattributes,
  scanRepoScope,
  unreadText,
  type CoverageInput,
  type RepoScope,
} from '../coverage.js';
import {
  detectLanguage,
  knownLanguages,
  LANGUAGE_TABLE,
  shebangInterpreter,
} from '../languages.js';
import { mergePartialGraphs } from '../merge.js';
import { buildGraph } from '../pipeline.js';
import { prefixRepoFiles } from '../repo.js';
import { strictIssues, toGraphReport } from '../strict.js';
import type { Extractor, PartialGraph } from '../types.js';

const tmp = () => realpathSync(mkdtempSync(join(tmpdir(), 'stack-atlas-cov-')));
function put(root: string, files: Record<string, string | Buffer>) {
  for (const [p, c] of Object.entries(files)) {
    mkdirSync(dirname(join(root, p)), { recursive: true });
    writeFileSync(join(root, p), c);
  }
}
const hasGit = (() => {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();
const git = (root: string, ...args: string[]) =>
  execFileSync('git', args, { cwd: root, stdio: 'ignore' });
const paths = (s: RepoScope) => s.files.map((f) => f.path);

describe('言語の判定の表（データ）', () => {
  it('拡張子・ファイル名・先頭・shebang の順に引き、表に無いものは other', () => {
    const cases: Array<[string, string, string]> = [
      ['Sources/App/Main.swift', 'swift', 'source'],
      ['a/b.py', 'python', 'source'],
      ['run.sh', 'shell', 'source'],
      ['x.ts', 'typescript', 'source'],
      ['x.d.ts', 'typescript', 'source'],
      ['x.tsx', 'typescript', 'source'],
      ['x.jsx', 'javascript', 'source'],
      ['x.mjs', 'javascript', 'source'],
      ['x.cjs', 'javascript', 'source'],
      ['C.svelte', 'svelte', 'source'],
      ['C.vue', 'vue', 'source'],
      ['M.kt', 'kotlin', 'source'],
      ['M.java', 'java', 'source'],
      ['m.go', 'go', 'source'],
      ['m.rs', 'rust', 'source'],
      ['m.c', 'c', 'source'],
      ['m.cpp', 'cpp', 'source'],
      ['m.m', 'objective-c', 'source'],
      ['m.cs', 'csharp', 'source'],
      ['m.php', 'php', 'source'],
      ['m.rb', 'ruby', 'source'],
      ['m.dart', 'dart', 'source'],
      ['m.lua', 'lua', 'source'],
      ['m.scala', 'scala', 'source'],
      ['m.ex', 'elixir', 'source'],
      ['m.hs', 'haskell', 'source'],
      ['m.sql', 'sql', 'source'],
      ['main.tf', 'terraform', 'source'],
      ['dev.tfvars', 'tfvars', 'config'],
      ['a.yaml', 'yaml', 'config'],
      ['a.json', 'json', 'config'],
      ['Cargo.toml', 'cargo', 'config'],
      ['a.toml', 'toml', 'config'],
      ['com.x.agent.plist', 'plist', 'config'],
      ['App.xcodeproj/project.pbxproj', 'pbxproj', 'config'],
      ['Package.swift', 'swiftpm', 'config'],
      ['Dockerfile', 'dockerfile', 'config'],
      ['Dockerfile.dev', 'dockerfile', 'config'],
      ['Makefile', 'makefile', 'config'],
      ['package.json', 'npm', 'config'],
      ['go.mod', 'go-mod', 'config'],
      ['README.md', 'markdown', 'doc'],
      ['LICENSE', 'text', 'doc'],
      ['index.html', 'html', 'asset'],
      ['a.scss', 'css', 'asset'],
      ['logo.png', 'image', 'asset'],
      ['f.woff2', 'font', 'asset'],
    ];
    for (const [p, language, category] of cases)
      expect(detectLanguage(p), p).toEqual({ language, category });
    expect(detectLanguage('a.unknownext')).toEqual({ language: 'other', category: 'other' });
    expect(detectLanguage('bin/tool')).toEqual({ language: 'other', category: 'other' });
  });

  it('拡張子の無いファイルは shebang で（env -S・版の数字・パス）', () => {
    expect(shebangInterpreter('#!/usr/bin/env python3')).toBe('python');
    expect(shebangInterpreter('#!/usr/bin/env -S python3.11 -u')).toBe('python');
    expect(shebangInterpreter('#!/bin/bash -e')).toBe('bash');
    expect(shebangInterpreter('echo hi')).toBeUndefined();
    expect(detectLanguage('bin/tool', '#!/usr/bin/env node')).toEqual({
      language: 'javascript',
      category: 'source',
    });
    expect(detectLanguage('bin/tool', '#!/bin/zsh')).toEqual({
      language: 'shell',
      category: 'source',
    });
    // 拡張子が表にあれば shebang は見ない
    expect(detectLanguage('x.md', '#!/bin/sh').language).toBe('markdown');
  });

  it('よく使う 60 以上の言語・形式を持ち、拡張子は 1 つの行にだけある', () => {
    expect(knownLanguages().length).toBeGreaterThanOrEqual(60);
    expect(knownLanguages('source').length).toBeGreaterThanOrEqual(45);
    const seen = new Map<string, string>();
    for (const e of LANGUAGE_TABLE)
      for (const x of e.ext ?? []) {
        expect(seen.get(x), `${x} が ${seen.get(x)} と ${e.language} の両方にある`).toBeUndefined();
        seen.set(x, e.language);
      }
  });
});

describe('生成物の印・縮めたファイル・行数・.gitattributes', () => {
  it('先頭 5 行の Code generated … DO NOT EDIT と @generated。6 行目より後は見ない', () => {
    expect(
      hasGeneratedHeader('// Code generated by protoc-gen-go. DO NOT EDIT.\npackage x\n'),
    ).toBe(true);
    expect(hasGeneratedHeader('/**\n * @generated\n */\n')).toBe(true);
    expect(hasGeneratedHeader('a\nb\nc\nd\ne\n// Code generated DO NOT EDIT\n')).toBe(false);
    expect(hasGeneratedHeader('// generated files go to dist/\n')).toBe(false);
  });
  it('1,000 字を超える行があれば縮めたファイル', () => {
    expect(isMinified(`a\n${'x'.repeat(1001)}\nb`)).toBe(true);
    expect(isMinified(`a\n${'x'.repeat(1000)}\nb`)).toBe(false);
  });
  it('行数（最後の改行の後に文字があれば 1 行）', () => {
    expect(countLines(Buffer.from(''))).toBe(0);
    expect(countLines(Buffer.from('a'))).toBe(1);
    expect(countLines(Buffer.from('a\n'))).toBe(1);
    expect(countLines(Buffer.from('a\nb'))).toBe(2);
    expect(countLines(Buffer.from('a\n\nb\n'))).toBe(3);
  });
  it('linguist-generated・linguist-vendored（=false・- で外す、/ を含むパターンは相対、後の規則が勝つ）', () => {
    const rules = [
      ...parseGitattributes(
        [
          '# comment',
          '*.pb.go linguist-generated',
          'third_party/** linguist-vendored',
          'Gen/ linguist-generated=true',
          'keep.pb.go -linguist-generated',
          '*.txt text eol=lf',
        ].join('\n'),
      ),
      ...parseGitattributes('local.pb.go linguist-generated=false\n', 'sub'),
    ];
    expect(attributesFor(rules, 'a/b/x.pb.go')).toBe('generated');
    expect(attributesFor(rules, 'keep.pb.go')).toBeUndefined();
    expect(attributesFor(rules, 'sub/local.pb.go')).toBeUndefined();
    expect(attributesFor(rules, 'third_party/lib/a.c')).toBe('vendored');
    expect(attributesFor(rules, 'x/third_party/a.c')).toBeUndefined();
    expect(attributesFor(rules, 'Gen/a.swift')).toBe('generated');
    expect(attributesFor(rules, 'src/a.go')).toBeUndefined();
  });
});

/** 理由ごとに 1 つずつ除かれるものを並べた repo（git のときは追跡する） */
function repoWithEveryReason(root: string) {
  put(root, {
    'Sources/App/Main.swift': 'import Foundation\nfunc main() {}\n',
    'scripts/run': '#!/usr/bin/env bash\necho hi\n',
    'node_modules/dep/index.js': 'module.exports = 1\n',
    'ios/Pods/X/X.swift': 'class X {}\n',
    'site/index.html': '<p>x</p>\n',
    'web/next.config.mjs': "export default { output: 'export', distDir: 'export' }\n",
    'web/export/a.js': 'x\n',
    'web/out/b.js': 'x\n',
    '.gitattributes': 'gen/** linguist-generated\nvendor/** linguist-vendored\n',
    'gen/api.swift': 'struct Gen {}\n',
    'vendor/lib.py': 'x = 1\n',
    'api/types.pb.go': '// Code generated by protoc-gen-go. DO NOT EDIT.\npackage api\n',
    'web/app.min.js': `${'x'.repeat(2000)}\n`,
    'big.py': Buffer.alloc(1024 * 1024 + 1, 'a'),
    '.env': 'TOKEN=canary\n',
    'README.md': '# x\n',
    'logo.png': Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    'data.bin': Buffer.from([0, 1, 2]),
  });
}
const config = { screens: { dir: 'site' } };

describe('数える範囲（walk。git の repo でない）', () => {
  it('.gitignore を当てないと報告し、既知のディレクトリ・出力先に降りず、理由ごとに数える', () => {
    const root = tmp();
    repoWithEveryReason(root);
    const s = scanRepoScope(root, 'r', config);
    expect(s.method).toBe('walk');
    expect(s.note).toMatch(/\.gitignore を当てず/);
    // walk は既知のディレクトリ（node_modules・Pods）と出力先（site・web/export・web/out・.stack-atlas/out）に降りない
    expect(s.prunedDirs).toBe(5);
    expect(s.excluded).toMatchObject({
      dir: 0,
      output: 0,
      generated: 1,
      vendored: 1,
      header: 1,
      minified: 1,
      tooLarge: 1,
    });
    expect(s.secret).toBe(2); // .env と .gitattributes（dotfile。数えるが読まない。.gitattributes は属性のためだけに読む）
    expect(paths(s).sort()).toEqual([
      'README.md',
      'Sources/App/Main.swift',
      'data.bin',
      'logo.png',
      'scripts/run',
      'web/next.config.mjs',
    ]);
    expect(s.files.find((f) => f.path === 'scripts/run')).toMatchObject({
      language: 'shell',
      category: 'source',
      lines: 2,
    });
    expect(s.files.find((f) => f.path === 'data.bin')!.category).toBe('other');
  });

  it('シンボリックリンク（ファイルもディレクトリも）を辿らず、repo の外を読まない', () => {
    const outside = tmp();
    put(outside, { 'secret.swift': 'let token = "outside"\n', 'dir/a.swift': 'x\n' });
    const root = tmp();
    put(root, { 'a.swift': 'let a = 1\n' });
    symlinkSync(join(outside, 'secret.swift'), join(root, 'link.swift'));
    symlinkSync(join(outside, 'dir'), join(root, 'linked'));
    const s = scanRepoScope(root, 'r');
    expect(paths(s)).toEqual(['a.swift']);
    expect(s.symlinks).toBe(2);
  });

  it('秘密らしいファイルは数えるが読まない（読めないファイルにしても notFiles にならない）', () => {
    const root = tmp();
    put(root, { 'a.py': 'x = 1\n', 'config/.env.local': 'TOKEN=canary\n', 'keys/id_rsa': 'k\n' });
    chmodSync(join(root, 'config/.env.local'), 0o000);
    chmodSync(join(root, 'keys/id_rsa'), 0o000);
    try {
      const s = scanRepoScope(root, 'r');
      expect(s.secret).toBe(2);
      expect(s.notFiles).toBe(0);
      expect(paths(s)).toEqual(['a.py']);
    } finally {
      chmodSync(join(root, 'config/.env.local'), 0o600);
      chmodSync(join(root, 'keys/id_rsa'), 0o600);
    }
  });

  it('件数の上限を越えた分は数えずに overLimit', () => {
    const root = tmp();
    put(root, { 'a.py': '1\n', 'b.py': '2\n', 'c.py': '3\n' });
    const s = scanRepoScope(
      root,
      'r',
      {},
      {
        maxFiles: 2,
        maxFileBytes: 1024,
        headBytes: 1024,
        minifiedLine: 1000,
        headerLines: 5,
        gitTimeoutMs: 10_000,
      },
    );
    expect(paths(s)).toEqual(['a.py', 'b.py']);
    expect(s.overLimit).toBe(1);
  });
});

describe.skipIf(!hasGit)('数える範囲（git の repo）', () => {
  it('追跡しているファイルだけ。既知のディレクトリ・出力先・属性・印・縮めた・大きすぎるを理由ごとに数える', () => {
    const root = tmp();
    repoWithEveryReason(root);
    git(root, 'init', '-q');
    git(root, 'add', '-A');
    put(root, { 'untracked.swift': 'let u = 1\n' }); // 追跡していないものは数えない
    const s = scanRepoScope(root, 'r', config);
    expect(s.method).toBe('git');
    expect(s.note).toBeUndefined();
    expect(s.excluded).toEqual({
      dir: 2, // node_modules/dep/index.js・ios/Pods/X/X.swift
      output: 3, // site/index.html・web/export/a.js・web/out/b.js
      generated: 1,
      vendored: 1,
      header: 1,
      minified: 1,
      tooLarge: 1,
    });
    expect(s.secret).toBe(2);
    expect(paths(s)).not.toContain('untracked.swift');
    expect(paths(s)).toContain('Sources/App/Main.swift');
    expect(s.tracked).toBe(18);
  });

  it('追跡しているリンクも辿らない（数えるのは symlinks だけ）', () => {
    const outside = tmp();
    put(outside, { 'x.swift': 'let x = 1\n' });
    const root = tmp();
    put(root, { 'a.swift': 'let a = 1\n' });
    symlinkSync(join(outside, 'x.swift'), join(root, 'out.swift'));
    git(root, 'init', '-q');
    git(root, 'add', '-A');
    const s = scanRepoScope(root, 'r');
    expect(s.method).toBe('git');
    expect(paths(s)).toEqual(['a.swift']);
    expect(s.symlinks).toBe(1);
  });

  it('追跡が 0（init しただけ）なら walk に落とし、そう報告する', () => {
    const root = tmp();
    put(root, { 'a.py': 'x\n' });
    git(root, 'init', '-q');
    const s = scanRepoScope(root, 'r');
    expect(s.method).toBe('walk');
    expect(s.note).toMatch(/追跡しているファイルが無い/);
    expect(paths(s)).toEqual(['a.py']);
  });
});

/** 範囲を直に渡す（読む・読まないの判定だけを確かめる） */
const scope = (repo: string, files: Array<[string, string, number?]>): RepoScope => ({
  repo,
  method: 'git',
  tracked: files.length,
  files: files.map(([path, language, lines]) => ({
    path,
    language,
    category: lines === undefined ? 'config' : 'source',
    ...(lines === undefined ? {} : { lines }),
  })),
  excluded: { dir: 0, output: 0, generated: 0, vendored: 0, header: 0, minified: 0, tooLarge: 0 },
  secret: 0,
  symlinks: 0,
  notFiles: 0,
  prunedDirs: 0,
  overLimit: 0,
});

describe('「読んだ」（最後の graph の file か、抽出器の read の申告）', () => {
  const base = (over: Partial<CoverageInput> = {}): CoverageInput => ({
    repos: { r: '/nonexistent/r' },
    configDir: '/nonexistent/r',
    config: {},
    partials: {},
    roles: new Map([['ts-types', 'language' as const]]),
    graphFiles: [],
    scopes: [
      scope('r', [
        ['src/a.ts', 'typescript', 10],
        ['src/types.ts', 'typescript', 5],
        ['src/removed.ts', 'typescript', 3],
        ['src/hand.ts', 'typescript', 2],
        ['src/patch.ts', 'typescript', 4],
        ['app/Main.swift', 'swift', 100],
        ['app/B.swift', 'swift', 50],
        ['go.mod', 'go-mod'],
        ['stack-atlas.config.yaml', 'yaml'],
      ]),
    ],
    ...over,
  });
  const input = base({
    partials: {
      // 箱の file（最後の graph にある）と、箱を出さない型だけのファイルの申告
      'ts-types': {
        nodes: [],
        edges: [],
        v2: {
          nodes: [{ id: 'fn:a', kind: 'fn', name: 'a', file: 'src/a.ts', ports: [] } as never],
          wires: [],
        },
        read: ['src/a.ts', 'src/types.ts'],
      },
      // 箱を出したが overrides の remove で最後の graph に無い（申告もしない）→ 読めていない
      'ts-imports': { nodes: [{ id: 'lib:removed', file: 'src/removed.ts' }], edges: [] },
      go: { nodes: [], edges: [], read: ['go.mod'] },
      hand: {
        nodes: [],
        edges: [],
        v2: {
          nodes: [{ id: 'fn:h', kind: 'fn', name: 'h', file: 'src/hand.ts', ports: [] } as never],
          wires: [],
        },
      },
    },
    graphFiles: ['src/a.ts', './src/hand.ts', 'src/patch.ts'],
  });

  it('段ごとに行数で数える（adapter ＞ extractor ＞ hand ＞ none）。readBy は読んだものごと', () => {
    const c = computeCoverage(input);
    const ts = c.languages.find((l) => l.language === 'typescript')!;
    expect(ts).toEqual({
      language: 'typescript',
      files: 5,
      lines: 24,
      read: { adapter: 15, extractor: 0, hand: 6, none: 3 },
      readBy: { hand: 2, overrides: 4, 'ts-types': 15 },
      unread: { files: 1, lines: 3 },
    });
    const swift = c.languages.find((l) => l.language === 'swift')!;
    expect(swift.unread).toEqual({ files: 2, lines: 150 });
    expect(c.languages.map((l) => l.language)).toEqual(['swift', 'typescript']); // 行数の多い順
    expect(c.formats).toEqual([
      { format: 'go-mod', files: 1, readBy: ['go'] },
      { format: 'yaml', files: 1, readBy: ['stack-atlas'] }, // config のあるディレクトリの設定は stack-atlas が読む
    ]);
    expect(c.unread).toEqual([
      {
        language: 'swift',
        files: 2,
        lines: 150,
        why: '構文の段（9-L1）で読めるようになる予定',
        examples: ['app/B.swift', 'app/Main.swift'],
      },
      {
        language: 'typescript',
        files: 1,
        lines: 3,
        why: '一部が読めていない（ts.tsconfig の tsconfig の include・files に入っていない）',
        examples: ['src/removed.ts'],
      },
    ]);
  });

  it('決定的: 抽出器の順・graph の file の順を変えても同じ JSON', () => {
    const a = JSON.stringify(computeCoverage(input));
    const reversed = Object.fromEntries(Object.entries(input.partials).reverse());
    const b = JSON.stringify(
      computeCoverage({
        ...input,
        partials: reversed,
        graphFiles: [...input.graphFiles].reverse(),
      }),
    );
    expect(b).toBe(a);
  });

  it('複数 repo: graph の file と read は `<repo>/` 付き（prefixRepoFiles が read も修飾し、merge は和集合）', () => {
    const ctxWeb = { repoName: 'web', repos: { web: '/x/web', api: '/x/api' }, root: '/x/web' };
    const part = prefixRepoFiles(
      { nodes: [{ id: 'lib:a', file: 'a.ts' }], edges: [], read: ['b.ts'] },
      ctxWeb,
    );
    expect(part.read).toEqual(['web/b.ts']);
    expect(part.nodes[0]!.file).toBe('web/a.ts');
    const merged = mergePartialGraphs([
      part,
      { nodes: [], edges: [], read: ['api/c.ts', 'web/b.ts'] },
    ]);
    expect(merged.read).toEqual(['web/b.ts', 'api/c.ts']);
    const c = computeCoverage({
      ...base(),
      repos: { web: '/x/web', api: '/x/api' },
      configDir: '/x',
      partials: { 'ts-types': merged },
      graphFiles: ['web/a.ts'],
      scopes: [
        scope('web', [
          ['a.ts', 'typescript', 1],
          ['b.ts', 'typescript', 1],
        ]),
        scope('api', [
          ['c.ts', 'typescript', 1],
          ['b.ts', 'typescript', 1], // api の b.ts は読んでいない（web の b.ts と別）
        ]),
      ],
    });
    expect(c.languages[0]!.read).toEqual({ adapter: 3, extractor: 0, hand: 0, none: 1 });
    expect(c.unread[0]!.examples).toEqual(['api/b.ts']);
    expect(c.scope.repos.map((r) => r.repo)).toEqual(['web', 'api']);
  });

  it('警告は言語ごとに 1 件（path coverage）。要約の文は 3 桁ごとに区切る', () => {
    const c = computeCoverage(input);
    expect(coverageIssues(c).map((i) => [i.level, i.path, i.message])).toEqual([
      [
        'warning',
        'coverage',
        '読めていないソース: swift 2 ファイル（150 行）— 構文の段（9-L1）で読めるようになる予定',
      ],
      [
        'warning',
        'coverage',
        '読めていないソース: typescript 1 ファイル（3 行）— 一部が読めていない（ts.tsconfig の tsconfig の include・files に入っていない）',
      ],
    ]);
    expect(
      unreadText({
        language: 'swift',
        files: 473,
        lines: 77899,
        why: '構文の段（9-L1）で読めるようになる予定',
      }),
    ).toBe(
      '読めていないソース: swift 473 ファイル（77,899 行）— 構文の段（9-L1）で読めるようになる予定',
    );
    expect(formatCoverage(c)).toEqual([
      '数える範囲: 9 ファイル（一覧 9）',
      '  swift: 2 ファイル・150 行、読めた 0 行（0%）',
      '  typescript: 5 ファイル・24 行、読めた 21 行（87%。hand 2・overrides 4・ts-types 15）',
    ]);
  });
});

describe('strict（9-L0b）: 箱 0 はエラー、読めていないソースは警告', () => {
  const none: Extractor = {
    name: 'none',
    detect: async () => false,
    extract: async () => ({ nodes: [], edges: [] }),
  };
  it('Swift だけの repo: 箱 0 の strict のエラー（見つけた言語を書く）と、言語ごとの警告。graph の報告にも数', async () => {
    const root = tmp();
    put(root, {
      'Sources/App/A.swift': 'struct A {}\nfunc a() {}\n',
      'Sources/App/B.swift': 'func b() {}\n',
      'Package.swift': '// swift-tools-version:5.9\n',
    });
    const res = await buildGraph({ root, extractors: [none], commit: false });
    expect(res.graphV2!.nodes).toEqual([]);
    const s = strictIssues(res);
    expect(s.errors.map((e) => [e.rule, e.path])).toEqual([['empty', 'coverage']]);
    expect(s.errors[0]!.message).toBe(
      '箱が 0 の graph です。数える範囲のソースは swift 2 ファイル（3 行）で、どの抽出器も読めませんでした（構文の段（9-L1）で読めるようになる予定。今は手書きの部分グラフで補う）',
    );
    expect(s.warnings.map((w) => [w.rule, w.path, w.message])).toEqual([
      [
        'unread',
        'coverage',
        '読めていないソース: swift 2 ファイル（3 行）— 構文の段（9-L1）で読めるようになる予定',
      ],
    ]);
    // 読めていないソースは issues の警告にも（path coverage）。エラーではない（build は失敗しない）
    expect(res.issues.filter((i) => i.path === 'coverage').map((i) => i.level)).toEqual([
      'warning',
    ]);
    expect(res.issues.some((i) => i.level === 'error')).toBe(false);
    const report = toGraphReport(res.harness!, s);
    expect(report.counts).toMatchObject({ strictErrors: 1, unreadLanguages: 1 });
    expect(report.coverage!.languages).toEqual([
      {
        language: 'swift',
        files: 2,
        lines: 3,
        read: { adapter: 0, extractor: 0, hand: 0, none: 3 },
        unread: { files: 2, lines: 3 },
      },
    ]);
    expect(report.coverage!.scope).toMatchObject({ files: 3, methods: ['walk'] });
    // graph.json に書く報告（project.generator.report）も同じ
    expect(res.graphV2!.project?.generator?.report?.counts.strictErrors).toBe(1);
  });

  it('箱 0 の文: 上位 5 言語と残りの数。設定で読める言語（typescript など）はそう書く', () => {
    const row = (language: string, lines: number) => ({
      language,
      files: 1,
      lines,
      read: { adapter: 0, extractor: 0, hand: 0, none: lines },
      readBy: {},
      unread: { files: 1, lines },
    });
    const c = computeCoverage({
      repos: { r: '/nonexistent/r' },
      configDir: '/nonexistent/r',
      config: {},
      partials: {},
      roles: new Map(),
      graphFiles: [],
      scopes: [scope('r', [])],
    });
    c.languages = [
      row('swift', 7000),
      row('python', 6000),
      row('typescript', 5000),
      row('shell', 4000),
      row('svelte', 3000),
      row('c', 10),
    ];
    expect(emptyGraphText(c)).toBe(
      '箱が 0 の graph です。数える範囲のソースは swift 1 ファイル（7,000 行）・python 1 ファイル（6,000 行）・' +
        'typescript 1 ファイル（5,000 行）・shell 1 ファイル（4,000 行）・svelte 1 ファイル（3,000 行）ほか 1 言語で、' +
        'どの抽出器も読めませんでした（typescript は設定で読める（coverage.unread の why）。ほかの言語は構文の段（9-L1）で' +
        '読めるようになる予定。今は手書きの部分グラフで補う）',
    );
  });

  it('ソースの無い repo: 箱 0 のエラーは「ソースが見つからない」', async () => {
    const root = tmp();
    put(root, { 'README.md': '# x\n' });
    const res = await buildGraph({ root, extractors: [none], commit: false });
    expect(strictIssues(res).errors.map((e) => e.message)).toEqual([
      '箱が 0 の graph です。数える範囲にソースが見つかりません（repo のパス・repos の設定を確かめる）',
    ]);
  });

  it('箱があれば empty は出ない。抽出器の read の申告で読めたソースは警告にならない', async () => {
    const root = tmp();
    put(root, { 'src/a.py': 'def a(): pass\n', 'src/b.py': 'x = 1\n' });
    const py: Extractor = {
      name: 'py',
      detect: async () => true,
      extract: async (): Promise<PartialGraph> => ({
        nodes: [{ id: 'lib:a', kind: 'lib', name: 'a', file: 'src/a.py' }],
        edges: [],
        read: ['src/b.py'],
      }),
    };
    const res = await buildGraph({ root, extractors: [py], commit: false });
    const s = strictIssues(res);
    expect(s.errors.map((e) => e.rule)).not.toContain('empty');
    expect(s.warnings.map((w) => w.rule)).not.toContain('unread');
    expect(res.harness!.coverage.languages).toEqual([
      {
        language: 'python',
        files: 2,
        lines: 2,
        read: { adapter: 0, extractor: 2, hand: 0, none: 0 },
        readBy: { py: 2 },
        unread: { files: 0, lines: 0 },
      },
    ]);
  });
});
